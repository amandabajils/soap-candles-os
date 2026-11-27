import { validateOrder } from "./validate-order.js";

const query = `query RecoverWorkshopFinancials($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id name createdAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      totalReceivedSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 2) {
        nodes { id title quantity isGiftCard }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

function reply(status, data) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Upstream request failed");
  return response.json();
}

// Static Admin API token if present; otherwise the client credentials grant of the
// store's own app (tokens last ~24 h, so each invocation requests a fresh one).
async function shopifyToken(shop) {
  const fixed = Deno.env.get("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (fixed) return fixed;
  const id = Deno.env.get("SHOPIFY_CLIENT_ID");
  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("client_credentials_missing");
  const response = await fetch("https://" + shop + "/admin/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("token_http_" + response.status);
  const data = await response.json();
  if (typeof data.access_token !== "string") throw new Error("token_missing");
  const scopes = String(data.scope ?? "").split(",");
  if (!scopes.includes("read_orders")) throw new Error("read_orders_scope_missing");
  return data.access_token;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const shop = Deno.env.get("SHOPIFY_SHOP_DOMAIN")?.toLowerCase();
  if (!key || request.headers.get("authorization") !== "Bearer " + key) {
    return reply(401, { error: "unauthorized" });
  }
  if (!base || !shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return reply(503, { error: "integration_not_configured" });
  }
  let token;
  try {
    token = await shopifyToken(shop);
  } catch (error) {
    return reply(503, { error: "shopify_token_unavailable", stage: error.message });
  }

  // Preview only during the parallel comparison. This worker performs no writes.
  try {
    const candidates = await fetchJson(base + "/rest/v1/rpc/os_shopify_financial_recovery_candidates", {
      method: "POST",
      headers: {
        apikey: key, authorization: "Bearer " + key, "content-type": "application/json",
        range: "0-39", "range-unit": "items",
      },
      body: "{}",
    });
    if (!Array.isArray(candidates)) throw new Error("Invalid candidate response");

    // An empty queue still probes the shop credential via a read-only order query.
    const ids = candidates.map(({ gid }) => gid);
    const result = await fetchJson("https://" + shop + "/admin/api/2026-10/graphql.json", {
      method: "POST",
      headers: { "x-shopify-access-token": token, "content-type": "application/json" },
      body: JSON.stringify(ids.length ? { query, variables: { ids } } : {
        query: "{ orders(first: 1) { nodes { id } } }",
      }),
    });
    if (result.errors?.length) throw new Error("Shopify query failed");
    if (!ids.length && !Array.isArray(result.data?.orders?.nodes)) {
      throw new Error("Invalid Shopify probe response");
    }
    const orders = result.data?.nodes ?? [];
    if (!Array.isArray(orders) || orders.length !== candidates.length) {
      throw new Error("Incomplete Shopify response");
    }
    const byId = new Map(orders.filter(Boolean).map((order) => [order.id, order]));
    const eligible = candidates.filter((candidate) => validateOrder(byId.get(candidate.gid), candidate)).length;
    return reply(200, {
      mode: "dry_run", candidates: candidates.length, eligible,
      needs_review: candidates.length - eligible, limit_reached: candidates.length === 40,
    });
  } catch {
    return reply(502, { error: "recovery_preview_failed" });
  }
});
