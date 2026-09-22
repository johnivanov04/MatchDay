-- MatchDay — Guideline 1.2: server-side objectionable-content filtering.
--
-- ── WHY THIS IS A TRIGGER AND NOT A CHECK IN THE SERVER ACTIONS ────────────
--
-- Every table below accepts a direct PostgREST write under RLS — `profiles`,
-- `leagues`, `matches`, `guideline_versions` and the rest each carry their own
-- INSERT/UPDATE policy, and the anon/publishable key is not a secret. A filter
-- living in a Server Action would therefore be a filter anybody could skip by
-- calling the REST endpoint the browser already calls. Apple's requirement is
-- that objectionable material cannot be *posted*, not that the happy path is
-- polite, so enforcement belongs at the lowest write boundary there is.
--
-- ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
--
-- A deterministic, in-repo lexical filter. It is not a classifier and does not
-- pretend to understand intent: it normalises text to defeat the common
-- evasions and matches a fixed vocabulary. It will miss novel spellings and
-- coded language, and reporting exists because of that, not in spite of it.
-- The complement to a filter that cannot catch everything is a human path that
-- can — see `content_reports`.


-- ── NORMALISATION ──────────────────────────────────────────────────────────
--
-- Case, leetspeak, padding punctuation and stretched letters are the four
-- evasions that cost nothing to attempt, so they cost nothing to undo.
-- Stretched letters collapse *all* runs, so the vocabulary below is stored
-- already collapsed: 'sh1iiit' and 'shit' both arrive as 'shit', and innocent
-- words collapse identically ('pass' -> 'pas'), which is why matching is by
-- whole token rather than by substring wherever a short word is involved.
create or replace function public.normalize_for_moderation(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            -- Both arguments are the SAME LENGTH. `translate` silently DELETES
            -- any source character without a destination, so an uneven pair
            -- removes characters instead of folding them — a difference that
            -- does not show up until a specific glyph goes missing.
            translate(
              lower(coalesce(p_text, '')),
              '0134578@$!',
              'oieastbasi'
            ),
            '[^a-z0-9]+', ' ', 'g'      -- punctuation becomes a separator
          ),
          '(.)\1+', '\1', 'g'            -- collapse stretched letters
        ),
        '\s+', ' ', 'g'                  -- collapse whitespace
      )
    ),
    ''
  );
$$;

comment on function public.normalize_for_moderation(text) is
  'Lower-cases, folds leetspeak, strips punctuation to spaces, collapses repeated characters and whitespace. Deterministic and immutable.';


-- ── THE VOCABULARY ─────────────────────────────────────────────────────────
--
-- Two lists, because one list cannot serve both needs.
--
-- `token` terms are matched as WHOLE WORDS. Short words live here, because a
-- substring match on three letters is how a filter rejects "Arsenal",
-- "Scunthorpe", "class" and "assist" — the Scunthorpe problem is not a curio
-- for a football app, it is Tuesday.
--
-- `dense` terms are matched against the text with spaces removed, which is what
-- catches "f u c k" and "n i g..." spelled out. Only terms that essentially
-- never occur inside an innocent English word are eligible, and every one is at
-- least five characters after collapsing.
create or replace function public.moderation_vocabulary()
returns table (term text, dense boolean)
language sql
immutable
set search_path = ''
as $$
  select v.term, v.dense from (values
    -- Sexual content
    ('fuck', true), ('fuk', true), ('fucker', true), ('fucking', true),
    ('motherfucker', true), ('cunt', false), ('cock', false), ('dick', false),
    ('pusy', false), ('twat', false), ('wank', false), ('wanker', false),
    ('blowjob', true), ('handjob', true), ('creampie', true), ('cumshot', true),
    ('deepthroat', true), ('gangbang', true), ('bukake', true),
    ('porn', false), ('porno', false), ('pornhub', true), ('xvideos', true),
    ('onlyfans', true), ('hentai', true), ('milf', false), ('nsfw', false),
    ('jerkof', true), ('jizm', false), ('cumming', false),
    -- Racial, ethnic and religious slurs
    ('niger', true), ('niga', true), ('nigger', true), ('nigga', true),
    ('chink', true), ('gook', false), ('spic', false), ('wetback', true),
    ('kike', false), ('raghead', true), ('towelhead', true), ('beaner', true),
    ('coon', false), ('paki', false), ('honkey', true), ('darkie', true),
    -- Homophobic and transphobic slurs
    ('fagot', true), ('fag', false), ('dyke', false), ('tranies', true),
    ('trany', false), ('shemale', true), ('ladyboy', true),
    -- Ableist slurs
    ('retard', true), ('retarded', true), ('spastic', true), ('mongoloid', true),
    -- Violence and self-harm
    ('kys', false), ('killyourself', true), ('kilyourself', true),
    ('rape', false), ('rapist', false), ('molest', false), ('pedo', false),
    ('pedophile', true), ('paedophile', true), ('childporn', true),
    ('lynch', false), ('nazi', false), ('hitler', false), ('holocaust', false),
    -- General profanity strong enough to be objectionable on a public listing
    ('shit', false), ('shite', false), ('bullshit', true), ('bastard', false),
    ('bich', false), ('whore', false), ('slut', false), ('arsehole', true),
    ('asshole', true), ('ashole', true), ('prick', false), ('bolock', false),
    ('wtf', false), ('stfu', false)
  ) as v(term, dense);
