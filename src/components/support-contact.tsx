import { getSupportEmail } from '@/lib/env';

/**
 * How somebody reaches a human.
 *
 * Rendered in two places and no others: the application footer, where it is
 * quiet and always available, and the error boundaries, where somebody is
 * already stuck. Both matter for a pilot with real players — a person who
 * cannot sign in, or whose league administrator has gone quiet, otherwise has
 * no route out of the product at all.
 *
 * Renders nothing when `NEXT_PUBLIC_SUPPORT_EMAIL` is unset, rather than
 * showing a dead link or inventing an address.
 */
export function SupportContact({ prefix = 'Need help?' }: { prefix?: string }) {
  const email = getSupportEmail();
  if (email === null) {
    return null;
  }

  return (
    <span>
      {prefix}{' '}
      <a href={`mailto:${email}`} className="underline underline-offset-4">
        {email}
      </a>
    </span>
  );
}
