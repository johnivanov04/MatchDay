/**
 * Hand-maintained mirror of the Phase 1 schema in `supabase/migrations/`.
 *
 * Once a Supabase project exists this can be replaced with
 * `supabase gen types typescript --local > src/types/database.ts`. Until then
 * these types are written by hand and kept honest by the database test suite,
 * which asserts the real column set and nullability against a real PostgreSQL
 * server (tests/db/schema.test.ts).
 */

export type LeagueVisibility = 'private' | 'searchable';
export type LeagueRole = 'league_admin' | 'player';
export type MembershipStatus = 'pending' | 'active' | 'suspended' | 'removed';
export type SelectionMode = 'first_come' | 'admin_approval';
export type WaitlistMode = 'automatic' | 'admin_controlled';

export const MEMBERSHIP_STATUSES: readonly MembershipStatus[] = [
  'pending',
  'active',
  'suspended',
  'removed',
];

export type ProfileRow = {
  id: string;
  first_name: string;
  last_name: string;
  email_normalized: string;
  phone: string | null;
  gender: string | null;
  preferred_positions: string[];
  goalkeeper_willing: boolean | null;
  /**
   * Legacy external photo address. Still rendered when present, but no longer
   * editable: the profile form has no URL input, and a managed upload clears
   * this column. See `20260818090100_profile_photo_path.sql`.
   */
  profile_photo_url: string | null;
  /** `{id}/{uuid}.jpg` in the public `avatars` bucket, or null. */
  profile_photo_path: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The details half of a profile: everything the profile form submits.
 *
 * Deliberately excludes both photo columns. They are written only by the avatar
 * action, from a path it generated itself — a form field that could set either
 * one would be a way to point a profile at an arbitrary address again, which is
 * precisely what this phase removed.
 */
export type ProfileDetailFields = {
  first_name: string;
  last_name: string;
  phone: string | null;
  gender: string | null;
  preferred_positions: string[];
  goalkeeper_willing: boolean | null;
};

/** The photo half. Written together, never independently. */
export type ProfilePhotoFields = {
  profile_photo_path: string | null;
  profile_photo_url: string | null;
};

/** Columns a user may write on their own profile. Email and id are server-owned. */
export type ProfileWritableFields = ProfileDetailFields & ProfilePhotoFields;

export type LeagueRow = {
  id: string;
  name: string;
  slug: string;
  general_area: string;
  timezone: string;
  sport_label: string;
  description: string;
  visibility: LeagueVisibility;
  default_capacity: number;
  default_min_players: number;
  default_selection_mode: SelectionMode;
  default_waitlist_mode: WaitlistMode;
  default_team_count: number;
  default_location: string | null;
  typical_schedule: string | null;
  logo_url: string | null;
  position_labels: string[];
  gender_field_enabled: boolean;
  goalkeeper_field_enabled: boolean;
  public_contact: string | null;
  settings_json: Record<string, unknown>;
  /**
   * Starting values for a new match's timing, as PostgreSQL interval literals
   * (`"02:00:00"`, `"1 day"`). Copied into a match at creation and resolved
   * there against the league timezone — changing one never moves a match that
   * already exists.
   *
   * The two nullable ones mean "this league does not use that feature", which
   * is a different statement from a duration of zero.
   */
  default_signup_closes_before: string;
  default_cancellation_cutoff_before: string;
  default_priority_window: string | null;
  default_roster_publish_before: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LeagueMembershipRow = {
  id: string;
  league_id: string;
  user_id: string;
  role: LeagueRole;
  status: MembershipStatus;
  suspended_until: string | null;
  /**
   * Why the administrator last changed this member's status.
   *
   * Administrator-only, like `league_membership_admin_notes`: never shown to
   * other players, never placed in a notification, a push payload or a log.
   */
  status_reason: string | null;
  joined_at: string | null;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
};

export type UserAppStateRow = {
  user_id: string;
  active_league_id: string | null;
  updated_at: string;
};

export type AuditEventRow = {
  id: string;
  league_id: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export type LeagueJoinRequestRow = {
  id: string;
  league_id: string;
  user_id: string;
  status: JoinRequestStatus;
  message: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Phase 2 invitation.
 *
 * `token_hash` is intentionally absent from this type. `authenticated` holds a
 * column-level grant that excludes it, so selecting it fails at the database;
 * leaving it out of the type means a `select *` cannot be written by accident
 * either.
 */
export type LeagueInviteRow = {
  id: string;
  league_id: string;
  label: string | null;
  grants_status: Extract<MembershipStatus, 'active' | 'pending'>;
  max_uses: number | null;
  use_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public search projection — exactly the fields PRD §12 permits in a public
 * or search result. Adding a field here means adding it to the view, which
 * means re-reading PRD §12 first.
 */
export type SearchableLeaguePublicRow = {
  id: string;
  slug: string;
  name: string;
  general_area: string;
  sport_label: string;
  typical_schedule: string | null;
  description: string;
};

export type LeagueMembershipAdminNoteRow = {
  id: string;
  league_id: string;
  membership_id: string;
  note: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// ── Phase 3 ────────────────────────────────────────────────────────────────

/** All six states exist in the enum; Phase 3 only transitions between three. */
export type MatchLifecycleStatus =
  | 'draft'
  | 'open'
  | 'roster_finalized'
  | 'teams_published'
  | 'canceled'
  | 'completed';

export type NotificationType =
  | 'join_request_submitted'
  | 'join_request_approved'
  | 'join_request_rejected'
  | 'league_invitation_accepted'
  | 'match_published'
  | 'match_changed'
  | 'match_canceled'
  | 'guideline_version_published'
  | 'guideline_acceptance_required'
  // Phase 4. The cancellation receipt, late-cancellation alert and waitlist
  // promotion that 02 §14 also lists belong to the Phase 5 workflow that can
  // send them.
  | 'signup_confirmed'
  | 'signup_pending'
  | 'waitlisted'
  | 'not_selected'
  | 'roster_published'
  | 'roster_changed'
  // Phase 5, completing 02 §14. `roster_changed` above is reused rather than
  // duplicated: a cancellation that changes a published roster is that event.
  | 'cancellation_receipt'
  | 'late_cancellation'
  | 'waitlist_promotion'
  | 'replacement_needed'
  | 'reminder'
  // Phase 6. Two types rather than one, matching how roster_published and
  // roster_changed already split first publication from a later change.
  | 'teams_published'
  | 'teams_changed'
  // Phase 7, completing 02 §14. One type, not two: a correction is the same
  // fact about the same match arriving again, and the revision in the
  // idempotency key is what distinguishes it from the first recording.
  | 'attendance_recorded';

export type PushDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'invalidated';

export type GuidelineVersionRow = {
  id: string;
  league_id: string;
  version_label: string;
  title: string;
  body: string;
  document_url: string | null;
  effective_at: string;
  requires_acceptance: boolean;
  published_at: string | null;
  archived_at: string | null;
  content_checksum: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type GuidelineAcceptanceRow = {
  id: string;
  league_id: string;
  guideline_version_id: string;
  membership_id: string;
  accepted_at: string;
};

export type MatchTemplateRow = {
  id: string;
  league_id: string;
  name: string;
  day_of_week: number | null;
  recurrence_note: string | null;
  arrival_time: string;
  kickoff_time: string;
  end_time: string;
  location_name: string;
  location_map_url: string | null;
  capacity: number;
  min_players: number;
  selection_mode: SelectionMode;
  waitlist_mode: WaitlistMode;
  team_count: number;
  priority_window: string | null;
  signup_closes_before: string;
  cancellation_cutoff_before: string;
  roster_publish_before: string | null;
  reminder_offsets: string[];
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MatchRow = {
  id: string;
  league_id: string;
  template_id: string | null;
  title: string;
  match_date: string;
  timezone: string;
  arrival_at: string;
  kickoff_at: string;
  end_at: string;
  location_name: string;
  location_map_url: string | null;
  capacity: number;
  min_players: number;
  selection_mode: SelectionMode;
  waitlist_mode: WaitlistMode;
  team_count: number;
  priority_window: string | null;
  priority_window_ends_at: string | null;
  signup_closes_at: string;
  cancellation_cutoff_at: string;
  roster_publish_target_at: string | null;
  status: MatchLifecycleStatus;
  public_notes: string | null;
  revision: number;
  /** Phase 4. Distinct from `revision`, which tracks edits to the match itself. */
  roster_revision: number;
  roster_finalized_at: string | null;
  /** Phase 6. 0 means teams have never been published. Distinct from roster_revision. */
  team_revision: number;
  teams_published_at: string | null;
  created_by: string | null;
  published_at: string | null;
  canceled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type MatchAdminNoteRow = {
  match_id: string;
  league_id: string;
  notes: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

// ── Phase 4 ────────────────────────────────────────────────────────────────

/**
 * All seven values from 02 §3. `canceled` and `withdrawn_late` exist so Phase 5
 * needs no migration on a populated table; a database trigger refuses to write
 * either until that phase implements the behaviour behind them.
 */
export type SignupStatus =
  | 'interested'
  | 'confirmed'
  | 'waitlisted'
  | 'not_selected'
  | 'not_available'
  | 'canceled'
  | 'withdrawn_late';

/** Only `confirmed` occupies a capacity slot — see signup_consumes_capacity(). */
export const CAPACITY_CONSUMING_STATUSES: readonly SignupStatus[] = ['confirmed'];

export type MatchSignupRow = {
  id: string;
  league_id: string;
  match_id: string;
  membership_id: string;
  status: SignupStatus;
  responded_at: string;
  priority_qualified: boolean | null;
  waitlist_position: number | null;
  canceled_at: string | null;
  cancellation_reason: string | null;
  selected_by: string | null;
  selected_at: string | null;
  override_reason: string | null;
  published_status: SignupStatus | null;
  created_at: string;
  updated_at: string;
};

/** What every signup RPC returns: the caller's own outcome, and nobody else's. */
export type SignupOutcome = {
  status: SignupStatus;
  waitlist_position: number | null;
};

/**
 * A confirmed player as a member is allowed to see them.
 *
 * A name and a managed avatar path, and nothing else. `profile_photo_path` is
 * the *object key* — `{uuid}/{uuid}.jpg` — not a URL; `managedAvatarUrl()`
 * turns it into one, and is the only thing that does.
 *
 * There is deliberately no `profile_photo_url` here or on any other projected
 * player type. A legacy address points at a host nobody here controls, and no
 * projection returns one — not even for the caller's own row.
 */
export type ConfirmedRosterEntry = {
  membership_id: string;
  first_name: string;
  last_name: string;
  is_self: boolean;
  profile_photo_path: string | null;
};

export type MatchSignupCounts = {
  confirmed: number;
  waitlisted: number;
  interested: number;
  capacity: number;
  min_players: number;
  cancellation_cutoff_at: string;
  /**
   * Whether cancelling right now would be late, decided by the database clock
   * — the same one `cancel_spot()` classifies with. Presentation only: it is
   * never submitted back and never trusted.
   */
  cancellation_is_late: boolean;
};

/**
 * One row of the administrator roster workspace.
 *
 * `gender` and `goalkeeper_willing` arrive as `null` unless the league enables
 * those fields. There is deliberately no phone, no attendance count, no
 * no-show warning and no skill rating: Phase 7 owns attendance and none of that
 * data exists, so the workspace omits it rather than showing a fabricated zero.
 */
export type RosterAdminEntry = {
  signup_id: string;
  membership_id: string;
  first_name: string;
  last_name: string;
  status: SignupStatus;
  responded_at: string;
  waitlist_position: number | null;
  priority_qualified: boolean | null;
  preferred_positions: string[];
  goalkeeper_willing: boolean | null;
  gender: string | null;
  membership_status: MembershipStatus;
  selected_at: string | null;
  override_reason: string | null;
  profile_photo_path: string | null;
};

export type AddableMember = {
  membership_id: string;
  first_name: string;
  last_name: string;
};

// ── Phase 5 ────────────────────────────────────────────────────────────────

/**
 * What the administrator needs to fill an open spot.
 *
 * `recommended_membership_id` is the first *still-eligible* waitlisted player,
 * re-derived on read rather than stored, so it cannot go stale between the
 * cancellation that opened the spot and the administrator acting on it.
 */
export type ReplacementState = {
  open_spots: number;
  waitlisted: number;
  recommended_membership_id: string | null;
  waitlist_mode: WaitlistMode;
};

// ── Phase 6 ────────────────────────────────────────────────────────────────

/** A draft team, as the administrator's builder sees it. */
export type DraftTeam = {
  team_id: string;
  name: string;
  label: string | null;
  display_order: number;
  player_count: number;
};

/**
 * One confirmed player in the team builder.
 *
 * `team_id` is null when they still need assigning — the state publication
 * refuses to proceed from. Gender and goalkeeper willingness arrive as `null`
 * unless the league enables those fields, and there is deliberately no rating,
 * score or attendance context: the MVP has no skill field and nothing infers
 * one.
 */
export type TeamBuilderPlayer = {
  membership_id: string;
  first_name: string;
  last_name: string;
  team_id: string | null;
  team_name: string | null;
  display_order: number | null;
  preferred_positions: string[];
  goalkeeper_willing: boolean | null;
  gender: string | null;
  profile_photo_path: string | null;
};

/**
 * One published team placement, as a confirmed player sees it.
 *
 * Names and managed avatar paths only. There is no column here through which a
 * position, goalkeeper flag, gender, phone number or legacy photo address could
 * travel.
 */
export type PublishedTeamEntry = {
  team_name: string;
  team_label: string | null;
  display_order: number;
  membership_id: string;
  first_name: string;
  last_name: string;
  is_self: boolean;
  profile_photo_path: string | null;
};

// ── Phase 7 ────────────────────────────────────────────────────────────────

/** The five outcomes from 02 §16. */
export type AttendanceOutcome =
  | 'attended'
  | 'excused_absence'
  | 'canceled_on_time'
  | 'canceled_late'
  | 'no_show';

/**
 * One row of the administrator's attendance workspace.
 *
 * Everybody who was ever confirmed for the match, including those who later
 * withdrew — they need `canceled_on_time` or `canceled_late` recorded, and
 * `signup_status` is what lets the administrator see which.
 *
 * `suggested` is derived from how the player left and is presentation only: it
 * is never submitted back and never trusted. It is never `no_show`, because a
 * late withdrawal is a withdrawal after the cutoff and nothing more.
 *
 * `note` is administrator-only. It reaches this type because the workspace is
 * administrator-only; it is absent from every player-facing type below.
 */
export type AttendanceWorkspaceEntry = {
  membership_id: string;
  first_name: string;
  last_name: string;
  signup_status: SignupStatus;
  canceled_at: string | null;
  outcome: AttendanceOutcome | null;
  suggested: AttendanceOutcome | null;
  note: string | null;
  revision: number | null;
  recorded_at: string | null;
  profile_photo_path: string | null;
};

/** A player's own outcome for one match. No note, and no way to ask about anybody else. */
export type MyAttendance = {
  outcome: AttendanceOutcome;
  recorded_at: string;
};

/** A player's own attendance across one league. */
export type MyAttendanceEntry = {
  match_id: string;
  match_title: string;
  kickoff_at: string;
  outcome: AttendanceOutcome;
};

/**
 * No-show context for one member, for the roster workspace.
 *
 * Counts and a date. There is deliberately no threshold, tier, colour, score or
 * ranking: 04 §1 settled that the product shows warnings and the administrator
 * decides, and no approved document defines a number at which somebody becomes
 * a problem.
 */
export type MembershipAttendanceSummary = {
  membership_id: string;
  recorded_count: number;
  attended_count: number;
  no_show_count: number;
  last_no_show_at: string | null;
};

export type MatchReminderRow = {
  id: string;
  league_id: string;
  match_id: string;
  offset_before: string;
  due_at: string;
  generated_at: string | null;
  notified_count: number | null;
  created_at: string;
};

/** Codes `match_signup_eligibility()` can return. */
export type SignupEligibility =
  | 'ELIGIBLE'
  | 'AUTH_REQUIRED'
  | 'MEMBERSHIP_REQUIRED'
  | 'GUIDELINES_NOT_ACCEPTED'
  | 'MATCH_NOT_OPEN'
  | 'SIGNUP_CLOSED';

export type NotificationRow = {
  id: string;
  recipient_user_id: string;
  league_id: string;
  match_id: string | null;
  type: NotificationType;
  title: string;
  body: string;
  deep_link: string;
  read_at: string | null;
  archived_at: string | null;
  idempotency_key: string;
  delivery_metadata: Record<string, unknown>;
  created_at: string;
};

/**
 * Push subscription as a client may see it.
 *
 * `endpoint`, `p256dh` and `auth_secret` are absent because they are excluded
 * from the column-level grant — together they are a bearer credential for that
 * device. Leaving them out of the type means a `select *` cannot be written by
 * accident either.
 */
export type PushSubscriptionRow = {
  id: string;
  user_id: string;
  device_label: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_success_at: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
};

export type PushDeliveryAttemptRow = {
  id: string;
  notification_id: string;
  subscription_id: string;
  status: PushDeliveryStatus;
  attempt_count: number;
  last_error_category: string | null;
  last_attempted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Shape expected by the `supabase-js` generics.
 *
 * `Insert` and `Update` describe what the *table* would accept, not what a
 * client is allowed to do. Phase 1 grants `authenticated` no INSERT privilege
 * on leagues, memberships or audit events at all, and RLS restricts the rest —
 * that enforcement lives in the database (20260803011000, 20260803011100),
 * where a type cannot be bypassed by a hand-written request.
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Pick<ProfileRow, 'id' | 'first_name' | 'last_name' | 'email_normalized'> &
          Partial<ProfileWritableFields>;
        Update: Partial<ProfileWritableFields>;
        Relationships: [];
      };
      leagues: {
        Row: LeagueRow;
        Insert: Omit<LeagueRow, 'id' | 'created_at' | 'updated_at'> & { id?: string };
        Update: Partial<Omit<LeagueRow, 'id' | 'created_at' | 'updated_at'>>;
        Relationships: [];
      };
      league_memberships: {
        Row: LeagueMembershipRow;
        Insert: Pick<LeagueMembershipRow, 'league_id' | 'user_id'> &
          Partial<Pick<LeagueMembershipRow, 'id' | 'role' | 'status' | 'suspended_until'>>;
        Update: Partial<Pick<LeagueMembershipRow, 'role' | 'status' | 'suspended_until'>>;
        Relationships: [];
      };
      user_app_state: {
        Row: UserAppStateRow;
        Insert: Pick<UserAppStateRow, 'user_id'> &
          Partial<Pick<UserAppStateRow, 'active_league_id'>>;
        Update: Partial<Pick<UserAppStateRow, 'active_league_id'>>;
        Relationships: [];
      };
      audit_events: {
        Row: AuditEventRow;
        Insert: Omit<AuditEventRow, 'id' | 'created_at'> & { id?: string };
        Update: never;
        Relationships: [];
      };
      league_membership_admin_notes: {
        Row: LeagueMembershipAdminNoteRow;
        Insert: Omit<LeagueMembershipAdminNoteRow, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
        };
        Update: Partial<Pick<LeagueMembershipAdminNoteRow, 'note'>>;
        Relationships: [];
      };
      league_join_requests: {
        Row: LeagueJoinRequestRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      league_invites: {
        Row: LeagueInviteRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      guideline_versions: {
        Row: GuidelineVersionRow;
        Insert: Pick<
          GuidelineVersionRow,
          'league_id' | 'version_label' | 'title' | 'body'
        > &
          Partial<
            Pick<
              GuidelineVersionRow,
              'document_url' | 'effective_at' | 'requires_acceptance' | 'created_by'
            >
          >;
        Update: Partial<
          Pick<
            GuidelineVersionRow,
            'version_label' | 'title' | 'body' | 'document_url' | 'effective_at' | 'requires_acceptance'
          >
        >;
        Relationships: [];
      };
      guideline_acceptances: {
        Row: GuidelineAcceptanceRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      match_templates: {
        Row: MatchTemplateRow;
        Insert: Omit<MatchTemplateRow, 'id' | 'created_at' | 'updated_at'> & { id?: string };
        Update: Partial<Omit<MatchTemplateRow, 'id' | 'league_id' | 'created_at' | 'updated_at'>>;
        Relationships: [];
      };
      matches: {
        Row: MatchRow;
        Insert: never;
        Update: Partial<
          Pick<
            MatchRow,
            | 'title'
            | 'location_name'
            | 'location_map_url'
            | 'capacity'
            | 'min_players'
            | 'team_count'
            | 'public_notes'
            | 'selection_mode'
            | 'waitlist_mode'
          >
        >;
        Relationships: [];
      };
      match_admin_notes: {
        Row: MatchAdminNoteRow;
        Insert: Pick<MatchAdminNoteRow, 'match_id' | 'league_id' | 'notes'> &
          Partial<Pick<MatchAdminNoteRow, 'updated_by'>>;
        Update: Partial<Pick<MatchAdminNoteRow, 'notes' | 'updated_by'>>;
        Relationships: [];
      };
      match_signups: {
        Row: MatchSignupRow;
        // Read-only from the API. Every write goes through a transactional RPC
        // that takes the match lock, enforces capacity and keeps waitlist
        // positions contiguous; a direct insert or update could do none of
        // those, so the type refuses to describe one.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      push_subscriptions: {
        Row: PushSubscriptionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      push_delivery_attempts: {
        Row: PushDeliveryAttemptRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      searchable_leagues_public: {
        Row: SearchableLeaguePublicRow;
        Relationships: [];
      };
    };
    Functions: {
      create_league: {
        Args: {
          p_name: string;
          p_slug: string;
          p_general_area: string;
          p_timezone: string;
          p_sport_label: string;
          p_description: string;
          p_default_capacity: number;
          p_default_min_players?: number;
          p_default_selection_mode?: SelectionMode;
          p_default_waitlist_mode?: WaitlistMode;
          p_default_team_count?: number;
          p_default_location?: string | null;
          p_typical_schedule?: string | null;
          p_gender_field_enabled?: boolean;
          p_goalkeeper_field_enabled?: boolean;
          p_default_signup_closes_before?: string;
          p_default_cancellation_cutoff_before?: string;
          p_default_priority_window?: string | null;
          p_default_roster_publish_before?: string | null;
        };
        Returns: string;
      };
      request_to_join_league: {
        Args: { p_league_id: string; p_message?: string | null };
        Returns: string;
      };
      withdraw_join_request: {
        Args: { p_request_id: string };
        Returns: undefined;
      };
      decide_join_request: {
        Args: { p_request_id: string; p_approve: boolean; p_note?: string | null };
        Returns: string | null;
      };
      create_league_invite: {
        Args: {
          p_league_id: string;
          p_token: string;
          p_label?: string | null;
          p_grants_status?: MembershipStatus;
          p_max_uses?: number | null;
          p_expires_in_days?: number;
        };
        Returns: string;
      };
      revoke_league_invite: {
        Args: { p_invite_id: string };
        Returns: undefined;
      };
      redeem_league_invite: {
        Args: { p_token: string };
        Returns: {
          league_id: string;
          membership_id: string;
          status: MembershipStatus;
          joined: boolean;
        };
      };
      add_league_member_by_email: {
        Args: { p_league_id: string; p_email: string; p_status?: MembershipStatus };
        Returns: string;
      };
      transfer_league_administration: {
        Args: {
          p_league_id: string;
          p_target_membership_id: string;
          p_reason?: string | null;
        };
        Returns: undefined;
      };
      current_required_guideline_version: {
        Args: { p_league_id: string };
        Returns: string | null;
      };
      has_accepted_required_guidelines: {
        Args: { p_league_id: string };
        Returns: boolean;
      };
      accept_guideline_version: {
        Args: { p_guideline_version_id: string };
        Returns: string;
      };
      publish_guideline_version: {
        Args: { p_guideline_version_id: string };
        Returns: string;
      };
      archive_guideline_version: {
        Args: { p_guideline_version_id: string };
        Returns: string;
      };
      league_guideline_acceptance_status: {
        Args: { p_league_id: string };
        Returns: {
          membership_id: string;
          user_id: string;
          membership_status: MembershipStatus;
          required_version_id: string | null;
          accepted: boolean;
          accepted_at: string | null;
        }[];
      };
      create_match: {
        Args: {
          p_league_id: string;
          p_title: string;
          p_match_date: string;
          p_arrival_time: string;
          p_kickoff_time: string;
          p_end_time: string;
          p_location_name: string;
          p_capacity: number;
          p_min_players: number;
          p_selection_mode: SelectionMode;
          p_waitlist_mode: WaitlistMode;
          p_team_count?: number;
          p_template_id?: string | null;
          p_location_map_url?: string | null;
          p_priority_window?: string | null;
          p_signup_closes_before?: string;
          p_cancellation_cutoff_before?: string;
          p_roster_publish_before?: string | null;
          p_public_notes?: string | null;
          p_admin_notes?: string | null;
        };
        Returns: string;
      };
      /**
       * `create_match` then `publish_match`, in one transaction. Identical
       * arguments to `create_match` on purpose — the two paths differ only in
       * whether the new match is opened, never in what it contains.
       */
      create_and_publish_match: {
        Args: {
          p_league_id: string;
          p_title: string;
          p_match_date: string;
          p_arrival_time: string;
          p_kickoff_time: string;
          p_end_time: string;
          p_location_name: string;
          p_capacity: number;
          p_min_players: number;
          p_selection_mode: SelectionMode;
          p_waitlist_mode: WaitlistMode;
          p_team_count?: number;
          p_template_id?: string | null;
          p_location_map_url?: string | null;
          p_priority_window?: string | null;
          p_signup_closes_before?: string;
          p_cancellation_cutoff_before?: string;
          p_roster_publish_before?: string | null;
          p_public_notes?: string | null;
          p_admin_notes?: string | null;
        };
        Returns: string;
      };
      publish_match: { Args: { p_match_id: string }; Returns: string };
      cancel_match: { Args: { p_match_id: string; p_reason?: string | null }; Returns: string };

      // ── Phase 4 ──────────────────────────────────────────────────────────
      // Every one of these takes only a match id (plus, for administrator
      // decisions, the target membership). No actor, league, role or
      // eligibility flag is a parameter — all of that is derived from
      // auth.uid() inside the function.
      match_signup_eligibility: {
        Args: { p_match_id: string };
        Returns: SignupEligibility;
      };
      join_match: { Args: { p_match_id: string }; Returns: SignupOutcome };
      request_spot: { Args: { p_match_id: string }; Returns: SignupOutcome };
      mark_unavailable: { Args: { p_match_id: string }; Returns: SignupOutcome };
      my_match_signup: { Args: { p_match_id: string }; Returns: SignupOutcome | null };
      match_confirmed_roster: {
        Args: { p_match_id: string };
        Returns: ConfirmedRosterEntry[];
      };
      match_signup_counts: {
        Args: { p_match_id: string };
        Returns: MatchSignupCounts[];
      };
      match_roster_admin: {
        Args: { p_match_id: string };
        Returns: RosterAdminEntry[];
      };
      match_addable_members: {
        Args: { p_match_id: string };
        Returns: AddableMember[];
      };
      set_signup_decision: {
        Args: {
          p_match_id: string;
          p_membership_id: string;
          p_status: SignupStatus;
          p_reason?: string | null;
        };
        Returns: SignupOutcome;
      };
      reorder_waitlist: {
        Args: { p_match_id: string; p_membership_ids: string[] };
        Returns: number;
      };
      add_member_to_match: {
        Args: {
          p_match_id: string;
          p_membership_id: string;
          p_status: SignupStatus;
          p_override_reason?: string | null;
        };
        Returns: SignupOutcome;
      };
      finalize_roster: { Args: { p_match_id: string }; Returns: number };

      // ── Phase 5 ──────────────────────────────────────────────────────────
      cancel_spot: {
        Args: { p_match_id: string; p_reason?: string | null };
        Returns: SignupOutcome;
      };
      promote_waitlisted_player: {
        Args: {
          p_match_id: string;
          p_membership_id?: string | null;
          p_reason?: string | null;
        };
        Returns: SignupOutcome;
      };
      match_replacement_state: {
        Args: { p_match_id: string };
        Returns: ReplacementState[];
      };
      mark_notification_unread: { Args: { p_notification_id: string }; Returns: string };
      archive_notification: { Args: { p_notification_id: string }; Returns: string };
      unarchive_notification: { Args: { p_notification_id: string }; Returns: string };
      // Worker-only: granted to service_role and refused to any other role by
      // an explicit `auth.role()` check inside the function. Returns the
      // occurrences it claimed, so the caller can push exactly those batches.
      // ── Phase 6 ──────────────────────────────────────────────────────────
      ensure_match_teams: { Args: { p_match_id: string }; Returns: number };
      create_match_team: {
        Args: { p_match_id: string; p_name?: string | null; p_label?: string | null };
        Returns: string;
      };
      rename_match_team: {
        Args: { p_team_id: string; p_name: string; p_label?: string | null };
        Returns: string;
      };
      delete_match_team: { Args: { p_team_id: string }; Returns: number };
      assign_player_to_team: {
        Args: { p_team_id: string; p_membership_id: string };
        Returns: string;
      };
      unassign_player_from_team: {
        Args: { p_match_id: string; p_membership_id: string };
        Returns: boolean;
      };
      randomize_match_teams: { Args: { p_match_id: string }; Returns: number };
      publish_match_teams: { Args: { p_match_id: string }; Returns: number };
      match_published_teams: {
        Args: { p_match_id: string };
        Returns: PublishedTeamEntry[];
      };
      match_team_builder: { Args: { p_match_id: string }; Returns: TeamBuilderPlayer[] };
      match_draft_teams: { Args: { p_match_id: string }; Returns: DraftTeam[] };

      record_attendance: {
        Args: {
          p_match_id: string;
          p_membership_id: string;
          p_outcome: AttendanceOutcome;
          p_note?: string | null;
          p_expected_revision?: number | null;
        };
        Returns: number;
      };
      complete_match: { Args: { p_match_id: string }; Returns: string };
      match_accepts_attendance: { Args: { p_match_id: string }; Returns: boolean };
      match_attendance_workspace: {
        Args: { p_match_id: string };
        Returns: AttendanceWorkspaceEntry[];
      };
      my_attendance: { Args: { p_match_id: string }; Returns: MyAttendance[] };
      my_attendance_history: { Args: { p_league_id: string }; Returns: MyAttendanceEntry[] };
      membership_attendance_summary: {
        Args: { p_league_id: string; p_membership_ids: string[] };
        Returns: MembershipAttendanceSummary[];
      };
      set_membership_status: {
        Args: {
          p_membership_id: string;
          p_status: MembershipStatus;
          p_reason?: string | null;
          p_suspended_until?: string | null;
        };
        Returns: string;
      };

      generate_due_reminders: {
        Args: { p_limit?: number };
        Returns: Array<{ reminder_id: string; notified: number }>;
      };
      update_draft_match: {
        Args: {
          p_match_id: string;
          p_title: string;
          p_match_date: string;
          p_arrival_time: string;
          p_kickoff_time: string;
          p_end_time: string;
          p_location_name: string;
          p_capacity: number;
          p_min_players: number;
          p_selection_mode: SelectionMode;
          p_waitlist_mode: WaitlistMode;
          p_team_count?: number;
          p_location_map_url?: string | null;
          p_priority_window?: string | null;
          p_signup_closes_before?: string;
          p_cancellation_cutoff_before?: string;
          p_roster_publish_before?: string | null;
          p_public_notes?: string | null;
        };
        Returns: string;
      };
      update_published_match: {
        Args: {
          p_match_id: string;
          p_title: string;
          p_match_date: string;
          p_arrival_time: string;
          p_kickoff_time: string;
          p_end_time: string;
          p_location_name: string;
          p_capacity: number;
          p_min_players: number;
          p_team_count: number;
          p_location_map_url?: string | null;
          p_public_notes?: string | null;
          p_change_note?: string | null;
          /** Optimistic concurrency: the revision the form was rendered from. */
          p_expected_revision?: number | null;
        };
        Returns: number;
      };
      mark_notification_read: { Args: { p_notification_id: string }; Returns: string };
      mark_all_notifications_read: { Args: Record<string, never>; Returns: number };
      register_push_subscription: {
        Args: {
          p_endpoint: string;
          p_p256dh: string;
          p_auth: string;
          p_device_label?: string | null;
        };
        Returns: string;
      };
      set_push_subscription_enabled: {
        Args: { p_subscription_id: string; p_enabled: boolean };
        Returns: string;
      };
      remove_push_subscription: { Args: { p_subscription_id: string }; Returns: undefined };
      record_push_delivery_result: {
        Args: {
          p_notification_id: string;
          p_subscription_id: string;
          p_status: PushDeliveryStatus;
          p_error_category?: string | null;
        };
        Returns: undefined;
      };
      record_audit_event: {
        Args: {
          p_league_id: string;
          p_entity_type: string;
          p_entity_id: string | null;
          p_action: string;
          p_before?: Record<string, unknown> | null;
          p_after?: Record<string, unknown> | null;
          p_reason?: string | null;
        };
        Returns: string;
      };
    };
    Enums: {
      league_visibility: LeagueVisibility;
      league_role: LeagueRole;
      membership_status: MembershipStatus;
      selection_mode: SelectionMode;
      waitlist_mode: WaitlistMode;
      join_request_status: JoinRequestStatus;
      match_lifecycle_status: MatchLifecycleStatus;
      notification_type: NotificationType;
      push_delivery_status: PushDeliveryStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}
