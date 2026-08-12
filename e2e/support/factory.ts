import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { readSupabaseEnvironment } from './environment';

/**
 * Test data, built fresh per test.
 *
 * Every spec that mutates state creates its **own** league with a unique slug,
 * its own members and its own matches. Nothing is shared, so no test can be
 * affected by another's writes and no test depends on running in a particular
 * order. That is what makes `fullyParallel` safe and what makes the suite
 * repeatable after `npm run db:reset` without any cleanup step.
 *
 * The factory writes through a direct PostgreSQL connection, which bypasses
 * Row Level Security — deliberately, and only here. Setting up a fixture is not
 * the thing under test; every assertion afterwards goes through the browser,
 * the real session and the real policies. Where a *domain operation* is what a
 * test is checking (joining, cancelling, publishing), the test drives the UI or
 * calls the same RPC a client would, never this file.
 */

export interface TestUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  membershipId: string;
}

export interface TestLeague {
  id: string;
  slug: string;
  name: string;
  admin: TestUser;
}

export interface TestMatch {
  id: string;
  title: string;
  leagueId: string;
  leagueSlug: string;
}

export interface CreateLeagueOptions {
  selectionMode?: 'first_come' | 'admin_approval';
  waitlistMode?: 'automatic' | 'admin_controlled';
  visibility?: 'private' | 'searchable';
  timezone?: string;
  genderFieldEnabled?: boolean;
}

export interface CreateMemberOptions {
  status?: 'pending' | 'active' | 'suspended' | 'removed';
  role?: 'league_admin' | 'player';
  acceptsGuidelines?: boolean;
}

export interface CreateMatchOptions {
  capacity?: number;
  minPlayers?: number;
  status?: 'draft' | 'open';
  selectionMode?: 'first_come' | 'admin_approval';
  waitlistMode?: 'automatic' | 'admin_controlled';
  /** Hours from now until kickoff. Negative puts the match in the past. */
  kickoffInHours?: number;
  /** Hours before kickoff that signup closes. */
  signupClosesBeforeHours?: number;
  /** Hours before kickoff that cancellation stops being on time. */
  cancellationCutoffBeforeHours?: number;
  title?: string;
}

/** A short unique suffix, so slugs and emails never collide across workers. */
function unique(): string {
  return randomUUID().slice(0, 8);
}

export class TestDataFactory {
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<TestDataFactory> {
    const { databaseUrl } = readSupabaseEnvironment();
    const client = new Client(databaseUrl);
    await client.connect();
    return new TestDataFactory(client);
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  /** Raw access, for the few assertions that are genuinely about stored state. */
  async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.client.query<T>(sql, params);
    return result.rows;
  }

