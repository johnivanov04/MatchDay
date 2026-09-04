import type { NotificationType } from '@/types/database';

/**
 * What each notification type is called when a person reads it.
 *
 * ── ONE REGISTRY, AND IT IS NOT THE AUTHORITY ──────────────────────────────
 *
 * This is display metadata: a label somebody sees in Settings. It does NOT
 * decide whether a notification may leave the building — `PUSH_ELIGIBLE_TYPES`
 * in `src/lib/push/payload.ts` does, and the delivery worker consults that, not
 * this. Keeping them separate means a mistake here shows somebody the wrong
 * label; a mistake there would put attendance on a lock screen.
 *
 * `configurable` therefore mirrors external eligibility rather than declaring
 * it, and a test holds the two lists to each other so they cannot drift.
 *
 * ── EXHAUSTIVE BY CONSTRUCTION ─────────────────────────────────────────────
 *
 * `Record<NotificationType, …>` means adding a twenty-sixth notification type
 * fails to compile until somebody decides, in writing, whether members may
 * switch it off. That decision is easy to forget and expensive to discover
 * later, so the compiler asks for it.
 */

export interface NotificationTypeMeta {
  /** Shown in Settings. Never the raw enum name. */
  label: string;
  /** Only where the label alone would leave somebody guessing. */
  description?: string;
  /**
   * Whether this type appears in the per-type preference matrix.
   *
   * False means the notification is in-app only, so there is no external
   * delivery to configure. Offering a switch that governs nothing would be
   * worse than offering none.
   */
  configurable: boolean;
}

export const NOTIFICATION_TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  // ── Externally deliverable: these appear in Settings ─────────────────────
  match_published: {
    label: 'New match published',
    configurable: true,
  },
  match_changed: {
    label: 'Match details changed',
    description: 'Time, place or size of a match you can play in.',
    configurable: true,
  },
  match_canceled: {
    label: 'Match cancelled',
    configurable: true,
  },
  signup_confirmed: {
    label: "You're in",
    description: 'Confirmation that you have a place.',
    configurable: true,
  },
  waitlisted: {
    label: 'You are on the waitlist',
    configurable: true,
  },
  waitlist_promotion: {
    label: 'A place opened up for you',
    description: 'Often the evening before a match — worth leaving on.',
    configurable: true,
  },
  not_selected: {
    label: 'Not selected this time',
    configurable: true,
  },
  roster_published: {
    label: 'Line-up published',
    configurable: true,
  },
  roster_changed: {
    label: 'Line-up changed',
    configurable: true,
  },
  teams_published: {
    label: 'Teams published',
    configurable: true,
  },
  teams_changed: {
    label: 'Teams changed',
    configurable: true,
  },
  reminder: {
    label: 'Match reminder',
    configurable: true,
  },
  late_cancellation: {
    label: 'Someone cancelled late',
    description: 'Administrators only.',
    configurable: true,
  },
  replacement_needed: {
    label: 'A replacement is needed',
    description: 'Administrators only.',
    configurable: true,
  },
  join_request_approved: {
    label: 'You were approved to join a league',
    configurable: true,
  },
  join_request_rejected: {
    label: 'A join request was declined',
    configurable: true,
  },
  guideline_acceptance_required: {
    label: 'New guidelines need your agreement',
    configurable: true,
  },

  // ── In-app only: deliberately absent from Settings ───────────────────────
  //
  // Each is either administrator housekeeping, a confirmation of something the
  // person just did, or — in one case — something that must never reach a lock
  // screen at all. None has external delivery to configure.
  join_request_submitted: { label: 'Someone asked to join', configurable: false },
  league_invitation_accepted: { label: 'An invitation was accepted', configurable: false },
  guideline_version_published: { label: 'Guidelines updated', configurable: false },
  signup_pending: { label: 'Your request is pending', configurable: false },
  cancellation_receipt: { label: 'You cancelled your place', configurable: false },
  member_left: { label: 'A member left the league', configurable: false },
  league_closed: { label: 'A league was closed', configurable: false },
  // NOT CONFIGURABLE, AND NOT MERELY UNINTERESTING. Its body can say "You are
  // recorded as not having attended". 7Q settles that the canonical in-app
  // record is required and an automatic push is not; there is no external
  // delivery here to switch on or off.
  attendance_recorded: { label: 'Attendance recorded', configurable: false },
};

/** The types a member may configure, in the order Settings shows them. */
export const CONFIGURABLE_NOTIFICATION_TYPES: readonly NotificationType[] = (
  Object.keys(NOTIFICATION_TYPE_META) as NotificationType[]
).filter((type) => NOTIFICATION_TYPE_META[type].configurable);
