import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * `provider_message_id` — the identifier the push provider gave an attempt.
 *
 * The column is evidence, not product state: nothing reads it, and its whole
 * value is that a question about one notification can be answered later.
 * What these prove is that recording it did not disturb the delivery state
 * machine, which is the part that decides whether somebody's phone stays
 * subscribed.
 */

const APNS_ID = '8B2E0B0E-4C3D-4F1A-9E77-2A6D5C1B0F42';

describe('recording a provider message id', () => {
  let db: TestDatabase;
  let subscriptionId: string;
  let notificationId: string;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');

    const registered = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
      client.query<{ register_apns_device: string }>(
        'select public.register_apns_device($1, $2, $3, $4)',
        [
          'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
          'production',
          'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
          null,
        ],
      ),
    );
    subscriptionId = registered.rows[0]?.register_apns_device ?? '';

    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
    );
    const notification = await db.pool.query<{ id: string }>(
      `select id from public.notifications
        where recipient_user_id = $1 and type = 'match_published' limit 1`,
      [SEED_USERS.rmvfcPlayer.id],
    );
    notificationId = notification.rows[0]?.id ?? '';
  });

  afterEach(async () => {
    await db.drop();
  });

  async function record(
    status: string,
    category: string | null,
    providerMessageId: string | null,
  ) {
    await db.pool.query('select public.record_push_delivery_result($1, $2, $3, $4, $5)', [
      notificationId,
      subscriptionId,
      status,
      category,
      providerMessageId,
    ]);
  }

  async function attempt() {
    const { rows } = await db.pool.query<{
      status: string;
      provider_message_id: string | null;
      attempt_count: number;
    }>(
      'select status::text, provider_message_id, attempt_count from public.push_delivery_attempts where notification_id = $1 and subscription_id = $2',
      [notificationId, subscriptionId],
    );
    return rows[0];
  }

  it('stores it on a successful delivery', async () => {
    await record('sent', null, APNS_ID);
    expect(await attempt()).toMatchObject({ status: 'sent', provider_message_id: APNS_ID });
  });

  it('stores it on a rejection', async () => {
    await record('invalidated', 'gone', APNS_ID);
    expect(await attempt()).toMatchObject({
      status: 'invalidated',
      provider_message_id: APNS_ID,
    });
  });

  it('accepts an attempt with no identifier at all', async () => {
    await record('sent', null, null);
    expect(await attempt()).toMatchObject({ status: 'sent', provider_message_id: null });
  });

  it('keeps the older identifier when a retry produces none', async () => {
    // A first attempt reached Apple and was rejected; the retry failed at the
    // socket. Losing the identifier of the attempt Apple actually saw would
    // discard the only thing worth quoting to them.
    await record('temporary_failure', 'server_error', APNS_ID);
    await record('temporary_failure', 'network', null);

    const row = await attempt();
    expect(row?.provider_message_id).toBe(APNS_ID);
    expect(row?.attempt_count).toBe(2);
  });

  it('takes the newer identifier when the retry has one', async () => {
    const second = '11111111-2222-4333-8444-555555555555';
    await record('temporary_failure', 'server_error', APNS_ID);
    await record('sent', null, second);

    expect(await attempt()).toMatchObject({ status: 'sent', provider_message_id: second });
  });

  describe('the delivery state machine is unchanged', () => {
    it('sent still clears the failure counter and stamps success', async () => {
      await record('sent', null, APNS_ID);
      const { rows } = await db.pool.query<{
        enabled: boolean;
        consecutive_failures: number;
        last_success_at: string | null;
      }>(
        'select enabled, consecutive_failures, last_success_at from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      expect(rows[0]?.enabled).toBe(true);
      expect(rows[0]?.consecutive_failures).toBe(0);
      expect(rows[0]?.last_success_at).not.toBeNull();
    });

    it('invalidated still retires the device', async () => {
      await record('invalidated', 'gone', APNS_ID);
      const { rows } = await db.pool.query<{ enabled: boolean; disabled_reason: string | null }>(
        'select enabled, disabled_reason from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      expect(rows[0]).toEqual({ enabled: false, disabled_reason: 'endpoint_gone' });
    });

    it('permanent_failure still leaves the device alone', async () => {
      await record('permanent_failure', 'unauthorized', APNS_ID);
      const { rows } = await db.pool.query<{ enabled: boolean; consecutive_failures: number }>(
        'select enabled, consecutive_failures from public.push_subscriptions where id = $1',
        [subscriptionId],
      );
      expect(rows[0]).toEqual({ enabled: true, consecutive_failures: 0 });
    });
  });

  it('rejects an identifier that is not a plain token', async () => {
    // Provider-supplied and stored, so it is constrained on the way in rather
    // than trusted at render time.
    for (const bad of ['has space', 'has\nnewline', "quote'", 'x'.repeat(129)]) {
      const error = await expectDatabaseError(() => record('sent', null, bad));
      expect(error.code).toBe(PG_ERROR.checkViolation);
    }
  });
});

describe('the function signature', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it('exists exactly once, so a four-argument call is unambiguous', async () => {
    /**
     * Adding a defaulted parameter creates a second signature rather than
     * replacing the first, and PostgreSQL then refuses a four-argument call as
     * ambiguous — which would take the whole dispatcher down. The migration
     * drops the old signature for this reason.
     */
    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_push_delivery_result'`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('keeps EXECUTE for service_role and nobody else', async () => {
    const { rows } = await db.pool.query<{
      authenticated: boolean;
      service_role: boolean;
      anon: boolean;
    }>(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
              has_function_privilege('anon', p.oid, 'EXECUTE')          as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_push_delivery_result'`,
    );
    expect(rows[0]).toEqual({ authenticated: false, service_role: true, anon: false });
  });
});
