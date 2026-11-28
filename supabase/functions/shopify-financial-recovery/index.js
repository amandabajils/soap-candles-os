import { reviewReason, toImportRow } from "./validate-order.js";

const PAGE = 40;
const MAX_PAGES = 10;

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
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("http_" + response.status);
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

function authorized(request, key) {
  if (key && request.headers.get("authorization") === "Bearer " + key) return true;
  const cron = Deno.env.get("SHOPIFY_RECOVERY_CRON_TOKEN");
  return !!cron && cron.length >= 24 && request.headers.get("x-recovery-cron-token") === cron;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const shop = Deno.env.get("SHOPIFY_SHOP_DOMAIN")?.toLowerCase();
  if (!authorized(request, key)) return reply(401, { error: "unauthorized" });
  if (!base || !key || !shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return reply(503, { error: "integration_not_configured" });
  }

  // Writes only with {"apply": true}; anything else is a dry run.
  let apply = false;
  try { apply = (await request.json())?.apply === true; } catch { /* empty body = dry run */ }

  let token;
  try {
    token = await shopifyToken(shop);
  } catch (error) {
    return reply(503, { error: "shopify_token_unavailable", stage: error.message });
  }

  const db = (path, body, range) => fetchJson(base + "/rest/v1/rpc/" + path, {
    method: "POST",
    headers: {
      apikey: key, authorization: "Bearer " + key, "content-type": "application/json",
      ...(range ? { range, "range-unit": "items" } : {}),
    },
    body: JSON.stringify(body),
  });

  const totals = { mode: apply ? "apply" : "dry_run", candidates: 0, eligible: 0, needs_review: 0, restored: 0, pages: 0 };
  try {
    // Candidates are a stable ordered list; page through it by offset so ineligible
    // rows (which stay in the list) cannot cause an endless loop.
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const candidates = await db("os_shopify_financial_recovery_candidates", {}, `${from}-${from + PAGE - 1}`);
      if (!Array.isArray(candidates)) throw new Error("invalid_candidates");
      totals.pages++;
      if (!candidates.length) {
        if (page === 0) {
          const probe = await fetchJson("https://" + shop + "/admin/api/2026-10/graphql.json", {
            method: "POST",
            headers: { "x-shopify-access-token": token, "content-type": "application/json" },
            body: JSON.stringify({ query: "{ orders(first: 1) { nodes { id } } }" }),
          });
          if (probe.errors?.length || !Array.isArray(probe.data?.orders?.nodes)) throw new Error("shopify_probe_failed");
        }
        break;
      }

      const ids = candidates.map(({ gid }) => gid);
      const result = await fetchJson("https://" + shop + "/admin/api/2026-10/graphql.json", {
        method: "POST",
        headers: { "x-shopify-access-token": token, "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { ids } }),
      });
      if (result.errors?.length) throw new Error("shopify_query_failed");
      const orders = result.data?.nodes;
      if (!Array.isArray(orders) || orders.length !== candidates.length) throw new Error("incomplete_shopify_response");

      const byId = new Map(orders.filter(Boolean).map((order) => [order.id, order]));
      const rows = candidates.map((candidate) => {
        const order = byId.get(candidate.gid);
        const reason = reviewReason(order, candidate);
        return reason ? { gid: candidate.gid, review_reason: reason } : toImportRow(order);
      });
      const eligible = rows.filter((row) => !row.review_reason).length;
      totals.candidates += candidates.length;
      totals.eligible += eligible;
      totals.needs_review += candidates.length - eligible;

      if (apply) {
        const [outcome] = await db("os_import_shopify_financials_api", { p_orders: rows });
        totals.restored += Number(outcome?.restored ?? 0);
      }
      if (candidates.length < PAGE) break;
    }
    return reply(200, totals);
  } catch (error) {
    console.error("shopify-financial-recovery", error.message);
    return reply(502, { error: "recovery_failed", stage: error.message, ...totals });
  }
});
