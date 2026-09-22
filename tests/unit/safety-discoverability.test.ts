import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Whether a member can FIND the safety controls.
 *
 * Guideline 1.2 asks that blocking be available to users. A page reachable only
 * by typing its URL is not available in any sense a reviewer would accept, and
 * "we built it, it just isn't linked" is how an app gets rejected twice.
 *
 * This reads the source rather than rendering, because the profile page is a
 * server component that reaches for a session. What matters is the link's
 * existence and its wording, both of which are static.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function source(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

describe('the blocked-members page is reachable without knowing the URL', () => {
  it('is linked from the profile screen', async () => {
    const profile = await source('src/app/(app)/profile/page.tsx');
    expect(profile).toContain('/settings/blocked');
  });

  it('is labelled in words a person would look for', async () => {
    const profile = await source('src/app/(app)/profile/page.tsx');
    // Not "Safety settings" or "Privacy controls" — somebody looking for this
    // is looking for the person they blocked.
    expect(profile).toMatch(/Blocked members/);
  });

  it('sits in the Account section, beside the other per-account settings', async () => {
    const profile = await source('src/app/(app)/profile/page.tsx');
    const account = profile.indexOf('<Section title="Account">');
    const blocked = profile.indexOf('/settings/blocked');
    const deletion = profile.indexOf('Deleting the account');
    expect(account).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(account);
    // Before the account-deletion section, which is deliberately last.
    expect(blocked).toBeLessThan(deletion);
  });

  it('points at a page that exists', async () => {
    await expect(source('src/app/(app)/settings/blocked/page.tsx')).resolves.toContain(
      'my_blocked_members',
    );
  });
});

describe('reporting is reachable from the surfaces that show other people', () => {
  it('is on the match detail page, where rosters and teams are', async () => {
    const match = await source('src/app/(app)/leagues/[slug]/matches/[matchId]/page.tsx');
    expect(match).toContain('MemberSafety');
    expect(match).toContain('ReportContent');
  });

  it('is on the guidelines page', async () => {
    const guidelines = await source('src/app/(app)/leagues/[slug]/guidelines/page.tsx');
    expect(guidelines).toContain('ReportContent');
  });

  it('is explained on the public support page', async () => {
    const support = await source('src/app/(legal)/support/page.tsx');
    expect(support).toMatch(/Report this member/);
    expect(support).toMatch(/Block this member/);
  });

  it('does not promise a response time we cannot guarantee', async () => {
    const support = await source('src/app/(legal)/support/page.tsx');
    // Guideline 1.2 asks for timely responses, not a published SLA. The
    // escalation guarantees a report REACHES a human; when one replies is a
    // separate claim and is deliberately not made.
    expect(support).not.toMatch(/24 hours|24-hour|within a day|same day/i);
  });
});
