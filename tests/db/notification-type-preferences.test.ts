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
 * Phase 3E's resolver, against real PostgreSQL.
 *
 * The property this file exists to protect is the boring one: ABSENCE MEANS
 * ENABLED. A migration that defaulted to disabled — or a resolver that treated
 * a missing row as "no" — would silently stop notifications for every existing
 * member, and nobody would notice until somebody missed a match.
 */

describe('per-type delivery preferences', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function notify(
    user: { id: string },
    key: string,
    type = 'match_published',
  ): Promise<string> {
    return asServiceRoleCommitting(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link,
            idempotency_key, delivery_metadata)
         values ($1, $2, $3::public.notification_type, 'T', 'B', '/leagues/x/matches/y', $4,
                 jsonb_build_object('push_eligible', true))
         returning id`,
        [user.id, SEED_LEAGUES.rmvfc, type, key],
      );
      return rows[0]!.id;
    });
  }

  async function resolve(id: string): Promise<{ push: boolean; email: string | null }> {
    return asServiceRole(db, async (client) => {
      const { rows } = await client.query<{ push_allowed: boolean; email_address: string | null }>(
        'select push_allowed, email_address from public.notification_channel_eligibility($1)',
        [id],
      );
      return { push: rows[0]!.push_allowed, email: rows[0]!.email_address };
    });
  }

  async function setGlobal(user: { id: string; email: string }, enabled: boolean) {
    await asUserCommitting(db, user, (client) =>
      client.query(
        `insert into public.notification_preferences (user_id, email_enabled) values ($1, $2)
         on conflict (user_id) do update set email_enabled = excluded.email_enabled`,
        [user.id, enabled],
      ),
    );
  }

  async function setType(
    user: { id: string; email: string },
    type: string,
    channel: 'push' | 'email',
    enabled: boolean,
  ) {
    await asUserCommitting(db, user, (client) =>
      client.query(
        `insert into public.notification_type_preferences
           (user_id, notification_type, channel, enabled)
         values ($1, $2::public.notification_type, $3::public.notification_channel, $4)
         on conflict (user_id, notification_type, channel)
         do update set enabled = excluded.enabled`,
        [user.id, type, channel, enabled],
      ),
    );
  }

  // ── Defaults ─────────────────────────────────────────────────────────────

  describe('absence means enabled', () => {
    it('allows push with no rows anywhere', async () => {
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-default-push-1');
      expect((await resolve(id)).push).toBe(true);
    });

    it('still sends no email with no rows, because the global master is off', async () => {
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-default-mail-1');
      expect((await resolve(id)).email).toBeNull();
    });

    it('sends email once the global master is on and no override exists', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-default-mail-2');
      expect((await resolve(id)).email).toBe(SEED_USERS.rmvfcPlayer.email);
    });

    it('a Phase 3D opted-in account with zero type rows behaves exactly as before 3E', async () => {
      // This is production's actual state: one account with the global switch
      // on and no per-type rows at all. It must keep receiving precisely what
      // it received yesterday.
      await setGlobal(SEED_USERS.rmvfcPlayer, true);

      const rows = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_type_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return Number(rows[0]!.c);
      });
      expect(rows).toBe(0);

      // Every externally deliverable type still resolves to both channels.
      for (const type of ['match_published', 'reminder', 'waitlist_promotion', 'teams_published']) {
        const id = await notify(SEED_USERS.rmvfcPlayer, `pref-3d-parity-${type}`, type);
        const r = await resolve(id);
        expect(r.push, type).toBe(true);
        expect(r.email, type).toBe(SEED_USERS.rmvfcPlayer.email);
      }
    });

    it('creates no preference rows just by resolving', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-default-mail-3');
      await resolve(id);

      const count = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_type_preferences',
        );
        return Number(rows[0]!.c);
      });

      expect(count).toBe(0);
    });
  });

  // ── Explicit overrides ───────────────────────────────────────────────────

  describe('explicit overrides', () => {
    it('push false stops push and leaves email alone', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-push-off-1');

      const r = await resolve(id);
      expect(r.push).toBe(false);
      expect(r.email).toBe(SEED_USERS.rmvfcPlayer.email);
    });

    it('email false stops email and leaves push alone', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-mail-off-1');

      const r = await resolve(id);
      expect(r.push).toBe(true);
      expect(r.email).toBeNull();
    });

    it('both false leaves nothing owed', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-both-off-1');

      expect(await resolve(id)).toEqual({ push: false, email: null });
    });

    it('an explicit true behaves exactly like absence', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-both-on-1');

      expect(await resolve(id)).toEqual({ push: true, email: SEED_USERS.rmvfcPlayer.email });
    });

    it('an override applies only to its own type', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const other = await notify(SEED_USERS.rmvfcPlayer, 'pref-other-type-1', 'reminder');
      expect((await resolve(other)).push).toBe(true);
    });

    it('an override applies only to its own channel', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-other-channel-1');
      expect((await resolve(id)).email).not.toBeNull();
    });

    it('an override applies only to its own user', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setGlobal(SEED_USERS.rmvfcAdmin, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);

      const theirs = await notify(SEED_USERS.rmvfcAdmin, 'pref-other-user-1');
      expect((await resolve(theirs)).email).toBe(SEED_USERS.rmvfcAdmin.email);
    });
  });

  // ── The global master ────────────────────────────────────────────────────

  describe('the global email switch is the master', () => {
    it('off dominates a per-type email ON', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, false);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-master-off-1');

      expect((await resolve(id)).email).toBeNull();
    });

    it('turning it off does NOT erase per-type choices', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);
      await setType(SEED_USERS.rmvfcPlayer, 'reminder', 'email', true);
      await setGlobal(SEED_USERS.rmvfcPlayer, false);

      const rows = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_type_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return Number(rows[0]!.c);
      });

      expect(rows).toBe(2);
    });

    it('turning it back on restores exactly the previous choices', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);
      await setGlobal(SEED_USERS.rmvfcPlayer, false);
      await setGlobal(SEED_USERS.rmvfcPlayer, true);

      const off = await notify(SEED_USERS.rmvfcPlayer, 'pref-master-restore-1');
      const on = await notify(SEED_USERS.rmvfcPlayer, 'pref-master-restore-2', 'reminder');

      expect((await resolve(off)).email).toBeNull();
      expect((await resolve(on)).email).toBe(SEED_USERS.rmvfcPlayer.email);
    });

    it('never gates push, which has no global switch', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, false);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-master-push-1');

      expect((await resolve(id)).push).toBe(true);
    });
  });

  // ── The Phase 3D entry point still works ─────────────────────────────────

  describe('notification_email_recipient is unchanged for Phase 3D callers', () => {
    it('keeps its signature and returns the same address', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-3d-compat-1');

      const email = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ e: string | null }>(
          'select public.notification_email_recipient($1) as e',
          [id],
        );
        return rows[0]!.e;
      });

      expect(email).toBe(SEED_USERS.rmvfcPlayer.email);
    });

    it('now also honours a per-type override', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'email', false);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-3d-compat-2');

      const email = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ e: string | null }>(
          'select public.notification_email_recipient($1) as e',
          [id],
        );
        return rows[0]!.e;
      });

      expect(email).toBeNull();
    });

    it('still refuses unverified and deleting accounts', async () => {
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-3d-compat-3');

      await db.pool.query('update auth.users set email_confirmed_at = null where id = $1', [
        SEED_USERS.rmvfcPlayer.id,
      ]);
      expect((await resolve(id)).email).toBeNull();

      await db.pool.query('update auth.users set email_confirmed_at = now() where id = $1', [
        SEED_USERS.rmvfcPlayer.id,
      ]);
      await asServiceRoleCommitting(db, (client) =>
        client.query('update public.profiles set deletion_started_at = now() where id = $1', [
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect((await resolve(id)).email).toBeNull();
    });
  });

  // ── Access ───────────────────────────────────────────────────────────────

  describe('a preference belongs to one person', () => {
    it('lets a member read their own', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const seen = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const { rows } = await client.query('select * from public.notification_type_preferences');
        return rows;
      });

      expect(seen).toHaveLength(1);
    });

    it('shows one member nothing of another\'s', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const seen = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const { rows } = await client.query('select * from public.notification_type_preferences');
        return rows;
      });

      expect(seen).toHaveLength(0);
    });

    it('refuses one member writing a preference for another', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.notification_type_preferences
               (user_id, notification_type, channel, enabled)
             values ($1, 'match_published', 'push', false)`,
            [SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('silently matches no rows when one member updates another', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          'update public.notification_type_preferences set enabled = true where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        ),
      );

      const still = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ enabled: boolean }>(
          'select enabled from public.notification_type_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return rows[0]!.enabled;
      });

      expect(still).toBe(false);
    });

    it('shows an unauthenticated visitor nothing', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query('select * from public.notification_type_preferences'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses the resolver to an ordinary member', async () => {
      const id = await notify(SEED_USERS.rmvfcPlayer, 'pref-rls-resolver-1');

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.notification_channel_eligibility($1)', [id]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('lets service_role read preferences for delivery', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const seen = await asServiceRole(db, async (client) => {
        const { rows } = await client.query('select * from public.notification_type_preferences');
        return rows.length;
      });

      expect(seen).toBe(1);
    });
  });

  // ── Hostile writes ───────────────────────────────────────────────────────

  describe('a member cannot reach another member\'s preferences', () => {
    it('refuses moving an OWNED row to another user_id', async () => {
      // THE ATTACK THE WITH CHECK EXISTS FOR. The USING clause lets somebody
      // update their own row; without a matching WITH CHECK they could rewrite
      // `user_id` and hand the row — and every future preference decision it
      // drives — to somebody else's account.
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            'update public.notification_type_preferences set user_id = $1 where user_id = $2',
            [SEED_USERS.rmvfcAdmin.id, SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('leaves the victim with no row at all after that attempt', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            'update public.notification_type_preferences set user_id = $1',
            [SEED_USERS.rmvfcAdmin.id],
          ),
        ),
      );

      const victimRows = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_type_preferences where user_id = $1',
          [SEED_USERS.rmvfcAdmin.id],
        );
        return Number(rows[0]!.c);
      });

      expect(victimRows).toBe(0);
    });

    it('refuses an insert naming another user even with a valid type and channel', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.notification_type_preferences
               (user_id, notification_type, channel, enabled)
             values ($1, 'reminder', 'email', false)`,
            [SEED_USERS.rmvfcAdmin.id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('gives an ordinary member no DELETE at all', async () => {
      // Not granted, deliberately: the write path is an idempotent upsert, so
      // there is nothing a member needs DELETE for.
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('delete from public.notification_type_preferences'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('cannot probe another member\'s state through the resolver', async () => {
      // The resolver returns an email address and reads `auth.users`. A session
      // must not be able to point it at an arbitrary notification.
      await setGlobal(SEED_USERS.rmvfcAdmin, true);
      const theirs = await notify(SEED_USERS.rmvfcAdmin, 'pref-probe-0001');

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.notification_channel_eligibility($1)', [theirs]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ── In-app-only types ────────────────────────────────────────────────────

  describe('a preference row for an in-app-only type is inert', () => {
    it('can be stored — the table does not police product policy', async () => {
      // Not a defect. The column is the notification_type enum, and adding a
      // CHECK listing seventeen values would be a second place for the
      // externally-eligible set to drift from `PUSH_ELIGIBLE_TYPES`.
      await setType(SEED_USERS.rmvfcPlayer, 'attendance_recorded', 'push', true);

      const stored = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          `select count(*)::text as c from public.notification_type_preferences
            where notification_type = 'attendance_recorded'`,
        );
        return Number(rows[0]!.c);
      });

      expect(stored).toBe(1);
    });

    it('creates no queue job, because the trigger never fires for it', async () => {
      // The first and strongest layer: `attendance_recorded` is written with
      // `push_eligible: false`, so there is no delivery job for a preference to
      // influence.
      await setGlobal(SEED_USERS.rmvfcPlayer, true);
      await setType(SEED_USERS.rmvfcPlayer, 'attendance_recorded', 'push', true);
      await setType(SEED_USERS.rmvfcPlayer, 'attendance_recorded', 'email', true);

      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `insert into public.notifications
             (recipient_user_id, league_id, type, title, body, deep_link,
              idempotency_key, delivery_metadata)
           values ($1, $2, 'attendance_recorded', 'T', 'B', '/x/y', 'pref-inapp-0001',
                   jsonb_build_object('push_eligible', false))`,
          [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc],
        ),
      );

      const jobs = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_delivery_jobs',
        );
        return Number(rows[0]!.c);
      });

      expect(jobs).toBe(0);
    });

    it('does not make the canonical notification any different', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'attendance_recorded', 'push', true);

      const id = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ id: string; delivery_metadata: unknown }>(
          `insert into public.notifications
             (recipient_user_id, league_id, type, title, body, deep_link,
              idempotency_key, delivery_metadata)
           values ($1, $2, 'attendance_recorded', 'T', 'B', '/x/y', 'pref-inapp-0002',
                   jsonb_build_object('push_eligible', false))
           returning id, delivery_metadata`,
          [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc],
        );
        return rows[0]!;
      });

      // The in-app record is written exactly as always — preferences govern
      // delivery, never creation.
      expect(id.delivery_metadata).toEqual({ push_eligible: false });
    });
  });

  // ── Shape ────────────────────────────────────────────────────────────────

  describe('the table itself', () => {
    it('refuses a duplicate (user, type, channel)', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.notification_type_preferences
               (user_id, notification_type, channel, enabled)
             values ($1, 'match_published', 'push', true)`,
            [SEED_USERS.rmvfcPlayer.id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('has exactly two channel values, and in_app is not one', async () => {
      const labels = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ enumlabel: string }>(
          `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
            where t.typname = 'notification_channel' order by e.enumsortorder`,
        );
        return rows.map((r) => r.enumlabel);
      });

      // In-app delivery is the canonical record and must not become
      // configurable by somebody adding an enum value.
      expect(labels).toEqual(['push', 'email']);
    });

    it('follows the account away when it is deleted', async () => {
      await setType(SEED_USERS.rmvfcPlayer, 'match_published', 'push', false);

      await asServiceRoleCommitting(db, (client) =>
        client.query('delete from public.profiles where id = $1', [SEED_USERS.rmvfcPlayer.id]),
      );

      const left = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ c: string }>(
          'select count(*)::text as c from public.notification_type_preferences where user_id = $1',
          [SEED_USERS.rmvfcPlayer.id],
        );
        return Number(rows[0]!.c);
      });

      expect(left).toBe(0);
    });

    it('stores nothing but the decision', async () => {
      const columns = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema='public' and table_name='notification_type_preferences'`,
        );
        return rows.map((r) => r.column_name).sort();
      });

      expect(columns).toEqual([
        'channel',
        'created_at',
        'enabled',
        'notification_type',
        'updated_at',
        'user_id',
      ]);
    });
  });
});
