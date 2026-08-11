import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 3B — editing a match after it exists.
 *
 * Two paths with deliberately different consequences: a draft can be changed
 * freely and tells nobody, while a published match can only change the details
 * of *this occasion* and always tells members.
 */
describe('match editing', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  const DRAFT_ARGS = `'Renamed draft','2026-09-21','18:00','19:30','21:00','New Pitch',18,12,
                      'first_come','automatic'`;

  describe('draft editing', () => {
    it('updates every permitted field', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_draft_match($1, ${DRAFT_ARGS}, 4, 'https://maps.example/x',
                                            interval '3 hours', interval '5 hours',
                                            interval '10 hours', interval '7 hours', 'Bring bibs')`,
          [SEED_MATCHES.rmvfcDraft],
        ),
      );

      const { rows } = await db.pool.query<{
        title: string;
        location_name: string;
        capacity: number;
        min_players: number;
        team_count: number;
        selection_mode: string;
        waitlist_mode: string;
        public_notes: string;
        location_map_url: string;
        signup_lead: string;
        cancel_lead: string;
        roster_lead: string;
        priority_window: string;
        priority_window_ends_at: Date | null;
      }>(
        `select title, location_name, capacity, min_players, team_count,
                selection_mode, waitlist_mode, public_notes, location_map_url,
                (kickoff_at - signup_closes_at)::text as signup_lead,
                (kickoff_at - cancellation_cutoff_at)::text as cancel_lead,
                (kickoff_at - roster_publish_target_at)::text as roster_lead,
                priority_window::text as priority_window, priority_window_ends_at
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );

      expect(rows[0]).toMatchObject({
        title: 'Renamed draft',
        location_name: 'New Pitch',
        capacity: 18,
        min_players: 12,
        team_count: 4,
        selection_mode: 'first_come',
        waitlist_mode: 'automatic',
        public_notes: 'Bring bibs',
        location_map_url: 'https://maps.example/x',
        signup_lead: '05:00:00',
        cancel_lead: '10:00:00',
        roster_lead: '07:00:00',
        priority_window: '03:00:00',
      });
    });

    it('clears the resolved priority-window end, which only publication can know', async () => {
      // The seed gives the draft one, so this genuinely changes state.
      const before = await db.pool.query<{ ends_at: Date | null }>(
        'select priority_window_ends_at as ends_at from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(before.rows[0]?.ends_at).not.toBeNull();

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS}, 2, null, interval '6 hours')`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const after = await db.pool.query<{ ends_at: Date | null; window: string }>(
        `select priority_window_ends_at as ends_at, priority_window::text as window
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );

      // The window runs from publication, so carrying the old instant forward
      // would describe a window nobody configured — and, once the match moves
      // earlier, would break matches_priority_window_before_close.
      expect(after.rows[0]?.window).toBe('06:00:00');
      expect(after.rows[0]?.ends_at).toBeNull();
    });

    it('lets a draft be moved to a date before the old priority-window end', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_draft_match($1,'Brought forward',(current_date + 1)::date,
                                            '18:00','19:00','20:30','P',18,12,
                                            'first_come','automatic')`,
          [SEED_MATCHES.rmvfcDraft],
        ),
      );

      const { rows } = await db.pool.query<{ match_date: string }>(
        'select match_date::text as match_date from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.match_date).toBeTruthy();
    });

    it('keeps the match a draft', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string; published_at: Date | null }>(
        'select status, published_at from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.status).toBe('draft');
      expect(rows[0]?.published_at).toBeNull();
    });

    it('leaves the draft invisible to members', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query('select id from public.matches where id = $1', [
          SEED_MATCHES.rmvfcDraft,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('writes an audit event', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ action: string; actor_user_id: string }>(
        `select action, actor_user_id from public.audit_events
          where entity_id = $1 and action = 'match.draft_updated'`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
    });

    it('creates no notification', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      // Members have never seen this match; there is nothing to correct.
      expect(rows[0]?.count).toBe('0');
    });

    it('does not change the revision', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ revision: number }>(
        'select revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      // The revision exists to key change notifications. A draft sends none.
      expect(rows[0]?.revision).toBe(0);
    });

    it('refuses a player, a non-member and another league’s administrator', async () => {
      for (const actor of [
        SEED_USERS.rmvfcPlayer,
        SEED_USERS.outsider,
        SEED_USERS.fivesAdmin,
      ]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
              SEED_MATCHES.rmvfcDraft,
            ]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('refuses an unauthenticated caller', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            SEED_MATCHES.rmvfcDraft,
          ]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('reports an unknown match exactly as an unauthorised one', async () => {
      const unknown = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            'aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff',
          ]),
        ),
      );
      const crossLeague = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            SEED_MATCHES.fivesOpen,
          ]),
        ),
      );

      // Identical, so a guessed id cannot confirm a private match exists.
      expect(unknown.message).toContain('NOT_LEAGUE_ADMIN');
      expect(unknown.message).toBe(crossLeague.message);
    });

    it('refuses a published match', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            SEED_MATCHES.rmvfcOpen,
          ]),
        ),
      );
      expect(error.message).toContain('MATCH_NOT_DRAFT');
    });

    it('refuses a canceled match', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.cancel_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            SEED_MATCHES.rmvfcDraft,
          ]),
        ),
      );
      expect(error.message).toContain('MATCH_NOT_DRAFT');
    });

    it('cannot move a match to another timezone', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ timezone: string }>(
        'select timezone from public.matches where id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      // The zone comes from the row, not from the caller — there is no
      // parameter for it.
      expect(rows[0]?.timezone).toBe('America/Los_Angeles');
    });

    it('enforces the same constraints as creation', async () => {
      const cases = [
        `'X','2026-09-21','18:00','19:00','20:00','P',1,0,'first_come','automatic'`,
        `'X','2026-09-21','18:00','19:00','20:00','P',10,30,'first_come','automatic'`,
        `'X','2026-09-21','18:00','20:00','19:00','P',10,0,'first_come','automatic'`,
      ];

      for (const args of cases) {
        const error = await expectDatabaseError(() =>
          asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
            client.query(`select public.update_draft_match($1, ${args})`, [
              SEED_MATCHES.rmvfcDraft,
            ]),
          ),
        );
        expect(error.code).toBe(PG_ERROR.checkViolation);
      }
    });
  });

  describe('published editing', () => {
    const OPEN_ARGS = `'Moved match','2026-09-28','18:00','19:30','21:00','Other Pitch',20,12,2`;

    it('increments the revision exactly once per edit', async () => {
      const revision = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ revision: number }>(
          `select public.update_published_match($1, ${OPEN_ARGS}) as revision`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0]?.revision;
      });

      expect(revision).toBe(1);

      const { rows } = await db.pool.query<{ revision: number }>(
        'select revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.revision).toBe(1);
    });

    it('creates exactly one notification per eligible member, excluding the actor', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_published_match($1, ${OPEN_ARGS})`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string; count: string }>(
        `select recipient_user_id, count(*)::text as count from public.notifications
          where type = 'match_changed' and match_id = $1
          group by recipient_user_id`,
        [SEED_MATCHES.rmvfcOpen],
      );

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.count === '1')).toBe(true);
      expect(rows.map((row) => row.recipient_user_id).sort()).toEqual(
        [SEED_USERS.multiLeaguePlayer.id, SEED_USERS.rmvfcPlayer.id].sort(),
      );
    });

    it('writes the audit event with both revisions', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_published_match($1, ${OPEN_ARGS}, null, null, 'Pitch flooded')`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );

      const { rows } = await db.pool.query<{
        before_data: Record<string, unknown>;
        after_data: Record<string, unknown>;
        reason: string;
      }>(
        `select before_data, after_data, reason from public.audit_events
          where entity_id = $1 and action = 'match.updated'`,
        [SEED_MATCHES.rmvfcOpen],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.before_data['revision']).toBe(0);
      expect(rows[0]?.after_data['revision']).toBe(1);
      expect(rows[0]?.reason).toBe('Pitch flooded');
    });

    it('keys the notification on the revision, so a retry of one edit cannot double-send', async () => {
      for (const title of ["'First edit'", "'Second edit'"]) {
        await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.update_published_match($1, ${title},'2026-09-28','18:00','19:30','21:00','P',20,12,2)`,
            [SEED_MATCHES.rmvfcOpen],
          ),
        );
      }

      const { rows } = await db.pool.query<{ key: string }>(
        `select idempotency_key as key from public.notifications
          where type = 'match_changed' and match_id = $1 order by idempotency_key`,
        [SEED_MATCHES.rmvfcOpen],
      );

      // `match_changed:<match>:<revision>:<recipient>` — unique per recipient
      // per revision, and every writer inserts ON CONFLICT DO NOTHING. Two
      // edits × two members, across two distinct revisions.
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.key)).size).toBe(4);
      expect(new Set(rows.map((row) => row.key.split(':')[2])).size).toBe(2);
      for (const row of rows) {
        expect(row.key.startsWith(`match_changed:${SEED_MATCHES.rmvfcOpen}:`)).toBe(true);
      }
    });

    it('preserves the deadline lead times when kickoff moves', async () => {
      const before = await db.pool.query<{ signup_lead: string; cancel_lead: string }>(
        `select (kickoff_at - signup_closes_at)::text as signup_lead,
                (kickoff_at - cancellation_cutoff_at)::text as cancel_lead
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_published_match($1, ${OPEN_ARGS})`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );

      const after = await db.pool.query<{ signup_lead: string; cancel_lead: string }>(
        `select (kickoff_at - signup_closes_at)::text as signup_lead,
                (kickoff_at - cancellation_cutoff_at)::text as cancel_lead
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );

      // Deadlines are configured as lead times; moving the match moves them
      // with it rather than resetting them to a default.
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, actor, (client) =>
            client.query(`select public.update_published_match($1, ${OPEN_ARGS})`, [
              SEED_MATCHES.rmvfcOpen,
            ]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('never lets a published edit change the participation terms', async () => {
      const before = await db.pool.query<{
        selection_mode: string;
        waitlist_mode: string;
      }>('select selection_mode, waitlist_mode from public.matches where id = $1', [
        SEED_MATCHES.rmvfcOpen,
      ]);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`select public.update_published_match($1, ${OPEN_ARGS})`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );

      const after = await db.pool.query<{ selection_mode: string; waitlist_mode: string }>(
        'select selection_mode, waitlist_mode from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );

      // The function has no parameter for either, so members' terms cannot
      // change under them.
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  describe('optimistic concurrency', () => {
    it('accepts an edit at the current revision', async () => {
      const revision = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ revision: number }>(
          `select public.update_published_match($1,'Fine','2026-09-28','18:00','19:30','21:00',
                                                'P',20,12,2,null,null,null,0) as revision`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0]?.revision;
      });
      expect(revision).toBe(1);
    });

    it('refuses a stale edit rather than overwriting a newer one', async () => {
      // Somebody else edits first, taking the revision to 1.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_published_match($1,'Their change','2026-09-28','18:00','19:30','21:00',
                                                'P',20,12,2,null,null,null,0)`,
          [SEED_MATCHES.rmvfcOpen],
        ),
      );

      // A form rendered before that still believes it is on revision 0.
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.update_published_match($1,'My stale change','2026-10-05','18:00','19:30','21:00',
                                                  'P',20,12,2,null,null,null,0)`,
            [SEED_MATCHES.rmvfcOpen],
          ),
        ),
      );

      expect(error.message).toContain('MATCH_REVISION_STALE');

      const { rows } = await db.pool.query<{ title: string; revision: number }>(
        'select title, revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      // The earlier change stands, untouched.
      expect(rows[0]).toMatchObject({ title: 'Their change', revision: 1 });
    });

    it('notifies nobody when a stale edit is refused', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_published_match($1,'Their change','2026-09-28','18:00','19:30','21:00',
                                                'P',20,12,2,null,null,null,0)`,
          [SEED_MATCHES.rmvfcOpen],
        ),
      );

      await expectDatabaseError(() =>
        asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.update_published_match($1,'Stale','2026-10-05','18:00','19:30','21:00',
                                                  'P',20,12,2,null,null,null,0)`,
            [SEED_MATCHES.rmvfcOpen],
          ),
        ),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where type = 'match_changed' and match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      // The check runs before anything is written, so members are never told
      // about a time that was rejected.
      expect(rows[0]?.count).toBe('2');
    });

    it('skips the check when no revision is supplied, preserving older callers', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_published_match($1,'First','2026-09-28','18:00','19:30','21:00','P',20,12,2)`,
          [SEED_MATCHES.rmvfcOpen],
        ),
      );

      const revision = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ revision: number }>(
          `select public.update_published_match($1,'Second','2026-09-28','18:00','19:30','21:00','P',20,12,2)
             as revision`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0]?.revision;
      });

      expect(revision).toBe(2);
    });
  });

  describe('administrator notes', () => {
    it('are readable by the administrator and invisible to every member', async () => {
      const adminRows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select notes from public.match_admin_notes');
        return result.rows;
      });
      expect(adminRows.length).toBeGreaterThan(0);

      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.multiLeaguePlayer]) {
        const rows = await asUser(db, actor, async (client) => {
          const result = await client.query('select notes from public.match_admin_notes');
          return result.rows;
        });
        expect(rows).toEqual([]);
      }
    });

    it('can be written and cleared by the administrator', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.match_admin_notes (match_id, league_id, notes)
           values ($1, $2, 'Watch the ankle')
           on conflict (match_id) do update set notes = excluded.notes`,
          [SEED_MATCHES.rmvfcDraft, SEED_LEAGUES.rmvfc],
        ),
      );

      const written = await db.pool.query<{ notes: string }>(
        'select notes from public.match_admin_notes where match_id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(written.rows[0]?.notes).toBe('Watch the ankle');

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('delete from public.match_admin_notes where match_id = $1', [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const cleared = await db.pool.query('select notes from public.match_admin_notes where match_id = $1', [
        SEED_MATCHES.rmvfcDraft,
      ]);
      expect(cleared.rows).toEqual([]);
    });

    it('are audited without recording their text', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.match_admin_notes (match_id, league_id, notes)
           values ($1, $2, 'Confidential: player dispute')`,
          [SEED_MATCHES.rmvfcDraft, SEED_LEAGUES.rmvfc],
        ),
      );

      const { rows } = await db.pool.query<{ action: string; after_data: Record<string, unknown> }>(
        `select action, after_data from public.audit_events
          where entity_id = $1 and action like 'match.admin_note%'`,
        [SEED_MATCHES.rmvfcDraft],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('match.admin_note_added');
      // Audit rows are readable by every future administrator, so the note's
      // text is deliberately not copied into one.
      expect(rows[0]?.after_data).toEqual({ has_notes: true });
      expect(JSON.stringify(rows[0])).not.toContain('Confidential');
    });

    it('notify nobody, even on a published match members are watching', async () => {
      // Upsert, exactly as saveMatchAdminNotesAction does — the seeded match
      // already has a note.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.match_admin_notes (match_id, league_id, notes)
           values ($1, $2, 'Private')
           on conflict (match_id) do update set notes = excluded.notes`,
          [SEED_MATCHES.rmvfcOpen, SEED_LEAGUES.rmvfc],
        ),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('never reach a notification body', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.match_admin_notes (match_id, league_id, notes)
           values ($1, $2, 'SECRETNOTE')`,
          [SEED_MATCHES.rmvfcDraft, SEED_LEAGUES.rmvfc],
        ),
      );
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(string_agg(title || ' ' || body || ' ' || deep_link, ' '), '') as blob
           from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.blob).not.toContain('SECRETNOTE');
    });

    it('refuse a player writing them', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.match_admin_notes (match_id, league_id, notes)
             values ($1, $2, 'Sneaky')`,
            [SEED_MATCHES.rmvfcOpen, SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('canceled matches stay read-only', () => {
    it('refuses both edit paths', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.cancel_match($1)', [SEED_MATCHES.rmvfcOpen]),
      );

      const draftPath = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(`select public.update_draft_match($1, ${DRAFT_ARGS})`, [
            SEED_MATCHES.rmvfcOpen,
          ]),
        ),
      );
      const publishedPath = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.update_published_match($1,'X','2026-09-28','18:00','19:30','21:00','P',20,12,2)`,
            [SEED_MATCHES.rmvfcOpen],
          ),
        ),
      );

      expect(draftPath.message).toContain('MATCH_NOT_DRAFT');
      expect(publishedPath.message).toContain('MATCH_NOT_OPEN');
    });

    it('still shows the match to members', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.cancel_match($1, $2)', [SEED_MATCHES.rmvfcOpen, 'Waterlogged']),
      );

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ status: string; cancellation_reason: string }>(
          'select status, cancellation_reason from public.matches where id = $1',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows;
      });

      // Read-only, not hidden — a cancellation is information a member needs.
      expect(rows[0]).toMatchObject({ status: 'canceled', cancellation_reason: 'Waterlogged' });
    });
  });

  describe('timezone round trip', () => {
    it('does not shift an unchanged time when the form is loaded and saved', async () => {
      const before = await db.pool.query<{
        arrival: string;
        kickoff: string;
        end: string;
        local_arrival: string;
        local_kickoff: string;
        local_end: string;
        match_date: string;
      }>(
        `select arrival_at::text as arrival, kickoff_at::text as kickoff, end_at::text as end,
                to_char(arrival_at at time zone timezone, 'HH24:MI') as local_arrival,
                to_char(kickoff_at at time zone timezone, 'HH24:MI') as local_kickoff,
                to_char(end_at at time zone timezone, 'HH24:MI') as local_end,
                match_date::text as match_date
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      const original = before.rows[0]!;

      // Exactly what the form does: read local values back, submit them again.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_draft_match($1, $2, $3::date, $4::time, $5::time, $6::time,
                                            $7, $8, $9, $10, $11)`,
          [
            SEED_MATCHES.rmvfcDraft,
            'Wednesday night 11v11 (draft)',
            original.match_date,
            original.local_arrival,
            original.local_kickoff,
            original.local_end,
            'RMV Community Pitch',
            22,
            14,
            'admin_approval',
            'admin_controlled',
          ],
        ),
      );

      const after = await db.pool.query<{ arrival: string; kickoff: string; end: string }>(
        `select arrival_at::text as arrival, kickoff_at::text as kickoff, end_at::text as end
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );

      expect(after.rows[0]?.arrival).toBe(original.arrival);
      expect(after.rows[0]?.kickoff).toBe(original.kickoff);
      expect(after.rows[0]?.end).toBe(original.end);
    });

    it.each([
      ['standard time', '2026-01-15', '2026-01-16 03:00:00'],
      ['daylight time', '2026-07-15', '2026-07-16 02:00:00'],
      ['the day before clocks go forward', '2026-03-07', '2026-03-08 03:00:00'],
      ['the day after clocks go forward', '2026-03-09', '2026-03-10 02:00:00'],
      ['the day before clocks go back', '2026-10-31', '2026-11-01 02:00:00'],
      ['the day after clocks go back', '2026-11-02', '2026-11-03 03:00:00'],
    ])('resolves a 19:00 kickoff on %s', async (_label, date, expectedUtc) => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `select public.update_draft_match($1,'DST check',$2::date,'18:30','19:00','20:30',
                                            'P',22,14,'admin_approval','admin_controlled')`,
          [SEED_MATCHES.rmvfcDraft, date],
        ),
      );

      const { rows } = await db.pool.query<{ utc: string; local: string }>(
        `select (kickoff_at at time zone 'UTC')::text as utc,
                to_char(kickoff_at at time zone timezone, 'HH24:MI') as local
           from public.matches where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );

      expect(rows[0]?.utc).toBe(expectedUtc);
      // Always 19:00 to a member reading it in the league's own zone.
      expect(rows[0]?.local).toBe('19:00');
    });
  });
});
