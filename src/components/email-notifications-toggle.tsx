'use client';

import { useActionState } from 'react';
import { setEmailNotificationsEnabledAction } from '@/server/actions/notification-preferences';

/**
 * One switch: email notifications, on or off.
 *
 * Phase 3E owns the per-type matrix. This is the channel master switch and
 * deliberately nothing more — shipping the grid now would mean designing it
 * around a preference model that does not exist yet.
 *
 * Rendered as a form-submitting button rather than a checkbox that saves on
 * change, because a control that silently persists on blur is one people are
 * never sure they actually changed. The label says what it will do next.
 */
export function EmailNotificationsToggle({ enabled }: { enabled: boolean }) {
  const [state, submit, pending] = useActionState(setEmailNotificationsEnabledAction, null);

  // The action's own answer wins once it arrives, so the control reflects what
  // was saved rather than what was clicked.
  const current = state?.ok === true ? state.data : enabled;
  const next = !current;

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="email_enabled" value={String(next)} />

      <div className="flex items-center justify-between gap-4">
        <span id="email-notifications-label" className="text-sm font-medium">
          Email notifications
        </span>
        <span
          role="status"
          aria-live="polite"
          className="text-sm text-muted"
          data-testid="email-notifications-state"
        >
          {current ? 'On' : 'Off'}
        </span>
      </div>

      <button
        type="submit"
        disabled={pending}
        aria-describedby="email-notifications-label"
        className="self-start rounded-md border border-line px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? 'Saving…' : current ? 'Turn off' : 'Turn on'}
      </button>

      {state?.ok === false && (
        <p role="alert" className="text-sm text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      )}
    </form>
  );
}
