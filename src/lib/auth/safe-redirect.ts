/**
 * Constrains a post-sign-in destination to a same-origin path.
 *
 * The `next` parameter on the auth callback is fully attacker-controllable: a
 * crafted sign-in link could otherwise bounce a user who has just
 * authenticated to an external page, which is the classic setup for a
 * convincing credential-phishing follow-up. Only absolute paths on this origin
 * are honoured; everything else falls back to the dashboard.
 */
export const DEFAULT_POST_SIGN_IN_PATH = '/dashboard';

export function safeRedirectPath(rawNext: string | null | undefined): string {
  if (typeof rawNext !== 'string' || rawNext === '') {
    return DEFAULT_POST_SIGN_IN_PATH;
  }

  // Must be a path on this origin.
  if (!rawNext.startsWith('/')) {
    return DEFAULT_POST_SIGN_IN_PATH;
  }

  // `//evil.example` and `/\evil.example` are protocol-relative URLs that
  // browsers resolve to a different origin despite the leading slash.
  if (rawNext.startsWith('//') || rawNext.startsWith('/\\')) {
    return DEFAULT_POST_SIGN_IN_PATH;
  }

  // Control characters — newlines especially — can smuggle an extra response
  // header or confuse URL parsing.
  if (/[\u0000-\u001F\u007F]/.test(rawNext)) {
    return DEFAULT_POST_SIGN_IN_PATH;
  }

  return rawNext;
}