$$;

comment on function public.moderation_vocabulary() is
  'The filter vocabulary, already normalised. `dense` terms also match with whitespace removed; the rest match whole tokens only.';


-- ── THE ALLOWLIST ──────────────────────────────────────────────────────────
--
-- Words that normalise onto, or contain, a blocked term and are entirely
-- ordinary — English place names, football clubs and everyday vocabulary. A
-- filter that rejects "Arsenal Sunday League" is worse than no filter, because
-- the person who hits it concludes the product is broken rather than that they
-- typed something wrong.
create or replace function public.moderation_allowlist()
returns table (term text)
language sql
immutable
set search_path = ''
as $$
  select a.term from (values
    ('arsenal'), ('arsene'), ('scunthorpe'), ('penistone'), ('lightwater'),
    ('clitheroe'), ('cockburn'), ('cockermouth'), ('cockfosters'), ('dickinson'),
    ('dickens'), ('hancock'), ('babcock'), ('woodcock'), ('shitterton'),
    ('sussex'), ('esex'), ('midlesex'), ('wesex'), ('sexton'),
    ('clas'), ('clasic'), ('clases'), ('asist'), ('asistant'), ('asists'),
    ('asociation'), ('asembly'), ('ases'), ('asesment'), ('aset'), ('asets'),
    ('asasin'), ('bas'), ('gras'), ('bras'), ('glas'), ('pas'), ('pases'),
    ('mas'), ('las'), ('compas'), ('canvas'), ('cutlas'), ('embasy'),
    ('analysis'), ('analyse'), ('analytics'), ('titan'), ('titans'),
    ('matsushita'), ('sixpack'), ('cumbria'), ('cumbernauld'), ('scumbag')
  ) as a(term);
$$;


