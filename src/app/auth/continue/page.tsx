import type { Metadata } from 'next';
import Link from 'next/link';
import { validateConfirmationUrl } from '@/lib/auth/confirmation-url';
import { parseConfirmationParams } from '@/lib/auth/email-confirmation';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { confirmEmailAction } from '@/server/actions/auth-confirmation';

export const metadata: Metadata = { title: 'Confirm your email' };

/**
 * The second click that stops a sign-in link being spent before the human sees
 * it.
 *
 * Supabase's confirmation links are single-use, and plenty of things open a
 * link before its recipient does: Brevo rewrites every link through its own
 * click-tracking redirect, corporate mail scanners fetch links to inspect them,
 * and some clients prefetch for previews. Any of those consumes the token, and
 * the person is then told their brand-new link is invalid. Supabase's
 * documented mitigation is to require a real click before the token is spent.
 * This is that page.
 *
 * ── THE RULE THIS PAGE MUST NEVER BREAK ────────────────────────────────────
 *
 * Rendering it must not consume the token. There is therefore:
 *
 *   * no `verifyOtp`, no `exchangeCodeForSession`, no Supabase client at all;
 *   * no fetch of anything;
 *   * no `redirect()`, no `<meta http-equiv="refresh">`, no `router.push`;
 *   * no `useEffect` — this is a server component with no client bundle, so
 *     there is no effect that *could* fire;
 *   * no prefetch on the legacy anchor: it is a plain `<a>`, deliberately not
 *     next/link, which prefetches on hover and viewport entry.
 *
 * The only thing that spends a token is a human submitting the form, which
 * posts to `confirmEmailAction`. Scanners do not POST.
 *
 * ── TWO LINK SHAPES, ON PURPOSE ────────────────────────────────────────────
 *
 * **New** — `?token_hash=…&type=signup|magiclink`. Our own POST verifies the
 * token, so it works in whichever browser opened the email. This is what the
 * production templates will carry.
 *
 * **Legacy** — `?confirmation_url=<supabase verify url>`. The shape currently
 * in production. It still renders and still works for the browser that
 * requested it, because links already sitting in people's inboxes must not
 * break the moment this deploys. It goes when those links have aged out; see
 * the note in `confirmation-url.ts`.
 *
 * ── WHAT IS DELIBERATELY NOT LOGGED ────────────────────────────────────────
 *
 * Both shapes carry a live credential. Neither is logged, placed in an
 * observability event, or sent anywhere — not even on the rejection paths,
 * where only a reason code exists and it too stays on the server.
 */
export default async function AuthContinuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Set by `confirmEmailAction` when verification fails. Carries no detail —
  // its presence is the whole message.
  const failed = params['error'] !== undefined;

  const confirmation = parseConfirmationParams(params['token_hash'], params['type']);
  const legacy = validateConfirmationUrl(
    typeof params['confirmation_url'] === 'string' ? params['confirmation_url'] : null,
  );

  // Sanitised here as well as in the action: it travels through an emailed
  // link, so it must be safe at every hop rather than only the last one.
  const next = safeRedirectPath(typeof params['next'] === 'string' ? params['next'] : null);

  if (failed || (!confirmation.ok && !legacy.ok)) {
    return (
      <main
        id="main"
        className="chalk-arc turf-stripes relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 pb-12 pt-[max(3rem,env(safe-area-inset-top))]"
      >
        <header className="animate-rise flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">MatchDay</p>
          <h1 className="text-[1.75rem] font-bold leading-tight">This link has expired</h1>
        </header>

        {/* One message for every rejection. A missing parameter, a malformed
            one, an unsupported type, a token that was already used and a token
            that never existed are all reported identically, so the page cannot
            be used to probe what we accept or whether an address is registered.
            Nothing from the parameters is echoed back. */}
        <p
          role="alert"
          className="surface-card px-4 py-3 text-sm leading-relaxed text-secondary"
        >
          Sign-in links can only be used once, and they expire after a while. Ask for a new one and
          open it from the email — it will work straight away.
        </p>

        <Link
          href="/sign-in"
          className="press inline-flex min-h-control w-full items-center justify-center rounded-[var(--radius-md)] bg-pitch-600 px-4 py-3 text-base font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
        >
          Get a new link
        </Link>
      </main>
    );
  }

  return (
    <main
      id="main"
      className="chalk-arc turf-stripes relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 pb-12 pt-[max(3rem,env(safe-area-inset-top))]"
    >
      <header className="animate-rise flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">MatchDay</p>
        <h1 className="text-[1.75rem] font-bold leading-tight">Confirm your email</h1>
        <p className="text-sm leading-relaxed text-secondary">
          One more tap and you are in. We ask for this because sign-in links can only be used once,
          and some email apps open links automatically before you get to them.
        </p>
      </header>

      {confirmation.ok ? (
        // The new flow. A form, because only an explicit submission may spend
        // the token — and because this posts to our own origin, the session
        // cookie is written for the browser actually being used.
        <form action={confirmEmailAction} className="animate-rise flex flex-col gap-4">
          <input type="hidden" name="token_hash" value={confirmation.tokenHash} />
          <input type="hidden" name="type" value={confirmation.type} />
          <input type="hidden" name="next" value={next} />
          <button
            type="submit"
            className="press inline-flex min-h-[3.125rem] w-full items-center justify-center rounded-[var(--radius-md)] bg-pitch-600 px-5 py-3 text-base font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
          >
            Continue to MatchDay
          </button>
        </form>
      ) : (
        // The legacy flow, for links already in inboxes. A plain anchor, on
        // purpose: `next/link` prefetches, which would open the confirmation
        // URL before anybody pressed anything — the precise failure this page
        // prevents. `rel="nofollow"` asks crawlers not to follow it either.
        <a
          href={legacy.ok ? legacy.url : '/sign-in'}
          rel="nofollow noopener"
          className="press animate-rise inline-flex min-h-[3.125rem] w-full items-center justify-center rounded-[var(--radius-md)] bg-pitch-600 px-5 py-3 text-base font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
        >
          Continue to MatchDay
        </a>
      )}

      <p className="text-sm text-muted">
        Did not request this? You can close this page — nothing happens until you tap the button.
      </p>

      <Link href="/sign-in" className="text-sm underline underline-offset-4">
        Back to sign in
      </Link>
    </main>
  );
}
