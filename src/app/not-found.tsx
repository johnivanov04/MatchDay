import { ButtonLink } from '@/components/ui/button';

/**
 * An address that does not correspond to anything.
 *
 * Distinct from the authorization redirects. A league or match somebody cannot
 * see is never a 404 — `getMatch` returning null sends them to the dashboard
 * with a notice, so that "does not exist" and "is not yours" are
 * indistinguishable from outside and a guessed id confirms nothing. This page
 * is for the genuinely absent: a mistyped path, a link to a route that has been
 * removed.
 *
 * It therefore offers no search and no suggestions, both of which would be
 * guessing at what somebody meant with no information to guess from.
 */
export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-start justify-center gap-4 px-5 py-10"
    >
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-muted">
        That address does not point to anything in MatchDay. It may have been mistyped, or it may
        have moved.
      </p>
      <ButtonLink href="/dashboard" variant="primary">
        Go to your dashboard
      </ButtonLink>
    </main>
  );
}
