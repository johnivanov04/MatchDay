import { LoadingState } from '@/components/ui/status';

/**
 * Shown while any authenticated route's server components are running.
 *
 * One file at the group root rather than one per route. Every screen beneath it
 * is the same shape — a heading, a line of context, then cards — so a shared
 * skeleton is honest about what is coming, and a route with a genuinely
 * different shape can add its own `loading.tsx` beside it.
 *
 * Its real job is on a phone on mobile data, where the gap between tapping a
 * match and seeing it is seconds rather than milliseconds and a blank screen
 * reads as a broken app.
 */
export default function AuthenticatedLoading() {
  return <LoadingState />;
}
