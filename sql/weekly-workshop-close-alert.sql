-- Rollback: unschedule soap-candles-weekly-workshop-close, remove the
-- weekly_workshop_close alert, then drop private.os_refresh_weekly_workshop_close(timestamptz).
create or replace function private.os_refresh_weekly_workshop_close(p_now timestamptz default now())
returns void
language plpgsql
set search_path = ''
as $$
declare
  madrid_now timestamp := p_now at time zone 'Europe/Madrid';
  cutoff timestamp := date_trunc('week', madrid_now);
  pending integer;
begin
  if madrid_now < cutoff + interval '9 hours' then
    cutoff := cutoff - interval '1 week';
  end if;

  select count(*) into pending
  from public.workshop_sessions
  where status = 'scheduled'
    and ends_at <= cutoff at time zone 'Europe/Madrid';

  if pending = 0 then
    update public.alerts set status = 'resolved'
    where dedupe_key = 'weekly_workshop_close' and status <> 'resolved';
    return;
  end if;

  insert into public.alerts (kind, dedupe_key, message, status)
  values ('weekly_workshop_close', 'weekly_workshop_close',
          format('Talleres pendientes de confirmar (%s)', pending), 'open')
  on conflict (dedupe_key) do update
    set message = excluded.message, status = excluded.status,
        created_at = case when alerts.status = 'open' then alerts.created_at else now() end
  where alerts.status <> 'open' or alerts.message is distinct from excluded.message;
end;
$$;

revoke all on function private.os_refresh_weekly_workshop_close(timestamptz)
from public, anon, authenticated;

-- Madrid is UTC+1 or UTC+2. The local cutoff keeps the Monday 09:00 rule
-- through both offsets. Later runs refresh the same alert and clear it when resolved.
select cron.schedule(
  'soap-candles-weekly-workshop-close',
  '0 * * * *',
  'select private.os_refresh_weekly_workshop_close()'
);
select private.os_refresh_weekly_workshop_close();
