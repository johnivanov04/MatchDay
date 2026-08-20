import type { ReactNode } from 'react';

/**
 * Typography for the public legal and support pages.
 *
 * ── WHY COMPONENTS RATHER THAN A `prose` CLASS ─────────────────────────────
 *
 * MatchDay has no typography plugin, and adding one for three documents would
 * be a dependency and a design system nobody else uses. More usefully, spelling
 * the structure out keeps the heading levels honest: every section is an `h2`
 * under the page's single `h1`, which is what the accessibility pass checks and
 * what a screen-reader user navigates by.
 */

export function LegalTitle({
  children,
  updated,
}: {
  children: ReactNode;
  /** Shown as a dateline. Legal copy that does not say when it changed is worse than none. */
  updated: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-2">
      <h1 className="text-[1.75rem] font-bold leading-tight sm:text-[2rem]">{children}</h1>
      <p className="text-sm text-muted">Last updated {updated}</p>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 flex flex-col gap-3">
      <h2 className="text-[1.0625rem] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A paragraph of body copy. Generous line height: these are read, not scanned. */
export function P({ children }: { children: ReactNode }) {
  return <p className="text-[0.9375rem] leading-relaxed text-secondary">{children}</p>;
}

export function List({ children }: { children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[0.9375rem] leading-relaxed text-secondary">
      {children}
    </ul>
  );
}

export function Item({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

/**
 * A short definition list, for "we collect X, because Y".
 *
 * A real `<dl>` rather than a two-column grid of `<div>`s: the pairing is the
 * meaning, and it is the one thing a screen reader can convey about this
 * content that a visual layout cannot.
 */
export function Definitions({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col gap-3">{children}</dl>;
}

export function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.9375rem] font-semibold">{term}</dt>
      <dd className="text-[0.9375rem] leading-relaxed text-secondary">{children}</dd>
    </div>
  );
}
