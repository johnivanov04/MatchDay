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
  profile_photo_url: string | null;
  created_at: string;
  updated_at: string;
};

/** Columns a user may write on their own profile. Email and id are server-owned. */
export type ProfileWritableFields = {
  first_name: string;
  last_name: string;
  phone: string | null;
  gender: string | null;
  preferred_positions: string[];
  goalkeeper_willing: boolean | null;
  profile_photo_url: string | null;
};

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
  | 'guideline_acceptance_required';

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
      publish_match: { Args: { p_match_id: string }; Returns: string };
      cancel_match: { Args: { p_match_id: string; p_reason?: string | null }; Returns: string };
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
