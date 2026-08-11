import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Roster publication, the derived participation labels, and what a player is
 * allowed to learn about everybody else.
 */
describe('roster publication', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 6);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      );
    }
  });

  afterEach(async () => {
    await db.drop();
  });

  async function decide(membershipId: string, status: string) {
    return asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select * from public.set_signup_decision($1, $2, $3)', [
        SEED_MATCHES.rmvfcOpen,
        membershipId,
        status,
      ]),
    );
  }

  async function finalize(user: SeedUser = SEED_USERS.rmvfcAdmin) {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<{ finalize_roster: number }>(
        'select public.finalize_roster($1)',
        [SEED_MATCHES.rmvfcOpen],
      );
      return result.rows[0]?.finalize_roster;
    });
  }

  async function notificationsFor(matchId: string) {
    const { rows } = await db.pool.query<{
      type: string;
      recipient_user_id: string;
      idempotency_key: string;
      title: string;
      body: string;
    }>(
      `select type::text, recipient_user_id, idempotency_key, title, body
         from public.notifications
        where match_id = $1 and type in
          ('roster_published', 'roster_changed', 'signup_confirmed', 'waitlisted', 'not_selected')
        order by idempotency_key`,
      [matchId],
    );
    return rows;
  }

  describe('finalizing', () => {
    beforeEach(async () => {
      await decide(members[0]!.membershipId, 'confirmed');
      await decide(members[1]!.membershipId, 'confirmed');
      await decide(members[2]!.membershipId, 'waitlisted');
      await decide(members[3]!.membershipId, 'not_selected');
    });

    it('increments the roster revision and moves the match to roster_finalized', async () => {
      expect(await finalize()).toBe(1);

      const { rows } = await db.pool.query<{
        status: string;
        roster_revision: number;
        roster_finalized_at: string | null;
        revision: number;
      }>(
        'select status, roster_revision, roster_finalized_at, revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.status).toBe('roster_finalized');
      expect(rows[0]?.roster_revision).toBe(1);
      expect(rows[0]?.roster_finalized_at).not.toBeNull();
      // The match's own revision is untouched: it tracks edits to the match,
      // and sharing one counter would make a publication suppress a genuine
      // match_changed notification.
      expect(rows[0]?.revision).toBe(0);
    });

    it('gives every responding player exactly one outcome notification', async () => {
      await finalize();
      const notifications = await notificationsFor(SEED_MATCHES.rmvfcOpen);

      expect(notifications).toHaveLength(4);
      expect(notifications.map((row) => row.type).sort()).toEqual([
        'not_selected',
        'roster_published',
        'roster_published',
        'waitlisted',
      ]);
      // One each, to four different people.
      expect(new Set(notifications.map((row) => row.recipient_user_id)).size).toBe(4);
    });

    it('is idempotent: publishing again announces nothing', async () => {
      expect(await finalize()).toBe(1);
      expect(await finalize()).toBe(1);
      expect(await finalize()).toBe(1);

      expect(await notificationsFor(SEED_MATCHES.rmvfcOpen)).toHaveLength(4);

      const { rows } = await db.pool.query<{ roster_revision: number }>(
        'select roster_revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.roster_revision).toBe(1);
    });

    it('creates a new revision and tells only the people whose outcome moved', async () => {
      await finalize();

      // One genuine change: the waitlisted player takes a spot.
      await decide(members[2]!.membershipId, 'confirmed');
      expect(await finalize()).toBe(2);

      const notifications = await notificationsFor(SEED_MATCHES.rmvfcOpen);
      const second = notifications.filter((row) => row.idempotency_key.includes(':2:'));

      expect(second).toHaveLength(4);
      const byType = second.reduce<Record<string, number>>((counts, row) => {
        counts[row.type] = (counts[row.type] ?? 0) + 1;
        return counts;
      }, {});
      // The promoted player hears they are confirmed; the other three hear the
      // roster moved and their own place did not.
      expect(byType).toEqual({ signup_confirmed: 1, roster_changed: 3 });
    });

    it('keys notifications on the revision, so a retry cannot double-send', async () => {
      await finalize();
      const notifications = await notificationsFor(SEED_MATCHES.rmvfcOpen);

      for (const row of notifications) {
        expect(row.idempotency_key.startsWith(`roster_outcome:${SEED_MATCHES.rmvfcOpen}:1:`)).toBe(
          true,
        );
      }
      expect(new Set(notifications.map((row) => row.idempotency_key)).size).toBe(4);
    });

    it('never names another player in a notification', async () => {
      await finalize();
      const notifications = await notificationsFor(SEED_MATCHES.rmvfcOpen);

      const blob = notifications.map((row) => `${row.title} ${row.body}`).join(' ');
      for (const member of members) {
        expect(blob).not.toContain(member.membershipId);
        expect(blob).not.toContain(member.user.email);
      }
      // And no waitlist position other than the recipient's own: the only
      // position mentioned belongs to the one waitlisted player.
      expect(blob.match(/number \d+ on the waitlist/g) ?? []).toHaveLength(1);
    });

    it('writes an audit event', async () => {
      await finalize();
      const { rows } = await db.pool.query<{
        actor_user_id: string;
        after_data: Record<string, unknown>;
      }>(
        `select actor_user_id, after_data from public.audit_events
          where entity_id = $1 and action = 'roster.published'`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
      expect(rows[0]?.after_data).toMatchObject({ roster_revision: 1, confirmed: 2 });
    });

    it('refuses a player and a cross-league administrator', async () => {
      for (const user of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() => finalize(user));
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('leaves the confirmed roster within capacity', async () => {
      await finalize();
      const { rows } = await db.pool.query<{ confirmed: number; capacity: number }>(
        `select public.match_confirmed_count($1) as confirmed,
                (select capacity from public.matches where id = $1) as capacity`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]!.confirmed).toBeLessThanOrEqual(rows[0]!.capacity);
    });

    it('does not notify a player who never responded', async () => {
      await finalize();
      const notifications = await notificationsFor(SEED_MATCHES.rmvfcOpen);
      const recipients = new Set(notifications.map((row) => row.recipient_user_id));

      // members[4] and [5] registered interest but received no decision, so
      // they have no outcome to be told about.
      expect(recipients.has(members[4]!.user.id)).toBe(false);
      expect(recipients.has(members[5]!.user.id)).toBe(false);
    });

    it('reopens for further changes without losing the revision', async () => {
      await finalize();
      await db.pool.query(`update public.matches set status = 'open' where id = $1`, [
        SEED_MATCHES.rmvfcOpen,
      ]);
      await decide(members[4]!.membershipId, 'confirmed');

      expect(await finalize()).toBe(2);
    });
  });

  describe('derived participation state', () => {
    async function label(matchId: string) {
      const { rows } = await db.pool.query<{
        confirmed: number;
        capacity: number;
        min_players: number;
      }>(
        `select public.match_confirmed_count($1) as confirmed,
                m.capacity, m.min_players
           from public.matches m where m.id = $1`,
        [matchId],
      );
      const row = rows[0]!;
      if (row.confirmed >= row.capacity) return 'full';
      if (row.confirmed < row.min_players) return 'needs_players';
      return 'enough_players';
    }

    it('reports needs_players with nobody signed up', async () => {
      await db.pool.query(
        'update public.matches set capacity = 6, min_players = 3 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('needs_players');
    });

    it('reports needs_players below the minimum', async () => {
      await db.pool.query(
        'update public.matches set capacity = 6, min_players = 3 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      await decide(members[0]!.membershipId, 'confirmed');
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('needs_players');
    });

    it('reports enough_players at exactly the minimum', async () => {
      await db.pool.query(
        'update public.matches set capacity = 6, min_players = 2 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      await decide(members[0]!.membershipId, 'confirmed');
      await decide(members[1]!.membershipId, 'confirmed');
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('enough_players');
    });

    it('reports enough_players between the minimum and capacity', async () => {
      await db.pool.query(
        'update public.matches set capacity = 6, min_players = 2 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      for (const member of members.slice(0, 3)) {
        await decide(member.membershipId, 'confirmed');
      }
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('enough_players');
    });

    it('reports full at exactly capacity', async () => {
      await db.pool.query(
        'update public.matches set capacity = 2, min_players = 2 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      await decide(members[0]!.membershipId, 'confirmed');
      await decide(members[1]!.membershipId, 'confirmed');
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('full');
    });

    it('counts interested players against neither threshold', async () => {
      await db.pool.query(
        'update public.matches set capacity = 2, min_players = 1 where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      // Six people have registered interest and none is confirmed. An
      // admin_approval match must not report itself full on requests alone.
      expect(await label(SEED_MATCHES.rmvfcOpen)).toBe('needs_players');
    });

    it('works the same way for a first-come match', async () => {
      await db.pool.query(
        'update public.matches set capacity = 2, min_players = 1 where id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      expect(await label(SEED_MATCHES.fivesOpen)).toBe('needs_players');

      const fives = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 2, 'fives');
      await asUserCommitting(db, fives[0]!.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
      expect(await label(SEED_MATCHES.fivesOpen)).toBe('enough_players');

      await asUserCommitting(db, fives[1]!.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
      expect(await label(SEED_MATCHES.fivesOpen)).toBe('full');
    });
  });

  describe('what a player may see', () => {
    beforeEach(async () => {
      await decide(members[0]!.membershipId, 'confirmed');
      await decide(members[1]!.membershipId, 'confirmed');
      await decide(members[2]!.membershipId, 'waitlisted');
      await decide(members[3]!.membershipId, 'waitlisted');
      await decide(members[4]!.membershipId, 'not_selected');
    });

    it('shows the full confirmed roster to a member', async () => {
      const rows = await asUser(db, members[2]!.user, async (client) => {
        const result = await client.query<{ first_name: string; is_self: boolean }>(
          'select first_name, is_self from public.match_confirmed_roster($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows;
      });

      // A waitlisted player still sees who is playing — 02 §12.
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.is_self === false)).toBe(true);
    });

    it('returns names and nothing else', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_confirmed_roster($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return result.fields.map((field) => field.name).sort();
      });

      // The signature is the boundary: there is no column here that could carry
      // a phone number, gender, attendance record or waitlist position.
      expect(rows).toEqual(['first_name', 'is_self', 'last_name', 'membership_id']);
    });

    it('shows a player only their own signup row', async () => {
      const rows = await asUser(db, members[2]!.user, async (client) => {
        const result = await client.query<{ membership_id: string; waitlist_position: number }>(
          'select membership_id, waitlist_position from public.match_signups',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.membership_id).toBe(members[2]!.membershipId);
      expect(rows[0]?.waitlist_position).toBe(1);
    });

    it('hides another player’s waitlist position however it is asked for', async () => {
      const probes = await asUser(db, members[2]!.user, async (client) => {
        const direct = await client.query(
          'select * from public.match_signups where membership_id = $1',
          [members[3]!.membershipId],
        );
        const counted = await client.query<{ count: string }>(
          `select count(*)::text as count from public.match_signups where status = 'waitlisted'`,
        );
        const aggregated = await client.query<{ max: number | null }>(
          'select max(waitlist_position) as max from public.match_signups',
        );
        const ordered = await client.query(
          'select waitlist_position from public.match_signups order by waitlist_position limit 50',
        );
        return {
          direct: direct.rows.length,
          counted: counted.rows[0]?.count,
          aggregated: aggregated.rows[0]?.max,
          ordered: ordered.rows.length,
        };
      });

      // Changing the id, counting, aggregating and paginating all answer only
      // about the caller, because the other rows are not visible at all.
      expect(probes.direct).toBe(0);
      expect(probes.counted).toBe('1');
      expect(probes.aggregated).toBe(1);
      expect(probes.ordered).toBe(1);
    });

    it('gives the same empty answer for a player who is not on the waitlist', async () => {
      const confirmed = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_signups');
        return result.rows.length;
      });
      // One row — their own — exactly as the waitlisted player sees one. The
      // count itself reveals nothing about the queue.
      expect(confirmed).toBe(1);
    });

    it('refuses the administrator workspace to a player', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_roster_admin($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('refuses the administrator workspace to a cross-league administrator', async () => {
      const rows = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query('select * from public.match_roster_admin($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('shows the administrator the full ordered waitlist', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ status: string; waitlist_position: number | null }>(
          `select status::text, waitlist_position from public.match_roster_admin($1)
            where status = 'waitlisted' order by waitlist_position`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows;
      });

      expect(rows.map((row) => row.waitlist_position)).toEqual([1, 2]);
    });

    it('withholds gender unless the league enables the field', async () => {
      await db.pool.query('update public.profiles set gender = $2 where id = $1', [
        members[0]!.user.id,
        'PRIVATEVALUE',
      ]);
      // The seed enables the field for RMVFC, so turn it off to test the half
      // of the branch that withholds.
      await db.pool.query('update public.leagues set gender_field_enabled = false where id = $1', [
        SEED_LEAGUES.rmvfc,
      ]);

      const disabled = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ gender: string | null }>(
          'select gender from public.match_roster_admin($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows;
      });
      expect(disabled.every((row) => row.gender === null)).toBe(true);

      await db.pool.query('update public.leagues set gender_field_enabled = true where id = $1', [
        SEED_LEAGUES.rmvfc,
      ]);
      const enabled = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ gender: string | null }>(
          'select gender from public.match_roster_admin($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows;
      });
      expect(enabled.some((row) => row.gender === 'PRIVATEVALUE')).toBe(true);
    });

    it('never returns a phone number, to anybody', async () => {
      await db.pool.query('update public.profiles set phone = $2 where id = $1', [
        members[0]!.user.id,
        '+15550000000',
      ]);

      for (const user of [SEED_USERS.rmvfcAdmin, members[1]!.user]) {
        const fields = await asUser(db, user, async (client) => {
          const roster = await client.query('select * from public.match_roster_admin($1)', [
            SEED_MATCHES.rmvfcOpen,
          ]);
          const confirmed = await client.query('select * from public.match_confirmed_roster($1)', [
            SEED_MATCHES.rmvfcOpen,
          ]);
          return [...roster.fields, ...confirmed.fields].map((field) => field.name);
        });
        expect(fields).not.toContain('phone');
      }
    });

    it('shows a non-member nothing at all', async () => {
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const signups = await client.query('select * from public.match_signups');
        const roster = await client.query('select * from public.match_confirmed_roster($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        const counts = await client.query('select * from public.match_signup_counts($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return {
          signups: signups.rows.length,
          roster: roster.rows.length,
          counts: counts.rows.length,
        };
      });
      expect(rows).toEqual({ signups: 0, roster: 0, counts: 0 });
    });

    it('shows a removed member nothing, including old rosters', async () => {
      const rows = await asUser(db, SEED_USERS.removedPlayer, async (client) => {
        const roster = await client.query('select * from public.match_confirmed_roster($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return roster.rows.length;
      });
      expect(rows).toBe(0);
    });

    it('keeps one league’s roster invisible from the other', async () => {
      // The multi-league player belongs to both leagues; the RMVFC roster must
      // not appear when they ask about the other league's match, and vice versa.
      const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query('select * from public.match_confirmed_roster($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return result.rows.length;
      });
      expect(rows).toBe(0);
    });

    it('never exposes an administrator note through a signup projection', async () => {
      await db.pool.query(
        `insert into public.match_admin_notes (match_id, league_id, notes)
         values ($1, $2, 'CONFIDENTIAL-ROSTER-NOTE')
         on conflict (match_id) do update set notes = excluded.notes`,
        [SEED_MATCHES.rmvfcOpen, SEED_LEAGUES.rmvfc],
      );

      const blob = await asUser(db, members[0]!.user, async (client) => {
        const roster = await client.query('select * from public.match_confirmed_roster($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        const counts = await client.query('select * from public.match_signup_counts($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        const mine = await client.query('select * from public.match_signups');
        return JSON.stringify([roster.rows, counts.rows, mine.rows]);
      });

      expect(blob).not.toContain('CONFIDENTIAL-ROSTER-NOTE');
    });

    it('gives a member counts without revealing who is queued', async () => {
      const counts = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query<{
          confirmed: number;
          waitlisted: number;
          interested: number;
        }>('select * from public.match_signup_counts($1)', [SEED_MATCHES.rmvfcOpen]);
        return result.rows[0];
      });

      // Sizes only. Knowing two people are queued does not say who or in which
      // order, and is what makes "would joining put me in a queue?" answerable.
      expect(counts).toMatchObject({ confirmed: 2, waitlisted: 2 });
    });
  });

  describe('signups written only through the transactional functions', () => {
    it('refuses a direct insert by a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, members[0]!.user, (client) =>
          client.query(
            `insert into public.match_signups (league_id, match_id, membership_id, status)
             values ($1, $2, $3, 'confirmed')`,
            [SEED_LEAGUES.rmvfc, SEED_MATCHES.rmvfcOpen, SEED_MEMBERSHIPS.rmvfcPlayer],
          ),
        ),
      );
      expect(error.code).toBe('42501');
    });

    it('refuses a player promoting themselves by direct update', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, members[2]!.user, (client) =>
          client.query(
            `update public.match_signups set status = 'confirmed', waitlist_position = null
              where membership_id = $1`,
            [members[2]!.membershipId],
          ),
        ),
      );
      expect(error.code).toBe('42501');
    });

    it('refuses a direct insert by the administrator too', async () => {
      // Even the administrator goes through the functions, which is what keeps
      // capacity, waitlist contiguity and the audit trail true.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.match_signups (league_id, match_id, membership_id, status)
             values ($1, $2, $3, 'confirmed')`,
            [SEED_LEAGUES.rmvfc, SEED_MATCHES.rmvfcOpen, SEED_MEMBERSHIPS.rmvfcPlayer],
          ),
        ),
      );
      expect(error.code).toBe('42501');
    });
  });
});
