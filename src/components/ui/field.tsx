import type { ReactNode } from 'react';
import { AlertIcon } from '@/components/ui/icon';

/**
 * Form controls.
 *
 * ── TWO NUMBERS THAT ARE LOAD-BEARING ──────────────────────────────────────
 *
 * `text-base` (16px) on every input. iOS Safari zooms the whole page when a
 * focused input is smaller than that, and the zoom does not undo itself — so
 * every input in this product is 16px whatever the surrounding type scale says.
 * It also means an input's natural height is 24 + 20 + 2 = 46px, comfortably
 * over the touch-target floor, so `min-h-11` on a field never actually binds.
 *
 * **Buttons are different, and this is where it bit.** At `text-sm` the natural
 * height is 20 + 20 + 2 = 42px, so `min-height` is the only thing holding them
 * at the floor — and a control sitting at exactly 44.000px fails a `< 44` check
 * the moment sub-pixel layout rounds it to 43.996. Buttons therefore use a
 * 46px floor: above the requirement rather than balanced on it. See the note in
 * `@/components/ui/button`.
 *
 * ── WHAT CHANGED IN THE REDESIGN ───────────────────────────────────────────
 *
 * The input was a white box with a hairline, identical to every card behind it,
 * so a form read as a stack of empty rectangles. It now sits on the sunken
 * surface, which makes a field look like somewhere to put something rather than
 * like a card that failed to load, and the focus state fills to raised with a
 * green ring — motion from "recessed" to "active" that costs nothing and reads
 * instantly.
 */

export const inputClassName =
  'w-full min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2.5 text-base text-[var(--text-primary)] placeholder:text-muted transition-[background-color,border-color,box-shadow] duration-150 hover:border-[var(--border-strong)] focus:border-pitch-500 focus:bg-[var(--surface-raised)] focus:outline-none focus:ring-2 focus:ring-pitch-500/25';

/**
 * A narrower variant, for `type="time"` and `type="date"` in a tight grid.
 *
 * Those controls have a browser-drawn picker glyph inside them and cannot
 * shrink below the width of their own value. Three of them across a 390px
 * phone, inside a card that already costs 32px of padding, leaves about 109px
 * each — enough that Chrome clips "06:30" to "06:3(". The screenshot review
 * caught it on the templates form, which is the one that sits inside a card.
 *
 * Trimming the horizontal padding buys back the twelve pixels that were
 * missing. It is not a general rule: everywhere else the roomier padding is
 * what makes a field feel like somewhere to put something.
 */
export const timeInputClassName =
  'w-full min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-2.5 text-base text-[var(--text-primary)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-[var(--border-strong)] focus:border-pitch-500 focus:bg-[var(--surface-raised)] focus:outline-none focus:ring-2 focus:ring-pitch-500/25';

/** The same control, marked as holding something the server rejected. */
export const inputErrorClassName =
  'border-whistle-500 bg-whistle-50/50 focus:border-whistle-500 focus:ring-whistle-500/25 dark:bg-whistle-900/20';

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
      <label
        htmlFor={htmlFor}
        className="flex items-baseline justify-between gap-2 text-sm font-semibold"
      >
        <span>{label}</span>
        {optional ? (
          <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted">
            Optional
          </span>
        ) : null}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="-mt-0.5 text-xs leading-relaxed text-muted">
          {hint}
        </p>
      )}
      {children}
      {error === undefined ? null : (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 text-sm font-medium text-whistle-600 dark:text-whistle-300"
        >
          <AlertIcon size={15} />
          {error}
        </p>
      )}
    </div>
  );
}

/** A form-level failure, above the fields. */
export function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) {
    return null;
  }
  return (
    <p
      role="alert"
      className="animate-rise flex items-start gap-2.5 rounded-[var(--radius-md)] border border-whistle-200 bg-whistle-50 px-3.5 py-3 text-sm font-medium text-whistle-800 dark:border-whistle-900 dark:bg-whistle-900/30 dark:text-whistle-100"
    >
      <AlertIcon size={17} />
      <span className="min-w-0">{message}</span>
    </p>
  );
}

/**
 * A form's submit.
 *
 * Full-width by default: on a phone the submit is the point of the screen, and
 * a 90px button floating at the bottom-left of a form is both harder to hit and
 * quieter than the thing deserves.
 *
 * `aria-busy` rather than only swapping the label, so the state is available to
 * a screen reader without it having to notice that the text changed.
 */
export function SubmitButton({
  children,
  pending,
  variant = 'primary',
  block = true,
  name,
  value,
  className = '',
}: {
  children: ReactNode;
  pending: boolean;
  variant?: 'primary' | 'secondary';
  block?: boolean;
  /**
   * For a form with more than one outcome.
   *
   * A submit button contributes its own `name`/`value` to the submitted data,
   * so "Save as draft" and "Publish match" are one form and one action that can
   * tell which was pressed — rather than two forms duplicating twenty fields.
   */
  name?: string;
  value?: string;
  className?: string;
}) {
  const base =
    'press inline-flex min-h-control select-none items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 py-2.5 text-sm font-semibold disabled:pointer-events-none disabled:opacity-55';
  const styles =
    variant === 'primary'
      ? 'bg-pitch-600 text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400'
      : 'border border-[var(--border-strong)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]';

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      className={`${base} ${styles} ${block ? 'w-full' : ''} ${className}`}
    >
      {pending ? <Spinner /> : null}
      {pending ? 'Working…' : children}
    </button>
  );
}

/**
 * The one spinner.
 *
 * `aria-hidden`, because the control it sits inside already carries
 * `aria-busy` and a changed label; a second announcement is noise. Stops
 * spinning under reduced motion and holds a static ring, which still reads as a
 * pending control.
 */
export function Spinner({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin motion-reduce:animate-none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A group of fields with a name.
 *
 * The long forms in this product — creating a match, creating a league — were
 * fifteen inputs in one undifferentiated column. Grouping them into three or
 * four named steps is the difference between a form somebody fills in and a
 * form somebody abandons.
 *
 * `step` adds a numbered chip. Everything stays on one page — this is a
 * sequence, not a wizard, so nothing is ever hidden behind a Continue button
 * that has to be clicked twice to correct a typo. The number is decoration for
 * sighted users and real text for everybody else, hence the `sr-only` prefix
 * inside the title rather than an `aria-label` on the chip.
 */
export function FieldGroup({
  legend,
  description,
  step,
  children,
}: {
  legend: string;
  description?: string;
  step?: number;
  children: ReactNode;
}) {
  return (
    <fieldset className="surface-card flex flex-col gap-4 p-4">
      <legend className="float-left flex w-full items-start gap-3 pb-1">
        {step === undefined ? null : <StepChip step={step} />}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.9375rem] font-semibold">
            {step === undefined ? null : <span className="sr-only">{`Step ${step}: `}</span>}
            {legend}
          </span>
          {description === undefined ? null : (
            <span className="text-sm font-normal text-muted">{description}</span>
          )}
        </span>
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * The numbered marker on a step. Exported so a step that is not a `fieldset` —
 * a review panel, say — can carry the same marker as the ones that are.
 */
export function StepChip({ step }: { step: number }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-pitch-600 text-xs font-bold text-white dark:bg-pitch-500 dark:text-pitch-950"
    >
      {step}
    </span>
  );
}
