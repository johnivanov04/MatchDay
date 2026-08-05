import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Audit coverage.
 *
 * The events are written by triggers rather than by the server actions, so that
 * a change arriving straight from PostgREST — bypassing all application code —
 * is recorded just the same. These tests therefore make their changes through
 * plain SQL, which is precisely the path that would otherwise go unaudited.
 */
describe('audit triggers', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function eventsFor(leagueId: string, action?: string) {
    const { rows } = await db.pool.query<{
      action: string;
      actor_user_id: string;
      before_data: Record<string, unknown> | null;
      after_data: Record<string, unknown> | null;
    }>(
      `select action, actor_user_id, before_data, after_data
         from public.audit_events
        where league_id = $1 and ($2::text is null or action = $2)
        order by created_at`,
      [leagueId, action ?? null],
    );
    return rows;
  }

  describe('leagues', () => {
    it('records league.visibility_changed when visibility moves', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(`update public.leagues set visibility = 'searchable' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);

        const result = await client.query<{ action: string }>(
          `select action from public.audit_events where action = 'league.visibility_changed'`,
        );
        expect(result.rowCount).toBe(1);
      });
    });

    it('captures only the fields that actually changed', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(
          `update public.leagues set visibility = 'searchable', default_capacity = 18 where id = $1`,
          [SEED_LEAGUES.rmvfc],
        );

        const result = await client.query<{
          before_data: Record<string, unknown>;
          after_data: Record<string, unknown>;
        }>(
          `select before_data, after_data from public.audit_events
            where action = 'league.visibility_changed'`,
        );

        const after = result.rows[0]?.after_data ?? {};
        expect(Object.keys(after).sort()).toEqual(['default_capacity', 'visibility']);
        expect(result.rows[0]?.before_data).toMatchObject({
          visibility: 'private',
          default_capacity: 22,
        });
      });
    });

    it('records league.updated for a non-visibility change', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(`update public.leagues set description = 'New description.' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);

        const result = await client.query<{ action: string }>(
          `select action from public.audit_events where action = 'league.updated'`,
        );
        expect(result.rowCount).toBe(1);
      });
    });

    it('writes nothing for a no-op update', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const before = await client.query('select id from public.audit_events');
        await client.query(`update public.leagues set name = name where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);
        const after = await client.query('select id from public.audit_events');
        expect(after.rowCount).toBe(before.rowCount);
      });
    });
  });

  describe('memberships', () => {
    it('records membership.status_changed', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(
          `update public.league_memberships set status = 'suspended' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        // Scoped to this membership: the seed already contains a
        // `membership.status_changed` event for a different member.
        const result = await client.query<{ before_data: Record<string, unknown> }>(
          `select before_data from public.audit_events
            where action = 'membership.status_changed' and entity_id = $1`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        expect(result.rowCount).toBe(1);
        expect(result.rows[0]?.before_data).toMatchObject({ status: 'active', role: 'player' });
      });
    });

    it('records membership.created on a new membership', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.outsider.email,
        ]);
        const result = await client.query<{ action: string }>(
          `select action from public.audit_events where action = 'membership.created'`,
        );
        expect(result.rowCount).toBe(1);
      });
    });
  });

  describe('actor attribution', () => {
    it('attributes the event to the session user, not to a parameter', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(`update public.leagues set description = 'Changed.' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);
        const result = await client.query<{ actor_user_id: string }>(
          `select actor_user_id from public.audit_events where action = 'league.updated'`,
        );
        expect(result.rows[0]?.actor_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
      });
    });

    it('writes nothing for a change with no authenticated session', async () => {
      // Seeding and service-role maintenance are not administrator actions.
      // This is also what keeps `supabase/seed.sql` reproducible.
      const before = await eventsFor(SEED_LEAGUES.rmvfc);
      await db.pool.query(`update public.leagues set description = 'Bulk edit.' where id = $1`, [
        SEED_LEAGUES.rmvfc,
      ]);
      const after = await eventsFor(SEED_LEAGUES.rmvfc);

      expect(after.length).toBe(before.length);
    });

    it('leaves the seeded audit trail at exactly what the seed inserted', async () => {
      const rmvfc = await eventsFor(SEED_LEAGUES.rmvfc);
      const fives = await eventsFor(SEED_LEAGUES.weeknightFives);
      expect(rmvfc).toHaveLength(1);
      expect(fives).toHaveLength(1);
    });
  });

  describe('the log itself stays protected', () => {
    it('remains readable only by that league’s administrator', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.leagues set description = 'Changed.' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]),
      );

      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin, SEED_USERS.outsider]) {
        const rows = await asUser(db, actor, async (client) => {
          const result = await client.query(
            'select id from public.audit_events where league_id = $1',
            [SEED_LEAGUES.rmvfc],
          );
          return result.rows;
        });
        expect(rows).toEqual([]);
      }
    });

    it('cannot be forged through log_audit_event', async () => {
      // The unchecked writer is internal; only the SECURITY DEFINER functions,
      // which run as the owner, may call it.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.log_audit_event($1, $2, 'league', null, 'league.updated')`,
            [SEED_LEAGUES.rmvfc, SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('cannot be forged by an administrator either', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.log_audit_event($1, $2, 'league', null, 'league.updated')`,
            [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('stays append-only', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.audit_events set reason = 'rewritten'`),
      );
      expect(error.message).toContain('AUDIT_EVENT_IMMUTABLE');
    });
  });
});
