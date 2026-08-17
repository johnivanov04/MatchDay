import type { SVGProps } from 'react';

/**
 * The icon set.
 *
 * ── WHY THESE ARE HAND-WRITTEN AND NOT A PACKAGE ───────────────────────────
 *
 * Twenty icons is about 4 KB of inline paths. The smallest tree-shakeable icon
 * library that covers them is an order of magnitude more, arrives with its own
 * release cadence, and would be the first third-party UI dependency in a
 * product that has so far needed none. This is the cheaper answer in every
 * direction that matters, and it means the whole set is drawn on one grid with
 * one stroke weight.
 *
 * ── THE GRID ───────────────────────────────────────────────────────────────
 *
 * 24×24, 1.75 stroke, round caps and joins, no fills. `currentColor`
 * throughout, so an icon inherits from whatever it sits inside and there is
 * never a colour to keep in sync with the text beside it.
 *
 * ── ACCESSIBILITY ──────────────────────────────────────────────────────────
 *
 * Every icon is `aria-hidden` and decorative **by default**, because in this
 * product every one of them sits next to a visible label. An icon that needs to
 * carry meaning takes a `title`, which turns it into `role="img"` with an
 * accessible name. That default is the right way round: a decorative icon
 * announced by a screen reader is noise on every row of a roster, and axe
 * cannot tell the two cases apart.
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Edge length in pixels. Matches the surrounding text size, usually 16–20. */
  size?: number;
  /** Supply only when the icon is the sole carrier of meaning. */
  title?: string;
}

function Svg({ size = 20, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  const labelled = title !== undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Never a flex item that shrinks: an icon squashed to 14px next to a long
      // name is worse than no icon.
      className={`shrink-0 ${rest.className ?? ''}`}
      {...(labelled ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

export const HomeIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.5 10.4 12 3.8l8.5 6.6v8.3a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z" />
    <path d="M9.4 20.3v-6.2h5.2v6.2" />
  </Svg>
);

export const BellIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Svg>
);

export const UserIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19 20.5v-1.7a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v1.7" />
    <circle cx="12" cy="7.5" r="3.6" />
  </Svg>
);

export const UsersIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M16.5 20.5v-1.7a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4v1.7" />
    <circle cx="10" cy="7.5" r="3.4" />
    <path d="M21 20.5v-1.7a4 4 0 0 0-3-3.9" />
    <path d="M16.5 4.3a4 4 0 0 1 0 7.4" />
  </Svg>
);

/* ── The soccer ball. The one place the theme is literal. ────────────────── */

export const BallIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m12 7.4 4.1 3-1.6 4.9H9.5L7.9 10.4z" />
    <path d="M12 3v4.4M20.6 9.9l-4.5.5M18.1 19.6l-3.6-4.3M5.9 19.6l3.6-4.3M3.4 9.9l4.5.5" />
  </Svg>
);

/* ── Objects ────────────────────────────────────────────────────────────── */

export const CalendarIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.2" y="5" width="17.6" height="16" rx="2.4" />
    <path d="M3.2 10h17.6M8.4 3v4M15.6 3v4" />
  </Svg>
);

export const ClockIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 7.2V12l3.2 1.9" />
  </Svg>
);

export const PinIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19 10.4c0 5.2-7 11-7 11s-7-5.8-7-11a7 7 0 1 1 14 0" />
    <circle cx="12" cy="10.2" r="2.6" />
  </Svg>
);

export const ShieldIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 21.4s7.4-3.4 7.4-9.1V5.9L12 2.9 4.6 5.9v6.4c0 5.7 7.4 9.1 7.4 9.1" />
  </Svg>
);

export const ClipboardIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 4.6H7.4A2.2 2.2 0 0 0 5.2 6.8v12.4a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V6.8a2.2 2.2 0 0 0-2.2-2.2H15" />
    <rect x="9" y="2.6" width="6" height="4" rx="1.4" />
  </Svg>
);

export const SettingsIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.6 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1.1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.7-1.1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.6h-.3a1.8 1.8 0 1 1 0-3.6h.2A1.5 1.5 0 0 0 5.7 8l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3H10a1.5 1.5 0 0 0 .9-1.4v-.3a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.6 1.1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7V10a1.5 1.5 0 0 0 1.4.9h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9" />
  </Svg>
);

export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="7.2" />
    <path d="m20.4 20.4-4.3-4.3" />
  </Svg>
);

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Svg>
);

export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4.8 12.6 4.6 4.6L19.2 7.4" />
  </Svg>
);

export const XIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9.4 5.6 6.4 6.4-6.4 6.4" />
  </Svg>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5.6 9.4 6.4 6.4 6.4-6.4" />
  </Svg>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19 12H5M11.4 5.4 4.8 12l6.6 6.6" />
  </Svg>
);

export const AlertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
    <path d="M12 9.4v4.2M12 17.6h.01" />
  </Svg>
);

export const InfoIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 15.8v-4.4M12 8.4h.01" />
  </Svg>
);

export const LogOutIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.4 20.4H5.8a1.9 1.9 0 0 1-1.9-1.9V5.5a1.9 1.9 0 0 1 1.9-1.9h3.6" />
    <path d="m15.6 16.4 4.4-4.4-4.4-4.4M20 12H9.4" />
  </Svg>
);

export const SparkIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.2 13.9 9l5.8 1.9-5.8 1.9L12 18.6 10.1 12.8 4.3 10.9 10.1 9z" />
  </Svg>
);

export const ImageIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2.6" />
    <circle cx="8.8" cy="8.8" r="1.9" />
    <path d="m20.8 15.4-4.4-4.4L5.6 21.8" />
  </Svg>
);

export const WhistleIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20.4 9.8h-8.2l-1.9-2.2H3.6a1.4 1.4 0 0 0-1.4 1.4v1.6" />
    <circle cx="8.2" cy="14.6" r="4.6" />
    <path d="M20.4 9.8v3.6a1.4 1.4 0 0 1-1.4 1.4h-6.2" />
  </Svg>
);
