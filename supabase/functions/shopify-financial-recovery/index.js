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

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const token = Deno.env.get("SHOPIFY_ADMIN_ACCESS_TOKEN");
  const shop = Deno.env.get("SHOPIFY_SHOP_DOMAIN")?.toLowerCase();
  if (!key || request.headers.get("authorization") !== "Bearer " + key) {
    return reply(401, { error: "unauthorized" });
  }
  if (!base || !token || !shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return reply(503, { error: "integration_not_configured" });
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
