import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_TEMPLATES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * `create_and_publish_match()` — creating a match and opening it in one step.
 *
 * ── WHAT THIS FUNCTION IS ALLOWED TO BE ────────────────────────────────────
 *
 * A wrapper, and nothing else. It calls `create_match()` and then
 * `publish_match()`, both of which are covered in their own right by
 * `matches.test.ts` and `notifications.test.ts`. So the assertions here are not
 * "does publishing work" — they are "is this indistinguishable from having
 * pressed Create and then Publish, and does it hold together when the second
 * half fails".
 *
 * The last property is the reason the function exists at all rather than the
 * application making two RPC calls in a row. Two calls leave a draft behind
 * when the second one fails; one transaction does not.
 */

/** The arguments both paths take, so the two can be compared like for like. */
const ARGS = `$1,'Wrapper match','2026-09-14','18:30','19:00','20:30','Pitch 3',22,14,
              'first_come','automatic'`;

describe('create_and_publish_match', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function createAndPublish(
    actor: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    league: string = SEED_LEAGUES.rmvfc,
  ): Promise<string> {
    return asUserCommitting(db, actor, async (client) => {
      const result = await client.query<{ id: string }>(
        `select public.create_and_publish_match(${ARGS}) as id`,
        [league],
      );
      return result.rows[0]?.id ?? '';
    });
  }

  describe('authorization', () => {
    it('lets the league administrator create and publish', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);
      expect(matchId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses an ordinary player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(`select public.create_and_publish_match(${ARGS})`, [SEED_LEAGUES.rmvfc]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses the administrator of a different league', async () => {
      // The authorization that fires is `create_match`'s, one call earlier than
      // `publish_match`'s — which is the point: the wrapper adds no checks of
      // its own and needs none, because both callees still run theirs.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query(`select public.create_and_publish_match(${ARGS})`, [SEED_LEAGUES.rmvfc]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');

      const { rows } = await db.pool.query(
        `select id from public.matches where title = 'Wrapper match'`,
      );
      expect(rows).toEqual([]);
    });

    it('refuses an unauthenticated visitor', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query(`select public.create_and_publish_match(${ARGS})`, [SEED_LEAGUES.rmvfc]),
        ),
      );
      // `create_match` raises AUTH_REQUIRED before it reaches the admin check.
      expect(error.message).toMatch(/AUTH_REQUIRED|permission denied/);
    });
  });

  describe('the row it produces', () => {
    it('is open, published, and returns its own id', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);

      const { rows } = await db.pool.query<{
        id: string;
        status: string;
        published_at: Date | null;
        title: string;
        capacity: number;
      }>('select id, status, published_at, title, capacity from public.matches where id = $1', [
        matchId,
      ]);

      expect(rows[0]?.id).toBe(matchId);
      expect(rows[0]?.status).toBe('open');
      expect(rows[0]?.published_at).not.toBeNull();
      // The inputs are passed straight through, not reinterpreted.
      expect(rows[0]?.title).toBe('Wrapper match');
      expect(rows[0]?.capacity).toBe(22);
    });

    it('resolves the priority window from publication, capped at the signup deadline', async () => {
      const matchId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_and_publish_match(
             $1,'Priority window','2026-09-14','18:30','19:00','20:30','Pitch 3',22,14,
             'first_come','automatic',2,null,null,
             interval '3 hours',      -- priority window
             interval '2 hours'       -- signup closes before kickoff
           ) as id`,
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows[0]?.id ?? '';
      });

      const { rows } = await db.pool.query<{
        published_at: Date;
        priority_window_ends_at: Date;
        signup_closes_at: Date;
        within: boolean;
      }>(
        `select published_at, priority_window_ends_at, signup_closes_at,
                priority_window_ends_at = least(published_at + priority_window, signup_closes_at)
                  as within
           from public.matches where id = $1`,
        [matchId],
      );

      // The whole reason publication cannot be a plain UPDATE: this value only
      // exists once there is a `published_at` to measure from.
      expect(rows[0]?.priority_window_ends_at).not.toBeNull();
      expect(rows[0]?.within).toBe(true);
      // A match published today with a 3-hour window and a deadline months out
      // ends its window three hours from now, not at the deadline.
      expect(rows[0]!.priority_window_ends_at.getTime()).toBeLessThan(
        rows[0]!.signup_closes_at.getTime(),
      );
    });

    it('leaves no priority window when the match has none', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);
      const { rows } = await db.pool.query<{ priority_window_ends_at: Date | null }>(
        'select priority_window_ends_at from public.matches where id = $1',
        [matchId],
      );
      expect(rows[0]?.priority_window_ends_at).toBeNull();
    });
  });

  describe('it is indistinguishable from create-then-publish', () => {
    it('writes the same two audit events, in the same order', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);

      const { rows } = await db.pool.query<{ action: string }>(
        `select action from public.audit_events
          where entity_id = $1 order by created_at, action`,
        [matchId],
      );

      expect(rows.map((row) => row.action)).toEqual(['match.created', 'match.published']);
    });

    it('fans out exactly one notification per active member, excluding the actor', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);

      const { rows } = await db.pool.query<{ recipient_user_id: string; type: string }>(
        `select recipient_user_id, type from public.notifications where match_id = $1`,
        [matchId],
      );

      expect(rows.every((row) => row.type === 'match_published')).toBe(true);

      // The same set `publish_match` would produce: every *active* member of
      // the league except the administrator who acted.
      const { rows: expected } = await db.pool.query<{ user_id: string }>(
        `select user_id from public.league_memberships
          where league_id = $1 and status = 'active' and user_id <> $2`,
        [SEED_LEAGUES.rmvfc, SEED_USERS.rmvfcAdmin.id],
      );

      expect(new Set(rows.map((row) => row.recipient_user_id))).toEqual(
        new Set(expected.map((row) => row.user_id)),
      );
      expect(rows).toHaveLength(expected.length);
    });

    it('uses the same idempotency key shape, so a republish adds nothing', async () => {
      const matchId = await createAndPublish(SEED_USERS.rmvfcAdmin);

      const before = await db.pool.query('select id from public.notifications where match_id = $1', [
        matchId,
      ]);

      // Publishing an already-open match returns unchanged and notifies nobody.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [matchId]),
      );

      const after = await db.pool.query('select id from public.notifications where match_id = $1', [
        matchId,
      ]);
      expect(after.rowCount).toBe(before.rowCount);
    });
  });

  describe('validation and atomicity', () => {
    it('creates nothing when the input is invalid', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.create_and_publish_match(
               $1,'Too small','2026-09-14','18:30','19:00','20:30','Pitch 3',1,0,
               'first_come','automatic')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      // The table's own CHECK, reached through the wrapper exactly as it is
      // through `create_match`.
      expect(error.message).toBeTruthy();

      const { rows } = await db.pool.query(
        `select id from public.matches where title = 'Too small'`,
      );
      expect(rows).toEqual([]);
    });

    it('refuses a template belonging to another league, and creates nothing', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.create_and_publish_match(
               $1,'Foreign template','2026-09-14','18:30','19:00','20:30','P',22,14,
               'first_come','automatic',2,$2)`,
            [SEED_LEAGUES.rmvfc, SEED_TEMPLATES.fivesThursday],
          ),
        ),
      );
      expect(error.message).toContain('MATCH_TEMPLATE_NOT_FOUND');

      const { rows } = await db.pool.query(
        `select id from public.matches where title = 'Foreign template'`,
      );
      expect(rows).toEqual([]);
    });

    /**
     * The property the whole function exists for.
     *
     * Publication is forced to fail *after* the row has been inserted, which is
     * the case two sequential RPC calls cannot survive: they would leave a
     * draft nobody asked for, invisible to its league, for somebody to find
     * later and wonder about. One transaction takes the INSERT down with it.
     */
    it('rolls the creation back when publication fails', async () => {
      await db.pool.query(`
        create function public.break_publication() returns trigger
        language plpgsql as $fn$
        begin
          if new.status = 'open' and old.status = 'draft' then
            raise exception 'FORCED_PUBLISH_FAILURE: injected by the test suite';
          end if;
          return new;
        end;
        $fn$;

        create trigger break_publication_trg
          before update on public.matches
          for each row execute function public.break_publication();
      `);

      const before = await db.pool.query('select count(*)::int as n from public.matches');

      const error = await expectDatabaseError(() =>
        asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.create_and_publish_match(${ARGS})`, [SEED_LEAGUES.rmvfc]),
        ),
      );
      expect(error.message).toContain('FORCED_PUBLISH_FAILURE');

      // No orphan draft, and nothing else left behind either.
      const after = await db.pool.query('select count(*)::int as n from public.matches');
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

      const orphans = await db.pool.query(
        `select id from public.matches where title = 'Wrapper match'`,
      );
      expect(orphans.rows).toEqual([]);

      // And no half-written audit trail or notifications for a match that does
      // not exist.
      const audit = await db.pool.query(
        `select a.id from public.audit_events a
          where a.action in ('match.created', 'match.published')
            and a.created_at > now() - interval '1 minute'`,
      );
      expect(audit.rows).toEqual([]);

      const notifications = await db.pool.query(
        `select id from public.notifications where type = 'match_published'
           and created_at > now() - interval '1 minute'`,
      );
      expect(notifications.rows).toEqual([]);

      await db.pool.query(`
        drop trigger break_publication_trg on public.matches;
        drop function public.break_publication();
      `);
    });
  });

  describe('execution privileges', () => {
    it('is SECURITY DEFINER with an empty search_path, like every other domain function', async () => {
      const { rows } = await db.pool.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `select p.prosecdef, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_and_publish_match'`,
      );

      expect(rows[0]?.prosecdef).toBe(true);
      expect(rows[0]?.proconfig).toContain('search_path=""');
    });

    it('grants EXECUTE to authenticated and service_role, and to nobody else', async () => {
      const { rows } = await db.pool.query<{ acl: string[] | null }>(
        `select p.proacl::text[] as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_and_publish_match'`,
      );

      const acl = rows[0]?.acl ?? [];
      // A null ACL would mean "PostgreSQL default", which for a function is
      // PUBLIC EXECUTE — the hole 20260805030900 closed for everything else.
      expect(acl.length).toBeGreaterThan(0);
      expect(acl.some((entry) => entry.startsWith('='))).toBe(false);
      expect(acl.some((entry) => entry.startsWith('authenticated='))).toBe(true);
      expect(acl.some((entry) => entry.startsWith('service_role='))).toBe(true);
    });
  });
});
