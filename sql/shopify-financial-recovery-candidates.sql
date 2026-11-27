-- Read-only candidate selection for the Shopify financial recovery worker.
begin;
create or replace function public.os_shopify_financial_recovery_candidates()
returns table (gid text, expected_seats integer)
language sql stable
set search_path = ''
as $$
  with links as (
    select r.id, r.status, r.seats,
      case
        when r.external_reference ~ '^gid://shopify/Order/[0-9]+/gid://shopify/LineItem/[0-9]+$'
          then split_part(r.external_reference, '/gid://shopify/LineItem/', 1)
        when b.order_id ~ '^[0-9]+$' then 'gid://shopify/Order/' || b.order_id
        when b.order_id ~ '^gid://shopify/Order/[0-9]+$' then b.order_id
      end as order_gid
    from public.reservations r
    left join public.os_cowlendar_live_bookings b
      on r.external_reference = 'cowlendar:' || b.booking_id
    where r.source = 'shopify'
  ), counted as (
    select *, count(*) over (partition by order_gid) as link_count
    from links where order_gid is not null
  )
  select c.order_gid, c.seats::integer
  from counted c
  where c.link_count = 1 and c.status = 'confirmed' and c.seats > 0
    and not exists (
      select 1 from public.reservation_financials f where f.reservation_id = c.id
    )
  order by c.order_gid;
$$;
revoke all on function public.os_shopify_financial_recovery_candidates() from public, anon, authenticated;
grant execute on function public.os_shopify_financial_recovery_candidates() to service_role;
commit;
