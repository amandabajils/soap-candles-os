grant select on public.os_session_wine_usage to authenticated;
create policy os_session_wine_usage_admin_read on public.os_session_wine_usage for select to authenticated using ((select private.is_admin()));
