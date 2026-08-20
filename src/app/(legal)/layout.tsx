import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLockup } from '@/components/ui/brand';

/**
 * The public legal and support pages: privacy, terms, support.
 *
 * ── OUTSIDE `(app)`, AND THAT IS THE REQUIREMENT ───────────────────────────
 *
 * Apple asks for a privacy policy and a support page reachable from the App
 * Store listing — by a reviewer who has never signed in, and by anybody who has
 * just deleted their account and no longer can. So these live in their own
 * route group with no session lookup, no profile fetch and no app shell.
 * Nothing here calls `requireOnboardedUser`, so there is nothing to redirect.
 *
 * A route group does not appear in the URL, so these are `/privacy`, `/terms`
 * and `/support` exactly as the App Store listing will name them.
 *
 * ── ONE SHELL FOR THE THREE ────────────────────────────────────────────────
 *
 * They cross-link to each other and share a header, a footer and a reading
 * column. Repeating that in three files is how two of them end up subtly
 * different a year from now.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-5 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        {/* Home rather than the dashboard: a signed-out reader would be bounced
            to sign-in from there, and `/` already routes each visitor to
            whichever of the two is right for them. */}
        <Link href="/" className="press inline-flex rounded-[var(--radius-md)]">
          <BrandLockup size={30} />
        </Link>
      </header>

      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>

      <footer className="mt-12 flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-6 text-sm">
        <nav aria-label="Legal and support">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link href="/privacy" className="underline underline-offset-4 hover:no-underline">
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link href="/terms" className="underline underline-offset-4 hover:no-underline">
                Terms of Use
              </Link>
            </li>
            <li>
              <Link href="/support" className="underline underline-offset-4 hover:no-underline">
                Support
              </Link>
            </li>
          </ul>
        </nav>
        <p className="text-xs text-muted">MatchDay — pickup match coordination.</p>
      </footer>
    </div>
  );
}
