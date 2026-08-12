'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/status';

/**
 * The boundary for every authenticated route.
 *
 * Before this existed, an error escaping a Server Component reached the
 * framework's default handler: a stack trace in development, and a bare
 * "Application error: a server-side exception has occurred" in production. Both
 * are worse than useless to somebody trying to sign up for a five-a-side.
 *
 * WHAT IS DELIBERATELY NOT RENDERED. `error.message`. Next.js already redacts
 * server-thrown messages in production, but this component also catches errors
 * thrown during client rendering, where nothing is redacted — and a message can
 * carry a constraint name, a column value, or an identifier belonging to
 * another league. The `digest` is safe by construction (a hash) and is shown so
 * somebody reporting the problem has something to quote.
 *
 * `reset()` re-renders the segment. It is the right offer here because most of
 * what reaches this boundary is transient — a dropped connection, a cold
 * database, a deploy mid-request — and asking somebody to re-navigate from the
 * dashboard to fix a network blip is a poor trade.
 */
export default function AuthenticatedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side, this is already in the platform logs with the same digest.
    // This covers the client-render case, which otherwise goes nowhere.
    console.error('[matchday] render failed', {
      digest: error.digest,
      name: error.name,
    });
  }, [error]);

  return (
    <ErrorState
      action={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700"
          >
            Try again
          </button>
          {error.digest === undefined ? null : (
            <p className="text-xs opacity-80">Reference: {error.digest}</p>
          )}
        </div>
      }
    />
  );
}
