import { readSupabaseEnvironment } from './environment';

/**
 * Reading the emails the stack actually sent.
 *
 * ── WHY A SPEC WOULD WANT THIS ─────────────────────────────────────────────
 *
 * Everywhere else, the suite signs in by minting a session through the Auth
 * admin API and installing the cookie — deliberately, because scraping an inbox
 * on every test would be slow and brittle. That shortcut is also precisely how
 * the confirmation flow shipped broken: nothing exercised the email, so nothing
 * noticed that the link only worked in the browser that requested it.
 *
 * So this exists for the one spec that must not take the shortcut. It reads the
 * real message out of Mailpit, which is the local stack's mail catcher, and the
 * link it returns is the one a person would have tapped.
 */

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

interface MailpitMessage {
  HTML: string;
  Text: string;
}

function mailpit(path: string): string {
  return `${readSupabaseEnvironment().mailpitUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * The most recent message sent to `address`, waiting for it to arrive.
 *
 * Polls rather than sleeps: GoTrue sends the mail after the API call returns,
 * so there is a real gap, and its size depends on how loaded the machine is.
 */
export async function waitForEmail(
  address: string,
  timeoutMs = 15_000,
): Promise<{ subject: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  const target = address.toLowerCase();

  while (Date.now() < deadline) {
    const response = await fetch(mailpit('/api/v1/messages?limit=200')).catch(() => null);

    if (response !== null && response.ok) {
      const { messages } = (await response.json()) as { messages: MailpitSummary[] };
      const match = messages
        .filter((message) => message.To.some((to) => to.Address.toLowerCase() === target))
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];

      if (match !== undefined) {
        const detail = (await fetch(mailpit(`/api/v1/message/${match.ID}`)).then((res) =>
          res.json(),
        )) as MailpitMessage;

        return {
          subject: match.Subject,
          // Both parts, because a template may put the link in either, and the
          // entities are decoded because `&amp;` in HTML is `&` in a URL.
          html: `${detail.HTML}\n${detail.Text}`.replaceAll('&amp;', '&'),
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `No email arrived for ${address} within ${String(timeoutMs)}ms. ` +
      'Is the local Supabase stack running with its mail catcher?',
  );
}

/**
 * The MatchDay confirmation link out of an email body.
 *
 * Deliberately looks for **our own** `/auth/continue` URL rather than a
 * Supabase `/auth/v1/verify` one: after the template switch the email points at
 * MatchDay and never at Supabase, and a spec that accepted either would keep
 * passing if the templates silently reverted.
 */
export function confirmationLinkFrom(emailBody: string): URL {
  const match = /https?:\/\/[^"'\s<>]*\/auth\/continue[^"'\s<>]*/.exec(emailBody);

  if (match === null) {
    throw new Error(
      'The email contained no /auth/continue link. Check the templates in supabase/config.toml.',
    );
  }

  return new URL(match[0]);
}

/** Deletes every captured message, so one test cannot read another's mail. */
export async function clearMailbox(): Promise<void> {
  await fetch(mailpit('/api/v1/messages'), { method: 'DELETE' }).catch(() => null);
}
