import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asServiceRole,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * APNs device registration.
 *
 * The interesting cases are all about identity: a device token is not stable,
 * an installation is, and the two can come apart in both directions. Most of
 * what follows exercises a way they come apart.
 */

const TOKEN_A = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const TOKEN_B = '0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C4B5A69788796A5B4C3D2E1F0';
const INSTALL_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const INSTALL_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface DeviceRow {
  id: string;
  user_id: string;
  channel: string;
  device_token: string | null;
  apns_environment: string | null;
  installation_id: string | null;
  enabled: boolean;
  device_label: string | null;
}

describe('APNs device registration', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  /** Every APNs row in the database, service-role, so credentials are visible. */
  async function devices(): Promise<DeviceRow[]> {
    const { rows } = await db.pool.query<DeviceRow>(
      `select id, user_id, channel, device_token, apns_environment, installation_id,
              enabled, device_label
         from public.push_subscriptions
        where channel = 'apns'
        order by installation_id`,
    );
    return rows;
  }

  function register(
    user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    token: string,
    environment: 'development' | 'production',
    installation: string,
    label: string | null = null,
  ) {
    return asUserCommitting(db, user, (client) =>
      client.query('select public.register_apns_device($1, $2, $3, $4)', [
        token,
        environment,
        installation,
        label,
      ]),
    );
  }

  it('registers a device to the caller', async () => {
    await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_A, 'Sam’s iPhone');

    expect(await devices()).toEqual([
      expect.objectContaining({
        user_id: SEED_USERS.rmvfcPlayer.id,
        channel: 'apns',
        device_token: TOKEN_A,
        apns_environment: 'production',
        installation_id: INSTALL_A,
        enabled: true,
        device_label: 'Sam’s iPhone',
      }),
    ]);
  });

  it('is not callable by the anon role at all', async () => {
    // Stopped by the EXECUTE grant, before the function's own guard — which is
    // the stronger of the two statements, and the reason the message is
    // "permission denied for function" rather than AUTH_REQUIRED.
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) =>
        client.query('select public.register_apns_device($1, $2, $3, $4)', [
          TOKEN_A,
          'production',
          INSTALL_A,
          null,
        ]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('refuses a caller that may execute it but has no session', async () => {
    // `service_role` holds EXECUTE and reaches the body, so this is the
    // AUTH_REQUIRED guard itself talking. Without it, `user_id` would be null
    // and the insert would fail with a constraint violation instead of an
    // intelligible error.
    const error = await expectDatabaseError(() =>
      asServiceRole(db, (client) =>
        client.query('select public.register_apns_device($1, $2, $3, $4)', [
          TOKEN_A,
          'production',
          INSTALL_A,
          null,
        ]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    expect(error.message).toContain('AUTH_REQUIRED');
  });

  describe('when APNs rotates the token', () => {
    /**
     * The case the installation id exists for. A rotated token is simply a new
     * value, so nothing about re-registering it collides with the row holding
     * the old one — keyed on the token alone, every rotation would leave an
     * orphan addressed to a token that no longer resolves.
     */
    it('updates the existing row rather than adding a second', async () => {
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_A);
      await register(SEED_USERS.rmvfcPlayer, TOKEN_B, 'production', INSTALL_A);

      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.device_token).toBe(TOKEN_B);
      expect(rows[0]?.installation_id).toBe(INSTALL_A);
    });

    it('keeps the label the player already had', async () => {
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_A, 'Sam’s iPhone');
      await register(SEED_USERS.rmvfcPlayer, TOKEN_B, 'production', INSTALL_A, null);

      expect((await devices())[0]?.device_label).toBe('Sam’s iPhone');
    });
  });

  describe('when the installation id is lost but the token is not', () => {
    /**
     * Local storage cleared, or a reinstall onto a device APNs reissued the
     * same token for. The old row still names this exact device, so leaving it
     * would deliver every notification twice.
     */
    it('releases the token from the installation that no longer claims it', async () => {
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_A);
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_B);

      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.installation_id).toBe(INSTALL_B);
    });
  });

  describe('environment is part of the token’s identity', () => {
    /**
     * A development token and a production token are minted by different
     * issuers and nothing guarantees they cannot coincide. A global
     * unique(device_token) would make one silently evict the other.
     */
    it('lets the same token exist once per environment', async () => {
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'development', INSTALL_A);
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_B);

      const rows = await devices();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.apns_environment).sort()).toEqual([
        'development',
        'production',
      ]);
    });

    it('moves an installation between environments in place', async () => {
      // A development build replaced by a TestFlight one: same installation,
      // new token, new environment.
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'development', INSTALL_A);
      await register(SEED_USERS.rmvfcPlayer, TOKEN_B, 'production', INSTALL_A);

      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.apns_environment).toBe('production');
    });
  });

  describe('when a device changes hands', () => {
    it('transfers ownership instead of leaving the previous account subscribed', async () => {
      await register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', INSTALL_A);
      await register(SEED_USERS.multiLeaguePlayer, TOKEN_A, 'production', INSTALL_A);

      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(SEED_USERS.multiLeaguePlayer.id);
    });
  });

  describe('rejects a malformed token', () => {
    it.each([
      ['A1B2C3D', 'an odd number of hex digits, which is not a whole number of bytes'],
      ['A1B2C3G4', 'a non-hex character'],
      ['', 'nothing at all'],
      ['   ', 'whitespace'],
    ])('%s (%s)', async (token) => {
      const error = await expectDatabaseError(() =>
        register(SEED_USERS.rmvfcPlayer, token, 'production', INSTALL_A),
      );
      expect(error.message).toContain('INVALID_DEVICE_TOKEN');
      expect(await devices()).toEqual([]);
    });

    it('normalises case rather than rejecting it', async () => {
      // Hex is case-insensitive, so a lowercase token names the same bytes. It
      // is folded to the plugin's own `%02X` form on the way in, which is what
      // stops the unique index holding one device twice under two spellings.
      await register(SEED_USERS.rmvfcPlayer, 'a1b2c3d4', 'production', INSTALL_A);
      await register(SEED_USERS.rmvfcPlayer, 'A1B2C3D4', 'production', INSTALL_B);

      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.device_token).toBe('A1B2C3D4');
    });

    it('accepts a token that is not 64 characters long', async () => {
      // No exact length is asserted anywhere: Apple documents the token as
      // variable, and pinning a length would turn a future widening into a
      // simultaneous registration failure on every device.
      await register(SEED_USERS.rmvfcPlayer, 'AABBCCDD', 'production', INSTALL_A);
      expect((await devices())[0]?.device_token).toBe('AABBCCDD');
    });
  });

  describe('rejects a malformed installation id', () => {
    it.each([['short'], [''], ['has spaces in it'], ['x'.repeat(65)]])(
      '%s',
      async (installation) => {
        const error = await expectDatabaseError(() =>
          register(SEED_USERS.rmvfcPlayer, TOKEN_A, 'production', installation),
        );
        expect(error.message).toContain('INVALID_INSTALLATION_ID');
      },
    );
  });
});