-- ── THE PREDICATE ──────────────────────────────────────────────────────────
-- ── SINGLE-LETTER RUNS ─────────────────────────────────────────────────────
--
-- "f u c k" and "F.U.C.K" both normalise to four one-letter tokens. Joining
-- runs of single-letter tokens reconstructs the word *precisely*, without the
-- collateral damage of removing every space in the string — which would glue
-- "surf Uckfield" into something the filter would have to refuse.
create or replace function public.join_letter_runs(p_norm text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out text := '';
  v_run text := '';
  v_tok text;
begin
  if p_norm is null then
    return null;
  end if;

  foreach v_tok in array string_to_array(p_norm, ' ')
  loop
    if length(v_tok) = 1 then
      v_run := v_run || v_tok;
    else
      if v_run <> '' then
        v_out := v_out || ' ' || v_run;
        v_run := '';
      end if;
      v_out := v_out || ' ' || v_tok;
    end if;
  end loop;

  if v_run <> '' then
    v_out := v_out || ' ' || v_run;
  end if;

  return btrim(v_out);
end;
$$;


-- ── THE PREDICATE ──────────────────────────────────────────────────────────
--
-- Three passes, cheapest first:
--   1. whole tokens of the normalised text;
--   2. whole tokens again after joining single-letter runs, which is the
--      spaced-out evasion and nothing else;
--   3. `dense` terms as substrings of the fully despaced text, for the case
--      where somebody simply omits all spaces.
-- A trailing plural 's' is stripped before matching, so "fuckers" is "fucker".
create or replace function public.contains_objectionable_content(p_text text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_norm   text := public.normalize_for_moderation(p_text);
  v_joined text;
  v_dense  text;
  v_form   text;
  v_token  text;
begin
  if v_norm is null then
    return false;
  end if;

  v_joined := public.join_letter_runs(v_norm);

  foreach v_form in array array[v_norm, v_joined]
  loop
    foreach v_token in array string_to_array(v_form, ' ')
    loop
      if exists (select 1 from public.moderation_allowlist() a where a.term = v_token) then
        continue;
      end if;

      if exists (
        select 1 from public.moderation_vocabulary() m
        where m.term = v_token
           or (length(v_token) > 3 and m.term = regexp_replace(v_token, 's$', ''))
      ) then
        return true;
      end if;
    end loop;
  end loop;

  v_dense := replace(v_norm, ' ', '');
  if exists (select 1 from public.moderation_allowlist() a where a.term = v_dense) then
    return false;
  end if;

  return exists (
    select 1 from public.moderation_vocabulary() m
    where m.dense and position(m.term in v_dense) > 0
  );
end;
$$;

comment on function public.contains_objectionable_content(text) is
  'True when the text contains a term from the moderation vocabulary after normalisation. Deterministic; no text is logged.';


-- ── THE TRIGGER ────────────────────────────────────────────────────────────
--
-- Generic over column names so one function guards every surface. Reads the row
-- as jsonb rather than naming columns, which is what lets the same function sit
-- on fourteen tables without fourteen near-identical bodies to keep in step.
--
-- The refusal carries NO part of the submitted text. The message a user sees is
-- generic by design, and nothing here writes the rejected value to the log,
-- because a moderation log full of the exact slurs people tried is a liability
-- rather than an asset.
create or replace function public.reject_objectionable_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   jsonb := to_jsonb(new);
  v_col   text;
  v_value jsonb;
  v_item  text;
begin
  foreach v_col in array tg_argv
  loop
    v_value := v_row -> v_col;

    if v_value is null or jsonb_typeof(v_value) = 'null' then
      continue;
    end if;

    if jsonb_typeof(v_value) = 'array' then
      for v_item in select jsonb_array_elements_text(v_value)
      loop
        if public.contains_objectionable_content(v_item) then
          raise exception 'CONTENT_REJECTED: submitted text was refused by the content filter'
            using errcode = '23514';
        end if;
      end loop;
    elsif public.contains_objectionable_content(v_value #>> '{}') then
      raise exception 'CONTENT_REJECTED: submitted text was refused by the content filter'
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.reject_objectionable_content() from public;


-- ── EVERY USER-AUTHORED SURFACE ANOTHER PERSON CAN SEE ─────────────────────
--
-- Admin-only notes are included. "Only administrators see it" is not "nobody
-- sees it" — a co-administrator is another user, and an abusive note about a
-- member is exactly the kind of content this is for.

create trigger profiles_moderate_text
  before insert or update on public.profiles
  for each row execute function public.reject_objectionable_content('first_name', 'last_name');

create trigger leagues_moderate_text
  before insert or update on public.leagues
  for each row execute function public.reject_objectionable_content(
    'name', 'description', 'general_area', 'sport_label', 'typical_schedule',
    'default_location', 'public_contact', 'position_labels');

create trigger matches_moderate_text
  before insert or update on public.matches
  for each row execute function public.reject_objectionable_content(
    'title', 'location_name', 'public_notes', 'cancellation_reason');

create trigger match_templates_moderate_text
  before insert or update on public.match_templates
  for each row execute function public.reject_objectionable_content(
    'name', 'recurrence_note', 'location_name');

create trigger guideline_versions_moderate_text
  before insert or update on public.guideline_versions
  for each row execute function public.reject_objectionable_content(
    'version_label', 'title', 'body');

create trigger league_join_requests_moderate_text
  before insert or update on public.league_join_requests
  for each row execute function public.reject_objectionable_content('message', 'decision_note');

create trigger match_teams_moderate_text
  before insert or update on public.match_teams
  for each row execute function public.reject_objectionable_content('name', 'label');

create trigger match_team_publication_entries_moderate_text
  before insert or update on public.match_team_publication_entries
  for each row execute function public.reject_objectionable_content('team_name', 'team_label');

create trigger match_signups_moderate_text
  before insert or update on public.match_signups
  for each row execute function public.reject_objectionable_content(
    'cancellation_reason', 'override_reason');

create trigger attendance_records_moderate_text
  before insert or update on public.attendance_records
  for each row execute function public.reject_objectionable_content('note');

create trigger league_memberships_moderate_text
  before insert or update on public.league_memberships
  for each row execute function public.reject_objectionable_content('status_reason');

create trigger league_membership_admin_notes_moderate_text
  before insert or update on public.league_membership_admin_notes
  for each row execute function public.reject_objectionable_content('note');

create trigger match_admin_notes_moderate_text
  before insert or update on public.match_admin_notes
  for each row execute function public.reject_objectionable_content('notes');

create trigger league_invites_moderate_text
  before insert or update on public.league_invites
  for each row execute function public.reject_objectionable_content('label');


-- NO BACKFILL. Existing rows are left exactly as they are: this migration adds
-- a gate on new writes and changes nothing already stored. Nothing here sends
-- anything, enqueues anything, or writes a notification.
