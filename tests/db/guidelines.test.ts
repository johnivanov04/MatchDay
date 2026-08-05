import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_GUIDELINES,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('guideline versions', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('authoring', () => {
    it('lets the administrator create a draft', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string; published_at: string | null }>(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'draft-1', 'Draft', 'Some rules.')
           returning id, published_at`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows;
      });

      expect(rows).toHaveLength(1);
      // A version is always born a draft.
      expect(rows[0]?.published_at).toBeNull();
    });

    it('computes the checksum from the body, ignoring anything supplied', async () => {
      const checksum = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ content_checksum: string; matches: boolean }>(
          `insert into public.guideline_versions
             (league_id, version_label, title, body, content_checksum)
           values ($1, 'draft-2', 'Draft', 'Exact text.', 'a-lie')
           returning content_checksum,
                     content_checksum = encode(sha256(convert_to('Exact text.','UTF8')),'hex') as matches`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0];
      });

      // A client-supplied checksum would let somebody claim a member accepted
      // text they never saw.
      expect(checksum?.matches).toBe(true);
      expect(checksum?.content_checksum).not.toBe('a-lie');
    });

    it('refuses a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.guideline_versions (league_id, version_label, title, body)
             values ($1, 'sneaky', 'T', 'B')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses another league’s administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query(
            `insert into public.guideline_versions (league_id, version_label, title, body)
             values ($1, 'cross-tenant', 'T', 'B')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses a draft that claims to be already published', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.guideline_versions
               (league_id, version_label, title, body, published_at)
             values ($1, 'presumptuous', 'T', 'B', now())`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('rejects a duplicate version label in the same league', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.guideline_versions (league_id, version_label, title, body)
             values ($1, '2026-DEVELOPMENT', 'T', 'B')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      // Case-insensitive: a label identifies a version.
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });
  });

  describe('published text is frozen', () => {
    it('refuses to edit the body of a published version', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.guideline_versions set body = 'rewritten' where id = $1`,
          [SEED_GUIDELINES.rmvfcRequired],
        ),
      );

      // A trigger, so this binds the service role too — editing accepted text
      // would silently change what every existing acceptance means.
      expect(error.message).toContain('GUIDELINE_PUBLISHED_IMMUTABLE');
    });

    it('refuses to flip the acceptance requirement after publication', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.guideline_versions set requires_acceptance = false where id = $1`,
          [SEED_GUIDELINES.rmvfcRequired],
        ),
      );
      expect(error.message).toContain('GUIDELINE_PUBLISHED_IMMUTABLE');
    });

    it('gives the administrator no update path to a published version', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          `update public.guideline_versions set title = 'Renamed' where id = $1`,
          [SEED_GUIDELINES.rmvfcRequired],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('still allows editing a draft', async () => {
      const draftId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'editable', 'T', 'B') returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          `update public.guideline_versions set body = 'Revised.' where id = $1`,
          [draftId],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(1);
    });
  });

  describe('visibility', () => {
    it('shows a member published versions only', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'unseen-draft', 'Draft', 'Members must not see this.')`,
          [SEED_LEAGUES.rmvfc],
        ),
      );

      const labels = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ version_label: string }>(
          'select version_label from public.guideline_versions',
        );
        return result.rows.map((row) => row.version_label);
      });

      expect(labels).toEqual(['2026-development']);
      expect(labels).not.toContain('unseen-draft');
    });

    it('shows the administrator drafts as well', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'admin-draft', 'Draft', 'Body.')`,
          [SEED_LEAGUES.rmvfc],
        );
        const result = await client.query('select id from public.guideline_versions');
        return result.rowCount;
      });
      expect(count).toBe(2);
    });

    it('hides another league’s guidelines entirely', async () => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.guideline_versions',
        );
        return result.rows.map((row) => row.league_id);
      });
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });

    it('shows a non-member nothing', async () => {
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query('select id from public.guideline_versions');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('shows a suspended member nothing', async () => {
      // Guidelines are member-only content, and a suspended membership is not
      // an active one.
      const rows = await asUser(db, SEED_USERS.suspendedPlayer, async (client) => {
        const result = await client.query('select id from public.guideline_versions');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('gives an anonymous visitor no access', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select id from public.guideline_versions')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('publishing and archiving', () => {
    it('publishes idempotently and audits once', async () => {
      const draftId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'to-publish', 'T', 'B') returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.publish_guideline_version($1)', [draftId]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.audit_events
          where entity_id = $1 and action = 'guideline_version.published'`,
        [draftId],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query('select public.publish_guideline_version($1)', [
              SEED_GUIDELINES.rmvfcRequired,
            ]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('archives without deleting, and records it', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.archive_guideline_version($1)', [
          SEED_GUIDELINES.rmvfcRequired,
        ]),
      );

      const { rows } = await db.pool.query<{ archived_at: Date | null }>(
        'select archived_at from public.guideline_versions where id = $1',
        [SEED_GUIDELINES.rmvfcRequired],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.archived_at).not.toBeNull();
    });

    it('refuses to archive something never published', async () => {
      const draftId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'never-published', 'T', 'B') returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.archive_guideline_version($1)', [draftId]),
        ),
      );
      expect(error.message).toContain('GUIDELINE_NOT_PUBLISHED');
    });
  });

  describe('acceptance', () => {
    it('records an acceptance for the caller’s own membership', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.accept_guideline_version($1)', [
          SEED_GUIDELINES.rmvfcRequired,
        ]),
      );

      const { rows } = await db.pool.query<{ membership_id: string }>(
        `select membership_id from public.guideline_acceptances
          where guideline_version_id = $1 and membership_id = $2`,
        [SEED_GUIDELINES.rmvfcRequired, SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      expect(rows).toHaveLength(1);
    });

    it('is idempotent and keeps the original timestamp', async () => {
      const first = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ id: string }>(
          'select public.accept_guideline_version($1) as id',
          [SEED_GUIDELINES.rmvfcRequired],
        );
        return result.rows[0]?.id;
      });

      const second = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ id: string }>(
          'select public.accept_guideline_version($1) as id',
          [SEED_GUIDELINES.rmvfcRequired],
        );
        return result.rows[0]?.id;
      });

      expect(second).toBe(first);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.guideline_acceptances
          where membership_id = $1`,
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('is immutable — no update path exists for anyone', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.guideline_acceptances set accepted_at = now() - interval '1 year'`,
        ),
      );
      expect(error.message).toContain('GUIDELINE_ACCEPTANCE_IMMUTABLE');
    });

    it('gives a client no direct insert path', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.guideline_acceptances (league_id, guideline_version_id, membership_id)
             values ($1, $2, $3)`,
            [SEED_LEAGUES.rmvfc, SEED_GUIDELINES.rmvfcRequired, SEED_MEMBERSHIPS.rmvfcPlayer],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('cannot be performed on behalf of somebody else', async () => {
      // There is no parameter for whose acceptance this is — the membership is
      // resolved from the session — so an administrator accepting for a member
      // records the administrator's own acceptance, not theirs.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.accept_guideline_version($1)', [
          SEED_GUIDELINES.rmvfcRequired,
        ]),
      );

      const { rows } = await db.pool.query<{ membership_id: string }>(
        `select membership_id from public.guideline_acceptances
          where guideline_version_id = $1`,
        [SEED_GUIDELINES.rmvfcRequired],
      );

      expect(rows.map((row) => row.membership_id)).not.toContain(SEED_MEMBERSHIPS.rmvfcPlayer);
      expect(rows.map((row) => row.membership_id)).toContain(SEED_MEMBERSHIPS.rmvfcAdmin);
    });

    it('refuses a non-member', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query('select public.accept_guideline_version($1)', [
            SEED_GUIDELINES.rmvfcRequired,
          ]),
        ),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('refuses an unpublished version, reporting it as though it does not exist', async () => {
      const draftId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions (league_id, version_label, title, body)
           values ($1, 'secret-draft', 'T', 'B') returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      const draftError = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.accept_guideline_version($1)', [draftId]),
        ),
      );
      const missingError = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.accept_guideline_version($1)', [
            '88888888-8888-4888-8888-0000000000ff',
          ]),
        ),
      );

      expect(draftError.message).toContain('GUIDELINE_NOT_FOUND');
      expect(draftError.message).toBe(missingError.message);
    });
  });

  describe('administrator acceptance status', () => {
    it('lists members and whether each has accepted', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ membership_id: string; accepted: boolean }>(
          'select membership_id, accepted from public.league_guideline_acceptance_status($1)',
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows;
      });

      const byMembership = new Map(rows.map((row) => [row.membership_id, row.accepted]));
      // The seed has the multi-league player accepting and nobody else.
      expect(byMembership.get(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer)).toBe(true);
      expect(byMembership.get(SEED_MEMBERSHIPS.rmvfcPlayer)).toBe(false);
      // Removed memberships are excluded.
      expect(byMembership.has(SEED_MEMBERSHIPS.rmvfcRemoved)).toBe(false);
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query('select * from public.league_guideline_acceptance_status($1)', [
              SEED_LEAGUES.rmvfc,
            ]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('lets an administrator read acceptance rows for their league only', async () => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.guideline_acceptances',
        );
        return result.rows.map((row) => row.league_id);
      });
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });
  });
});
