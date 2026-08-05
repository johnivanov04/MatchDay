import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_INVITES,
  SEED_INVITE_TOKEN,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

const NEW_TOKEN = 'a'.repeat(43);

describe('invitation links', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('token storage', () => {
    it('stores the SHA-256 digest, never the token', async () => {
      const { rows } = await db.pool.query<{ digest_matches: boolean; contains_token: boolean }>(
        `select token_hash = sha256(convert_to($2, 'UTF8')) as digest_matches,
                encode(token_hash, 'escape') like '%' || $2 || '%' as contains_token
           from public.league_invites where id = $1`,
        [SEED_INVITES.rmvfc, SEED_INVITE_TOKEN],
      );

      expect(rows[0]?.digest_matches).toBe(true);
      expect(rows[0]?.contains_token).toBe(false);
    });

    it('keeps the digest unreadable through the API, even for the owning administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select token_hash from public.league_invites'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('rejects `select *`, which would include the digest', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select * from public.league_invites'),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('lets the administrator read the metadata columns', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ label: string; use_count: number }>(
          'select label, use_count, max_uses, expires_at from public.league_invites',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.label).toBe('Local development link');
    });
  });

  describe('creation', () => {
    it('creates an invite for an administrator and audits it', async () => {
      const inviteId = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_league_invite($1, $2, 'Spring', 'active', 5, 7) as id`,
          [SEED_LEAGUES.rmvfc, NEW_TOKEN],
        );
        return result.rows[0]?.id ?? '';
      });

      const { rows } = await db.pool.query<{ action: string }>(
        `select action from public.audit_events where entity_id = $1`,
        [inviteId],
      );
      expect(rows.map((row) => row.action)).toEqual(['invite.created']);
    });

    it('refuses a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.create_league_invite($1, $2)', [SEED_LEAGUES.rmvfc, NEW_TOKEN]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses another league’s administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query('select public.create_league_invite($1, $2)', [SEED_LEAGUES.rmvfc, NEW_TOKEN]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses a token short enough to be guessable', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.create_league_invite($1, $2)', [SEED_LEAGUES.rmvfc, 'short']),
        ),
      );
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('refuses an expiry beyond the permitted window', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.create_league_invite($1, $2, null, 'active', null, 365)`,
            [SEED_LEAGUES.rmvfc, NEW_TOKEN],
          ),
        ),
      );
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('refuses an invite that would grant an unusable status', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.league_invites (league_id, token_hash, grants_status)
           values ($1, sha256(convert_to($2,'UTF8')), 'suspended')`,
          [SEED_LEAGUES.rmvfc, NEW_TOKEN],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });
  });

  describe('redemption', () => {
    it('grants membership and spends one use', async () => {
      const result = await asUserCommitting(db, SEED_USERS.outsider, async (client) => {
        const redeemed = await client.query<{ redeem_league_invite: Record<string, unknown> }>(
          'select public.redeem_league_invite($1) as redeem_league_invite',
          [SEED_INVITE_TOKEN],
        );
        return redeemed.rows[0]?.redeem_league_invite;
      });

      expect(result).toMatchObject({ joined: true, status: 'active' });

      const membership = await db.pool.query<{ status: string; role: string }>(
        'select status, role from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(membership.rows[0]).toMatchObject({ status: 'active', role: 'player' });

      const invite = await db.pool.query<{ use_count: number }>(
        'select use_count from public.league_invites where id = $1',
        [SEED_INVITES.rmvfc],
      );
      expect(invite.rows[0]?.use_count).toBe(1);
    });

    it('is idempotent and does not spend a second use', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.outsider, (client) =>
          client.query('select public.redeem_league_invite($1)', [SEED_INVITE_TOKEN]),
        );
      }

      const memberships = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.league_memberships
          where league_id = $1 and user_id = $2`,
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      const invite = await db.pool.query<{ use_count: number }>(
        'select use_count from public.league_invites where id = $1',
        [SEED_INVITES.rmvfc],
      );

      expect(memberships.rows[0]?.count).toBe('1');
      expect(invite.rows[0]?.use_count).toBe(1);
    });

    it('does not spend a use for someone who already belongs', async () => {
      const result = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const redeemed = await client.query<{ redeem_league_invite: Record<string, unknown> }>(
          'select public.redeem_league_invite($1) as redeem_league_invite',
          [SEED_INVITE_TOKEN],
        );
        return redeemed.rows[0]?.redeem_league_invite;
      });

      expect(result).toMatchObject({ joined: false });

      const invite = await db.pool.query<{ use_count: number }>(
        'select use_count from public.league_invites where id = $1',
        [SEED_INVITES.rmvfc],
      );
      expect(invite.rows[0]?.use_count).toBe(0);
    });

    it('honours an invite that grants pending status', async () => {
      await db.pool.query(
        `update public.league_invites set grants_status = 'pending' where id = $1`,
        [SEED_INVITES.rmvfc],
      );

      await asUserCommitting(db, SEED_USERS.outsider, (client) =>
        client.query('select public.redeem_league_invite($1)', [SEED_INVITE_TOKEN]),
      );

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      );
      expect(rows[0]?.status).toBe('pending');
    });

    it('records invite.redeemed with the joining player as the actor', async () => {
      await asUserCommitting(db, SEED_USERS.outsider, (client) =>
        client.query('select public.redeem_league_invite($1)', [SEED_INVITE_TOKEN]),
      );

      const { rows } = await db.pool.query<{ actor_user_id: string }>(
        `select actor_user_id from public.audit_events where action = 'invite.redeemed'`,
      );
      // A non-administrator actor — which is precisely why record_audit_event()
      // could not be used for this event.
      expect(rows[0]?.actor_user_id).toBe(SEED_USERS.outsider.id);
    });
  });

  describe('every rejection looks the same', () => {
    async function redeemExpectingFailure(token: string): Promise<string> {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query('select public.redeem_league_invite($1)', [token]),
        ),
      );
      return error.message;
    }

    it('unknown, expired, revoked and exhausted are indistinguishable', async () => {
      const unknown = await redeemExpectingFailure('z'.repeat(43));

      // `league_invites_expiry_after_creation` forbids an expiry earlier than
      // the row's own creation, so an expired invite has to be aged properly
      // rather than merely backdated — which is what a real one looks like.
      await db.pool.query(
        `update public.league_invites
            set created_at = now() - interval '30 days',
                expires_at = now() - interval '1 day'
          where id = $1`,
        [SEED_INVITES.rmvfc],
      );
      const expired = await redeemExpectingFailure(SEED_INVITE_TOKEN);

      await db.pool.query(
        `update public.league_invites
            set expires_at = now() + interval '1 day', revoked_at = now() where id = $1`,
        [SEED_INVITES.rmvfc],
      );
      const revoked = await redeemExpectingFailure(SEED_INVITE_TOKEN);

      await db.pool.query(
        `update public.league_invites
            set revoked_at = null, max_uses = 1, use_count = 1 where id = $1`,
        [SEED_INVITES.rmvfc],
      );
      const exhausted = await redeemExpectingFailure(SEED_INVITE_TOKEN);

      for (const message of [unknown, expired, revoked, exhausted]) {
        expect(message).toContain('INVITE_INVALID');
      }
      expect(new Set([unknown, expired, revoked, exhausted]).size).toBe(1);
    });

    it('refuses an unauthenticated redemption', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query('select public.redeem_league_invite($1)', [SEED_INVITE_TOKEN]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('revocation', () => {
    it('revokes and then refuses redemption', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.revoke_league_invite($1)', [SEED_INVITES.rmvfc]),
      );

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query('select public.redeem_league_invite($1)', [SEED_INVITE_TOKEN]),
        ),
      );
      expect(error.message).toContain('INVITE_INVALID');
    });

    it('is idempotent and keeps the original timestamp', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.revoke_league_invite($1)', [SEED_INVITES.rmvfc]),
      );
      const first = await db.pool.query<{ revoked_at: Date }>(
        'select revoked_at from public.league_invites where id = $1',
        [SEED_INVITES.rmvfc],
      );

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.revoke_league_invite($1)', [SEED_INVITES.rmvfc]),
      );
      const second = await db.pool.query<{ revoked_at: Date }>(
        'select revoked_at from public.league_invites where id = $1',
        [SEED_INVITES.rmvfc],
      );

      expect(second.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query('select public.revoke_league_invite($1)', [SEED_INVITES.rmvfc]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });
  });

  describe('usage limit', () => {
    it('cannot be exceeded even by direct update', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          'update public.league_invites set max_uses = 1, use_count = 2 where id = $1',
          [SEED_INVITES.rmvfc],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('league_invites_within_use_limit');
    });
  });

  describe('visibility', () => {
    it('hides invites from players and from other leagues', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin, SEED_USERS.outsider]) {
        const rows = await asUser(db, actor, async (client) => {
          const result = await client.query('select id from public.league_invites');
          return result.rows;
        });
        expect(rows).toEqual([]);
      }
    });
  });
});
