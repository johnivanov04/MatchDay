-- MatchDay — lock down the moderation helpers.
--
-- The filter's helper functions were left with PostgreSQL's default EXECUTE
-- grant to PUBLIC, which the schema suite caught. It matters more than the
-- usual least-privilege tidy-up: `moderation_vocabulary()` returns the entire
-- blocklist, so an unauthenticated caller could read out exactly what is
-- refused and work backwards to what is not. A filter whose word list can be
-- enumerated is a filter with a published set of answers.
--
-- Nothing calls these from a session. They exist for the triggers, which run as
-- the definer and are unaffected by a revoke.

revoke execute on function public.normalize_for_moderation(text) from public, anon, authenticated;
revoke execute on function public.join_letter_runs(text) from public, anon, authenticated;
revoke execute on function public.moderation_vocabulary() from public, anon, authenticated;
revoke execute on function public.moderation_allowlist() from public, anon, authenticated;
revoke execute on function public.contains_objectionable_content(text) from public, anon, authenticated;

-- service_role keeps them, so an operator can ask why a string was refused
-- without having to reimplement the normalisation somewhere else.
grant execute on function public.normalize_for_moderation(text) to service_role;
grant execute on function public.join_letter_runs(text) to service_role;
grant execute on function public.moderation_vocabulary() to service_role;
grant execute on function public.moderation_allowlist() to service_role;
grant execute on function public.contains_objectionable_content(text) to service_role;
