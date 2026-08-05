import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Atomic administrator transfer.
 *
 * The invariant under test is not "the function works" but "the league is never
 * observable with zero or two active administrators, whatever happens". Every
 * failure case therefore also asserts that the original administrator is still
 * in place afterwards.
 */
describe('administrator transfer', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function activeAdmins(leagueId: string) {
    const { rows } = await db.pool.query<{ user_id: string }>(
      `select user_id from public.league_memberships
        where league_id = $1 and role = 'league_admin' and status = 'active'`,
      [leagueId],
    );
    return rows.map((row) => row.user_id);
  }

  it('hands administration over and leaves exactly one administrator', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.transfer_league_administration($1, $2, $3)', [
        SEED_LEAGUES.rmvfc,
        SEED_MEMBERSHIPS.rmvfcPlayer,
        'Stepping down',
      ]),
    );

    expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcPlayer.id]);
  });

  it('demotes the outgoing administrator to player in the same transaction', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.transfer_league_administration($1, $2)', [
        SEED_LEAGUES.rmvfc,
        SEED_MEMBERSHIPS.rmvfcPlayer,
      ]),
    );

    const { rows } = await db.pool.query<{ role: string; status: string }>(
      'select role, status from public.league_memberships where id = $1',
      [SEED_MEMBERSHIPS.rmvfcAdmin],
    );
    expect(rows[0]).toMatchObject({ role: 'player', status: 'active' });
  });

  it('records league.administration_transferred with both parties', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.transfer_league_administration($1, $2, $3)', [
        SEED_LEAGUES.rmvfc,
        SEED_MEMBERSHIPS.rmvfcPlayer,
        'Stepping down',
      ]),
    );

    const { rows } = await db.pool.query<{
      before_data: Record<string, string>;
      after_data: Record<string, string>;
      reason: string;
    }>(
      `select before_data, after_data, reason from public.audit_events
        where action = 'league.administration_transferred'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.before_data['admin_user_id']).toBe(SEED_USERS.rmvfcAdmin.id);
    expect(rows[0]?.after_data['admin_user_id']).toBe(SEED_USERS.rmvfcPlayer.id);
    expect(rows[0]?.reason).toBe('Stepping down');
  });

  it('also records the two role changes, from the trigger', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.transfer_league_administration($1, $2)', [
        SEED_LEAGUES.rmvfc,
        SEED_MEMBERSHIPS.rmvfcPlayer,
      ]),
    );

    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.audit_events
        where action = 'membership.role_changed'`,
    );
    expect(rows[0]?.count).toBe('2');
  });

  describe('access moves with the role', () => {
    /**
     * The page guard `requireLeagueAdminPage()` admits exactly those for whom
     * `is_league_admin()` is true, and the administrator-only tables are gated
     * on the same predicate. Asserting it here is asserting who can open
     * `/leagues/[slug]/members` and `/settings`, at the layer that actually
     * decides — no page can grant access the database refuses.
     */
    async function administersRmvfc(user: (typeof SEED_USERS)[keyof typeof SEED_USERS]) {
      return asUser(db, user, async (client) => {
        const result = await client.query<{ is_admin: boolean }>(
          'select public.is_league_admin($1) as is_admin',
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows[0]?.is_admin;
      });
    }

    it('grants the outgoing administrator nothing afterwards', async () => {
      expect(await administersRmvfc(SEED_USERS.rmvfcAdmin)).toBe(true);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.transfer_league_administration($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      expect(await administersRmvfc(SEED_USERS.rmvfcAdmin)).toBe(false);
    });

    it('grants the incoming administrator everything afterwards', async () => {
      expect(await administersRmvfc(SEED_USERS.rmvfcPlayer)).toBe(false);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.transfer_league_administration($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      expect(await administersRmvfc(SEED_USERS.rmvfcPlayer)).toBe(true);
    });

    it('moves the administrator-only data with the role', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.transfer_league_administration($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      async function adminOnlyRowCounts(
        user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
      ) {
        return asUser(db, user, async (client) => {
          const invites = await client.query('select id from public.league_invites');
          const audit = await client.query('select id from public.audit_events');
          return { invites: invites.rowCount, audit: audit.rowCount };
        });
      }

      const outgoing = await adminOnlyRowCounts(SEED_USERS.rmvfcAdmin);
      const incoming = await adminOnlyRowCounts(SEED_USERS.rmvfcPlayer);

      expect(outgoing).toEqual({ invites: 0, audit: 0 });
      expect(incoming.invites).toBeGreaterThan(0);
      expect(incoming.audit).toBeGreaterThan(0);
    });

    it('leaves the outgoing administrator an ordinary member, not an outsider', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.transfer_league_administration($1, $2)', [
          SEED_LEAGUES.rmvfc,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );

      // They still belong to the league — the dashboard they are redirected to
      // must still show it.
      const leagues = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ slug: string }>('select slug from public.leagues');
        return result.rows.map((row) => row.slug);
      });

      expect(leagues).toEqual(['rmv-football-club']);
    });

    it('leaves both parties unchanged when the transfer fails', async () => {
      await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.transfer_league_administration($1, $2)', [
            SEED_LEAGUES.rmvfc,
            SEED_MEMBERSHIPS.rmvfcSuspended,
          ]),
        ),
      );

      expect(await administersRmvfc(SEED_USERS.rmvfcAdmin)).toBe(true);
      expect(await administersRmvfc(SEED_USERS.rmvfcPlayer)).toBe(false);
    });
  });

  describe('invalid recipients leave the league untouched', () => {
    it.each([
      ['a suspended member', SEED_MEMBERSHIPS.rmvfcSuspended],
      ['a removed member', SEED_MEMBERSHIPS.rmvfcRemoved],
      ['a membership in another league', SEED_MEMBERSHIPS.fivesPending],
      ['the administrator themselves', SEED_MEMBERSHIPS.rmvfcAdmin],
      ['a membership that does not exist', '33333333-3333-4333-8333-0000000000ff'],
    ])('refuses %s', async (_label, membershipId) => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.transfer_league_administration($1, $2)', [
            SEED_LEAGUES.rmvfc,
            membershipId,
          ]),
        ),
      );

      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
      // The rollback is what matters: the league still has its original single
      // administrator.
      expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcAdmin.id]);
    });
  });

  describe('authorization', () => {
    it('refuses a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.transfer_league_administration($1, $2)', [
            SEED_LEAGUES.rmvfc,
            SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer,
          ]),
        ),
      );

      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcAdmin.id]);
    });

    it('refuses another league’s administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query('select public.transfer_league_administration($1, $2)', [
            SEED_LEAGUES.rmvfc,
            SEED_MEMBERSHIPS.rmvfcPlayer,
          ]),
        ),
      );

      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcAdmin.id]);
    });

    it('does not let a player promote themselves through the update policy', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query(
          `update public.league_memberships set role = 'league_admin' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        );
        return result.rowCount;
      });

      expect(rowCount).toBe(0);
    });
  });

  describe('the underlying invariant still holds', () => {
    it('refuses a second active administrator, however it is attempted', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.league_memberships set role = 'league_admin' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        ),
      );
      expect(error.message).toContain('league_memberships_single_active_admin_key');
    });

    it('refuses to commit a league with no administrator', async () => {
      const client = await db.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `update public.league_memberships set status = 'removed' where id = $1`,
          [SEED_MEMBERSHIPS.rmvfcAdmin],
        );
        const error = await expectDatabaseError(() => client.query('commit'));
        expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }

      expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcAdmin.id]);
    });

    it('evaluates the cardinality check independently of the caller’s RLS', async () => {
      // Regression guard for the defect fixed in 20260803020500. Without
      // SECURITY DEFINER, the trigger's "was this league deleted?" guard is
      // answered by the caller's visibility, so an administrator who removes
      // their own membership makes the league invisible to themselves and the
      // whole cardinality check is skipped.
      const { rows } = await db.pool.query<{ prosecdef: boolean }>(
        `select p.prosecdef
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'enforce_single_active_league_admin'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.prosecdef).toBe(true);
    });

    it('stops an administrator removing themselves through the members screen', async () => {
      // The action path: an UPDATE via the Phase 1 policy. The deferred
      // constraint rejects it at COMMIT rather than letting the league end up
      // headless.
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
            SEED_MEMBERSHIPS.rmvfcAdmin,
          ]),
        ),
      );

      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
      expect(await activeAdmins(SEED_LEAGUES.rmvfc)).toEqual([SEED_USERS.rmvfcAdmin.id]);
    });
  });
});
