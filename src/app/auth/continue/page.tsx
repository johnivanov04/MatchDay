import type { Metadata } from 'next';
import Link from 'next/link';
import { validateConfirmationUrl } from '@/lib/auth/confirmation-url';

export const metadata: Metadata = { title: 'Continue sign in' };

/**
 * The second click that stops a sign-in link being spent before the human sees
 * it.
 *
 * Supabase's confirmation links are single-use, and plenty of things open a
 * link before its recipient does: Brevo rewrites every link through its own
 * click-tracking redirect, corporate mail scanners fetch links to inspect them,
 * and some clients prefetch for previews. Any of those consumes the token, and
 * the person is then told their brand-new link is invalid. Supabase's
 * documented mitigation is to point the email at a page on our own origin and
 * require a real click before the confirmation URL is followed. This is that
 * page.
 *
 * ── THE RULE THIS PAGE MUST NEVER BREAK ────────────────────────────────────
 *
 * Rendering it must not consume the token. There is therefore:
 *
 *   * no `verifyOtp`, no `exchangeCodeForSession`, no Supabase client at all;
 *   * no fetch of the confirmation URL;
 *   * no `redirect()`, no `<meta http-equiv="refresh">`, no `router.push`;
 *   * no `useEffect` — this is a server component with no client bundle, so
 *     there is no effect that *could* fire;
 *   * no prefetch: the anchor is a plain `<a>`, deliberately not next/link,
 *     which prefetches on hover and viewport entry. Prefetching this href
 *     would recreate the exact bug the page exists to fix.
 *
 * The only thing that follows the confirmation URL is a human pressing the
 * button. Everything after that is unchanged: Supabase verifies the token and
 * redirects to `/auth/callback`, which exchanges it for a session exactly as
 * it does today.
 *
 * ── WHAT IS DELIBERATELY NOT LOGGED ────────────────────────────────────────
 *
 * The confirmation URL contains a live credential. It is never logged, never
 * placed in an observability event, and never sent anywhere — not even on the
 * rejection paths, where only the reason code is available and it too stays on
 * the server. `src/lib/observability/log.ts` would refuse a `token` key
 * anyway; this page simply never offers one.
 */
export default async function AuthContinuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['confirmation_url'];
  const result = validateConfirmationUrl(typeof raw === 'string' ? raw : null);

  if (!result.ok) {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 py-12"
      >
        <header className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">Matchday</p>
          <h1 className="text-2xl font-bold">This sign-in link is not valid</h1>
        </header>

        {/* One message for every rejection. A missing parameter, a malformed
            one and a link pointing somewhere else are all reported identically,
            so the page cannot be used to probe what we accept. Nothing from the
            parameter is echoed back. */}
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          We could not read the sign-in link from your email. It may have been altered in transit,
          or the address may have been copied incompletely.
        </p>

        <p className="text-sm text-muted">
          Request a new link and open it directly from the email — sign-in links are single-use.
        </p>

        <Link
          href="/sign-in"
          className="inline-flex min-h-11 w-fit items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700"
        >
          Back to sign in
        </Link>
      </main>
    );
  }

  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 py-12"
    >
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">Matchday</p>
        <h1 className="text-2xl font-bold">Continue sign in</h1>
        <p className="text-sm text-muted">
          One more tap and you are in. We ask for this because sign-in links can only be used once,
          and some email apps open links automatically before you get to them.
        </p>
      </header>

      {/*
        A plain anchor, on purpose.

        `next/link` prefetches, which would open the confirmation URL before
        anybody pressed anything — the precise failure this page prevents.
        `rel="nofollow"` asks crawlers and scanners not to follow it either.
      */}
      <a
        href={result.url}
        rel="nofollow noopener"
        className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-pitch-600 px-4 py-3 text-base font-semibold text-white hover:bg-pitch-700"
      >
        Continue sign in
      </a>

      <p className="text-sm text-muted">
        Did not request this? You can close this page — nothing happens until you tap the button.
      </p>

      <Link href="/sign-in" className="text-sm underline underline-offset-4">
        Back to sign in
      </Link>
    </main>
  );
}
