'use client';

import { useActionState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import { createInviteAction, revokeInviteAction } from '@/server/actions/invites';
import {
  addMemberByEmailAction,
  decideJoinRequestAction,
  transferAdministrationAction,
  updateMembershipStatusAction,
} from '@/server/actions/membership';
import type { LeagueInviteRow } from '@/types/database';
import type {
  InviteState,
  JoinRequestSummary,
  LeagueMemberSummary,
} from '@/lib/leagues/league-admin';

function displayName(
  profile: { first_name: string; last_name: string } | null,
  fallback: string,
): string {
  return profile === null ? fallback : `${profile.first_name} ${profile.last_name}`;
}

/** Approve / reject a pending request. Both calls are idempotent server-side. */
export function JoinRequestRow({ entry }: { entry: JoinRequestSummary }) {
  const [state, submit, pending] = useActionState(decideJoinRequestAction, null);

  return (
    <li className="surface-card flex flex-col gap-2 p-3">
      <div>
        <p className="text-sm font-semibold">
          {displayName(entry.profile, 'A Matchday member')}
        </p>
        <p className="text-xs text-muted">{entry.profile?.email_normalized ?? ''}</p>
      </div>

      {entry.request.message === null ? null : (
        <p className="text-sm italic">“{entry.request.message}”</p>
      )}

      <div className="flex gap-2">
        <form action={submit}>
          <input type="hidden" name="request_id" value={entry.request.id} />
          <input type="hidden" name="decision" value="approve" />
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-lg bg-pitch-600 px-3 py-2 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
          >
            Approve
          </button>
        </form>
        <form action={submit}>
          <input type="hidden" name="request_id" value={entry.request.id} />
          <input type="hidden" name="decision" value="reject" />
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold disabled:opacity-60"
          >
            Reject
          </button>
        </form>
      </div>

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </li>
  );
}

export function MemberRow({
  entry,
  leagueId,
  isSelf,
}: {
  entry: LeagueMemberSummary;
  leagueId: string;
  isSelf: boolean;
}) {
  const [state, submit, pending] = useActionState(updateMembershipStatusAction, null);
  const { membership } = entry;

  return (
    <li className="surface-card flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* A deleted or not-yet-created profile has no name to take initials
              from, so there is nothing to render but the text fallback. */}
          {entry.profile === null ? null : (
            <PlayerAvatar player={entry.profile} size={36} />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {displayName(entry.profile, 'A Matchday member')}
              {isSelf ? ' (you)' : ''}
            </p>
            <p className="truncate text-xs text-muted">
              {entry.profile?.email_normalized ?? ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {membership.role === 'league_admin' ? (
            <span className="rounded-full border border-pitch-500/50 px-2 py-0.5 text-xs font-medium">
              Administrator
            </span>
          ) : null}
          <span className="text-xs capitalize text-muted">{membership.status}</span>
        </div>
      </div>

      {/* The reason the administrator last gave. Shown back to them because a
          suspension they set three weeks ago is exactly the thing they will
          need when deciding whether to lift it — and because it is the only
          place it is readable. It never reaches the member. */}
      {membership.status_reason === null ? null : (
        <p className="text-xs text-muted">
          Reason: {membership.status_reason}
          {membership.status === 'suspended' && membership.suspended_until !== null
            ? ` · until ${new Date(membership.suspended_until).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}`
            : ''}
        </p>
      )}

      {/* The administrator's own membership cannot be changed here: removing it
          would leave the league with no administrator, which the database
          refuses outright with ADMIN_TRANSFER_INVALID. Transfer administration
          first. */}
      {isSelf ? null : (
        <form action={submit} className="flex flex-col gap-2">
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="membership_id" value={membership.id} />

          <div className="flex items-center gap-2">
            <label htmlFor={`status-${membership.id}`} className="sr-only">
              Membership status
            </label>
            <select
              id={`status-${membership.id}`}
              name="status"
              defaultValue={membership.status === 'pending' ? 'active' : membership.status}
              className="min-h-11 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm"
            >
              {/* No `pending` option. It is a state a join request or an
                  invitation puts somebody in, not a decision an administrator
                  makes about an existing member, and the database refuses it. */}
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="removed">Removed</option>
            </select>
            <button
              type="submit"
              disabled={pending}
              className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
            >
              Update
            </button>
          </div>

          <label htmlFor={`reason-${membership.id}`} className="sr-only">
            Reason for the change
          </label>
          <input
            id={`reason-${membership.id}`}
            name="reason"
            type="text"
            maxLength={500}
            placeholder="Reason (required to suspend or remove)"
            className="min-h-11 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm"
            aria-describedby={`reason-hint-${membership.id}`}
            aria-invalid={state?.ok === false && state.fieldErrors['reason'] !== undefined}
          />
          {/* The field-level message. Without it a missing reason surfaced as
              the generic "check the highlighted fields", with nothing
              highlighted and nothing said about which field. */}
          {state?.ok === false && state.fieldErrors['reason'] !== undefined ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.fieldErrors['reason']}
            </p>
          ) : null}
          <p id={`reason-hint-${membership.id}`} className="text-xs text-muted">
            Only administrators can see this. Suspending or removing somebody also releases the
            spots they hold in matches that have not been played yet.
          </p>

          <label htmlFor={`until-${membership.id}`} className="text-xs text-muted">
            Suspend until (optional)
          </label>
          <input
            id={`until-${membership.id}`}
            name="suspended_until"
            type="date"
            defaultValue={
              membership.suspended_until === null
                ? ''
                : (membership.suspended_until.slice(0, 10) ?? '')
            }
            className="min-h-11 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm"
            aria-describedby={`until-hint-${membership.id}`}
          />
          <p id={`until-hint-${membership.id}`} className="text-xs text-muted">
            A note of when you intend to lift it. Nothing happens automatically on that date —
            reactivating somebody is always your decision.
          </p>
        </form>
      )}

      {/* The whole-form message, and only when no field carries its own.
          Rendering both put two `role="alert"` regions in one list item, so a
          screen reader announced "Give a reason" and then "check the
          highlighted fields" — the second saying less than the first and
          contradicting its specificity. */}
      {state?.ok === false && Object.keys(state.fieldErrors).length === 0 ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </li>
  );
}

export function AddMemberForm({ leagueId }: { leagueId: string }) {
  const [state, submit, pending] = useActionState(addMemberByEmailAction, null);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="league_id" value={leagueId} />
      <FormError message={state?.ok === false ? state.fieldErrors['form'] : undefined} />
      {state?.ok === true ? (
        <p role="status" className="text-sm font-medium text-pitch-600">
          Member added.
        </p>
      ) : null}

      <Field
        label="Email address"
        htmlFor="member-email"
        hint="The person needs an existing Matchday account."
        error={state?.ok === false ? state.fieldErrors['email'] : undefined}
      >
        <input
          id="member-email"
          name="email"
          type="email"
          required
          className={inputClassName}
          placeholder="player@example.com"
        />
      </Field>

      <Field label="Join as" htmlFor="member-status">
        <select id="member-status" name="status" defaultValue="active" className={inputClassName}>
          <option value="active">Active member</option>
          <option value="pending">Pending approval</option>
        </select>
      </Field>

      <SubmitButton pending={pending} variant="secondary">
        Add member
      </SubmitButton>
    </form>
  );
}

export function CreateInviteForm({ leagueId }: { leagueId: string }) {
  const [state, submit, pending] = useActionState(createInviteAction, null);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="league_id" value={leagueId} />
      <FormError message={state?.ok === false ? state.message : undefined} />

      {state?.ok === true ? (
        <div className="rounded-lg border border-pitch-500/40 bg-pitch-50 p-3 dark:bg-pitch-900/40">
          <p className="text-sm font-semibold">Copy this link now.</p>
          <p className="mt-1 text-xs text-muted">
            It is shown once and cannot be retrieved again. Expires in {state.data.expiresInDays}{' '}
            days.
          </p>
          <input
            readOnly
            value={state.data.url}
            onFocus={(event) => event.currentTarget.select()}
            className={`${inputClassName} mt-2 font-mono text-xs`}
            aria-label="Invitation link"
          />
        </div>
      ) : null}

      <Field label="Label" htmlFor="invite-label" optional hint="Only you see this.">
        <input
          id="invite-label"
          name="label"
          maxLength={120}
          className={inputClassName}
          placeholder="Spring signups"
        />
      </Field>

      <Field label="People who use this link join as" htmlFor="invite-grants">
        <select
          id="invite-grants"
          name="grants_status"
          defaultValue="active"
          className={inputClassName}
        >
          <option value="active">Active members straight away</option>
          <option value="pending">Pending your approval</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Maximum uses"
          htmlFor="invite-max-uses"
          optional
          hint="Blank for unlimited."
          error={state?.ok === false ? state.fieldErrors['max_uses'] : undefined}
        >
          <input
            id="invite-max-uses"
            name="max_uses"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Expires in (days)"
          htmlFor="invite-expiry"
          error={state?.ok === false ? state.fieldErrors['expires_in_days'] : undefined}
        >
          <input
            id="invite-expiry"
            name="expires_in_days"
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            defaultValue={14}
            required
            className={inputClassName}
          />
        </Field>
      </div>

      <SubmitButton pending={pending} variant="secondary">
        Create invitation link
      </SubmitButton>
    </form>
  );
}

