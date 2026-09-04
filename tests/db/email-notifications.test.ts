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
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 3D against real PostgreSQL.
 *
 * Two things can only be tested here: that a preference is genuinely somebody's
 * own under RLS, and that recipient resolution reads `auth.users` correctly —
 * including the verification state, which `profiles.email_normalized` knows
 * nothing about.
 */

describe('email notifications', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function notificationFor(user: { id: string }, key: string): Promise<string> {
    return asServiceRoleCommitting(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link,
            idempotency_key, delivery_metadata)
         values ($1, $2, 'match_published', 'T', 'B', '/leagues/x/matches/y', $3,
                 jsonb_build_object('push_eligible', true))
         returning id`,
        [user.id, SEED_LEAGUES.rmvfc, key],
      );
      return rows[0]!.id;
    });
  }

  async function setPreference(user: { id: string; email: string }, enabled: boolean) {
    await asUserCommitting(db, user, (client) =>
      client.query(
        `insert into public.notification_preferences (user_id, email_enabled)
         values ($1, $2)
         on conflict (user_id) do update set email_enabled = excluded.email_enabled`,
        [user.id, enabled],
      ),
    );
  }

  async function resolve(notificationId: string): Promise<string | null> {
    return asServiceRole(db, async (client) => {
      const { rows } = await client.query<{ email: string | null }>(
        'select public.notification_email_recipient($1) as email',
        [notificationId],
      );
      return rows[0]?.email ?? null;
    });
  }

  // ── The opt-in ───────────────────────────────────────────────────────────

  describe('nobody is emailed because this shipped', () => {
    it('creates no preference rows at all', async () => {
      // The migration writes nothing. Absence means off, which is what let this
      // phase ship without a backfill and without emailing every member.
      const count = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_preferences',
        );
        return Number(rows[0]!.c);
      });

      expect(count).toBe(0);
    });

    it('resolves to nobody for a user who has never touched the setting', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-default-off-01');
      expect(await resolve(id)).toBeNull();
    });

    it('still resolves to nobody when the row exists but is off', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, false);
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-explicit-off-1');
      expect(await resolve(id)).toBeNull();
    });

    it('defaults the column to false when a row is inserted without one', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('insert into public.notification_preferences (user_id) values ($1)', [
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );

      const enabled = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ email_enabled: boolean }>(
          'select email_enabled from public.notification_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return rows[0]!.email_enabled;
      });

      expect(enabled).toBe(false);
    });

    it('does not backfill delivery obligations for notifications that already exist', async () => {
      // Enabling email is not a request for a fortnight of history. The old
      // notification's job reached a terminal state long ago; nothing reopens
      // it, and no email attempt row appears.
      const old = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-no-backfill-01');
      await setPreference(SEED_USERS.rmvfcPlayer, true);

      const attempts = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.email_delivery_attempts',
        );
        return Number(rows[0]!.c);
      });

      expect(attempts).toBe(0);
      // The notification is now resolvable — it just is not re-delivered,
      // because nothing claims a finished job.
      expect(await resolve(old)).not.toBeNull();
    });
  });

  // ── Whose preference it is ───────────────────────────────────────────────

  describe('the preference belongs to one person', () => {
    it('lets a member read and update their own', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, true);

      const seen = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query<{ email_enabled: boolean }>(
          'select email_enabled from public.notification_preferences',
        );
        return rows;
      });

      expect(seen).toEqual([{ email_enabled: true }]);
    });

    it('shows one member nothing of another member\'s preference', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, true);

      const seen = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query('select * from public.notification_preferences');
        return rows;
      });

      // Not an error — simply no rows. RLS filters rather than refuses.
      expect(seen).toHaveLength(0);
    });

    it('refuses one member switching email ON for another', async () => {
      // The attack that matters: subscribing somebody else to email they never
      // asked for. The insert policy's WITH CHECK is what stops it.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            'insert into public.notification_preferences (user_id, email_enabled) values ($1, true)',
            [SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('silently matches no rows when one member tries to update another', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, false);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          'update public.notification_preferences set email_enabled = true where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        ),
      );

      const stillOff = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ email_enabled: boolean }>(
          'select email_enabled from public.notification_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return rows[0]!.email_enabled;
      });

      expect(stillOff).toBe(false);
    });

    it('shows an unauthenticated visitor nothing', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, true);

      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select * from public.notification_preferences')),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ── Recipient resolution ─────────────────────────────────────────────────

  describe('who the email actually goes to', () => {
    it('resolves the account address when the switch is on and the address is confirmed', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, true);
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-resolve-ok-01');

      expect(await resolve(id)).toBe(SEED_USERS.rmvfcPlayer.email);
    });

    it('resolves to nobody when the address is UNVERIFIED', async () => {
      // An unverified address may belong to somebody else entirely. Sending
      // league activity to it would leak one person's matches to another's
      // inbox — which is why `profiles.email_normalized` is not the source:
      // it is a lowercased copy of a JWT claim and knows nothing about this.
      await setPreference(SEED_USERS.rmvfcPlayer, true);
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-unverified-01');

      // Through the pool, not as `service_role`: the auth schema is not one the
      // application roles may write, which is itself the reason recipient
      // resolution goes through a SECURITY DEFINER function.
      await db.pool.query('update auth.users set email_confirmed_at = null where id = $1', [
        SEED_USERS.rmvfcPlayer.id,
      ]);

      expect(await resolve(id)).toBeNull();
    });

    it('resolves to nobody once the account is being deleted', async () => {
      await setPreference(SEED_USERS.rmvfcPlayer, true);
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-deleting-01');

      await asServiceRoleCommitting(db, (client) =>
        client.query('update public.profiles set deletion_started_at = now() where id = $1', [
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );

      expect(await resolve(id)).toBeNull();
    });

    it('returns null rather than throwing for a notification that does not exist', async () => {
      expect(await resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    it('refuses an ordinary member entirely', async () => {
      // It returns somebody's email address. It is emphatically not something
      // a session may call.
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-rls-resolve-1');

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.notification_email_recipient($1)', [id]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ── Delivery bookkeeping ─────────────────────────────────────────────────

  describe('email delivery attempts', () => {
    async function record(
      notificationId: string,
      status: string,
      category: string | null = null,
      providerMessageId: string | null = null,
    ) {
      await asServiceRoleCommitting(db, (client) =>
        client.query('select public.record_email_delivery_result($1, $2, $3, $4)', [
          notificationId,
          status,
          category,
          providerMessageId,
        ]),
      );
    }

    async function attempt(notificationId: string) {
      return asServiceRole(db, async (client) => {
        const { rows } = await client.query(
          `select status::text as status, attempt_count, last_error_category,
                  provider_message_id, sent_at
             from public.email_delivery_attempts where notification_id = $1`,
          [notificationId],
        );
        return rows[0];
      });
    }

    it('creates one row and increments attempt_count on each real request', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-01');

      await record(id, 'temporary_failure', 'rate_limited');
      expect(await attempt(id)).toMatchObject({
        status: 'temporary_failure',
        attempt_count: 1,
        last_error_category: 'rate_limited',
      });

      await record(id, 'temporary_failure', 'server_error');
      expect(await attempt(id)).toMatchObject({ attempt_count: 2 });
    });

    it('never creates a duplicate row for one notification', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-02');
      for (let i = 0; i < 4; i += 1) {
        await record(id, 'temporary_failure', 'network');
      }

      const count = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.email_delivery_attempts where notification_id = $1',
          [id],
        );
        return Number(rows[0]!.c);
      });

      expect(count).toBe(1);
    });

    it('refuses a second row for the same notification outright', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-03');
      await record(id, 'sent');

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            `insert into public.email_delivery_attempts (notification_id, status, sent_at)
             values ($1, 'sent', now())`,
            [id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('moves a temporary failure to sent, stamping sent_at', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-04');
      await record(id, 'temporary_failure', 'rate_limited');
      await record(id, 'sent', null, 'resend-msg-0001');

      const row = await attempt(id);
      expect(row).toMatchObject({
        status: 'sent',
        attempt_count: 2,
        provider_message_id: 'resend-msg-0001',
      });
      expect(row.sent_at).not.toBeNull();
    });

    it('does not erase a provider_message_id a later attempt did not supply', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-05');
      await record(id, 'temporary_failure', 'server_error', 'resend-msg-0002');
      await record(id, 'temporary_failure', 'timeout', null);

      expect((await attempt(id)).provider_message_id).toBe('resend-msg-0002');
    });

    it('refuses a category that is a provider response rather than a category', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-06');

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query('select public.record_email_delivery_result($1, $2, $3, null)', [
            id,
            'permanent_failure',
            'Invalid `to` field: player@example.test',
          ]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('stores no recipient address column at all', async () => {
      // Deliberate: a copy of somebody's email here would sit outside
      // `auth.users`, where account deletion already knows how to scrub it.
      const columns = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema='public' and table_name='email_delivery_attempts'`,
        );
        return rows.map((r) => r.column_name);
      });

      expect(columns).not.toContain('recipient_email');
      expect(columns.filter((c) => c.includes('email'))).toEqual([]);
    });

    it('is invisible to ordinary members', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.email_delivery_attempts'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses the bookkeeping RPC to ordinary members', async () => {
      const id = await notificationFor(SEED_USERS.rmvfcPlayer, 'email-attempts-07');

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query("select public.record_email_delivery_result($1, 'sent', null, null)", [id]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});
