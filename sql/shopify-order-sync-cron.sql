-- Invocación programada de soap-shopify-order-sync (mismo token de Vault que la recuperación financiera).
begin;
create or replace function private.invoke_shopify_order_sync()
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
    raise exception 'Missing valid Shopify cron token';
  end if;
  perform net.http_post(
    url := 'https://stiucnalemcwedlreaux.supabase.co/functions/v1/soap-shopify-order-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-recovery-cron-token', token),
    body := jsonb_build_object('pages', 2),
    timeout_milliseconds := 120000);
end;
$$;
revoke all on function private.invoke_shopify_order_sync() from public, anon, authenticated;
commit;
-- Activación (tras coordinar el corte con la tarea de ChatGPT):
-- select cron.schedule('soap-candles-shopify-order-sync', '20,50 * * * *', 'select private.invoke_shopify_order_sync()');
-- select cron.schedule('soap-candles-shopify-financial-recovery', '55 * * * *', 'select private.invoke_shopify_financial_recovery()');