describe('remove_apns_installation', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function countDevices(): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.push_subscriptions where channel = 'apns'`,
    );
    return Number(rows[0]?.count ?? '0');
  }

  function remove(
    user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    installation: string,
  ) {
    return asUserCommitting(db, user, (client) =>
      client.query('select public.remove_apns_installation($1)', [installation]),
    );
  }

  beforeEach(async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
      client.query('select public.register_apns_device($1, $2, $3, $4)', [
        TOKEN_A,
        'production',
        INSTALL_A,
        null,
      ]),
    );
  });

  it('removes the caller’s installation', async () => {
    await remove(SEED_USERS.rmvfcPlayer, INSTALL_A);
    expect(await countDevices()).toBe(0);
  });

  it('is idempotent', async () => {
    await remove(SEED_USERS.rmvfcPlayer, INSTALL_A);
    await remove(SEED_USERS.rmvfcPlayer, INSTALL_A);
    expect(await countDevices()).toBe(0);
  });

  it('says nothing and removes nothing for an installation id that does not exist', async () => {
    // Silent rather than an error: a distinguishing failure would tell a caller
    // whether an installation id exists.
    await remove(SEED_USERS.rmvfcPlayer, INSTALL_B);
    expect(await countDevices()).toBe(1);
  });

  it('cannot remove somebody else’s device, even knowing its installation id', async () => {
    await remove(SEED_USERS.multiLeaguePlayer, INSTALL_A);
    expect(await countDevices()).toBe(1);
  });

  it('refuses an unauthenticated caller', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) =>
        client.query('select public.remove_apns_installation($1)', [INSTALL_A]),
      ),
    );
    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });
});

describe('the device token is a credential', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
      client.query('select public.register_apns_device($1, $2, $3, $4)', [
        TOKEN_A,
        'production',
        INSTALL_A,
        null,
      ]),
    );
  });

  afterEach(async () => {
    await db.drop();
  });

  it.each(['device_token', 'apns_environment', 'installation_id'])(
    'cannot be read back by its own owner: %s',
    async (column) => {
      // Exactly the treatment `endpoint`, `p256dh` and `auth_secret` get. A
      // compromised session must not be able to walk away with the ability to
      // put notifications on somebody's lock screen.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(`select ${column} from public.push_subscriptions`),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    },
  );

  it('leaves the owner able to see that the device is theirs and is an app', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ channel: string; enabled: boolean }>(
        'select channel, enabled from public.push_subscriptions',
      );
      return result.rows;
    });

    expect(rows).toEqual([{ channel: 'apns', enabled: true }]);
  });
});

describe('the two channels cannot be mixed in one row', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it.each([
    [
      'an apns row carrying Web Push credentials',
      `insert into public.push_subscriptions
         (user_id, channel, device_token, apns_environment, installation_id, endpoint)
       values ($1, 'apns', '${TOKEN_A}', 'production', '${INSTALL_A}', 'https://push.example/x-endpoint')`,
    ],
    [
      'an apns row with no token',
      `insert into public.push_subscriptions
         (user_id, channel, apns_environment, installation_id)
       values ($1, 'apns', 'production', '${INSTALL_A}')`,
    ],
    [
      'an apns row with no environment',
      `insert into public.push_subscriptions
         (user_id, channel, device_token, installation_id)
       values ($1, 'apns', '${TOKEN_A}', '${INSTALL_A}')`,
    ],
    [
      'a web_push row that lost its keys when the columns became nullable',
      `insert into public.push_subscriptions (user_id, channel, endpoint)
       values ($1, 'web_push', 'https://push.example/x-endpoint')`,
    ],
    [
      'a web_push row carrying a device token',
      `insert into public.push_subscriptions
         (user_id, channel, endpoint, p256dh, auth_secret, device_token)
       values ($1, 'web_push', 'https://push.example/x-endpoint', 'p256dh-key-value', 'auth-sec', '${TOKEN_A}')`,
    ],
  ])('rejects %s', async (_label, sql) => {
    // Written as the service role, which bypasses RLS — so this is the
    // constraint itself talking, not a policy.
    const error = await expectDatabaseError(() =>
      db.pool.query(sql, [SEED_USERS.rmvfcPlayer.id]),
    );
    expect(error.code).toBe(PG_ERROR.checkViolation);
  });
});

describe('Web Push is unaffected', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it('still registers, and lands on the web_push channel without being told to', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
      client.query('select public.register_push_subscription($1, $2, $3, $4)', [
        'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop',
        'BPp256dhKeyValueHere',
        'authSecretValue',
        'Sam’s laptop',
      ]),
    );

    const { rows } = await db.pool.query<{ channel: string; device_token: string | null }>(
      'select channel, device_token from public.push_subscriptions',
    );
    expect(rows).toEqual([{ channel: 'web_push', device_token: null }]);
  });
});

describe('delivery bookkeeping treats an APNs row like any other', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it('retires the device when APNs says the token is gone', async () => {
    const { rows } = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ register_apns_device: string }>(
        'select public.register_apns_device($1, $2, $3, $4)',
        [TOKEN_A, 'production', INSTALL_A, null],
      );
      return result;
    });
    const subscriptionId = rows[0]?.register_apns_device;

    // The seed carries no notifications, so one is produced the way the
    // dispatcher would ever see it: by publishing a match.
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
    );
    const notification = await db.pool.query<{ id: string }>(
      `select id from public.notifications
        where recipient_user_id = $1 and type = 'match_published' limit 1`,
      [SEED_USERS.rmvfcPlayer.id],
    );
    expect(notification.rows).toHaveLength(1);

    await db.pool.query('select public.record_push_delivery_result($1, $2, $3, $4)', [
      notification.rows[0]?.id,
      subscriptionId,
      'invalidated',
      'unregistered',
    ]);

    const after = await db.pool.query<{ enabled: boolean; disabled_reason: string | null }>(
      'select enabled, disabled_reason from public.push_subscriptions where id = $1',
      [subscriptionId],
    );
    expect(after.rows[0]).toEqual({ enabled: false, disabled_reason: 'endpoint_gone' });
  });
});
