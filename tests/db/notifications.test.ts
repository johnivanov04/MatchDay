import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_GUIDELINES,
  SEED_JOIN_REQUESTS,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('canonical notifications', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function notificationsFor(user: (typeof SEED_USERS)[keyof typeof SEED_USERS]) {
    return asUser(db, user, async (client) => {
      const result = await client.query<{
        id: string;
        type: string;
        deep_link: string;
        league_id: string;
      }>('select id, type, deep_link, league_id from public.notifications');
      return result.rows;
    });
  }

  describe('match publication fanout', () => {
    it('creates exactly one notification per active member, excluding the actor', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string; count: string }>(
        `select recipient_user_id, count(*)::text as count
           from public.notifications
          where type = 'match_published' and match_id = $1
          group by recipient_user_id`,
        [SEED_MATCHES.rmvfcDraft],
      );

      // RMVFC's active members are the administrator, the multi-league player
      // and the RMVFC player. The administrator published it, so two remain.
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.count === '1')).toBe(true);
      expect(rows.map((row) => row.recipient_user_id).sort()).toEqual(
        [SEED_USERS.multiLeaguePlayer.id, SEED_USERS.rmvfcPlayer.id].sort(),
      );
    });

    it('does not notify suspended, pending or removed members', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string }>(
        `select recipient_user_id from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      const recipients = rows.map((row) => row.recipient_user_id);

      expect(recipients).not.toContain(SEED_USERS.suspendedPlayer.id);
      expect(recipients).not.toContain(SEED_USERS.removedPlayer.id);
      expect(recipients).not.toContain(SEED_USERS.outsider.id);
    });

    it('is idempotent: republishing creates nothing new', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('notifies only that league', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ league_id: string }>(
        `select distinct league_id from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows.map((row) => row.league_id)).toEqual([SEED_LEAGUES.rmvfc]);
    });

    it('deep-links to the match, as a local path', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ deep_link: string }>(
        `select distinct deep_link from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.deep_link).toBe(
        `/leagues/rmv-football-club/matches/${SEED_MATCHES.rmvfcDraft}`,
      );
    });
  });

  describe('cancellation', () => {
    it('notifies when an open match is canceled', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.cancel_match($1, $2)', [SEED_MATCHES.rmvfcOpen, 'Waterlogged']),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'match_canceled' and match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('says nothing when a draft is abandoned', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.cancel_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      // Members never saw it, so there is nothing to tell them.
      expect(rows[0]?.count).toBe('0');
    });

    it('is idempotent', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.cancel_match($1)', [SEED_MATCHES.rmvfcOpen]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'match_canceled' and match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.count).toBe('2');
    });
  });

  describe('edits', () => {
    it('notifies once per revision, and a repeated edit is a new revision', async () => {
      const first = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ revision: number }>(
          `select public.update_published_match($1,'Moved','2026-09-21','18:30','19:00','20:30','P',22,14,2)
             as revision`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0]?.revision;
      });

      const second = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ revision: number }>(
          `select public.update_published_match($1,'Moved again','2026-09-22','18:30','19:00','20:30','P',22,14,2)
             as revision`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0]?.revision;
      });

      expect(second).toBe((first ?? 0) + 1);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'match_changed' and match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      // Two edits × two members.
      expect(rows[0]?.count).toBe('4');
    });

    it('refuses to edit a draft through the published path', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.update_published_match($1,'X','2026-09-21','18:30','19:00','20:30','P',22,14,2)`,
            [SEED_MATCHES.rmvfcDraft],
          ),
        ),
      );
      expect(error.message).toContain('MATCH_NOT_OPEN');
    });
  });

  describe('guideline publication', () => {
    it('sends the acceptance-required type when acceptance is needed', async () => {
      const versionId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions
             (league_id, version_label, title, body, requires_acceptance)
           values ($1, 'needs-accept', 'T', 'B', true) returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_guideline_version($1)', [versionId]),
      );

      const { rows } = await db.pool.query<{ type: string; count: string }>(
        `select type, count(*)::text as count from public.notifications
          where idempotency_key like $1 group by type`,
        [`%${versionId}%`],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe('guideline_acceptance_required');
      expect(rows[0]?.count).toBe('2');
    });

    it('sends the informational type when acceptance is not needed', async () => {
      const versionId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `insert into public.guideline_versions
             (league_id, version_label, title, body, requires_acceptance)
           values ($1, 'fyi-only', 'T', 'B', false) returning id`,
          [SEED_LEAGUES.rmvfc],
        );
        return inserted.rows[0]?.id ?? '';
      });

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_guideline_version($1)', [versionId]),
      );

      const { rows } = await db.pool.query<{ type: string }>(
        `select distinct type from public.notifications where idempotency_key like $1`,
        [`%${versionId}%`],
      );

      // Exactly one type per publication, never both.
      expect(rows.map((row) => row.type)).toEqual(['guideline_version_published']);
    });

    it('is idempotent across repeated publish calls', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.publish_guideline_version($1)', [
            SEED_GUIDELINES.rmvfcRequired,
          ]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where idempotency_key like $1`,
        [`%${SEED_GUIDELINES.rmvfcRequired}%`],
      );
      // Already published in the seed, so publishing again changes nothing.
      expect(rows[0]?.count).toBe('0');
    });
  });

  describe('recipient isolation', () => {
    it('shows a user only their own notifications', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const player = await notificationsFor(SEED_USERS.rmvfcPlayer);
      const multi = await notificationsFor(SEED_USERS.multiLeaguePlayer);

      expect(player).toHaveLength(1);
      expect(multi).toHaveLength(1);
      expect(player[0]?.id).not.toBe(multi[0]?.id);
    });

    it('hides members’ notifications from the league administrator', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      // A notification is addressed to a person, not to a tenant.
      expect(await notificationsFor(SEED_USERS.rmvfcAdmin)).toEqual([]);
    });

    it('gives an unauthenticated visitor nothing', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select id from public.notifications')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('gives a client no write path', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.notifications
               (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
             values ($1,$2,'match_published','Forged','Body','/dashboard','forged-key-1234')`,
            [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('gives a client no way to call the fanout helpers', async () => {
      // These two are the unchecked writers: one addresses an arbitrary user,
      // the other a whole league. Granting either to `authenticated` would let
      // any signed-in user forge notifications for anybody.
      const createError = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.create_notification($1::uuid, $2::uuid, 'match_published',
                                               't', 'b', '/dashboard', 'k1234567')`,
            [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc],
          ),
        ),
      );

      const fanoutError = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.notify_league_members($1::uuid, 'match_published',
                                                 't', 'b', '/dashboard', 'k1234567')`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );

      expect(createError.code).toBe(PG_ERROR.insufficientPrivilege);
      expect(fanoutError.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('read state', () => {
    it('marks one as read, and is idempotent', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const notificationId = (await notificationsFor(SEED_USERS.rmvfcPlayer))[0]?.id ?? '';

      const first = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        await client.query('select public.mark_notification_read($1)', [notificationId]);
        const result = await client.query<{ read_at: Date }>(
          'select read_at from public.notifications where id = $1',
          [notificationId],
        );
        return result.rows[0]?.read_at;
      });

      const second = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        await client.query('select public.mark_notification_read($1)', [notificationId]);
        const result = await client.query<{ read_at: Date }>(
          'select read_at from public.notifications where id = $1',
          [notificationId],
        );
        return result.rows[0]?.read_at;
      });

      expect(first).not.toBeNull();
      expect(second).toEqual(first);
    });

    it('refuses to mark somebody else’s notification', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const notificationId = (await notificationsFor(SEED_USERS.rmvfcPlayer))[0]?.id ?? '';

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select public.mark_notification_read($1)', [notificationId]),
        ),
      );
      // Reported exactly as an id that does not exist.
      expect(error.message).toContain('NOTIFICATION_NOT_FOUND');
    });

    it('marks all of the caller’s own, and only those', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const marked = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ n: number }>(
          'select public.mark_all_notifications_read() as n',
        );
        return result.rows[0]?.n;
      });
      expect(marked).toBe(1);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where recipient_user_id = $1 and read_at is null`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  describe('Phase 2 integration', () => {
    it('notifies the administrator of a new join request', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.request_to_join_league($1)', [SEED_LEAGUES.weeknightFives]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string; type: string }>(
        `select recipient_user_id, type from public.notifications
          where type = 'join_request_submitted'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(SEED_USERS.fivesAdmin.id);
    });

    it('notifies the applicant when approved, deep-linking into the league', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string; deep_link: string }>(
        `select recipient_user_id, deep_link from public.notifications
          where type = 'join_request_approved'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(SEED_USERS.outsider.id);
      expect(rows[0]?.deep_link).toBe('/leagues/weeknight-5v5/matches');
    });

    it('notifies the applicant when rejected, deep-linking to discovery', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, false)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ deep_link: string }>(
        `select deep_link from public.notifications where type = 'join_request_rejected'`,
      );
      // A rejected applicant has no membership, so the link must not point at
      // member-only content.
      expect(rows[0]?.deep_link).toBe('/leagues/discover');
    });

    it('does not notify twice when a decision is repeated', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
          client.query('select public.decide_join_request($1, true)', [
            SEED_JOIN_REQUESTS.outsiderToFives,
          ]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'join_request_approved'`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('notifies the administrator when an invitation is redeemed', async () => {
      await asUserCommitting(db, SEED_USERS.outsider, (client) =>
        client.query('select public.redeem_league_invite($1)', [
          'matchday-local-development-invite-token-0001',
        ]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string }>(
        `select recipient_user_id from public.notifications
          where type = 'league_invitation_accepted'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
    });

    it('does not notify again when the same person re-opens the link', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.outsider, (client) =>
          client.query('select public.redeem_league_invite($1)', [
            'matchday-local-development-invite-token-0001',
          ]),
        );
      }

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'league_invitation_accepted'`,
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  describe('deep links are always local paths', () => {
    it('rejects an absolute or protocol-relative link at the schema level', async () => {
      for (const link of ['https://evil.example/x', '//evil.example', '/\\evil.example']) {
        const error = await expectDatabaseError(() =>
          db.pool.query(
            `insert into public.notifications
               (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
             values ($1,$2,'match_published','t','b',$3,'key-' || gen_random_uuid()::text)`,
            [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc, link],
          ),
        );
        expect(error.code).toBe(PG_ERROR.checkViolation);
      }
    });
  });
});
