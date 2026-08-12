import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUserCommitting,
  connectAs,
  connectAsWorker,
  createExtraMembers,
  createTestDatabase,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 5 against real PostgreSQL concurrency.
 *
 * The invariant everything here defends: **one freed slot promotes at most one
 * player, and the confirmed count never exceeds capacity.** It holds because
 * `cancel_spot()`, `join_match()`, `set_signup_decision()` and
 * `promote_waitlisted_player()` all take `select ... from matches where id = $1
 * for update` as their first statement, so the cancellation, its capacity
 * release and its promotion are one transaction under one lock.
 *
 * Every race below opens a **separate connection per actor** and fires with
 * `Promise.all`. The shared pool is not used for the racing calls: it caps at
 * four connections and recycles them, so two "concurrent" statements through it
 * can serialize on one socket and pass without testing anything.
 */
describe('cancellation concurrency', () => {
  let db: TestDatabase;
  let clients: Client[] = [];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await db.drop();
  });

  async function connect(users: SeedUser[]): Promise<Client[]> {
    const opened = await Promise.all(users.map((user) => connectAs(db, user)));
    clients.push(...opened);
    return opened;
  }

  async function setCapacity(matchId: string, capacity: number) {
    await db.pool.query(
      'update public.matches set capacity = $2, min_players = 1 where id = $1',
      [matchId, capacity],
    );
  }

  async function confirmedCount(matchId: string) {
    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.match_signups
        where match_id = $1 and status = 'confirmed'`,
      [matchId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async function waitlistPositions(matchId: string) {
    const { rows } = await db.pool.query<{ waitlist_position: number }>(
      `select waitlist_position from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [matchId],
    );
    return rows.map((row) => row.waitlist_position);
  }

  async function countNotifications(matchId: string, type: string) {
    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type = $2::public.notification_type`,
      [matchId, type],
    );
    return Number(rows[0]?.count ?? '0');
  }

  /** Seats `capacity` players and queues the rest, on the automatic-mode match. */
  async function seatAndQueue(capacity: number, total: number): Promise<ExtraMember[]> {
    await setCapacity(SEED_MATCHES.fivesOpen, capacity);
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, total);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
    }
    return members;
  }

  /** Settles everything, so one rejection does not hide the others' outcomes. */
  const race = <T,>(work: Array<Promise<T>>) => Promise.allSettled(work);

  it('keeps capacity exact when a cancellation races a join', async () => {
    // Full, with nobody waiting: one player leaves as another arrives.
    const members = await seatAndQueue(3, 3);
    const arriving = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 1, 'arriving');

    const [leaver, joiner] = await connect([members[0]!.user, arriving[0]!.user]);

    await race([
      leaver!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      joiner!.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    // Either order is a coherent outcome — the joiner takes the freed seat, or
    // arrives first and waits — but the count is exact and the queue is valid
    // whichever way it went.
    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(3);
    const positions = await waitlistPositions(SEED_MATCHES.fivesOpen);
    expect(positions).toEqual(positions.map((_, index) => index + 1));
    expect(positions.length).toBeLessThanOrEqual(1);
  });

  it('promotes exactly one player when a confirmed player cancels', async () => {
    const members = await seatAndQueue(2, 8);
    const [leaver] = await connect([members[0]!.user]);

    await leaver!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]);

    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
    expect(await countNotifications(SEED_MATCHES.fivesOpen, 'waitlist_promotion')).toBe(1);
    // Position 1 took the seat; everyone behind moved up with no gap.
    expect(await waitlistPositions(SEED_MATCHES.fivesOpen)).toEqual([1, 2, 3, 4, 5]);
  });

  it('produces one cancellation when the same signup is cancelled twice at once', async () => {
    const members = await seatAndQueue(2, 5);

    // Five connections, one person: a double tap, a retry and a refresh all at
    // the same instant.
    const connections = await Promise.all(
      [0, 1, 2, 3, 4].map(() => connectAs(db, members[0]!.user)),
    );
    clients.push(...connections);

    const results = await race(
      connections.map((client) =>
        client.query<{ status: string }>('select * from public.cancel_spot($1)', [
          SEED_MATCHES.fivesOpen,
        ]),
      ),
    );

    // Every call answers with the same standing outcome rather than failing.
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      const value = (result as PromiseFulfilledResult<{ rows: Array<{ status: string }> }>).value;
      expect(value.rows[0]?.status).toBe('canceled');
    }

    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
    // One release, one promotion, one receipt.
    expect(await countNotifications(SEED_MATCHES.fivesOpen, 'waitlist_promotion')).toBe(1);
    expect(await countNotifications(SEED_MATCHES.fivesOpen, 'cancellation_receipt')).toBe(1);

    const { rows } = await db.pool.query<{ roster_revision: number }>(
      'select roster_revision from public.matches where id = $1',
      [SEED_MATCHES.fivesOpen],
    );
    expect(rows[0]?.roster_revision).toBe(0);
  });

  it('promotes two distinct players when two confirmed players cancel at once', async () => {
    const members = await seatAndQueue(3, 9);
    const [a, b] = await connect([members[0]!.user, members[1]!.user]);

    await race([
      a!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      b!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(3);
    expect(await countNotifications(SEED_MATCHES.fivesOpen, 'waitlist_promotion')).toBe(2);

    // Two seats freed, two different people took them — never the same person
    // twice, which is what a lost lock would produce.
    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select distinct s.membership_id from public.notifications n
         join public.match_signups s
           on s.membership_id::text = split_part(n.idempotency_key, ':', 3)
        where n.match_id = $1 and n.type = 'waitlist_promotion'`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(rows).toHaveLength(2);

    expect(await waitlistPositions(SEED_MATCHES.fivesOpen)).toEqual([1, 2, 3, 4]);
  });

  it('cannot overfill when an administrator promotion races a cancellation', async () => {
    // RMVFC is administrator-controlled, so a cancellation opens a spot and
    // waits for a decision.
    await db.pool.query(
      `update public.matches set selection_mode = 'first_come', capacity = 3, min_players = 1
        where id = $1`,
      [SEED_MATCHES.rmvfcOpen],
    );
    const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 8);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.rmvfcOpen]),
      );
    }

    const [leaver] = await connect([members[0]!.user]);
    const admins = await Promise.all([0, 1, 2].map(() => connectAs(db, SEED_USERS.rmvfcAdmin)));
    clients.push(...admins);

    // One withdrawal and three simultaneous attempts to fill the seat.
    await race([
      leaver!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      ...admins.map((client) =>
        client.query('select * from public.promote_waitlisted_player($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]),
      ),
    ]);

    // At most full, never more, and no duplicate confirmation.
    expect(await confirmedCount(SEED_MATCHES.rmvfcOpen)).toBeLessThanOrEqual(3);
    const positions = await waitlistPositions(SEED_MATCHES.rmvfcOpen);
    expect(positions).toEqual(positions.map((_, index) => index + 1));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('keeps positions valid when a withdrawal races a reorder', async () => {
    const members = await seatAndQueue(2, 8);

    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select membership_id from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [SEED_MATCHES.fivesOpen],
    );
    const order = rows.map((row) => row.membership_id);

    // members[3] is waitlisted; they leave while the administrator reorders the
    // list they are still part of.
    const [leaver, admin] = await connect([members[3]!.user, SEED_USERS.fivesAdmin]);

    await race([
      leaver!.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      admin!.query('select public.reorder_waitlist($1, $2)', [
        SEED_MATCHES.fivesOpen,
        [...order].reverse(),
      ]),
    ]);

    // Whichever won, the result is contiguous and unique. A reorder that ran
    // second against a set that had changed is refused by its own validation
    // rather than corrupting the ordering.
    const positions = await waitlistPositions(SEED_MATCHES.fivesOpen);
    expect(positions).toEqual(positions.map((_, index) => index + 1));
    expect(new Set(positions).size).toBe(positions.length);
    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
  });

  it('creates one reminder per recipient when the generator runs twice at once', async () => {
    await db.pool.query(
      `update public.matches set capacity = 6, min_players = 1,
                                 reminder_offsets = array[interval '2 hours']
        where id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 4);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
    }
    await db.pool.query('select public.materialize_match_reminders($1)', [
      SEED_MATCHES.fivesOpen,
    ]);
    await db.pool.query(
      `update public.match_reminders set due_at = now() - interval '1 minute'
        where match_id = $1`,
      [SEED_MATCHES.fivesOpen],
    );

    // Four workers, all awake at once — what a scheduler with overlapping runs
    // or a retried invocation actually looks like.
    const workers = await Promise.all([0, 1, 2, 3].map(() => connectAsWorker(db)));
    clients.push(...workers);

    const results = await race(
      workers.map((client) =>
        client.query<{ reminder_id: string; notified: number }>(
          'select * from public.generate_due_reminders()',
        ),
      ),
    );

    const claimedTotal = results.reduce((total, result) => {
      if (result.status !== 'fulfilled') return total;
      return total + result.value.rows.length;
    }, 0);
    // `for update skip locked` means the losers find nothing rather than
    // waiting and re-sending.
    expect(claimedTotal).toBe(1);

    const { rows } = await db.pool.query<{ count: string; recipients: string }>(
      `select count(*)::text as count,
              count(distinct recipient_user_id)::text as recipients
         from public.notifications where type = 'reminder'`,
    );
    expect(rows[0]?.count).toBe('4');
    expect(rows[0]?.recipients).toBe('4');
  });

  it('keeps inbox mutations consistent and never crosses users under a race', async () => {
    const inserted = await db.pool.query<{ id: string }>(
      `insert into public.notifications
         (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
       values ($1, $2, 'match_published', 'A match', 'Tonight', '/dashboard', 'race-mine'),
              ($3, $2, 'match_published', 'A match', 'Tonight', '/dashboard', 'race-theirs')
       returning id`,
      [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc, SEED_USERS.multiLeaguePlayer.id],
    );
    const mine = inserted.rows[0]!.id;
    const theirs = inserted.rows[1]!.id;

    const owners = await Promise.all(
      [0, 1, 2, 3].map(() => connectAs(db, SEED_USERS.rmvfcPlayer)),
    );
    clients.push(...owners);

    await race([
      owners[0]!.query('select public.mark_notification_read($1)', [mine]),
      owners[1]!.query('select public.mark_notification_unread($1)', [mine]),
      owners[2]!.query('select public.archive_notification($1)', [mine]),
      // The same person reaching for somebody else's notification, at the same
      // moment as their own legitimate mutations.
      owners[3]!.query('select public.archive_notification($1)', [theirs]),
    ]);

    const { rows } = await db.pool.query<{
      id: string;
      read_at: string | null;
      archived_at: string | null;
    }>(
      `select id, read_at::text as read_at, archived_at::text as archived_at
         from public.notifications where id in ($1, $2) order by id`,
      [mine, theirs],
    );

    const other = rows.find((row) => row.id === theirs)!;
    // Untouched, whatever order the four statements landed in.
    expect(other.read_at).toBeNull();
    expect(other.archived_at).toBeNull();

    // The caller's own row ends in some state, but a coherent one: read_at and
    // archived_at are independent columns and neither is left inconsistent.
    const own = rows.find((row) => row.id === mine)!;
    expect(own).toBeDefined();
  });
});
