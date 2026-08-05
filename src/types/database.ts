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
    };
    CompositeTypes: Record<string, never>;
  };
}
