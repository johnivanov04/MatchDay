import { describe, expect, it } from 'vitest';
import {
  absoluteAppUrl,
  escapeHtml,
  renderNotificationEmail,
} from '@/lib/email/template';

/**
 * What ends up in somebody's inbox.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT: a notification's title and body are
 * built in SQL from administrator free text — `'New match: ' || matches.title`
 * — and the only constraint on those columns is length. A league administrator
 * who names a match `<img src=x onerror=alert(1)>` would, without escaping, get
 * that markup rendered inside every member's mail client.
 */

const BASE = {
  title: 'New match: Monday night 11v11',
  body: 'Mon 17 Aug 19:00 at RMV Community Pitch',
  url: 'https://app.matchdayapps.com/leagues/rmv/matches/abc',
  settingsUrl: 'https://app.matchdayapps.com/settings/notifications',
};

describe('escapeHtml', () => {
  it.each([
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['&', '&amp;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (raw, escaped) => {
    expect(escapeHtml(raw)).toBe(escaped);
  });

  it('escapes ampersands before anything else, so entities are not double-broken', () => {
    // `&` first is the classic ordering bug: escape `<` first and `&lt;`
    // becomes `&amp;lt;` on the next pass.
    expect(escapeHtml('Reds & <Blues>')).toBe('Reds &amp; &lt;Blues&gt;');
  });
});

describe('hostile notification content', () => {
  it.each([
    ['<script>alert(1)</script>', 'script tag'],
    ['<img src=x onerror="alert(1)">', 'event handler'],
    ['"><a href="https://evil.test">click</a>', 'attribute break-out'],
    ["' onmouseover='alert(1)", 'single-quoted attribute break-out'],
    ['<iframe src="https://evil.test"></iframe>', 'iframe'],
    ['</td></tr></table><h1>hijacked', 'layout break-out'],
  ])('never lets %s survive into the HTML body (%s)', (hostile) => {
    const rendered = renderNotificationEmail({ ...BASE, title: hostile, body: hostile });

    // The property that matters is that no character which could START markup
    // or END an attribute survives unescaped. `onerror=` may well appear as
    // literal text — with its `<` and quotes escaped it is inert prose, and
    // asserting on the substring would be testing the wrong thing.
    expect(rendered.html).not.toContain(hostile);

    // No tag the hostile string tried to open.
    for (const tag of ['<script', '<img', '<iframe', '<a href="https://evil']) {
      expect(rendered.html).not.toContain(tag);
    }

    // And the hostile input is present only in escaped form.
    const escaped = hostile
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    expect(rendered.html).toContain(escaped);
  });

  it('leaves the plain-text part unescaped, because text/plain renders nothing', () => {
    // Escaping here would show a reader a literal `&amp;` in a match called
    // "Reds & Blues" — a bug in the other direction.
    const rendered = renderNotificationEmail({ ...BASE, title: 'Reds & Blues', body: 'A < B' });

    expect(rendered.text).toContain('Reds & Blues');
    expect(rendered.text).toContain('A < B');
    expect(rendered.text).not.toContain('&amp;');
  });

  it('strips control characters from the subject, which is a header', () => {
    // A subject is a header and a CRLF in one is how a second header gets
    // added. Resend takes JSON and builds the headers itself, so this is not a
    // live injection — but it is not a guarantee this codebase controls.
    const rendered = renderNotificationEmail({
      ...BASE,
      title: 'Friendly\r\nBcc: someone@example.test',
    });

    expect(rendered.subject).not.toContain('\r');
    expect(rendered.subject).not.toContain('\n');
    expect(rendered.subject).toBe('Friendly Bcc: someone@example.test');
  });

  it('collapses tabs and vertical whitespace too', () => {
    const rendered = renderNotificationEmail({ ...BASE, title: 'A\tB\u000bC   D' });
    expect(rendered.subject).toBe('A B C D');
  });
});

describe('the rendered message', () => {
  it('carries both an HTML and a plain-text part', () => {
    const rendered = renderNotificationEmail(BASE);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('uses the notification title as the subject', () => {
    expect(renderNotificationEmail(BASE).subject).toBe(BASE.title);
  });

  it('truncates an absurd subject rather than sending it whole', () => {
    const rendered = renderNotificationEmail({ ...BASE, title: 'T'.repeat(400) });
    expect(rendered.subject.length).toBeLessThanOrEqual(120);
    expect(rendered.subject).toContain('…');
  });

  it('links to the app and to the settings page', () => {
    const rendered = renderNotificationEmail(BASE);
    expect(rendered.html).toContain(BASE.url);
    expect(rendered.html).toContain(BASE.settingsUrl);
    expect(rendered.text).toContain(BASE.url);
    expect(rendered.text).toContain(BASE.settingsUrl);
  });

  it('says it is transactional and mentions the inbox', () => {
    const rendered = renderNotificationEmail(BASE);
    expect(rendered.html).toContain('in-app inbox');
    expect(rendered.text).toContain('in-app inbox');
  });

  it('carries no more than the in-app notification already shows', () => {
    // The title, the body, two links and MatchDay branding. Nothing about
    // rosters, attendance, other members, or internal identifiers.
    const rendered = renderNotificationEmail({
      ...BASE,
      // Fields that exist elsewhere in the domain and must never be in an email.
      title: 'New match',
      body: 'Mon 19:00',
    });

    for (const forbidden of ['roster', 'attendance', 'gender', 'phone', 'membership_id', 'user_id']) {
      expect(rendered.html.toLowerCase()).not.toContain(forbidden);
      expect(rendered.text.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('absoluteAppUrl', () => {
  const BASE_URL = 'https://app.matchdayapps.com';

  it('builds an absolute HTTPS link from a local path', () => {
    expect(absoluteAppUrl(BASE_URL, '/leagues/x/matches/y')).toBe(
      'https://app.matchdayapps.com/leagues/x/matches/y',
    );
  });

  it.each([
    ['//evil.test', 'protocol-relative'],
    ['/\\evil.test', 'backslash-smuggled origin'],
    ['leagues/x', 'relative path'],
    ['https://evil.test/x', 'absolute URL'],
    ['/x\nBcc: evil@example.test', 'embedded newline'],
  ])('refuses %s (%s)', (path) => {
    expect(absoluteAppUrl(BASE_URL, path)).toBeNull();
  });

  it('refuses a non-HTTPS base, so a misconfigured deployment sends no links', () => {
    expect(absoluteAppUrl('http://localhost:3000', '/x')).toBeNull();
  });

  it('returns null rather than throwing on a malformed base', () => {
    expect(absoluteAppUrl('not a url', '/x')).toBeNull();
  });
});
