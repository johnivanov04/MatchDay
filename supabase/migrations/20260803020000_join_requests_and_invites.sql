-- Matchday — Phase 2
-- Join requests and revocable invitation links.
--
-- Both tables are tenant-owned (`league_id NOT NULL`), and neither is writable
-- by `authenticated`. Every mutation runs through a SECURITY DEFINER function
-- in 20260803020200_league_management_functions.sql, because each one has to
-- check something the caller is not allowed to read directly — whether a league
-- is searchable, whether an invite token matches, whether a membership already
-- exists.

create type public.join_request_status as enum (
  'pending',
  'approved',
  'rejected',
  'withdrawn'
);

-- ── league_join_requests ───────────────────────────────────────────────────

create table public.league_join_requests (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  status public.join_request_status not null default 'pending',
  message text,

  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint league_join_requests_message_length
    check (message is null or char_length(btrim(message)) between 1 and 500),
  constraint league_join_requests_decision_note_length
    check (decision_note is null or char_length(btrim(decision_note)) between 1 and 500),

  -- A decision must carry its timestamp, and a pending request must not look
  -- as though one has already been made.
  constraint league_join_requests_decision_consistency check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status <> 'pending' and decided_at is not null)
  )
);

-- At most one live request per person per league (F-03: "Duplicate pending join
-- requests are prevented"). Partial, so the full history of earlier rejected or
-- withdrawn requests is retained rather than overwritten.
create unique index league_join_requests_one_pending_key
  on public.league_join_requests (league_id, user_id)
  where status = 'pending'::public.join_request_status;

-- Administrator's queue for a league.
create index league_join_requests_league_status_idx
  on public.league_join_requests (league_id, status, created_at desc);

-- "What have I asked to join?"
create index league_join_requests_user_idx
  on public.league_join_requests (user_id, created_at desc);

create trigger league_join_requests_set_updated_at
  before update on public.league_join_requests
  for each row execute function public.set_updated_at();

comment on table public.league_join_requests is
  'Requests to join a searchable league. Written only through '
  'public.request_to_join_league(), public.decide_join_request() and '
  'public.withdraw_join_request(); `authenticated` holds no write privilege.';


-- ── league_invites ─────────────────────────────────────────────────────────
--
-- The raw token is NEVER stored. Only its SHA-256 digest lives here, so a dump
-- of this table yields nothing an attacker can redeem. The token is returned to
-- the creating administrator exactly once, at creation.

create table public.league_invites (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,

  -- sha256(token). 32 bytes, unique so a digest collision cannot alias two
  -- invites, and indexed because redemption looks up by digest.
  token_hash bytea not null,

  label text,

  -- Whether redeeming this link joins immediately or lands in the approval
  -- queue (F-03: "joins or requests membership according to the invite
  -- configuration").
  grants_status public.membership_status not null default 'active',

  -- NULL means unlimited uses.
  max_uses integer,
  use_count integer not null default 0,

  expires_at timestamptz not null default (now() + interval '14 days'),
  revoked_at timestamptz,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint league_invites_token_hash_length
    check (octet_length(token_hash) = 32),
  constraint league_invites_label_length
    check (label is null or char_length(btrim(label)) between 1 and 120),

  -- An invite may only hand out a membership someone can actually use.
  constraint league_invites_grants_status_allowed
    check (grants_status in ('active'::public.membership_status,
                             'pending'::public.membership_status)),

  constraint league_invites_use_count_non_negative check (use_count >= 0),
  constraint league_invites_max_uses_positive check (max_uses is null or max_uses > 0),
  constraint league_invites_within_use_limit
    check (max_uses is null or use_count <= max_uses),

  -- Every invite expires. There is no "never expires" option by design.
  constraint league_invites_expiry_after_creation check (expires_at > created_at)
);

create unique index league_invites_token_hash_key
  on public.league_invites (token_hash);

create index league_invites_league_idx
  on public.league_invites (league_id, created_at desc);

create trigger league_invites_set_updated_at
  before update on public.league_invites
  for each row execute function public.set_updated_at();

comment on table public.league_invites is
  'Revocable, expiring invitation links. Stores only sha256(token); the raw '
  'token is shown to the creating administrator once and is unrecoverable '
  'afterwards. `authenticated` cannot read token_hash (column-level grant).';
comment on column public.league_invites.token_hash is
  'SHA-256 digest of the invite token. Never grant SELECT on this column.';
