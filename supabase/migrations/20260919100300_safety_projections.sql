-- MatchDay — Guideline 1.2: the two reads the safety UI needs.
--
-- Neither existing projection can serve them. `match_confirmed_roster` returns
-- a membership id and deliberately not a user id — a roster has never needed
-- one, and adding a column to a `returns table` signature means dropping and
-- recreating a function every screen depends on. So blocking gets its own
-- narrow seam instead, which is also the one that has to answer "have I already
-- blocked this person?".

-- ── WHO IS ON THIS ROSTER, AND HAVE I BLOCKED THEM ────────────────────────
--
-- Returns user ids, so it is deliberately narrow: active members of the
-- league only, for a published match, and never the caller's own row. Somebody
-- who cannot see the roster gets nothing, and the answer for a match that does
-- not exist is identical to the answer for one in a league you are not in.
create or replace function public.match_roster_safety(p_match_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  is_blocked boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id,
         m.user_id,
         exists (
           select 1 from public.user_blocks b
           where b.blocker_user_id = auth.uid()
             and b.blocked_user_id = m.user_id
         )
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  join public.matches mt on mt.id = s.match_id
  join public.profiles p on p.id = m.user_id
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status)
    and public.is_active_member(mt.league_id)
    and mt.published_at is not null
    and m.user_id <> auth.uid()
    and p.deletion_started_at is null
    and p.deleted_at is null;
$$;

revoke execute on function public.match_roster_safety(uuid) from public, anon;
grant execute on function public.match_roster_safety(uuid) to authenticated;


-- ── MY BLOCK LIST ──────────────────────────────────────────────────────────
--
-- Names are included because a list of UUIDs is not a list a person can act on,
-- and these are people the caller has already chosen to block — they saw the
-- name when they blocked it. A departing account still shows as "Former member"
-- rather than disappearing, so unblocking remains possible and the list does
-- not silently shrink.
create or replace function public.my_blocked_members()
returns table (
  user_id uuid,
  first_name text,
  last_name text,
  blocked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.blocked_user_id,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.first_name else 'Former' end,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.last_name else 'member' end,
         b.created_at
  from public.user_blocks b
  join public.profiles p on p.id = b.blocked_user_id
  where b.blocker_user_id = auth.uid()
  order by b.created_at desc;
$$;

revoke execute on function public.my_blocked_members() from public, anon;
grant execute on function public.my_blocked_members() to authenticated;
