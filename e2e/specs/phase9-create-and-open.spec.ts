import type { Page } from '@playwright/test';
import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';
import type { TestLeague } from '../support/factory';

/**
 * Creating a match, as an organizer actually does it.
 *
 * ── THE FAILURE THIS COVERS ────────────────────────────────────────────────
 *
 * The form's only button was "Create as draft", and it redirected to the match
 * *list*. Publishing was a separate errand: find the match again, open it, press
 * Publish to members. Organizers created matches, believed they had scheduled
 * them, and left them invisible to their league — a silent failure that cost
 * real fixtures. Nothing here was broken in a way any assertion could see,
 * because every individual step worked.
 *
 * So these two flows are deliberately end-to-end and deliberately about the
 * *outcome*: after pressing one button, is the match in the state the button
 * said it would be, and can the people who need to see it see it.
 */

const FUTURE_DATE = '2027-03-14';

/** Fills the create form with a complete, valid match. */
async function fillMatchForm(page: Page, league: TestLeague, title: string): Promise<void> {
  await page.goto(`/leagues/${league.slug}/matches/new`);
  await expect(page.getByRole('heading', { name: 'Create a match' })).toBeVisible();
  // Hydration: the form is a client component and the submit buttons carry the
  // intent, so a press that lands before React attaches goes nowhere.
  await page.waitForLoadState('networkidle');

  await page.getByLabel('Match title').fill(title);
  await page.getByLabel('Date').fill(FUTURE_DATE);
  await page.getByLabel('Arrive').fill('18:30');
  await page.getByLabel('Kickoff').fill('19:00');
  await page.getByLabel('Ends').fill('20:30');
  await page.getByLabel('Location').fill('Testville Astro');
  await page.getByLabel('Capacity').fill('12');
  await page.getByLabel('Minimum', { exact: true }).fill('8');
}

async function statusOf(
  factory: { query: <T extends Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]> },
  title: string,
): Promise<string | undefined> {
  const rows = await factory.query<{ status: string }>(
    'select status::text as status from public.matches where title = $1',
    [title],
  );
  return rows[0]?.status;
}

