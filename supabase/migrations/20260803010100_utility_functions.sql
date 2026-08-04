-- Matchday — Phase 1
-- Small, reusable helpers used by table constraints and triggers.
--
-- Every function pins `search_path = ''` so that a caller cannot shadow a
-- referenced object by putting a malicious schema earlier on their own path.
-- That means every reference below is schema-qualified.

-- Maintains an `updated_at` column. Attached per table.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Validates every element of a text[] without a subquery, so it can be used
-- directly inside a CHECK constraint. NULL/empty arrays are valid; callers add
-- their own NOT NULL / length rules.
create or replace function public.text_array_entries_are_valid(
  p_values text[],
  p_min_length integer,
  p_max_length integer
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    bool_and(char_length(btrim(entry)) between p_min_length and p_max_length),
    true
  )
  from unnest(coalesce(p_values, '{}'::text[])) as entry;
$$;

-- IANA timezone validation. `pg_timezone_names` cannot be referenced from a
-- CHECK constraint (it is not immutable), so leagues validate through a trigger
-- instead. This is still a database-level rule: it cannot be bypassed by any
-- client, server action or direct SQL.
create or replace function public.leagues_validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names tz
    where tz.name = new.timezone
  ) then
    raise exception 'INVALID_TIMEZONE: % is not a recognised IANA timezone', new.timezone
      using errcode = '23514';
  end if;

  return new;
end;
$$;
