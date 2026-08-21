import 'server-only';

import { headers } from 'next/headers';
import { isNativeIOSUserAgent } from '@/lib/platform/native';

/**
 * Whether the current request came from the MatchDay iOS app.
 *
 * Reads the request's User-Agent, so it is available in every Server Component
 * and every Server Action without a client round-trip and without a hydration
 * flash. Pass the result down as a prop rather than calling
 * `isNativeIOSClient()` in a leaf — the server already knows.
 *
 * Not cached: `headers()` is already per-request in Next, and the check is a
 * substring test on a string the runtime has in hand.
 */
export async function isNativeIOSApp(): Promise<boolean> {
  const headerList = await headers();
  return isNativeIOSUserAgent(headerList.get('user-agent'));
}
