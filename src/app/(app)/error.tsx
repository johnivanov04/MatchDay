'use client';

import { useEffect } from 'react';
import { SupportContact } from '@/components/support-contact';
import { Button } from '@/components/ui/button';
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
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          {error.digest === undefined ? null : (
            <p className="text-xs opacity-80">Reference: {error.digest}</p>
          )}
          {/* The digest above is only useful to somebody who can be told it.
              Pairing the two means a stuck player can report the exact failure
              instead of describing it. */}
          <p className="text-xs opacity-80">
            <SupportContact prefix="Still stuck?" />
          </p>
        </div>
      }
    />
  );
}
