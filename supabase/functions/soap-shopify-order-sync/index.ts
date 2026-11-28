// Captura de pedidos Shopify en os_shopify_order_snapshots (ventas nuevas y cambios de estado).
// Body opcional: {"dry_run": true} compara con lo guardado sin escribir; {"pages": n} limita páginas (máx. 12).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Token fijo si existe; si no, client credentials de la app de la tienda (dura ~24 h).
async function shopifyToken(shop: string): Promise<string> {
  const fixed = Deno.env.get("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (fixed) return fixed;
  const id = Deno.env.get("SHOPIFY_CLIENT_ID"), secret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("client_credentials_missing");
  const r = await fetch("https://" + shop + "/admin/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("token_http_" + r.status);
  const data = await r.json();
  if (typeof data.access_token !== "string") throw new Error("token_missing");
  if (!String(data.scope ?? "").split(",").includes("read_orders")) throw new Error("read_orders_scope_missing");
  return data.access_token;
}

const kindOf = (titles: string[]) =>
  titles.some((t) => /tarjeta de regalo|gift card/i.test(t)) ? "gift_card"
  : titles.some((t) => /taller|workshop|vela|jabón|jabon/i.test(t)) ? "workshop" : "unclassified";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const supa = Deno.env.get("SUPABASE_URL"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const shop = (Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (!supa || !service) return json({ error: "Supabase environment incomplete" }, 503);
  const cron = Deno.env.get("SHOPIFY_RECOVERY_CRON_TOKEN");
  const authorized = req.headers.get("authorization") === "Bearer " + service ||
    (!!cron && cron.length >= 24 && req.headers.get("x-recovery-cron-token") === cron);
  if (!authorized) return json({ error: "Unauthorized" }, 401);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return json({ error: "Invalid Shopify shop domain" }, 503);

  let body: { dry_run?: boolean; pages?: number } = {};
  try { body = await req.json(); } catch { /* sin cuerpo */ }
  const dryRun = body.dry_run === true;
  const maxPages = Math.min(12, Math.max(1, Number(body.pages) || 12));

  let token: string;
  try { token = await shopifyToken(shop); } catch (e) { return json({ ok: false, error: "shopify_token_unavailable", stage: (e as Error).message }, 503); }

  // Diagnóstico: suscripciones de webhook de esta app (solo lectura, sin datos de clientes).
  if ((body as { webhooks?: boolean }).webhooks === true) {
    const r = await fetch("https://" + shop + "/admin/api/2026-10/graphql.json", {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{webhookSubscriptions(first:50){nodes{topic format endpoint{__typename ... on WebhookHttpEndpoint{callbackUrl}}}}}" }),
      signal: AbortSignal.timeout(15000),
    });
    const w = await r.json();
    // deno-lint-ignore no-explicit-any
    const nodes = (w.data?.webhookSubscriptions?.nodes ?? []).map((n: any) => ({
      topic: n.topic, format: n.format, host: n.endpoint?.callbackUrl ? new URL(n.endpoint.callbackUrl).host + new URL(n.endpoint.callbackUrl).pathname : n.endpoint?.__typename,
    }));
    return json({ ok: !w.errors, errors: w.errors?.map((e: { message: string }) => e.message), subscriptions: nodes });
  }

  const db = createClient(supa, service, { auth: { persistSession: false } });
  let cursor: string | null = null, pages = 0, hasNext = true, processed = 0;
  const diff = { new: 0, status_changed: 0, amount_changed: 0, unchanged: 0 };
  try {
    while (hasNext && pages < maxPages) {
      const query = `query($after:String){orders(first:100,after:$after,sortKey:CREATED_AT,reverse:true){pageInfo{hasNextPage endCursor}edges{node{id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}}lineItems(first:100){nodes{title quantity}}}}}}`;
      const response = await fetch("https://" + shop + "/admin/api/2026-10/graphql.json", {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { after: cursor } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error("Shopify HTTP " + response.status);
      const result = await response.json();
      if (result.errors?.length) throw new Error("Shopify query failed");
      const orders = result.data?.orders;
      if (!orders) throw new Error("Shopify orders unavailable");

      // deno-lint-ignore no-explicit-any
      const rows = orders.edges.map(({ node: o }: any) => ({
        order_gid: o.id, order_name: o.name, order_created_at: o.createdAt,
        gross_amount: Number(o.totalPriceSet.shopMoney.amount), currency: o.totalPriceSet.shopMoney.currencyCode,
        financial_status: o.displayFinancialStatus, fulfillment_status: o.displayFulfillmentStatus,
        // deno-lint-ignore no-explicit-any
        line_item_count: o.lineItems.nodes.reduce((n: number, l: any) => n + l.quantity, 0),
        // deno-lint-ignore no-explicit-any
        order_kind: kindOf(o.lineItems.nodes.map((l: any) => l.title)),
        source: "shopify_admin_sync", captured_at: new Date().toISOString(),
      }));

      if (rows.length) {
        const { data: existing, error: existingError } = await db.from("os_shopify_order_snapshots")
          .select("order_gid,order_kind,financial_status,gross_amount").in("order_gid", rows.map((r: { order_gid: string }) => r.order_gid));
        if (existingError) throw new Error("Existing snapshots: " + existingError.message);
        const prev = new Map((existing ?? []).map((x) => [x.order_gid, x]));
        const changed: typeof rows = [];
        for (const row of rows) {
          const p = prev.get(row.order_gid);
          // Una clasificación manual como taller se conserva.
          if (row.order_kind === "unclassified" && p?.order_kind === "workshop") row.order_kind = "workshop";
          if (!p) diff.new++;
          else if (p.financial_status !== row.financial_status) diff.status_changed++;
          else if (Number(p.gross_amount) !== row.gross_amount) diff.amount_changed++;
          else { diff.unchanged++; continue; }
          changed.push(row);
        }
        // Solo se escriben pedidos nuevos o con cambios: los demás conservan su procedencia.
        if (!dryRun && changed.length) {
          const { error } = await db.from("os_shopify_order_snapshots").upsert(changed, { onConflict: "order_gid" });
          if (error) throw new Error("Database: " + error.message);
          processed += changed.length;
        }
      }
      pages++; hasNext = orders.pageInfo.hasNextPage; cursor = orders.pageInfo.endCursor;
    }
    return json({ ok: true, dry_run: dryRun, processed, pages, morePages: hasNext, diff });
  } catch (e) {
    console.error("soap-shopify-order-sync", (e as Error).message);
    return json({ ok: false, error: (e as Error).message, processed, pages, diff }, 502);
  }
});
