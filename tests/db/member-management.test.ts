import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('member management', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('adding a member by email', () => {
    it('creates an active membership for an existing account', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.outsider.email,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string; role: string }>(
        'select status, role from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(rows[0]).toMatchObject({ status: 'active', role: 'player' });
    });

    it('matches the address case-insensitively', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          '  OutSider@MatchDay.TEST ',
        ]),
      );

      const { rows } = await db.pool.query(
        'select id from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(rows).toHaveLength(1);
    });

    it('is idempotent: adding twice yields one membership', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.add_league_member_by_email($1, $2)', [
            SEED_LEAGUES.rmvfc,
            SEED_USERS.outsider.email,
          ]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.league_memberships
          where league_id = $1 and user_id = $2`,
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('reactivates a removed member rather than adding a row', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.removedPlayer.email,
        ]),
      );

      const { rows } = await db.pool.query<{ id: string; status: string }>(
        'select id, status from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.removedPlayer.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(SEED_MEMBERSHIPS.rmvfcRemoved);
      expect(rows[0]?.status).toBe('active');
    });

    it('never disturbs an existing administrator', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.rmvfcAdmin.email,
        ]),
      );

      const { rows } = await db.pool.query<{ role: string; status: string }>(
        'select role, status from public.league_memberships where id = $1',
        [SEED_MEMBERSHIPS.rmvfcAdmin],
      );
      expect(rows[0]).toMatchObject({ role: 'league_admin', status: 'active' });
    });

    it('can add someone as pending', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.add_league_member_by_email($1, $2, 'pending')`, [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.outsider.email,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(rows[0]?.status).toBe('pending');
    });

    it('refuses to add someone as suspended or removed', async () => {
      for (const status of ['suspended', 'removed']) {
        const error = await expectDatabaseError(() =>
          asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
            client.query('select public.add_league_member_by_email($1, $2, $3)', [
              SEED_LEAGUES.rmvfc,
              SEED_USERS.outsider.email,
              status,
            ]),
          ),
        );
        expect(error.message).toContain('VALIDATION_FAILED');
      }
    });

    it('reports an unknown address', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.add_league_member_by_email($1, $2)', [
            SEED_LEAGUES.rmvfc,
            'nobody@matchday.test',
          ]),
        ),
      );
      expect(error.message).toContain('PROFILE_NOT_FOUND');
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query('select public.add_league_member_by_email($1, $2)', [
              SEED_LEAGUES.rmvfc,
              SEED_USERS.outsider.email,
            ]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('refuses an unauthenticated caller', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query('select public.add_league_member_by_email($1, $2)', [
            SEED_LEAGUES.rmvfc,
            SEED_USERS.outsider.email,
          ]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('does not create a membership in another league', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.add_league_member_by_email($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_USERS.outsider.email,
        ]),
      );

      const { rows } = await db.pool.query<{ league_id: string }>(
        'select league_id from public.league_memberships where user_id = $1',
        [SEED_USERS.outsider.id],
      );
      expect(rows.map((row) => row.league_id)).toEqual([SEED_LEAGUES.rmvfc]);
    });
  });

  describe('changing a member’s status', () => {
    it('lets the administrator suspend and reinstate', async () => {
      const status = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(
          `update public.league_memberships set status = 'suspended' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        const result = await client.query<{ status: string }>(
          'select status from public.league_memberships where id = $1',
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        return result.rows[0]?.status;
      });
      expect(status).toBe('suspended');
    });

    it('refuses a player changing their own status', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query(
          `update public.league_memberships set status = 'active' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcSuspended],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('refuses an administrator reaching into another league', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          `update public.league_memberships set status = 'removed' where id = $1`,
          [SEED_MEMBERSHIPS.fivesPending],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('removes a member without deleting the row', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where id = $1',
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      expect(rows[0]?.status).toBe('removed');
    });

    it('cuts off a removed member’s access to the league', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      const visible = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query('select id from public.leagues');
        return result.rowCount;
      });
      expect(visible).toBe(0);
    });
  });
});
