import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('RLS — audit events', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('shows a league administrator only their own league’s audit trail', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ league_id: string; action: string }>(
        'select league_id, action from public.audit_events',
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.league_id).toBe(SEED_LEAGUES.rmvfc);
    expect(rows[0]?.action).toBe('membership.status_changed');
  });

  it('hides the audit trail from players', async () => {
    const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query('select id from public.audit_events');
      return result.rows;
    });

    // This player is an active member of BOTH leagues and still sees nothing.
    expect(rows).toEqual([]);
  });

  it('hides the audit trail from non-members', async () => {
    const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
      const result = await client.query('select id from public.audit_events');
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it('gives an unauthenticated visitor no access', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) => client.query('select id from public.audit_events')),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  describe('write path', () => {
    it('refuses a direct insert even from a league administrator', async () => {
      // `authenticated` holds no INSERT privilege at all, so a forged audit
      // entry is impossible regardless of what a compromised client sends.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.audit_events (league_id, entity_type, action)
             values ($1, 'league', 'league.updated')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('records an event through record_audit_event for the league administrator', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(
          `select public.record_audit_event(
             $1, 'league_membership', $2, 'membership.status_changed',
             '{"status":"active"}'::jsonb, '{"status":"suspended"}'::jsonb, 'Test reason')`,
          [SEED_LEAGUES.rmvfc, SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        const result = await client.query<{ actor_user_id: string; reason: string }>(
          `select actor_user_id, reason from public.audit_events where reason = 'Test reason'`,
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      // The actor comes from the session, never from a parameter.
      expect(rows[0]?.actor_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
    });

    it('refuses record_audit_event for a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(`select public.record_audit_event($1, 'league', null, 'league.updated')`, [
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );

      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses record_audit_event against a league the caller does not administer', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.record_audit_event($1, 'league', null, 'league.updated')`, [
            SEED_LEAGUES.weeknightFives,
          ]),
        ),
      );

      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses record_audit_event without a session', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query(`select public.record_audit_event($1, 'league', null, 'league.updated')`, [
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses to modify an audit event even with RLS bypassed', async () => {
      // Immutability is a trigger, not a policy, so it also binds the
      // service-role connection used by trusted server code.
      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.audit_events set reason = 'rewritten'`),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
      expect(error.message).toContain('AUDIT_EVENT_IMMUTABLE');
    });

    it('refuses to delete an audit event from a client session', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('delete from public.audit_events'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});