  private async createAccount(label: string): Promise<{ id: string; email: string; first: string }> {
    const id = randomUUID();
    const token = unique();
    const email = `${label}.${token}@matchday.test`;
    const first = `${label.charAt(0).toUpperCase()}${label.slice(1)}${token.slice(0, 4)}`;

    // Mirrors `supabase/seed.sql` exactly, including the empty-string token
    // columns GoTrue expects and — crucially — the `auth.identities` row. The
    // seed's own comment records why: GoTrue resolves an email sign-in through
    // that table, so a user without one cannot be issued a magic link at all.
    await this.client.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         email_change_token_current, phone_change, phone_change_token, reauthentication_token
       )
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
               $2, null, now(),
               '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
               now(), now(), '', '', '', '', '', '', '', '')`,
      [id, email],
    );
    await this.client.query(
      `insert into auth.identities (
         id, user_id, provider, provider_id, identity_data,
         last_sign_in_at, created_at, updated_at
       )
       values (gen_random_uuid(), $1::uuid, 'email', $1::text,
               jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true),
               null, now(), now())`,
      [id, email],
    );
    await this.client.query(
      `insert into public.profiles (id, first_name, last_name, email_normalized)
       values ($1, $2, 'Tester', $3)`,
      [id, first, email],
    );

    return { id, email, first };
  }

  /**
   * A league with its administrator, both brand new.
   *
   * Created directly rather than through `create_league()` because the point is
   * a starting position, not the creation flow — which has its own spec that
   * drives the real form.
   */
  async createLeague(options: CreateLeagueOptions = {}): Promise<TestLeague> {
    const account = await this.createAccount('admin');
    const leagueId = randomUUID();
    const membershipId = randomUUID();
    const token = unique();
    const slug = `e2e-league-${token}`;
    const name = `E2E League ${token}`;

    // One transaction, for the same reason `create_league()` uses one: the
    // Phase 1 deferred constraint trigger rejects any league that reaches
    // COMMIT without exactly one active administrator, so two separate
    // statements could never both succeed.
    await this.client.query('begin');
    try {
      await this.client.query(
        `insert into public.leagues
           (id, name, slug, general_area, timezone, sport_label, description, visibility,
            default_capacity, default_min_players, default_selection_mode,
            default_waitlist_mode, default_team_count, gender_field_enabled, created_by)
         values ($1, $2, $3, 'E2E Area', $4, 'Soccer 5v5',
                 'A league created by the end-to-end suite.', $5,
                 10, 4, $6, $7, 2, $8, $9)`,
        [
          leagueId,
          name,
          slug,
          options.timezone ?? 'America/Los_Angeles',
          options.visibility ?? 'private',
          options.selectionMode ?? 'first_come',
          options.waitlistMode ?? 'automatic',
          options.genderFieldEnabled ?? false,
          account.id,
        ],
      );

      await this.client.query(
        `insert into public.league_memberships (id, league_id, user_id, role, status)
         values ($1, $2, $3, 'league_admin', 'active')`,
        [membershipId, leagueId, account.id],
      );
      await this.client.query('commit');
    } catch (error: unknown) {
      await this.client.query('rollback');
      throw error;
    }

    return {
      id: leagueId,
      slug,
      name,
      admin: {
        id: account.id,
        email: account.email,
        firstName: account.first,
        lastName: 'Tester',
        membershipId,
      },
    };
  }

  /** A member of an existing league. Accepts the current guidelines by default. */
  async createMember(
    league: TestLeague,
    options: CreateMemberOptions = {},
  ): Promise<TestUser> {
    const account = await this.createAccount('player');
    const membershipId = randomUUID();

    await this.client.query(
      `insert into public.league_memberships (id, league_id, user_id, role, status)
       values ($1, $2, $3, $4, $5)`,
      [
        membershipId,
        league.id,
        account.id,
        options.role ?? 'player',
        options.status ?? 'active',
      ],
    );

    if (options.acceptsGuidelines !== false) {
      await this.client.query(
        `insert into public.guideline_acceptances (league_id, membership_id, guideline_version_id)
         select $1, $2, v.id from public.guideline_versions v
          where v.id = public.current_required_guideline_version($1)
         on conflict do nothing`,
        [league.id, membershipId],
      );
    }

    return {
      id: account.id,
      email: account.email,
      firstName: account.first,
      lastName: 'Tester',
      membershipId,
    };
  }

  /** An account belonging to no league at all. */
  async createOutsider(): Promise<TestUser> {
    const account = await this.createAccount('outsider');
    return {
      id: account.id,
      email: account.email,
      firstName: account.first,
      lastName: 'Tester',
      membershipId: '',
    };
  }

  /**
   * A match, with every deadline resolved from a kickoff relative to now.
   *
   * Times go through `AT TIME ZONE` exactly as `create_match()` does, so a
   * fixture match is indistinguishable from one an administrator made.
   */
  async createMatch(league: TestLeague, options: CreateMatchOptions = {}): Promise<TestMatch> {
    const id = randomUUID();
    const kickoffInHours = options.kickoffInHours ?? 72;
    const status = options.status ?? 'open';
    const title = options.title ?? `E2E Match ${unique()}`;

    await this.client.query(
      `insert into public.matches (
         id, league_id, title, match_date, timezone,
         arrival_at, kickoff_at, end_at, location_name,
         capacity, min_players, selection_mode, waitlist_mode, team_count,
         signup_closes_at, cancellation_cutoff_at,
         status, created_by, published_at
       )
       select
         $1, l.id, $2,
         slot.match_date,
         l.timezone,
         (slot.match_date + time '18:30') at time zone l.timezone,
         (slot.match_date + time '19:00') at time zone l.timezone,
         (slot.match_date + time '20:30') at time zone l.timezone,
         'E2E Pitch',
         $4, $5, $6::public.selection_mode, $7::public.waitlist_mode, 2,
         ((slot.match_date + time '19:00') at time zone l.timezone)
           - make_interval(hours => $8),
         ((slot.match_date + time '19:00') at time zone l.timezone)
           - make_interval(hours => $9),
         $10::public.match_lifecycle_status,
         l.created_by,
         -- Cast once and compare as text: the same parameter cannot be
         -- deduced as an enum in one place and a string in another.
         case when $10::text = 'draft' then null else now() end
       from public.leagues l
       cross join lateral (
         -- A FIXED LOCAL TIME OF DAY, on a date kickoffInHours away.
         --
         -- now() plus an interval would put kickoff at whatever hour the suite
         -- happens to run, and an evening run pushed the 90-minute end time
         -- past local midnight, where end_time > kickoff_time is false as a
         -- wall clock and the edit form rightly refuses to save. That made
         -- three Phase 3B tests fail by time of day rather than by behaviour.
         select (((now() + make_interval(hours => $3)) at time zone l.timezone)::date) as match_date
       ) slot
       where l.id = $11`,
      [
        id,
        title,
        kickoffInHours,
        options.capacity ?? 10,
        options.minPlayers ?? 1,
        options.selectionMode ?? 'first_come',
        options.waitlistMode ?? 'automatic',
        options.signupClosesBeforeHours ?? 2,
        options.cancellationCutoffBeforeHours ?? 24,
        status,
        league.id,
      ],
    );

    return { id, title, leagueId: league.id, leagueSlug: league.slug };
  }

  /**
   * Puts a member into a match by calling the same RPC the application calls,
   * as that member.
   *
   * Deliberately not a direct insert: capacity, waitlist position and
   * notifications must be produced by the real transaction, or a test would be
   * asserting against a state the product can never actually reach.
   */
  async joinMatch(match: TestMatch, user: TestUser): Promise<void> {
    await this.asUser(user, async () => {
      await this.client.query('select public.join_match($1)', [match.id]);
    });
  }

  async requestSpot(match: TestMatch, user: TestUser): Promise<void> {
    await this.asUser(user, async () => {
      await this.client.query('select public.request_spot($1)', [match.id]);
    });
  }

  /**
   * Calls a database function as a specific person.
   *
   * Needed for any RPC that derives its actor from `auth.uid()` — which is all
   * of the administrator ones. The factory's plain `query` runs with no JWT at
   * all, so those would raise AUTH_REQUIRED rather than doing anything.
   */
  async callAs<T extends Record<string, unknown>>(
    user: TestUser,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    let rows: T[] = [];
    await this.asUser(user, async () => {
      const result = await this.client.query<T>(sql, params);
      rows = result.rows;
    });
    return rows;
  }

  /** Runs `fn` with the verified-JWT claims PostgREST would have set. */
  private async asUser(user: TestUser, fn: () => Promise<void>): Promise<void> {
    await this.client.query('begin');
    await this.client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        sub: user.id,
        email: user.email,
        role: 'authenticated',
        aud: 'authenticated',
      }),
    ]);
    await this.client.query('set local role authenticated');
    try {
      await fn();
      await this.client.query('reset role');
      await this.client.query('commit');
    } catch (error: unknown) {
      await this.client.query('rollback');
      throw error;
    }
  }

  /** A published guideline version that members must accept. */
  async publishRequiredGuideline(league: TestLeague, label = 'e2e-required'): Promise<string> {
    const id = randomUUID();
    await this.client.query(
      `insert into public.guideline_versions
         (id, league_id, version_label, title, body, effective_at,
          requires_acceptance, published_at, content_checksum, created_by)
       values ($1, $2, $3, 'E2E Guidelines',
               'Play fairly and let the administrator know if you cannot make it.',
               now(), true, now(), md5($3), $4)`,
      [id, league.id, `${label}-${unique()}`, league.admin.id],
    );
    return id;
  }

  /** Moves a match's cancellation cutoff into the past. */
  async expireCancellationCutoff(match: TestMatch): Promise<void> {
    await this.client.query(
      `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
        where id = $1`,
      [match.id],
    );
  }

  /** Moves a match's signup deadline into the past. */
  async closeSignup(match: TestMatch): Promise<void> {
    await this.client.query(
      `update public.matches
          set signup_closes_at = now() - interval '1 hour', priority_window_ends_at = null
        where id = $1`,
      [match.id],
    );
  }

  /** Schedules a reminder that is already due. */
  async createDueReminder(match: TestMatch): Promise<string> {
    await this.client.query(
      `update public.matches set reminder_offsets = array[interval '2 hours'] where id = $1`,
      [match.id],
    );
    await this.client.query('select public.materialize_match_reminders($1)', [match.id]);
    const rows = await this.query<{ id: string }>(
      `update public.match_reminders set due_at = now() - interval '1 minute'
        where match_id = $1 returning id`,
      [match.id],
    );
    return rows[0]?.id ?? '';
  }
}
