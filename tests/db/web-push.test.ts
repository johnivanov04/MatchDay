import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asServiceRole,
  asServiceRoleCommitting,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

const ENDPOINT_A = 'https://push.example.test/endpoint/aaaaaaaaaaaaaaaaaaaa';
const ENDPOINT_B = 'https://push.example.test/endpoint/bbbbbbbbbbbbbbbbbbbb';

describe('web push subscriptions and delivery', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function subscribe(
    user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    endpoint: string,
    label = 'Test device',
  ): Promise<string> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<{ id: string }>(
        'select public.register_push_subscription($1,$2,$3,$4) as id',
        [endpoint, 'p256dh-key-value-1234567890', 'auth-secret-1234', label],
      );
      return result.rows[0]?.id ?? '';
    });
  }

  describe('credentials are write-only', () => {
    it('never lets a user read back the endpoint or keys', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      for (const column of ['endpoint', 'p256dh', 'auth_secret']) {
        const error = await expectDatabaseError(() =>
          asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
            client.query(`select ${column} from public.push_subscriptions`),
          ),
        );
        // Together these three are a bearer credential for that device.
        expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
      }
    });

    it('rejects `select *`, which would include them', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.push_subscriptions'),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('lets a user read their own device metadata', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A, 'iPhone');

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ device_label: string; enabled: boolean }>(
          'select device_label, enabled from public.push_subscriptions',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.device_label).toBe('iPhone');
    });

    it('lets the service role read the credentials — it is the only thing that can', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      const rows = await asServiceRole(db, async (client) => {
        const result = await client.query<{ endpoint: string }>(
          'select endpoint from public.push_subscriptions',
        );
        return result.rows;
      });
      expect(rows[0]?.endpoint).toBe(ENDPOINT_A);
    });
  });

  describe('ownership and isolation', () => {
    it('shows a user only their own devices', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      await subscribe(SEED_USERS.multiLeaguePlayer, ENDPOINT_B);

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ user_id: string }>(
          'select user_id from public.push_subscriptions',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(SEED_USERS.rmvfcPlayer.id);
    });

    it('supports several devices for one person', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A, 'iPhone');
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_B, 'Laptop');

      const labels = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ device_label: string }>(
          'select device_label from public.push_subscriptions order by device_label',
        );
        return result.rows.map((row) => row.device_label);
      });

      expect([...labels].sort()).toEqual(['Laptop', 'iPhone'].sort());
    });

    it('treats a re-subscribe of the same endpoint as an update', async () => {
      const first = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A, 'iPhone');
      const second = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A, 'iPhone');

      expect(second).toBe(first);

      const { rows } = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.push_subscriptions',
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('reassigns an endpoint when a shared device changes hands', async () => {
      await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      await subscribe(SEED_USERS.multiLeaguePlayer, ENDPOINT_A);

      const { rows } = await db.pool.query<{ user_id: string; count: string }>(
        `select user_id, count(*) over ()::text as count from public.push_subscriptions`,
      );

      // The endpoint belongs to whoever most recently granted permission on
      // that device; the previous owner must not keep receiving their alerts.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(SEED_USERS.multiLeaguePlayer.id);
    });

    it('refuses to disable or remove somebody else’s device', async () => {
      const id = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select public.set_push_subscription_enabled($1, false)', [id]),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');

      // Removal is idempotent, so it does not raise — but it must not delete.
      await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
        client.query('select public.remove_push_subscription($1)', [id]),
      );

      const { rows } = await db.pool.query('select id from public.push_subscriptions where id = $1', [
        id,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('gives a client no direct write path', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_secret)
             values ($1, $2, 'k', 'a')`,
            [SEED_USERS.rmvfcPlayer.id, ENDPOINT_A],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('gives an anonymous visitor nothing', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select id from public.push_subscriptions')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('enable and remove', () => {
    it('turns a device off and on again', async () => {
      const id = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.set_push_subscription_enabled($1, false)', [id]),
      );

      const off = await db.pool.query<{ enabled: boolean; disabled_reason: string }>(
        'select enabled, disabled_reason from public.push_subscriptions where id = $1',
        [id],
      );
      expect(off.rows[0]?.enabled).toBe(false);
      expect(off.rows[0]?.disabled_reason).toBe('user_disabled');

      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.set_push_subscription_enabled($1, true)', [id]),
      );

      const on = await db.pool.query<{ enabled: boolean }>(
        'select enabled from public.push_subscriptions where id = $1',
        [id],
      );
      expect(on.rows[0]?.enabled).toBe(true);
    });

    it('removes idempotently', async () => {
      const id = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.remove_push_subscription($1)', [id]),
        );
      }

      const { rows } = await db.pool.query('select id from public.push_subscriptions');
      expect(rows).toEqual([]);
    });
  });

  describe('delivery bookkeeping', () => {
    async function aNotificationFor(
      user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    ): Promise<string> {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ id: string }>(
        'select id from public.notifications where recipient_user_id = $1 limit 1',
        [user.id],
      );
      return rows[0]?.id ?? '';
    }

    it('records a successful delivery and clears the failure counter', async () => {
      const subscriptionId = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      await asServiceRoleCommitting(db, (client) =>
        client.query(`select public.record_push_delivery_result($1,$2,'sent')`, [
          notificationId,
          subscriptionId,
        ]),
      );

      const attempt = await db.pool.query<{
        status: string;
        attempt_count: number;
        delivered_at: Date | null;
      }>(
        'select status, attempt_count, delivered_at from public.push_delivery_attempts',
      );
      expect(attempt.rows[0]).toMatchObject({ status: 'sent', attempt_count: 1 });
      expect(attempt.rows[0]?.delivered_at).not.toBeNull();

      const subscription = await db.pool.query<{
        consecutive_failures: number;
        last_success_at: Date | null;
      }>(
        'select consecutive_failures, last_success_at from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      expect(subscription.rows[0]?.consecutive_failures).toBe(0);
      expect(subscription.rows[0]?.last_success_at).not.toBeNull();
    });

    it('is idempotent per notification and subscription', async () => {
      const subscriptionId = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await asServiceRoleCommitting(db, (client) =>
          client.query(`select public.record_push_delivery_result($1,$2,'sent')`, [
            notificationId,
            subscriptionId,
          ]),
        );
      }

      const { rows } = await db.pool.query<{ count: string; attempt_count: number }>(
        'select count(*)::text as count, max(attempt_count) as attempt_count from public.push_delivery_attempts',
      );
      // One row, three recorded attempts — the same alert can never land on the
      // same phone twice.
      expect(rows[0]?.count).toBe('1');
      expect(rows[0]?.attempt_count).toBe(3);
    });

    it('counts temporary failures and retires an endpoint after enough of them', async () => {
      const subscriptionId = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await asServiceRoleCommitting(db, (client) =>
          client.query(
            `select public.record_push_delivery_result($1,$2,'temporary_failure','server_error')`,
            [notificationId, subscriptionId],
          ),
        );
      }

      const { rows } = await db.pool.query<{ enabled: boolean; disabled_reason: string }>(
        'select enabled, disabled_reason from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      // Silently dead endpoints never return 410; they just keep timing out.
      expect(rows[0]?.enabled).toBe(false);
      expect(rows[0]?.disabled_reason).toBe('repeated_failures');
    });

    it('retires the device immediately when the endpoint is gone', async () => {
      const subscriptionId = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `select public.record_push_delivery_result($1,$2,'invalidated','gone')`,
          [notificationId, subscriptionId],
        ),
      );

      const { rows } = await db.pool.query<{ enabled: boolean; disabled_reason: string }>(
        'select enabled, disabled_reason from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      expect(rows[0]?.enabled).toBe(false);
      expect(rows[0]?.disabled_reason).toBe('endpoint_gone');
    });

    it('stores only an error category, never a provider response', async () => {
      const subscriptionId = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            `select public.record_push_delivery_result($1,$2,'temporary_failure',$3)`,
            [
              notificationId,
              subscriptionId,
              'HTTP 500 from https://push.example.test/endpoint/secret',
            ],
          ),
        ),
      );

      // The column's format check refuses anything that is not a short
      // lower-case category, so an endpoint cannot be smuggled into it.
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('lets a user see delivery status for their own device only', async () => {
      const mine = await subscribe(SEED_USERS.rmvfcPlayer, ENDPOINT_A);
      const theirs = await subscribe(SEED_USERS.multiLeaguePlayer, ENDPOINT_B);
      const notificationId = await aNotificationFor(SEED_USERS.rmvfcPlayer);

      for (const subscriptionId of [mine, theirs]) {
        await asServiceRoleCommitting(db, (client) =>
          client.query(`select public.record_push_delivery_result($1,$2,'sent')`, [
            notificationId,
            subscriptionId,
          ]),
        );
      }

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ subscription_id: string }>(
          'select subscription_id from public.push_delivery_attempts',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.subscription_id).toBe(mine);
    });

    it('gives a client no way to record a delivery result', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `select public.record_push_delivery_result($1::uuid,$2::uuid,'sent')`,
            [SEED_MATCHES.rmvfcOpen, SEED_MATCHES.rmvfcOpen],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('push never blocks the domain', () => {
    it('leaves the canonical notification intact when nothing was delivered', async () => {
      // No subscriptions exist at all — the closest database-level equivalent
      // of "every push failed".
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const notifications = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      const match = await db.pool.query<{ status: string }>(
        'select status from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      const attempts = await db.pool.query('select id from public.push_delivery_attempts');

      expect(notifications.rows[0]?.count).toBe('2');
      expect(match.rows[0]?.status).toBe('open');
      expect(attempts.rows).toEqual([]);
    });
  });
});
