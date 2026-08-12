import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_USERS,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 5K — the rest of the notification centre.
 *
 * Phase 3 shipped mark-read and deliberately deferred these, noting that
 * `read_at` and `archived_at` were already on the table so they would be
 * additions rather than a migration.
 *
 * The archive semantics were already decided by the reads: `getMyNotifications`
 * filters `archived_at is null` and `getUnreadNotificationCount` filters both
 * columns. These tests hold the mutations to that contract.
 */
describe('notification inbox', () => {
  let db: TestDatabase;
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');

    // Two notifications addressed to two different people.
    const insert = async (recipient: string, key: string) => {
      const { rows } = await db.pool.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
         values ($1, $2, 'match_published', 'A match', 'Tonight', '/dashboard', $3)
         returning id`,
        [recipient, SEED_LEAGUES.rmvfc, key],
      );
      return rows[0]!.id;
    };

    mine = await insert(SEED_USERS.rmvfcPlayer.id, 'inbox-test-mine');
    theirs = await insert(SEED_USERS.multiLeaguePlayer.id, 'inbox-test-theirs');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function call(user: SeedUser, fn: string, id: string) {
    return asUserCommitting(db, user, (client) =>
      client.query(`select public.${fn}($1)`, [id]),
    );
  }

  async function stateOf(id: string) {
    const { rows } = await db.pool.query<{
      read_at: string | null;
      archived_at: string | null;
    }>(
      // Cast to text: pg hands back Date objects, and two Dates holding the
      // same instant are not identical, so a timestamp comparison would fail
      // for the wrong reason.
      `select read_at::text as read_at, archived_at::text as archived_at
         from public.notifications where id = $1`,
      [id],
    );
    return rows[0]!;
  }

  /** What the inbox query returns, mirroring `getMyNotifications`. */
  async function inboxFor(user: SeedUser) {
    return asUser(db, user, async (client) => {
      const result = await client.query<{ id: string }>(
        'select id from public.notifications where archived_at is null',
      );
      return result.rows.map((row) => row.id);
    });
  }

  /** The unread badge, mirroring `getUnreadNotificationCount`. */
  async function unreadCountFor(user: SeedUser) {
    return asUser(db, user, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where read_at is null and archived_at is null`,
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  describe('mark read and unread', () => {
    it('marks read, then unread again', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', mine);
      expect((await stateOf(mine)).read_at).not.toBeNull();

      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_unread', mine);
      expect((await stateOf(mine)).read_at).toBeNull();
    });

    it('is idempotent in both directions', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', mine);
      const first = (await stateOf(mine)).read_at;
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', mine);
      // `coalesce(read_at, now())` keeps the original timestamp.
      expect((await stateOf(mine)).read_at).toBe(first);

      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_unread', mine);
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_unread', mine);
      expect((await stateOf(mine)).read_at).toBeNull();
    });

    it('moves the unread count with it', async () => {
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(1);
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', mine);
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(0);
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_unread', mine);
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(1);
    });
  });

  describe('archive', () => {
    it('removes the notification from the active inbox', async () => {
      expect(await inboxFor(SEED_USERS.rmvfcPlayer)).toEqual([mine]);
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      expect(await inboxFor(SEED_USERS.rmvfcPlayer)).toEqual([]);
    });

    it('removes it from the unread count without marking it read', async () => {
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(1);
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);

      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(0);
      // "I am done with this" is not the claim "I read this". Overwriting
      // read_at would destroy the only record of whether they ever did.
      expect((await stateOf(mine)).read_at).toBeNull();
    });

    it('preserves an existing read timestamp', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', mine);
      const readAt = (await stateOf(mine)).read_at;

      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      expect((await stateOf(mine)).read_at).toBe(readAt);
    });

    it('is idempotent, keeping the first archive timestamp', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      const first = (await stateOf(mine)).archived_at;
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      expect((await stateOf(mine)).archived_at).toBe(first);
    });

    it('deletes nothing — the row survives for history', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);

      const { rows } = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.notifications where id = $1',
        [mine],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('can be restored', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      await call(SEED_USERS.rmvfcPlayer, 'unarchive_notification', mine);

      expect((await stateOf(mine)).archived_at).toBeNull();
      expect(await inboxFor(SEED_USERS.rmvfcPlayer)).toEqual([mine]);
    });

    it('restores an unread notification to the unread count', async () => {
      await call(SEED_USERS.rmvfcPlayer, 'archive_notification', mine);
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(0);

      await call(SEED_USERS.rmvfcPlayer, 'unarchive_notification', mine);
      expect(await unreadCountFor(SEED_USERS.rmvfcPlayer)).toBe(1);
    });
  });

  describe('ownership', () => {
    it.each(['mark_notification_read', 'mark_notification_unread', 'archive_notification', 'unarchive_notification'])(
      '%s refuses another user’s notification',
      async (fn) => {
        const error = await expectDatabaseError(() =>
          call(SEED_USERS.rmvfcPlayer, fn, theirs),
        );
        // Scoped by recipient in the WHERE clause, so this is a miss — the same
        // answer an identifier that does not exist would get.
        expect(error.message).toContain('NOTIFICATION_NOT_FOUND');
      },
    );

    it('leaves the other user’s notification untouched', async () => {
      await expectDatabaseError(() =>
        call(SEED_USERS.rmvfcPlayer, 'archive_notification', theirs),
      );
      await expectDatabaseError(() =>
        call(SEED_USERS.rmvfcPlayer, 'mark_notification_read', theirs),
      );

      const state = await stateOf(theirs);
      expect(state.read_at).toBeNull();
      expect(state.archived_at).toBeNull();
    });

    it('reports a missing notification the same way as somebody else’s', async () => {
      const unknown = await expectDatabaseError(() =>
        call(SEED_USERS.rmvfcPlayer, 'archive_notification', '00000000-0000-4000-8000-000000000000'),
      );
      const other = await expectDatabaseError(() =>
        call(SEED_USERS.rmvfcPlayer, 'archive_notification', theirs),
      );
      expect(unknown.message).toBe(other.message);
    });

    it('shows a user only their own notifications', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ id: string }>('select id from public.notifications');
        return result.rows.map((row) => row.id);
      });
      expect(rows).toEqual([mine]);
    });

    it('refuses a direct update, even of your own row', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('update public.notifications set read_at = now() where id = $1', [mine]),
        ),
      );
      // No UPDATE policy exists: the functions are the only mutation path, so
      // `archived_at` and `idempotency_key` cannot be tampered with.
      expect(error.code).toBe('42501');
    });
  });
});
