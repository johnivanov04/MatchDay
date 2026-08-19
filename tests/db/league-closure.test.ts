import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Closing a league.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Only so that an administrator can delete their account. Every league has
 * exactly one active administrator, and `transfer_league_administration`
 * requires an active player to hand over to — so an administrator whose league
 * has no other member was being told to do something they could not do. Apple
 * requires an in-app path to account deletion, and a screen whose only
 * instruction is impossible is not one.
 *
 * The invariant is narrowed in exactly one direction and nowhere else: an open
 * league still demands exactly one administrator, and two remain impossible for
 * open and closed leagues alike.
 */

const LEAGUE = SEED_LEAGUES.weeknightFives;
const ADMIN = SEED_USERS.fivesAdmin;
const MATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000011';
const INVITE_TOKEN = 'matchday-closed-league-invite-000000001';

describe('closing a league', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query('update public.matches set capacity = 6, min_players = 1 where id = $1', [
      MATCH,
    ]);
    members = await createExtraMembers(db, LEAGUE, 3);

    // Created through the RPC so the token is hashed the way the product hashes
    // it — `pgcrypto` is not installed in the test template, so a hand-rolled
    // `digest()` insert is not available here.
    await callAs(ADMIN, 'select public.create_league_invite($1, $2)', [LEAGUE, INVITE_TOKEN]);
  });

  afterEach(async () => {
    await db.drop();
  });

  async function callAs<T extends Record<string, unknown>>(
    user: SeedUser,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  const close = async (user: SeedUser = ADMIN, leagueId: string = LEAGUE) =>
    callAs(user, 'select public.close_league($1)', [leagueId]);

  async function closedAt(leagueId: string = LEAGUE): Promise<string | null> {
    const { rows } = await db.pool.query<{ closed_at: string | null }>(
      'select closed_at::text from public.leagues where id = $1',
      [leagueId],
    );
    return rows[0]!.closed_at;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]!.n);
  }

  // ══ Authorization ════════════════════════════════════════════════════════

  describe('who may close a league', () => {
    it('lets the administrator close their own', async () => {
      await close();
      expect(await closedAt()).not.toBeNull();
    });

    it('refuses a player', async () => {
      const error = await expectDatabaseError(() => close(members[0]!.user));
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      expect(await closedAt()).toBeNull();
    });

    it('refuses the administrator of a different league', async () => {
      const error = await expectDatabaseError(() => close(SEED_USERS.rmvfcAdmin));
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('answers a league that does not exist exactly as one you do not run', async () => {
      const missing = await expectDatabaseError(() =>
        close(ADMIN, '00000000-0000-4000-8000-000000000000'),
      );
      const foreign = await expectDatabaseError(() => close(ADMIN, SEED_LEAGUES.rmvfc));
      expect(missing.message).toBe(foreign.message);
    });

    it('refuses an anonymous caller at the grant', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select public.close_league($1)', [LEAGUE])),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('is idempotent', async () => {
      await close();
      const first = await closedAt();

      await close();

      // Same league, same state, same timestamp — a retry from the deletion
      // flow must not look like a second closure.
      expect(await closedAt()).toBe(first);
    });
  });

  // ══ The cardinality invariant ════════════════════════════════════════════

  describe('the single-administrator invariant', () => {
    it('still requires exactly one for an open league', async () => {
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, ADMIN, (client) =>
          client.query(
            `update public.league_memberships set status = 'suspended' where id = $1`,
            [SEED_MEMBERSHIPS.fivesAdmin],
          ),
        ),
      );
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    });

    it('permits zero once the league is closed', async () => {
      await close();

      await asUserCommitting(db, ADMIN, (client) =>
        client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          SEED_MEMBERSHIPS.fivesAdmin,
        ]),
      );

      expect(
        await count(
          `select count(*)::text as n from public.league_memberships
            where league_id = $1 and role = 'league_admin' and status = 'active'`,
          [LEAGUE],
        ),
      ).toBe(0);
    });

    it('still refuses a second administrator in an open league', async () => {
      // The half of the invariant this feature does not touch:
      // `league_memberships_single_active_admin_key` is a partial unique index
      // and remains the reason two is impossible.
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.league_memberships set role = 'league_admin' where id = $1`,
          [members[0]!.membershipId],
        ),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('still refuses a second administrator in a closed league', async () => {
      await close();

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.league_memberships set role = 'league_admin' where id = $1`,
          [members[0]!.membershipId],
        ),
      );
      // Refused earlier here, by the closed-league guard rather than by the
      // index — nobody is promoted in a league that has ended. Two remains
      // impossible either way, which is what matters.
      expect(error.message).toContain('LEAGUE_CLOSED');
    });

    it('does not relax any other league', async () => {
      await close();

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.league_memberships set status = 'removed' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcAdmin],
        ),
      );
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    });
  });

  // ══ Matches ══════════════════════════════════════════════════════════════

  describe('what happens to the matches', () => {
    it('cancels a future match through the canonical primitive', async () => {
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);

      await close();

      const { rows } = await db.pool.query<{ status: string; reason: string | null }>(
        'select status::text, cancellation_reason as reason from public.matches where id = $1',
        [MATCH],
      );
      expect(rows[0]!.status).toBe('canceled');
      expect(rows[0]!.reason).toBe('The league has been closed.');
    });

    it('tells the players their match is off', async () => {
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);

      await close();

      // `cancel_match`'s own fanout, not something this feature re-implements.
      expect(
        await count(
          `select count(*)::text as n from public.notifications
            where type = 'match_canceled' and recipient_user_id = $1`,
          [members[0]!.user.id],
        ),
      ).toBe(1);
    });

    it('leaves a completed match exactly as it was', async () => {
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);
      await db.pool.query(
        `update public.matches
            set match_date = (now() - interval '2 days')::date,
                arrival_at = now() - interval '2 days',
                kickoff_at = now() - interval '2 days' + interval '30 minutes',
                end_at = now() - interval '2 days' + interval '2 hours',
                signup_closes_at = now() - interval '2 days',
                cancellation_cutoff_at = now() - interval '3 days',
                status = 'completed', completed_at = now()
          where id = $1`,
        [MATCH],
      );

      await close();

      const { rows } = await db.pool.query<{ status: string }>(
        'select status::text from public.matches where id = $1',
        [MATCH],
      );
      expect(rows[0]!.status).toBe('completed');
      // And the roster it was played with.
      expect(
        await count('select count(*)::text as n from public.match_signups where match_id = $1', [
          MATCH,
        ]),
      ).toBe(1);
    });

    it('deletes no league, match or history', async () => {
      await close();

      expect(await count('select count(*)::text as n from public.leagues where id = $1', [LEAGUE])).toBe(1);
      expect(
        await count('select count(*)::text as n from public.matches where league_id = $1', [LEAGUE]),
      ).toBeGreaterThan(0);
    });
  });

  // ══ The notification ═════════════════════════════════════════════════════

  describe('the league_closed notification', () => {
    it('reaches every other active member exactly once', async () => {
      await close();

      const { rows } = await db.pool.query<{ recipient_user_id: string; n: string }>(
        `select recipient_user_id, count(*)::text as n from public.notifications
          where type = 'league_closed' group by recipient_user_id`,
      );
      for (const row of rows) {
        expect(row.n).toBe('1');
      }
      const recipients = rows.map((row) => row.recipient_user_id);
      for (const member of members) {
        expect(recipients).toContain(member.user.id);
      }
    });

    it('does not tell the administrator who closed it', async () => {
      await close();
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where type = 'league_closed' and recipient_user_id = $1`,
        [ADMIN.id],
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('names the league and lands somewhere safe', async () => {
      await close();
      const { rows } = await db.pool.query<{ title: string; body: string; deep_link: string }>(
        `select title, body, deep_link from public.notifications
          where type = 'league_closed' limit 1`,
      );
      expect(rows[0]!.title).toBe('League closed');
      expect(rows[0]!.body).toBe('Weeknight 5v5 has been closed.');
      expect(rows[0]!.deep_link).toBe('/dashboard');
    });

    it('carries no delivery metadata, so nothing marks it push-eligible', async () => {
      await close();
      const { rows } = await db.pool.query<{ delivery_metadata: Record<string, unknown> }>(
        `select delivery_metadata from public.notifications where type = 'league_closed' limit 1`,
      );
      expect(rows[0]!.delivery_metadata).toEqual({});
    });

    it('is not duplicated by a second closure', async () => {
      await close();
      await close();

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications where type = 'league_closed'`,
      );
      expect(Number(rows[0]!.n)).toBe(members.length + 1); // extras + the seeded multi-league player
    });
  });

  // ══ Nothing new happens in a closed league ═══════════════════════════════

  describe('a closed league', () => {
    beforeEach(async () => {
      await close();
    });

    it('disappears from discovery', async () => {
      await db.pool.query(
        `update public.leagues set visibility = 'searchable' where id = $1`,
        [LEAGUE],
      );

      expect(
        await count('select count(*)::text as n from public.searchable_leagues_public where id = $1', [
          LEAGUE,
        ]),
      ).toBe(0);
    });

    it('refuses a join request', async () => {
      await db.pool.query(
        `update public.leagues set visibility = 'searchable' where id = $1`,
        [LEAGUE],
      );

      // `rmvfcPlayer`, not `outsider` — the seed already gives the outsider a
      // pending request to this league, and `request_to_join_league` returns
      // the existing one rather than inserting, so nothing would reach the
      // guard and the test would pass without testing anything.
      const error = await expectDatabaseError(() =>
        callAs(SEED_USERS.rmvfcPlayer, 'select public.request_to_join_league($1)', [LEAGUE]),
      );
      expect(error.message).toMatch(/LEAGUE_NOT_FOUND|LEAGUE_CLOSED/);
    });

    it('refuses an invitation redemption', async () => {
      // The invite is live and valid — created before the closure, exactly as a
      // real one would have been. What refuses it is the league's state, not
      // the token's.
      const error = await expectDatabaseError(() =>
        callAs(SEED_USERS.outsider, 'select public.redeem_league_invite($1)', [INVITE_TOKEN]),
      );
      expect(error.message).toMatch(/LEAGUE_CLOSED|INVITE_INVALID/);
    });

    it('refuses a new match', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.matches
             (league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
              location_name, capacity, min_players, selection_mode, waitlist_mode,
              signup_closes_at, cancellation_cutoff_at, status, created_by)
           select $1, 'After the end', (now() + interval '7 days')::date, l.timezone,
                  now() + interval '7 days', now() + interval '7 days',
                  now() + interval '7 days' + interval '90 minutes',
                  'Pitch', 10, 4, 'first_come', 'automatic',
                  now() + interval '7 days', now() + interval '6 days', 'draft', $2
             from public.leagues l where l.id = $1`,
          [LEAGUE, ADMIN.id],
        ),
      );
      expect(error.message).toContain('LEAGUE_CLOSED');
    });

    it('refuses an administration transfer', async () => {
      const error = await expectDatabaseError(() =>
        callAs(ADMIN, 'select public.transfer_league_administration($1, $2)', [
          LEAGUE,
          members[0]!.membershipId,
        ]),
      );
      expect(error.message).toContain('LEAGUE_CLOSED');
    });

    it('keeps its members and their history', async () => {
      expect(
        await count(
          `select count(*)::text as n from public.league_memberships
            where league_id = $1 and status = 'active'`,
          [LEAGUE],
        ),
      ).toBeGreaterThan(0);
    });

    it('still permits a member to leave', async () => {
      // `removed` is the one direction a closed league accepts, and it has to:
      // it is how both leaving and account deletion finish.
      await callAs(members[0]!.user, 'select public.leave_league($1)', [LEAGUE]);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status::text from public.league_memberships where id = $1',
        [members[0]!.membershipId],
      );
      expect(rows[0]!.status).toBe('removed');
    });

    it('no longer blocks its administrator from deleting their account', async () => {
      const blockers = await callAs(ADMIN, 'select * from public.my_account_deletion_blockers()');
      expect(blockers).toHaveLength(0);

      await callAs(ADMIN, 'select public.begin_my_account_deletion()');
      await callAs(ADMIN, 'select public.finalize_my_account_deletion()');

      const { rows } = await db.pool.query<{ first_name: string; status: string }>(
        `select p.first_name, m.status::text
           from public.profiles p
           join public.league_memberships m on m.user_id = p.id and m.league_id = $2
          where p.id = $1`,
        [ADMIN.id, LEAGUE],
      );
      expect(rows[0]!.first_name).toBe('Former');
      expect(rows[0]!.status).toBe('removed');
    });
  });
});
