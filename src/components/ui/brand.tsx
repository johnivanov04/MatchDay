/**
 * The Matchday mark.
 *
 * A ball, reduced until it is a circle with one pentagon and three seams — at
 * 28px anything more becomes mud. The disc is the brand green and the seams are
 * knocked out of it, so the mark holds up on both themes without a second
 * artwork, and reads as a ball at a glance without ever announcing itself as a
 * clip-art football.
 *
 * `aria-hidden` and paired with a visible "Matchday" wordmark in the header, so
 * the link's accessible name comes from real text rather than from alt copy
 * that would have to be maintained separately.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="16" cy="16" r="15" className="fill-pitch-600 dark:fill-pitch-500" />
      <g
        className="stroke-white dark:stroke-pitch-950"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      >
        <path d="m16 9.2 5.1 3.7-1.9 6h-6.4l-2-6z" />
        <path d="M16 4.4v4.8M27 12.4l-5.9.5M22.6 26.1l-3.4-6.2M9.4 26.1l3.4-6.2M5 12.4l5.9.5" />
      </g>
    </svg>
  );
}

/** The mark plus the wordmark, as used in the app bar and on the sign-in screen. */
export function BrandLockup({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark size={size} />
      <span className="text-[1.0625rem] font-bold tracking-[-0.02em]">MatchDay</span>
    </span>
  );
}