test.describe('creating a match', () => {
  test('Save as draft lands on the match, clearly not live', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const title = `Draft ${Date.now().toString(36)}`;

    const admin = await asUser(league.admin.email);
    await fillMatchForm(admin, league, title);
    await admin.getByRole('button', { name: 'Save as draft' }).click();

    // The match itself, not the list it used to bounce to.
    await admin.waitForURL(/\/matches\/[0-9a-f-]{36}/);
    await expect(admin.getByRole('heading', { name: title })).toBeVisible();
    await expect(admin.getByText('Saved as a draft. Nobody has been notified yet.')).toBeVisible();
    await expect(admin.getByText('Draft — members cannot see this match yet.')).toBeVisible();
    await expectNoServerError(admin);

    expect(await statusOf(factory, title)).toBe('draft');

    // Unchanged behaviour: a draft is invisible to members by list and by link,
    // and nobody was notified.
    const matchId = new URL(admin.url()).pathname.split('/').pop() ?? '';
    const memberPage = await asUser(member.email);
    await memberPage.goto(`/leagues/${league.slug}/matches`);
    await expect(memberPage.locator('body')).not.toContainText(title);
    await expectRedirectedTo(
      memberPage,
      `/leagues/${league.slug}/matches/${matchId}`,
      '/dashboard',
    );

    const notified = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications where match_id = $1`,
      [matchId],
    );
    expect(notified[0]?.count).toBe('0');
  });

  test('Publish match opens it in one step and tells the league', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const title = `Published ${Date.now().toString(36)}`;

    const admin = await asUser(league.admin.email);
    await fillMatchForm(admin, league, title);
    await admin.getByRole('button', { name: 'Publish match' }).click();

    await admin.waitForURL(/\/matches\/[0-9a-f-]{36}/);
    await expect(admin.getByRole('heading', { name: title })).toBeVisible();
    await expect(admin.getByText('Match published — members have been notified.')).toBeVisible();
    await expect(admin.getByText('Open — members can see this match and sign up.')).toBeVisible();
    await expectNoServerError(admin);

    // Open in the database, published, and with no second step required: the
    // Publish control that a draft would show is absent.
    expect(await statusOf(factory, title)).toBe('open');
    await expect(admin.getByRole('button', { name: 'Publish to members' })).toHaveCount(0);
    await expect(admin.getByText('Draft — members cannot see this match yet.')).toHaveCount(0);

    const matchId = new URL(admin.url()).pathname.split('/').pop() ?? '';
    const published = await factory.query<{ published_at: string | null }>(
      'select published_at from public.matches where id = $1',
      [matchId],
    );
    expect(published[0]?.published_at).not.toBeNull();

    // The fanout the lifecycle owns: one notification for the member, none for
    // the administrator who did it.
    const notifications = await factory.query<{ recipient_user_id: string }>(
      `select recipient_user_id from public.notifications
        where match_id = $1 and type = 'match_published'`,
      [matchId],
    );
    expect(notifications.map((row) => row.recipient_user_id)).toEqual([member.id]);

    // And the member can actually reach it.
    const memberPage = await asUser(member.email);
    await memberPage.goto(`/leagues/${league.slug}/matches/${matchId}`);
    await expect(memberPage.getByRole('heading', { name: title })).toBeVisible();
    // The administrator's "Open" banner is not shown to players — for them an
    // open match is simply a match.
    await expect(memberPage.getByText('Open — members can see this match')).toHaveCount(0);
  });

  test('an invalid match cannot be published, and creates nothing', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const title = `Invalid ${Date.now().toString(36)}`;

    const admin = await asUser(league.admin.email);
    await fillMatchForm(admin, league, title);
    // Kickoff before arrival: refused by the same schema on both paths.
    await admin.getByLabel('Kickoff').fill('17:00');
    await admin.getByRole('button', { name: 'Publish match' }).click();

    await expect(admin.getByText('Kickoff cannot be before the arrival time.')).toBeVisible();
    // Still on the form, and nothing was written by either half of the wrapper.
    expect(new URL(admin.url()).pathname).toBe(`/leagues/${league.slug}/matches/new`);
    expect(await statusOf(factory, title)).toBeUndefined();
    await expectNoServerError(admin);
  });

  test('a player cannot reach the create form at all', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    await expectRedirectedTo(page, `/leagues/${league.slug}/matches/new`, '/dashboard');
  });
});

test.describe('opening a notification', () => {
  test('marks it read, lands on its target, and the badge follows', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const title = `Notified ${Date.now().toString(36)}`;

    // Two notifications, so "marks exactly one" is observable.
    const admin = await asUser(league.admin.email);
    await fillMatchForm(admin, league, title);
    await admin.getByRole('button', { name: 'Publish match' }).click();
    await admin.waitForURL(/\/matches\/[0-9a-f-]{36}/);

    const second = await factory.createMatch(league, { status: 'draft' });
    await admin.goto(`/leagues/${league.slug}/matches/${second.id}`);
    await admin.getByRole('button', { name: 'Publish to members' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          `select count(*)::text as count from public.notifications
            where recipient_user_id = $1 and read_at is null`,
          [member.id],
        );
        return rows[0]?.count;
      })
      .toBe('2');

    const page = await asUser(member.email);
    await page.goto('/notifications');
    await expect(page.getByText('2 unread notifications.')).toBeVisible();

    // The badge on the tab bar carries the same count.
    const inboxTab = page.getByRole('link', { name: /Inbox/ }).first();
    await expect(inboxTab).toContainText('2');

    // Open the one about the match just published.
    const row = page.getByRole('listitem').filter({ hasText: `New match: ${title}` });
    await row.getByRole('button', { name: 'Open' }).click();

    // It lands on the deep link, which is the match the notification is about.
    await page.waitForURL(new RegExp(`/leagues/${league.slug}/matches/[0-9a-f-]{36}`));
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expectNoServerError(page);

    // Exactly one row was marked read — the other is untouched.
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          `select count(*)::text as count from public.notifications
            where recipient_user_id = $1 and read_at is null`,
          [member.id],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    // The badge decremented on the page we navigated *to*, without a reload.
    await expect(page.getByRole('link', { name: /Inbox/ }).first()).toContainText('1');

    // Back in the inbox it reads as read, and stays that way through a reload.
    await page.goto('/notifications');
    await expect(page.getByText('1 unread notification.')).toBeVisible();
    const opened = page.getByRole('listitem').filter({ hasText: `New match: ${title}` });
    await expect(opened.getByRole('button', { name: 'Mark as unread' })).toBeVisible();

    await page.reload();
    await expect(page.getByText('1 unread notification.')).toBeVisible();
    await expect(
      page.getByRole('listitem').filter({ hasText: `New match: ${title}` })
        .getByRole('button', { name: 'Mark as unread' }),
    ).toBeVisible();
  });

  test('opening the last unread notification removes the badge entirely', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await admin.getByRole('button', { name: 'Publish to members' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.notifications where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    const page = await asUser(member.email);
    await page.goto('/notifications');
    await expect(page.getByRole('link', { name: /Inbox/ }).first()).toContainText('1');

    await page.getByRole('button', { name: 'Open' }).first().click();
    await page.waitForURL(/\/matches\//);

    // At zero unread there is no number and no stale dot — `CountBadge` renders
    // nothing at all rather than a `0`.
    const inbox = page.getByRole('link', { name: /Inbox/ }).first();
    await expect(inbox).not.toContainText('1');
    await expect(inbox).not.toContainText('0');

    await page.goto('/notifications');
    await expect(page.getByText('You are all caught up.')).toBeVisible();
  });

  test('re-opening an already-read notification is harmless', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await admin.getByRole('button', { name: 'Publish to members' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.notifications where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    const page = await asUser(member.email);
    await page.goto('/notifications');
    await page.getByRole('button', { name: 'Open' }).first().click();
    await page.waitForURL(/\/matches\//);

    // `::text`, because `pg` hands back a Date object and two equal timestamps
    // are then two different objects.
    const firstRead = await factory.query<{ read_at: string }>(
      `select read_at::text as read_at from public.notifications where recipient_user_id = $1`,
      [member.id],
    );
    expect(firstRead[0]?.read_at).not.toBeNull();

    // Open it again. `mark_notification_read` coalesces, so the original
    // timestamp survives rather than being pushed forward.
    await page.goto('/notifications');
    await page.getByRole('button', { name: 'Open' }).first().click();
    await page.waitForURL(/\/matches\//);

    const secondRead = await factory.query<{ read_at: string }>(
      `select read_at::text as read_at from public.notifications where recipient_user_id = $1`,
      [member.id],
    );
    expect(secondRead[0]?.read_at).toBe(firstRead[0]?.read_at);
  });

  test('one member cannot mark another member’s notification read', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await admin.getByRole('button', { name: 'Publish to members' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.notifications where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('2');

    // Alice opens hers.
    const alicePage = await asUser(alice.email);
    await alicePage.goto('/notifications');
    await alicePage.getByRole('button', { name: 'Open' }).first().click();
    await alicePage.waitForURL(/\/matches\//);

    // Bob's is untouched — the RPC scopes its UPDATE to the recipient, so there
    // is no id Alice could have submitted that would have reached it.
    const bobRows = await factory.query<{ read_at: string | null }>(
      'select read_at from public.notifications where recipient_user_id = $1',
      [bob.id],
    );
    expect(bobRows[0]?.read_at).toBeNull();

    const bobPage = await asUser(bob.email);
    await bobPage.goto('/notifications');
    await expect(bobPage.getByText('1 unread notification.')).toBeVisible();
  });
});
