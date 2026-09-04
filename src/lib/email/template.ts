/**
 * What a MatchDay notification looks like in an inbox.
 *
 * ── EVERY DYNAMIC VALUE IS ESCAPED ─────────────────────────────────────────
 *
 * A notification's title and body are assembled in SQL from administrator free
 * text: `'New match: ' || matches.title`, `... || ' at ' || location_name`. The
 * only constraint on those columns is length. So a league administrator can
 * name a match `<img src=x onerror=...>` and, without escaping, that would
 * render as markup inside every member's mail client.
 *
 * The HTML is therefore built from escaped fragments only. There is no path
 * that interpolates an unescaped value, and the plain-text part carries the raw
 * string precisely because text/plain renders nothing.
 *
 * ── NO MORE THAN THE INBOX ALREADY SHOWS ───────────────────────────────────
 *
 * The email carries the same title, body and link the in-app notification does
 * and nothing else. No roster, no attendance, no member list, no internal ids.
 * An email is forwarded, quoted and left open on a train far more often than an
 * app screen, so it gets the narrower of the two.
 */

export interface EmailTemplateInput {
  /** The notification's own title. Untrusted. */
  title: string;
  /** The notification's own body. Untrusted. */
  body: string;
  /** Absolute HTTPS link into the app. Built here, never supplied. */
  url: string;
  /** Absolute HTTPS link to the settings page carrying the email toggle. */
  settingsUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The five characters that can change the meaning of markup.
 *
 * Quotes included because escaped values appear inside attributes; an
 * apostrophe alone would be enough to break out of a single-quoted one.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A subject line, made safe to be a header.
 *
 * ── CONTROL CHARACTERS ARE STRIPPED, NOT TRIMMED ───────────────────────────
 *
 * `trim()` removes leading and trailing whitespace and leaves the interior
 * alone, so a match titled `Friendly\r\nBcc: someone@example.test` produced a
 * subject containing a CRLF. Resend takes JSON and builds the headers itself,
 * so this is not a live injection today — but a subject is a header, a CRLF in
 * one is the classic way to add another, and relying on a third party's parser
 * to keep refusing it is not a guarantee we control.
 *
 * Every C0 control is removed and runs of whitespace collapse to one space.
 */
function subjectFrom(title: string): string {
  const flattened = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return flattened.length <= 120 ? flattened : `${flattened.slice(0, 119)}…`;
}

/**
 * Only same-origin app links are ever linked to.
 *
 * The deep link comes from a column constrained to `^/[^/\\]`, and this builds
 * an absolute URL from it against a base the deployment controls. A value that
 * somehow escaped that constraint would produce a link to somewhere else
 * entirely, so it is re-checked here rather than trusted twice.
 */
export function absoluteAppUrl(baseUrl: string, path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return null;
  }
  if (/[\r\n]/.test(path)) {
    return null;
  }

  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:') {
      return null;
    }
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

export function renderNotificationEmail(input: EmailTemplateInput): RenderedEmail {
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const url = escapeHtml(input.url);
  const settingsUrl = escapeHtml(input.settingsUrl);

  // Table-based and inline-styled on purpose. Mail clients are not browsers:
  // Outlook ignores most of a stylesheet, Gmail strips `<style>` in some views,
  // and flexbox is not reliably supported anywhere. This is the boring layout
  // that renders the same in all of them.
  const html = `<!-- MatchDay notification -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f4f5f7;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:520px;background-color:#ffffff;border-radius:12px;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:24px 24px 8px 24px;">
            <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:0.06em;
                      text-transform:uppercase;color:#6b7280;">MatchDay</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px;">
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.35;color:#111827;">${title}</h1>
            <p style="margin:0 0 20px 0;font-size:15px;line-height:1.55;color:#374151;">${body}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 24px 24px;">
            <a href="${url}"
               style="display:inline-block;padding:11px 20px;border-radius:8px;
                      background-color:#111827;color:#ffffff;font-size:15px;
                      font-weight:600;text-decoration:none;">Open in MatchDay</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px 24px 24px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
              You are receiving this because email notifications are switched on for your
              MatchDay account. Everything here is also in your in-app inbox.<br>
              <a href="${settingsUrl}" style="color:#6b7280;">Manage email notifications</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  // The raw strings, unescaped — text/plain renders no markup, and escaping
  // here would show readers a literal `&amp;` in a match called "Reds & Blues".
  const text = [
    input.title,
    '',
    input.body,
    '',
    `Open in MatchDay: ${input.url}`,
    '',
    'You are receiving this because email notifications are switched on for your',
    'MatchDay account. Everything here is also in your in-app inbox.',
    `Manage email notifications: ${input.settingsUrl}`,
  ].join('\n');

  return { subject: subjectFrom(input.title), html, text };
}
