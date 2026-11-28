-- Fecha de compra de cada reserva, para la ficha y para ordenar la lista.
-- Prioridad: fecha del pedido Shopify (por referencia de línea o por el pedido de Cowlendar),
-- fecha de confirmación de Atrápalo en el ledger y, si no hay otra, el alta en el OS.
-- security_invoker: respeta la RLS de las tablas de origen (solo quien puede leerlas ve la fecha externa).
begin;
create or replace view public.os_reservation_purchase_dates
with (security_invoker = true) as
select
  r.id as reservation_id,
  coalesce(o.order_created_at, oc.order_created_at, l.confirmation_at, r.created_at) as purchased_at,
  case
    when coalesce(o.order_created_at, oc.order_created_at) is not null then 'shopify'
    when l.confirmation_at is not null then 'atrapalo'
    else 'os'
  end as basis
from public.reservations r
left join public.os_shopify_order_snapshots o
  on r.external_reference like 'gid://shopify/Order/%'
 and o.order_gid = split_part(r.external_reference, '/gid://shopify/LineItem/', 1)
left join public.os_cowlendar_live_bookings b
  on r.external_reference = 'cowlendar:' || b.booking_id
left join public.os_shopify_order_snapshots oc
  on b.order_id is not null
 and oc.order_gid = case when b.order_id ~ '^[0-9]+$' then 'gid://shopify/Order/' || b.order_id else b.order_id end
left join lateral (
  select x.confirmation_at from public.atrapalo_booking_ledger x
  where x.os_reservation_id = r.id order by x.updated_at desc nulls last limit 1
) l on true;

revoke all on public.os_reservation_purchase_dates from anon;
grant select on public.os_reservation_purchase_dates to authenticated, service_role;
commit;
