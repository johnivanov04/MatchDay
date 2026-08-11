import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUserCommitting,
  connectAs,
  createExtraMembers,
  createTestDatabase,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type TestDatabase,
} from './helpers/harness';

/**
 * Real concurrency against real PostgreSQL.
 *
 * "No confirmed spot is duplicated under concurrent requests" is a PRD §13
 * success metric, and it is the one property in this product that cannot be
 * tested by awaiting operations one after another — a sequential test passes
 * whether or not any locking exists.
 *
 * So every test here opens a **separate connection per player** and fires the
 * statements with `Promise.all`. The shared pool is not used for the racing
 * calls: it caps at four connections and recycles them, so two "concurrent"
 * statements through it can end up serialized on one socket, which would make
 * these tests pass without testing anything.
 *
 * The mechanism under test is `select ... from matches where id = $1 for
 * update` as the first statement of every capacity-touching function. One
 * stable row, always locked first, so the racing transactions queue rather than
 * each reading a count that the other is about to invalidate.
 */
describe('signup concurrency', () => {
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

  async function connect(members: ExtraMember[]): Promise<Client[]> {
    const opened = await Promise.all(members.map((member) => connectAs(db, member.user)));
    clients.push(...opened);
    return opened;
  }

  async function setCapacity(matchId: string, capacity: number) {
    await db.pool.query(
      'update public.matches set capacity = $2, min_players = 1 where id = $1',
      [matchId, capacity],
    );
  }

  async function confirmedCount(matchId: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.match_signups
        where match_id = $1 and status = 'confirmed'`,
      [matchId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async function waitlistPositions(matchId: string): Promise<number[]> {
    const { rows } = await db.pool.query<{ waitlist_position: number }>(
      `select waitlist_position from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [matchId],
    );
    return rows.map((row) => row.waitlist_position);
  }

  /** Settles every promise, so one rejection does not hide the others' outcomes. */
  async function race<T>(work: Array<Promise<T>>) {
    return Promise.allSettled(work);
  }

  it('awards one remaining slot to exactly one of two simultaneous joins', async () => {
    // Capacity 2 with one seat already taken leaves exactly one.
    await setCapacity(SEED_MATCHES.fivesOpen, 2);
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 3);
    await asUserCommitting(db, members[0]!.user, (client) =>
      client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
    );

    const [a, b] = await connect([members[1]!, members[2]!]);

    const results = await race([
      a!.query<{ status: string }>('select * from public.join_match($1)', [
        SEED_MATCHES.fivesOpen,
      ]),
      b!.query<{ status: string }>('select * from public.join_match($1)', [
        SEED_MATCHES.fivesOpen,
      ]),
    ]);

    const outcomes = results
      .map((result) => (result.status === 'fulfilled' ? result.value.rows[0]?.status : 'rejected'))
      .sort();

    // One takes the seat, the other queues. Neither fails, and the count is
    // never allowed past capacity.
    expect(outcomes).toEqual(['confirmed', 'waitlisted']);
    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
    expect(await waitlistPositions(SEED_MATCHES.fivesOpen)).toEqual([1]);
  });

  it('never exceeds capacity when far more players race than there are seats', async () => {
    await setCapacity(SEED_MATCHES.fivesOpen, 3);
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 12);
    const connections = await connect(members);

    await race(
      connections.map((client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      ),
    );

    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(3);

    // The other nine queue behind them, each with a distinct place.
    expect(await waitlistPositions(SEED_MATCHES.fivesOpen)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('gives simultaneous joins to a full match distinct sequential positions', async () => {
    await setCapacity(SEED_MATCHES.fivesOpen, 2);
    const seated = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 2, 'seated');
    for (const member of seated) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
    }

    const latecomers = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 8, 'late');
    const connections = await connect(latecomers);

    const results = await race(
      connections.map((client) =>
        client.query<{ status: string; waitlist_position: number }>(
          'select * from public.join_match($1)',
          [SEED_MATCHES.fivesOpen],
        ),
      ),
    );

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const positions = await waitlistPositions(SEED_MATCHES.fivesOpen);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // No duplicates, stated separately from the sequence so a failure says which.
    expect(new Set(positions).size).toBe(positions.length);
    expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
  });

  it('cannot exceed capacity through concurrent administrator confirmations', async () => {
    await setCapacity(SEED_MATCHES.rmvfcOpen, 3);
    const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 8);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      );
    }

    // One administrator, several browser tabs — every confirmation racing the
    // others through separate connections.
    const adminConnections = await Promise.all(
      members.map(() => connectAs(db, SEED_USERS.rmvfcAdmin)),
    );
    clients.push(...adminConnections);

    const results = await race(
      adminConnections.map((client, index) =>
        client.query('select * from public.set_signup_decision($1, $2, $3)', [
          SEED_MATCHES.rmvfcOpen,
          members[index]!.membershipId,
          'confirmed',
        ]),
      ),
    );

    const confirmed = await confirmedCount(SEED_MATCHES.rmvfcOpen);
    expect(confirmed).toBe(3);

    // The surplus is refused rather than silently dropped, and refused with the
    // domain code the interface knows how to explain.
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect(String((result as PromiseRejectedResult).reason)).toContain('CAPACITY_EXCEEDED');
    }
  });

  it('keeps waitlist positions intact under concurrent reorders', async () => {
    await setCapacity(SEED_MATCHES.fivesOpen, 2);
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 8);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
    }

    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select membership_id from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [SEED_MATCHES.fivesOpen],
    );
    const order = rows.map((row) => row.membership_id);

    const adminConnections = await Promise.all(
      [0, 1, 2, 3].map(() => connectAs(db, SEED_USERS.fivesAdmin)),
    );
    clients.push(...adminConnections);

    // Four different permutations of the same set, applied at once.
    const permutations = [
      [...order].reverse(),
      [...order.slice(3), ...order.slice(0, 3)],
      [...order.slice(1), order[0]!],
      order,
    ];

    await race(
      adminConnections.map((client, index) =>
        client.query('select public.reorder_waitlist($1, $2)', [
          SEED_MATCHES.fivesOpen,
          permutations[index],
        ]),
      ),
    );

    const positions = await waitlistPositions(SEED_MATCHES.fivesOpen);
    // Whichever ordering won, the result is still 1..N exactly once each.
    expect(positions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(positions).size).toBe(positions.length);

    const { rows: names } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.match_signups
        where match_id = $1 and status = 'waitlisted'`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(names[0]?.count).toBe('6');
  });

  it('creates one signup and one notification when the same request is retried at once', async () => {
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 1);
    // Five connections, one person — a double-tap, a retry and a refresh all at
    // the same instant.
    const connections = await Promise.all(
      [0, 1, 2, 3, 4].map(() => connectAs(db, members[0]!.user)),
    );
    clients.push(...connections);

    const results = await race(
      connections.map((client) =>
        client.query<{ status: string }>('select * from public.join_match($1)', [
          SEED_MATCHES.fivesOpen,
        ]),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(5);
    for (const result of fulfilled) {
      expect((result as PromiseFulfilledResult<{ rows: Array<{ status: string }> }>).value.rows[0]?.status)
        .toBe('confirmed');
    }

    const { rows: signups } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.match_signups where match_id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(signups[0]?.count).toBe('1');

    const { rows: notifications } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.notifications where match_id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(notifications[0]?.count).toBe('1');
  });

  it('serializes a join against an administrator decision on the same match', async () => {
    // Both take the same match row lock first, so the confirmed count each one
    // reads already includes whatever the other committed.
    await setCapacity(SEED_MATCHES.rmvfcOpen, 2);
    const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 3);
    for (const member of members) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      );
    }

    const adminConnections = await Promise.all(
      [0, 1, 2].map(() => connectAs(db, SEED_USERS.rmvfcAdmin)),
    );
    clients.push(...adminConnections);

    await race(
      adminConnections.map((client, index) =>
        client.query('select * from public.add_member_to_match($1, $2, $3)', [
          SEED_MATCHES.rmvfcOpen,
          members[index]!.membershipId,
          'confirmed',
        ]),
      ),
    );

    expect(await confirmedCount(SEED_MATCHES.rmvfcOpen)).toBe(2);
  });
});
