import type { ReactNode } from 'react';

/**
 * `min-h-11` is 44px, the touch-target floor.
 *
 * Padding and line height alone came to 42, which nobody notices reading a form
 * on a laptop and everybody feels tapping a select on a touchline. `text-base`
 * (16px) is also load-bearing: iOS Safari zooms the whole page when a focused
 * input is smaller than that, and the zoom does not undo itself.
 */
export const inputClassName =
  'w-full min-h-11 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5 text-base text-[var(--text-primary)] placeholder:text-muted';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  optional?: boolean;
  children: ReactNode;
}) {
  const hintId = hint === undefined ? undefined : `${htmlFor}-hint`;
  const errorId = error === undefined ? undefined : `${htmlFor}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {optional ? <span className="ml-1.5 text-xs font-normal text-muted">Optional</span> : null}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {children}
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) {
    return null;
  }
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
    >
      {message}
    </p>
  );
}

export function SubmitButton({
  children,
  pending,
  variant = 'primary',
}: {
  children: ReactNode;
  pending: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const base =
    'inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60';
  const styles =
    variant === 'primary'
      ? 'bg-pitch-600 text-white hover:bg-pitch-700'
      : 'border border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-pitch-50 dark:hover:bg-pitch-900';

  return (
    <button type="submit" disabled={pending} className={`${base} ${styles}`}>
      {pending ? 'Working…' : children}
    </button>
  );
}
