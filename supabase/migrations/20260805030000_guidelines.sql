-- Matchday — Phase 3A
-- Versioned league guidelines and their acknowledgements (F-04).
--
-- Two tables with very different lifetimes. A guideline *version* is an
-- administrator-authored document that moves draft → published → archived. An
-- *acceptance* is a permanent record that one person agreed to one exact
-- version; it is written once and is never editable again, by anyone, because
-- the whole point of an acknowledgement is that it cannot be revised after the
-- fact.

create table public.guideline_versions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,

  -- Administrator-chosen identifier, e.g. '2026-spring' or 'v3'.
  version_label text not null,
  title text not null,
  body text not null,

  -- Optional pointer to a document held elsewhere. Phase 3 deliberately ships
  -- no upload infrastructure: there is no reviewed, tested storage design in
  -- this repository yet, and inventing one here would be the least-examined
  -- part of the phase.
  document_url text,

  effective_at timestamptz not null default now(),
  requires_acceptance boolean not null default true,

  published_at timestamptz,
  archived_at timestamptz,

  -- sha256 of the body, maintained by trigger. Lets an administrator prove
  -- which text a member actually accepted, even if a later version reuses the
  -- same label.
  content_checksum text not null default '',

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint guideline_versions_label_format
    check (char_length(btrim(version_label)) between 1 and 60),
  constraint guideline_versions_title_length
    check (char_length(btrim(title)) between 1 and 160),
  constraint guideline_versions_body_length
    check (char_length(btrim(body)) between 1 and 100000),
  constraint guideline_versions_document_url_scheme
    check (document_url is null
           or (document_url ~ '^https://' and char_length(document_url) <= 2048)),

  -- Archiving something never published is meaningless, and would let a draft
  -- reach a terminal state without ever having been visible.
  constraint guideline_versions_archive_requires_publish
    check (archived_at is null or published_at is not null),
  constraint guideline_versions_archive_after_publish
    check (archived_at is null or published_at is null or archived_at >= published_at)
);

-- One label per league: a version identifier has to identify a version.
create unique index guideline_versions_league_label_key
  on public.guideline_versions (league_id, lower(btrim(version_label)));

-- Composite key so acceptances can carry a tenant-checked foreign key.
alter table public.guideline_versions
  add constraint guideline_versions_id_league_key unique (id, league_id);

-- "What must members of this league accept right now?" — the hot path for the
-- signup-eligibility predicate Phase 4 will call on every signup attempt.
create index guideline_versions_current_idx
  on public.guideline_versions (league_id, effective_at desc, published_at desc)
  where published_at is not null and archived_at is null;

create index guideline_versions_league_created_idx
  on public.guideline_versions (league_id, created_at desc);

-- Keeps the checksum honest regardless of which code path wrote the row, and
-- prevents a client from supplying a checksum that does not match the text.
create or replace function public.guideline_versions_set_checksum()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.content_checksum := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end;
$$;

create trigger guideline_versions_set_checksum
  before insert or update of body on public.guideline_versions
  for each row execute function public.guideline_versions_set_checksum();

create trigger guideline_versions_set_updated_at
  before update on public.guideline_versions
  for each row execute function public.set_updated_at();

-- Published text is the thing members agreed to. Editing it afterwards would
-- silently change what every existing acceptance means, so the body, label and
-- acceptance requirement freeze at publication. Corrections are made by
-- publishing a new version — which is the entire reason versions exist.
create or replace function public.guideline_versions_guard_published_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is null then
    return new;
  end if;

  if new.body is distinct from old.body
     or new.version_label is distinct from old.version_label
     or new.requires_acceptance is distinct from old.requires_acceptance
     or new.effective_at is distinct from old.effective_at
     or new.league_id is distinct from old.league_id
  then
    raise exception
      'GUIDELINE_PUBLISHED_IMMUTABLE: publish a new version instead of editing a published one'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger guideline_versions_guard_published_edit
  before update on public.guideline_versions
  for each row execute function public.guideline_versions_guard_published_edit();

comment on table public.guideline_versions is
  'League-scoped guideline documents. Draft → published → archived. Published '
  'text is frozen; corrections are new versions. Never hard-deleted.';


-- ── Acknowledgements ───────────────────────────────────────────────────────
-- Written only by public.accept_guideline_version(), which requires the caller
-- to own the membership. There is no UPDATE or DELETE path for anyone.

create table public.guideline_acceptances (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  guideline_version_id uuid not null,
  membership_id uuid not null,

  accepted_at timestamptz not null default now(),

  constraint guideline_acceptances_version_fk
    foreign key (guideline_version_id, league_id)
    references public.guideline_versions (id, league_id) on delete cascade,

  constraint guideline_acceptances_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id) on delete cascade
);

-- One acceptance per person per version. Re-accepting is a no-op, not a second
-- row, which is what makes the operation idempotent.
create unique index guideline_acceptances_membership_version_key
  on public.guideline_acceptances (membership_id, guideline_version_id);

create index guideline_acceptances_version_idx
  on public.guideline_acceptances (guideline_version_id);

create index guideline_acceptances_league_idx
  on public.guideline_acceptances (league_id, accepted_at desc);

-- Immutable in the strongest available sense: a trigger, so the rule binds the
-- service role and any future migration too, not merely API callers.
create or replace function public.guideline_acceptances_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'GUIDELINE_ACCEPTANCE_IMMUTABLE: an acknowledgement cannot be changed or withdrawn'
    using errcode = '42501';
end;
$$;

-- UPDATE and DELETE only. Deleting a league still cascades, which is a
-- deliberate exception: the tenant is gone, so its history goes with it.
create trigger guideline_acceptances_immutable
  before update on public.guideline_acceptances
  for each row execute function public.guideline_acceptances_block_mutation();

comment on table public.guideline_acceptances is
  'Immutable record that one membership accepted one exact guideline version. '
  'Written only through public.accept_guideline_version().';
