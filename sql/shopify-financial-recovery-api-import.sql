-- Escritura idempotente de la recuperación financiera de Shopify desde la API directa.
-- Mismas garantías que public.os_import_exact_shopify_financials(jsonb):
--   pedido exacto, EUR, PAID/PARTIALLY_REFUNDED/REFUNDED, una sola línea de taller sin tarjeta regalo,
--   vínculo único con una reserva confirmada sin ficha, plazas = cantidad, reembolsado <= recibido,
--   on conflict do nothing (nunca sobrescribe importes ni capturas ya asentadas).
-- Diferencias: procedencia 'shopify_admin_api' y registro de cada pedido en external_sync_events
-- (processed / needs_review) para auditar errores y casos ambiguos.
begin;

create or replace function public.os_import_shopify_financials_api(p_orders jsonb)
returns table (restored bigint, snapshots bigint, needs_review bigint)
language sql
set search_path = ''
as $$
with raw as (
  select * from jsonb_to_recordset(coalesce(p_orders, '[]'::jsonb)) as o(
    gid text, name text, created_at timestamptz, financial_status text, fulfillment_status text,
    quantity integer, gross numeric, received numeric, refunded numeric, currency text,
    single_workshop_line boolean, review_reason text
  )
  where gid ~ '^gid://shopify/Order/[0-9]+$'
), orders as (
  select * from raw
  where review_reason is null and created_at is not null
    and currency = 'EUR' and single_workshop_line and quantity > 0
    and financial_status in ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED')
    and gross >= 0 and received >= 0 and refunded >= 0 and refunded <= received
), unique_orders as (
  select o.* from orders o where (select count(*) from orders x where x.gid = o.gid) = 1
), links as (
  select r.id, r.status, r.seats, o.*, count(*) over (partition by o.gid) as linked_count
  from public.reservations r
  left join public.os_cowlendar_live_bookings b on r.external_reference = 'cowlendar:' || b.booking_id
  join unique_orders o on (
    b.order_id in (o.gid, split_part(o.gid, '/', 5))
    or split_part(r.external_reference, '/gid://shopify/LineItem/', 1) = o.gid
  )
  where r.source = 'shopify'
), eligible as (
  select * from links where linked_count = 1 and status = 'confirmed' and seats = quantity
), quoted as (
  insert into public.os_shopify_order_snapshots
    (order_gid, order_name, order_created_at, gross_amount, currency, financial_status,
     fulfillment_status, line_item_count, order_kind, captured_at, source)
  select gid, name, created_at, gross, currency, financial_status, fulfillment_status,
         quantity, 'workshop', now(), 'shopify_admin_api'
  from eligible
  on conflict (order_gid) do nothing
  returning 1
), inserted as (
  insert into public.reservation_financials
    (reservation_id, paid_amount, currency, payment_method, refunded_amount, refund_status)
  select id, received, currency, 'shopify', refunded,
         case when refunded > 0 then 'processed' else 'none' end
  from eligible
  on conflict (reservation_id) do nothing
  returning reservation_id
), outcome as (
  select r.gid,
    case when e.gid is not null then 'processed' else 'needs_review' end as state,
    case
      when e.gid is not null then null
      when r.review_reason is not null then r.review_reason
      when not exists (select 1 from orders o where o.gid = r.gid) then 'validation_failed'
      when not exists (select 1 from unique_orders u where u.gid = r.gid) then 'duplicate_order_in_batch'
      when not exists (select 1 from links l where l.gid = r.gid) then 'no_reservation_link'
      when exists (select 1 from links l where l.gid = r.gid and l.linked_count > 1) then 'ambiguous_link'
      else 'status_or_seats_mismatch'
    end as reason
  from (select distinct on (gid) * from raw) r
  left join (select distinct gid from eligible) e on e.gid = r.gid
), logged as (
  insert into public.external_sync_events (provider, external_id, event_type, state, payload, error_message, processed_at)
  select 'shopify', gid, 'financial_recovery', state,
         jsonb_build_object('source', 'shopify_admin_api'), reason, now()
  from outcome
  on conflict (provider, external_id, event_type) where external_id is not null
  do update set state = excluded.state, error_message = excluded.error_message, processed_at = excluded.processed_at
  returning state
)
select (select count(*) from inserted),
       (select count(*) from quoted),
       (select count(*) from logged where state = 'needs_review');
$$;

revoke all on function public.os_import_shopify_financials_api(jsonb) from public, anon, authenticated;
grant execute on function public.os_import_shopify_financials_api(jsonb) to service_role;

-- Invocación programada: mismo patrón que Holded (token en Vault, cabecera propia).
create or replace function private.invoke_shopify_financial_recovery()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions', 'vault'
as $$
declare token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets
  where name = 'shopify_recovery_cron_token' order by created_at desc limit 1;
  if token is null or length(token) < 24 then
    raise exception 'Missing valid Shopify recovery cron token';
  end if;
  perform net.http_post(
    url := 'https://stiucnalemcwedlreaux.supabase.co/functions/v1/shopify-financial-recovery',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-recovery-cron-token', token),
    body := jsonb_build_object('apply', true),
    timeout_milliseconds := 120000);
end;
$$;
revoke all on function private.invoke_shopify_financial_recovery() from public, anon, authenticated;

commit;
-- La programación se activa aparte, después de validar en paralelo:
-- select cron.schedule('soap-candles-shopify-financial-recovery', '50 * * * *', 'select private.invoke_shopify_financial_recovery()');
