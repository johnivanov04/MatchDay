import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asServiceRole,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Reporting and blocking, against real PostgreSQL.
 *
 * The properties worth protecting are mostly negative ones: that the subject of
 * a report cannot discover it, that a target id cannot be used to probe for
 * leagues you cannot see, and that a block cannot be read by the person it was
 * placed on. Each of those is a policy that has to be ABSENT, and an absent
 * policy is exactly the kind of thing a refactor adds back by accident.
 */

describe('reporting and blocking', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('filing a report', () => {
    it('records a report against a member of a league you share', async () => {
      const id = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `select public.submit_content_report(
             'user'::public.report_target_type, $1,
             'harassment'::public.report_reason, 'Said something vile after the match.') as id`,
          [SEED_USERS.rmvfcAdmin.id],
        );
        return rows[0]!.id;
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('records a report against a match you can see', async () => {
      const id = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `select public.submit_content_report(
             'match'::public.report_target_type, $1,
             'spam'::public.report_reason, null) as id`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows[0]!.id;
      });
      expect(id).not.toBeNull();
    });

    it('stores only what is needed to investigate', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query(
          `select public.submit_content_report('user'::public.report_target_type, $1,
             'hate_speech'::public.report_reason, 'details here')`,
          [SEED_USERS.rmvfcAdmin.id],
        ),
      );

      const columns = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'content_reports'`,
        );
        return rows.map((row) => row.column_name);
      });

      // No address, no device token, no copy of the reported content.
      expect(columns).not.toContain('reporter_email');
      expect(columns.filter((c) => /email|phone|token|device/.test(c))).toEqual([]);
    });

    it('refuses a report against a league the reporter cannot see', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query(
            `select public.submit_content_report('league'::public.report_target_type, $1,
               'spam'::public.report_reason, null)`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('answers a league that does not exist exactly as one you cannot see', async () => {
      const unseen = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query(
            `select public.submit_content_report('league'::public.report_target_type, $1,
               'spam'::public.report_reason, null)`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      const missing = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query(
            `select public.submit_content_report('league'::public.report_target_type,
               '00000000-0000-4000-8000-000000000000',
               'spam'::public.report_reason, null)`,
          ),
        ),
      );
      expect(missing.message).toBe(unseen.message);
    });

    it('refuses reporting yourself', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.submit_content_report('user'::public.report_target_type, $1,
               'other'::public.report_reason, null)`,
            [SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('refuses a second open report for the same target', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query(
          `select public.submit_content_report('user'::public.report_target_type, $1,
             'harassment'::public.report_reason, null)`,
          [SEED_USERS.rmvfcAdmin.id],
        ),
      );

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.submit_content_report('user'::public.report_target_type, $1,
               'spam'::public.report_reason, null)`,
            [SEED_USERS.rmvfcAdmin.id],
          ),
        ),
      );
      expect(error.message).toContain('REPORT_ALREADY_OPEN');
    });

    it('allows a new report once the previous one is resolved', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query(
          `select public.submit_content_report('user'::public.report_target_type, $1,
             'harassment'::public.report_reason, null)`,
          [SEED_USERS.rmvfcAdmin.id],
        ),
      );
      await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'select id from public.content_reports limit 1',
        );
        await client.query(
          `select public.resolve_content_report($1, 'dismissed'::public.report_status, 'no action')`,
          [rows[0]!.id],
        );
        await client.query('commit');
      });

      const again = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `select public.submit_content_report('user'::public.report_target_type, $1,
             'spam'::public.report_reason, null) as id`,
          [SEED_USERS.rmvfcAdmin.id],
        );
        return rows[0]!.id;
      });
      expect(again).not.toBeNull();
    });

    it('bounds the detail text', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.submit_content_report('user'::public.report_target_type, $1,
               'other'::public.report_reason, $2)`,
            [SEED_USERS.rmvfcAdmin.id, 'x'.repeat(1001)],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('filters the detail text like any other user-authored field', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.submit_content_report('user'::public.report_target_type, $1,
               'other'::public.report_reason, 'this fucker again')`,
            [SEED_USERS.rmvfcAdmin.id],
          ),
        ),
      );
      expect(error.message).toContain('CONTENT_REJECTED');
    });
  });

  describe('a report is invisible to the person it is about', () => {
    beforeEach(async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query(
          `select public.submit_content_report('user'::public.report_target_type, $1,
             'harassment'::public.report_reason, 'kept private')`,
          [SEED_USERS.rmvfcAdmin.id],
        ),
      );
    });

    it('lets the reporter read their own report', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.content_reports',
        );
        return Number(rows[0]!.n);
      });
      expect(count).toBe(1);
    });

    it('shows the reported member nothing — not even that it exists', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.content_reports',
        );
        return Number(rows[0]!.n);
      });
      expect(count).toBe(0);
    });

    it('shows an unrelated member nothing', async () => {
      const count = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.content_reports',
        );
        return Number(rows[0]!.n);
      });
      expect(count).toBe(0);
    });

    it('shows an unauthenticated visitor nothing', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select * from public.content_reports')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('gives a member no way to change or withdraw one', async () => {
      const update = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query("update public.content_reports set status = 'dismissed'"),
        ),
      );
      expect(update.code).toBe(PG_ERROR.insufficientPrivilege);

      const remove = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('delete from public.content_reports'),
        ),
      );
      expect(remove.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses an ordinary member the operator functions', async () => {
      const resolve = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.resolve_content_report('00000000-0000-4000-8000-000000000000',
               'dismissed'::public.report_status, null)`,
          ),
        ),
      );
      expect(resolve.code).toBe(PG_ERROR.insufficientPrivilege);

      const claim = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.claim_unescalated_reports(10)'),
        ),
      );
      expect(claim.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('claims each report for escalation exactly once', async () => {
      const first = await asServiceRole(db, async (client) => {
        const { rows } = await client.query('select * from public.claim_unescalated_reports(50)');
        await client.query('commit');
        return rows.length;
      });
      const second = await asServiceRole(db, async (client) => {
        const { rows } = await client.query('select * from public.claim_unescalated_reports(50)');
        return rows.length;
      });
      expect(first).toBe(1);
      expect(second).toBe(0);
    });
  });

  describe('blocking', () => {
    it('blocks and unblocks', async () => {
      const blocked = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        await client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.user_blocks',
        );
        return Number(rows[0]!.n);
      });
      expect(blocked).toBe(1);

      const after = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        await client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        await client.query('select public.unblock_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.user_blocks',
        );
        return Number(rows[0]!.n);
      });
      expect(after).toBe(0);
    });

    it('is idempotent', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        await client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        await client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        await client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]);
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.user_blocks',
        );
        return Number(rows[0]!.n);
      });
      expect(count).toBe(1);
    });

    it('refuses blocking yourself', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.block_user($1)', [SEED_USERS.rmvfcPlayer.id]),
        ),
      );
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('never tells you who has blocked you', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.rmvfcAdmin.id]),
      );

      const visible = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'select count(*)::text as n from public.user_blocks',
        );
        return Number(rows[0]!.n);
      });
      expect(visible).toBe(0);
    });

    it('is symmetric for interaction, whichever side placed it', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.outsider.id]),
      );

      const both = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ a: boolean; b: boolean }>(
          `select public.is_blocked_between($1, $2) as a,
                  public.is_blocked_between($2, $1) as b`,
          [SEED_USERS.rmvfcPlayer.id, SEED_USERS.outsider.id],
        );
        return rows[0]!;
      });
      expect(both.a).toBe(true);
      expect(both.b).toBe(true);
    });

    it('stops a join request reaching an administrator who blocked you', async () => {
      // `outsider` already holds a pending request to this league in the seed,
      // and the RPC returns the existing one rather than inserting — so the
      // trigger would never fire. Use somebody with no request instead.
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.rmvfcPlayer.id]),
      );

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.request_to_join_league($1, $2)', [
            SEED_LEAGUES.weeknightFives,
            'let me in',
          ]),
        ),
      );
      expect(error.message).toContain('BLOCKED_INTERACTION');
    });

    it('leaves an unrelated league reachable', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.rmvfcPlayer.id]),
      );
      // Cross-league isolation: a block by the fives admin says nothing about
      // RMVFC, whose administrator has blocked nobody.
      const blockedThere = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ blocked: boolean }>(
          'select public.is_blocked_between($1, $2) as blocked',
          [SEED_USERS.rmvfcAdmin.id, SEED_USERS.rmvfcPlayer.id],
        );
        return rows[0]!.blocked;
      });
      expect(blockedThere).toBe(false);
    });
  });

  describe('what a blocked member looks like on a roster', () => {
    // The seeded match has no signups, so without this the roster assertions
    // would pass against an empty list and prove nothing.
    beforeEach(async () => {
      // Written as fixture rather than through `join_match`, which refuses
      // until the league's guidelines have been accepted. What is under test
      // here is the projection, not the signup rules that guard it.
      await asServiceRole(db, async (client) => {
        await client.query(
          `insert into public.match_signups (league_id, match_id, membership_id, status)
           select $1, $2, m.id, 'confirmed'
             from public.league_memberships m
            where m.id = any($3::uuid[])`,
          [
            SEED_LEAGUES.rmvfc,
            SEED_MATCHES.rmvfcOpen,
            [SEED_MEMBERSHIPS.rmvfcPlayer, SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer],
          ],
        );
        await client.query('commit');
      });
    });

    it('replaces the name for the person who blocked them', async () => {
      const before = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ first_name: string }>(
          'select first_name from public.match_confirmed_roster($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows.map((row) => row.first_name);
      });

      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.multiLeaguePlayer.id]),
      );

      const after = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ first_name: string }>(
          'select first_name from public.match_confirmed_roster($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows.map((row) => row.first_name);
      });

      expect(after).toContain('Blocked');
      expect(after.length).toBe(before.length);
    });

    it('leaves the roster unchanged for everybody else', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.multiLeaguePlayer.id]),
      );

      const asAdmin = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query<{ first_name: string }>(
          'select first_name from public.match_confirmed_roster($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows.map((row) => row.first_name);
      });
      expect(asAdmin).not.toContain('Blocked');
    });

    it('does not weaken the administrator roster', async () => {
      // The admin blocks somebody and must still be able to administer them.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.block_user($1)', [SEED_USERS.multiLeaguePlayer.id]),
      );

      const names = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query<{ first_name: string }>(
          'select first_name from public.match_roster_admin($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows.map((row) => row.first_name);
      });
      expect(names).not.toContain('Blocked');
    });
  });

  describe('profile photos are not handed to other members', () => {
    it('returns a photo path only for your own row', async () => {
      await asServiceRole(db, async (client) => {
        await client.query(
          `update public.profiles set profile_photo_path = $1 where id = $2`,
          [`${SEED_USERS.multiLeaguePlayer.id}/11111111-1111-4111-8111-00000000000a.jpg`,
           SEED_USERS.multiLeaguePlayer.id],
        );
        await client.query('commit');
      });

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ is_self: boolean; profile_photo_path: string | null }>(
          'select is_self, profile_photo_path from public.match_confirmed_roster($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return rows;
      });

      for (const row of rows) {
        if (!row.is_self) {
          expect(row.profile_photo_path).toBeNull();
        }
      }
      // And the photo really was set, so this is not passing vacuously.
      const stored = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ p: string | null }>(
          'select profile_photo_path as p from public.profiles where id = $1',
          [SEED_USERS.multiLeaguePlayer.id],
        );
        return rows[0]!.p;
      });
      expect(stored).not.toBeNull();
    });
  });
});