export function InviteRow({
  invite,
  inviteState,
  expiresLabel,
  leagueId,
}: {
  invite: LeagueInviteRow;
  /** Computed on the server — the clock must not be read during render. */
  inviteState: InviteState;
  expiresLabel: string;
  leagueId: string;
}) {
  const [state, submit, pending] = useActionState(revokeInviteAction, null);
  const live = inviteState === 'live';

  return (
    <li className="surface-card flex items-start justify-between gap-3 p-3">
      <div>
        <p className="text-sm font-semibold">{invite.label ?? 'Invitation link'}</p>
        <p className="text-xs text-muted">
          {invite.use_count} used
          {invite.max_uses === null ? '' : ` of ${invite.max_uses}`} ·{' '}
          {inviteState === 'revoked'
            ? 'revoked'
            : inviteState === 'expired'
              ? 'expired'
              : inviteState === 'exhausted'
                ? 'fully used'
                : `expires ${expiresLabel}`}
        </p>
        <p className="mt-1 text-xs text-muted">
          Joins as {invite.grants_status === 'active' ? 'active member' : 'pending approval'}
        </p>
      </div>

      {live ? (
        <form action={submit}>
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="invite_id" value={invite.id} />
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? 'Revoking…' : 'Revoke'}
          </button>
          {state?.ok === false ? (
            <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {state.message}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

export function TransferAdministrationForm({
  leagueId,
  candidates,
}: {
  leagueId: string;
  candidates: LeagueMemberSummary[];
}) {
  const [state, submit, pending] = useActionState(transferAdministrationAction, null);

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted">
        Administration can only be handed to an active player. Add or activate a member first.
      </p>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="league_id" value={leagueId} />
      <FormError message={state?.ok === false ? state.message : undefined} />

      <Field label="New administrator" htmlFor="transfer-target">
        <select id="transfer-target" name="membership_id" required className={inputClassName}>
          {candidates.map((candidate) => (
            <option key={candidate.membership.id} value={candidate.membership.id}>
              {displayName(candidate.profile, 'A Matchday member')}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Type “transfer” to confirm"
        htmlFor="transfer-confirm"
        hint="You will become an ordinary player in this league immediately."
        error={state?.ok === false ? state.fieldErrors['confirm'] : undefined}
      >
        <input id="transfer-confirm" name="confirm" required className={inputClassName} />
      </Field>

      <SubmitButton pending={pending} variant="secondary">
        Transfer administration
      </SubmitButton>
    </form>
  );
}
