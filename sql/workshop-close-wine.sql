-- The original finalization RPC remains available for older clients.
create or replace function public.os_record_workshop_close(
  p_session_id uuid,
  p_attendees integer,
  p_recipe_kind text,
  p_bottles integer,
  p_expected_bottles integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workshop public.workshop_sessions%rowtype;
  previous_usage public.os_session_wine_usage%rowtype;
  saved_usage public.os_session_wine_usage%rowtype;
begin
  perform private.os_inventory_check_admin();

  select * into workshop from public.workshop_sessions where id = p_session_id for update;
  if not found or workshop.status not in ('scheduled', 'completed') or workshop.ends_at > now() then
    raise exception 'Solo se pueden registrar cierres de talleres que ya han terminado.';
  end if;
  if workshop.status = 'completed' and (p_attendees is not null or p_recipe_kind is not null) then
    raise exception 'Este taller ya está cerrado. Actualiza la ficha antes de continuar.';
  end if;
  if p_bottles is not null then
    if p_bottles < 0 or p_bottles > 200 then
      raise exception 'Indica entre 0 y 200 botellas.';
    end if;
    select * into previous_usage from public.os_session_wine_usage where session_id = p_session_id for update;
    if previous_usage.bottles is distinct from p_bottles then
      if previous_usage.bottles is distinct from p_expected_bottles then
        raise exception 'El consumo ha cambiado. Vuelve a abrir la ficha antes de guardarlo.';
      end if;
      insert into public.os_session_wine_usage (session_id, bottles, source)
      values (p_session_id, p_bottles, 'manual')
      on conflict (session_id) do update
        set bottles = excluded.bottles, source = excluded.source, updated_at = now()
        where os_session_wine_usage.bottles is not distinct from p_expected_bottles
      returning * into saved_usage;
      if not found then
        raise exception 'El consumo ha cambiado. Vuelve a abrir la ficha antes de guardarlo.';
      end if;
      insert into public.audit_log (table_name, record_id, operation, actor_id, old_data, new_data)
      values ('os_session_wine_usage', p_session_id::text,
              case when previous_usage.session_id is null then 'INSERT' else 'UPDATE' end,
              auth.uid(), case when previous_usage.session_id is not null then to_jsonb(previous_usage) end,
              to_jsonb(saved_usage));
    end if;
  end if;

  if workshop.status = 'scheduled' then
    perform public.os_inventory_finalize_workshop(p_session_id, p_attendees, p_recipe_kind);
  end if;
end;
$$;

revoke all on function public.os_record_workshop_close(uuid, integer, text, integer, integer) from public, anon;
grant execute on function public.os_record_workshop_close(uuid, integer, text, integer, integer) to authenticated;
