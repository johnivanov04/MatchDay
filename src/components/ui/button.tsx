import type { ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';

/**
 * Every button and every button-shaped link in the product.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Before it, `min-h-11 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3
 * py-2 text-sm` appeared about twenty-five times, hand-typed, with four
 * different paddings and three different disabled treatments. Worse, the most
 * consequential actions in the product — "Publish teams", "Remove photo",
 * "Approve" — were rendered as underlined text links, so nothing on a screen
 * looked more important than anything else.
 *
 * ── THE VARIANTS MEAN SOMETHING ────────────────────────────────────────────
 *
 *   * `primary`   — the one thing this screen is for. At most one per view.
 *   * `secondary` — a real alternative to the primary action.
 *   * `ghost`     — a tertiary action that should not compete: filters, cancel.
 *   * `danger`    — destroys or removes something a person cannot get back.
 *   * `quiet`     — an inline text action inside a dense row, where a bordered
 *                   control would turn a roster into a wall of boxes.
 *
 * ── THE TOUCH-TARGET FLOOR IS NOT NEGOTIABLE ───────────────────────────────
 *
 * Every size below clears WCAG 2.1 SC 2.5.5 with headroom — see `min-h-control`
 * in `globals.css` for why the floor is 46px and not the 44 the guideline asks
 * for. The end-to-end mobile pass measures every `button` on seven screens at
 * 320px and fails the build under 44, so `sm` here is *visually* small —
 * tighter padding, smaller text — while keeping the target a fingertip wide.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type Size = 'sm' | 'md' | 'lg';

const BASE =
  'press inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold disabled:pointer-events-none disabled:opacity-55';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-pitch-600 text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400',
  secondary:
    'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
  danger:
    'border border-whistle-200 bg-whistle-50 text-whistle-700 hover:bg-whistle-100 dark:border-whistle-900 dark:bg-whistle-900/30 dark:text-whistle-200 dark:hover:bg-whistle-900/50',
  quiet:
    'text-pitch-700 underline decoration-pitch-500/40 underline-offset-4 hover:decoration-pitch-500 dark:text-pitch-300',
};

/**
 * ── 46px, NOT 44 ───────────────────────────────────────────────────────────
 *
 * WCAG 2.5.5 asks for 44, and this product's mobile pass measures every
 * control against exactly that. Sitting *on* the floor turned out to be a trap:
 * a `min-h-11` button whose natural height is under 44 has `min-height` as its
 * only binding constraint, so it computes to exactly 44.000px — and any
 * sub-pixel layout variation makes `getBoundingClientRect().height` return
 * 43.996 and the check fail. It caught "Cancel my spot" on two of three full
 * runs while passing in isolation, which is exactly what a knife-edge looks
 * like.
 *
 * Two extra pixels is imperceptible and puts the whole system above its own
 * floor rather than balanced on it. The visual size of a control is set by its
 * padding and type scale, not by this number.
 */
const SIZES: Record<Size, string> = {
  // Reads as a small control; the padding is what shrinks, not the target.
  sm: 'min-h-control px-3 py-2 text-sm',
  md: 'min-h-control px-4 py-2.5 text-sm',
  lg: 'min-h-[3.125rem] px-5 py-3 text-base',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  /** Stretches to the container. The right default for a form's submit on a phone. */
  block?: boolean;
  /** Leading icon. Decorative — the label carries the meaning. */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  icon,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * Deliberately a separate component rather than an `as` prop: an anchor and a
 * button differ in keyboard behaviour, in what a screen reader announces, and
 * in whether the browser will open them in a new tab. Blurring that at the call
 * site is how a "button" ends up being something you cannot middle-click, or a
 * navigation ends up being something a screen reader calls a button.
 */
export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  block = false,
  icon,
  className = '',
  label,
  children,
}: {
  href: Route | string;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
  className?: string;
  /** Overrides the accessible name when the visible text is not enough. */
  label?: string;
  children: ReactNode;
}) {
  // An explicit prop list rather than spreading `ComponentPropsWithoutRef<'a'>`:
  // under `exactOptionalPropertyTypes` an optional handler spread into `Link`
  // is `Handler | undefined` where `Link` wants `Handler`, and widening every
  // anchor prop to satisfy that would be a lot of surface for props no call
  // site uses.
  return (
    <Link
      href={href as Route}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {icon}
      {children}
    </Link>
  );
}

/**
 * A square icon-only control.
 *
 * `label` is required and becomes the accessible name, because an icon alone
 * has none — this is the one place in the product where forgetting a prop would
 * produce a control a screen reader announces as "button".
 *
 * Square, and sized by `min-h-control` on both axes rather than a fixed `h-11`.
 * The fixed version was the worst case of the 44px trap: `height: 44px` cannot
 * even grow past the floor the way `min-height` can, so it was pinned exactly on
 * the requirement in both dimensions.
 */
export function IconButton({
  label,
  variant = 'ghost',
  className = '',
  type = 'button',
  children,
  ...rest
}: {
  label: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      type={type}
      aria-label={label}
      className={`${BASE} ${VARIANTS[variant]} min-h-control min-w-[2.875rem] rounded-[var(--radius-md)] ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Two or three small actions that belong to one row.
 *
 * ── WHY A TRAY AND NOT THREE BUTTONS ───────────────────────────────────────
 *
 * The administrator screens repeat a control cluster once per player: Confirm /
 * Waitlist / Not selected on the roster, Rename / Delete on a team. Giving each
 * one its own border meant a twelve-player roster drew about thirty boxes, and
 * the names — the thing being read — were the quietest marks on the screen.
 *
 * One border around the set says "these belong together and to this row", costs
 * a third of the ink, and lets the buttons inside be plain text at full contrast.
 * The children keep their own touch targets; this only draws the frame.
 *
 * No `align-self` of its own: a tray in a stacked row wants to hug the right
 * edge and a tray in a card header wants the top, and two `self-*` utilities of
 * equal specificity fighting inside one `class` attribute is decided by
 * stylesheet order rather than by the call site. So the call site says.
 */
export function ActionTray({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex shrink-0 items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface)] p-0.5 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A button sized and styled to live inside an `ActionTray`.
 *
 * Borderless — the tray owns the border — and small in *padding* only: the
 * target stays at `min-h-control` like everything else. `tone="affirm"` gives
 * the one positive action in a cluster the only colour in it.
 */
export function TrayButton({
  tone = 'neutral',
  className = '',
  type = 'button',
  children,
  ...rest
}: {
  tone?: 'neutral' | 'affirm';
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      type={type}
      className={`press inline-flex min-h-control items-center whitespace-nowrap rounded-[calc(var(--radius-md)-2px)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-55 ${
        tone === 'affirm'
          ? 'text-pitch-700 dark:text-pitch-300'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
