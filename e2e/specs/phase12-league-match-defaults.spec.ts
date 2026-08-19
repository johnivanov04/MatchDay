import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';

/**
 * League-level match timing defaults, driven through the real forms.
 *
 * ── WHAT THIS IS PROVING ───────────────────────────────────────────────────
 *
 * That an organizer can set their league's timing policy once and have new
 * matches start there — and, just as important, that doing so later never
 * disturbs a match they have already created. The second property is the one
 * that would be expensive to get wrong and invisible until somebody's signup
 * deadline moved under them.
 */

const FUTURE_DATE = '2027-05-20';

/**
 * Reads a number input's current value.
 *
 * Not `exact`: `Field` appends an "Optional" badge inside the `<label>`, so an
 * optional field's accessible name is "Priority window Optional". Every label
 * used here is unique on its page, so a substring match is unambiguous.
 */
async function valueOf(page: Page, label: string): Promise<string> {
  return page.getByLabel(label).inputValue();
}

async function createLeague(
  page: Page,
  name: string,
  timing: { signup: string; cutoff: string; priority: string; roster: string },
): Promise<string> {
  await page.goto('/leagues/new');
  await page.waitForLoadState('networkidle');

  await page.getByLabel('League name').fill(name);
  await page.getByLabel('Short description').fill('A league for testing timing defaults.');
  await page.getByLabel('General area').fill('Testville');
  await page.getByLabel('Sport or format').fill('Soccer 5v5');

  await page.getByLabel('Signup closes').fill(timing.signup);
  await page.getByLabel('Cancellation cutoff').fill(timing.cutoff);
  await page.getByLabel('Priority window').fill(timing.priority);
  await page.getByLabel('Roster publish target').fill(timing.roster);

  await page.getByRole('button', { name: 'Create league' }).click();
  await page.waitForURL(/\/leagues\/[a-z0-9-]+\/settings/);

  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

async function fillMatchBasics(page: Page, title: string): Promise<void> {
  await page.getByLabel('Match title').fill(title);
  await page.getByLabel('Date').fill(FUTURE_DATE);
  await page.getByLabel('Arrive').fill('18:30');
  await page.getByLabel('Kickoff').fill('19:00');
  await page.getByLabel('Ends').fill('20:30');
  await page.getByLabel('Location').fill('Testville Astro');
  await page.getByLabel('Capacity').fill('12');
  await page.getByLabel('Minimum', { exact: true }).fill('8');
}

test.describe('a league carries its own match timing', () => {
  test('set once, inherited by new matches, and never applied backwards', async ({
    factory,
    asUser,
  }) => {
    test.setTimeout(120_000);
    const organizer = await factory.createOutsider();
    const page = await asUser(organizer.email);

    // ── 1. Create the league with explicit timing ──────────────────────────
    const slug = await createLeague(page, `Timing ${Date.now().toString(36)}`, {
      signup: '12',
      cutoff: '30',
      priority: '6',
      roster: '4',
    });
    await expectNoServerError(page);

    // ── 2. It persisted, and the settings form reads it back ───────────────
    const stored = await factory.query<{
      signup: string;
      cutoff: string;
      priority: string;
      roster: string;
    }>(
      `select default_signup_closes_before::text as signup,
              default_cancellation_cutoff_before::text as cutoff,
              default_priority_window::text as priority,
              default_roster_publish_before::text as roster
         from public.leagues where slug = $1`,
      [slug],
    );
    expect(stored[0]).toEqual({
      signup: '12:00:00',
      cutoff: '30:00:00',
      priority: '06:00:00',
      roster: '04:00:00',
    });

    await page.goto(`/leagues/${slug}/settings`);
    await page.waitForLoadState('networkidle');
    expect(await valueOf(page, 'Signup closes')).toBe('12');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('30');
    expect(await valueOf(page, 'Priority window')).toBe('6');
    expect(await valueOf(page, 'Roster publish target')).toBe('4');

    // ── 3. Create Match starts from them ───────────────────────────────────
    await page.goto(`/leagues/${slug}/matches/new`);
    await page.waitForLoadState('networkidle');
    expect(await valueOf(page, 'Signup closes')).toBe('12');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('30');
    expect(await valueOf(page, 'Priority window')).toBe('6');
    expect(await valueOf(page, 'Roster published')).toBe('4');
    await expect(page.getByText('Using your league defaults')).toBeVisible();

    // ── 4. Publishing resolves them against the kickoff ────────────────────
    const first = `Inherited ${Date.now().toString(36)}`;
    await fillMatchBasics(page, first);
    await page.getByRole('button', { name: 'Publish match' }).click();
    await page.waitForURL(/\/matches\/[0-9a-f-]{36}/);
    await expectNoServerError(page);

    const resolved = await factory.query<{
      signup_gap: string;
      cutoff_gap: string;
      roster_gap: string;
      priority: string | null;
    }>(
      `select extract(epoch from (kickoff_at - signup_closes_at))/3600 || '' as signup_gap,
              extract(epoch from (kickoff_at - cancellation_cutoff_at))/3600 || '' as cutoff_gap,
              extract(epoch from (kickoff_at - roster_publish_target_at))/3600 || '' as roster_gap,
              priority_window::text as priority
         from public.matches where title = $1`,
      [first],
    );
    // Measured back from kickoff, which is the only thing these durations mean.
    expect(Number(resolved[0]?.signup_gap)).toBe(12);
    expect(Number(resolved[0]?.cutoff_gap)).toBe(30);
    expect(Number(resolved[0]?.roster_gap)).toBe(4);
    expect(resolved[0]?.priority).toBe('06:00:00');

    // ── 5. Change the league defaults ──────────────────────────────────────
    await page.goto(`/leagues/${slug}/settings`);
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Signup closes').fill('3');
    await page.getByLabel('Cancellation cutoff').fill('9');
    await page.getByLabel('Priority window').fill('');
    await page.getByLabel('Roster publish target').fill('');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('League settings saved.')).toBeVisible();

    // ── 6. The existing match did not move ─────────────────────────────────
    const unchanged = await factory.query<{ signup_gap: string; priority: string | null }>(
      `select extract(epoch from (kickoff_at - signup_closes_at))/3600 || '' as signup_gap,
              priority_window::text as priority
         from public.matches where title = $1`,
      [first],
    );
    expect(Number(unchanged[0]?.signup_gap)).toBe(12);
    expect(unchanged[0]?.priority).toBe('06:00:00');

    // ── 7. A new match uses the new defaults, including the cleared ones ───
    await page.goto(`/leagues/${slug}/matches/new`);
    await page.waitForLoadState('networkidle');
    expect(await valueOf(page, 'Signup closes')).toBe('3');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('9');
    // Blank, not zero: the league no longer uses these at all.
    expect(await valueOf(page, 'Priority window')).toBe('');
    expect(await valueOf(page, 'Roster published')).toBe('');

    const second = `Updated ${Date.now().toString(36)}`;
    await fillMatchBasics(page, second);
    await page.getByRole('button', { name: 'Publish match' }).click();
    await page.waitForURL(/\/matches\/[0-9a-f-]{36}/);

    const latest = await factory.query<{
      signup_gap: string;
      priority: string | null;
      roster: string | null;
    }>(
      `select extract(epoch from (kickoff_at - signup_closes_at))/3600 || '' as signup_gap,
              priority_window::text as priority,
              roster_publish_target_at::text as roster
         from public.matches where title = $1`,
      [second],
    );
    expect(Number(latest[0]?.signup_gap)).toBe(3);
    expect(latest[0]?.priority).toBeNull();
    expect(latest[0]?.roster).toBeNull();
  });

  test('a brand-new league starts at two and twenty-four hours', async ({ factory, asUser }) => {
    const organizer = await factory.createOutsider();
    const page = await asUser(organizer.email);

    await page.goto('/leagues/new');
    await page.waitForLoadState('networkidle');

    // The initial values a first-time organizer is shown, unchanged from what
    // the application used to hard-code — so nobody's league behaves
    // differently for having been created after this feature.
    expect(await valueOf(page, 'Signup closes')).toBe('2');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('24');
    expect(await valueOf(page, 'Priority window')).toBe('');
    expect(await valueOf(page, 'Roster publish target')).toBe('');

    await expect(
      page.getByText(/MatchDay does not automatically publish the roster/),
    ).toBeVisible();
  });
});

test.describe('templates still win', () => {
  test('a new template starts from the league, then owns its own values', async ({
    factory,
    asUser,
  }) => {
    test.setTimeout(120_000);
    const organizer = await factory.createOutsider();
    const page = await asUser(organizer.email);

    const slug = await createLeague(page, `Templated ${Date.now().toString(36)}`, {
      signup: '12',
      cutoff: '30',
      priority: '6',
      roster: '4',
    });

    // ── The template form inherits the league's policy ─────────────────────
    await page.goto(`/leagues/${slug}/templates`);
    await page.waitForLoadState('networkidle');
    expect(await valueOf(page, 'Signup closes')).toBe('12');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('30');
    expect(await valueOf(page, 'Priority window')).toBe('6');
    expect(await valueOf(page, 'Roster published')).toBe('4');

    // ── Saved with its own values, including a deliberate blank ────────────
    const templateName = `Cup night ${Date.now().toString(36)}`;
    await page.getByLabel('Template name').fill(templateName);
    await page.getByLabel('Arrive').fill('17:30');
    await page.getByLabel('Kickoff').fill('18:00');
    await page.getByLabel('Ends').fill('19:30');
    await page.getByLabel('Location').fill('Cup Pitch');
    await page.getByLabel('Capacity').fill('10');
    await page.getByLabel('Signup closes').fill('1');
    await page.getByLabel('Cancellation cutoff').fill('2');
    // Cleared on purpose: this kind of match has no priority window.
    await page.getByLabel('Priority window').fill('');
    await page.getByRole('button', { name: /Save template|Create template/ }).first().click();
    await expect(page.getByText('Template saved.')).toBeVisible();

    // ── Changing the league afterwards does not touch the template ─────────
    await page.goto(`/leagues/${slug}/settings`);
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Signup closes').fill('20');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('League settings saved.')).toBeVisible();

    const template = await factory.query<{ signup: string; priority: string | null }>(
      `select signup_closes_before::text as signup, priority_window::text as priority
         from public.match_templates where name = $1`,
      [templateName],
    );
    expect(template[0]?.signup).toBe('01:00:00');
    expect(template[0]?.priority).toBeNull();

    // ── Selecting it overrides the league, nulls included ──────────────────
    await page.goto(`/leagues/${slug}/matches/new`);
    await page.waitForLoadState('networkidle');
    // League first.
    expect(await valueOf(page, 'Signup closes')).toBe('20');
    expect(await valueOf(page, 'Priority window')).toBe('6');

    await page.getByLabel('Start from a template').selectOption({ label: templateName });
    await expect(page.getByText(`Using defaults from ${templateName}`)).toBeVisible();

    expect(await valueOf(page, 'Signup closes')).toBe('1');
    expect(await valueOf(page, 'Cancellation cutoff')).toBe('2');
    // THE ASSERTION THIS FEATURE TURNS ON. The template says "no priority
    // window"; a field-level `??` would have put the league's 6 back.
    expect(await valueOf(page, 'Priority window')).toBe('');

    const title = `From template ${Date.now().toString(36)}`;
    await page.getByLabel('Match title').fill(title);
    await page.getByLabel('Date').fill(FUTURE_DATE);
    await page.getByRole('button', { name: 'Publish match' }).click();
    await page.waitForURL(/\/matches\/[0-9a-f-]{36}/);
    await expectNoServerError(page);

    const created = await factory.query<{ signup_gap: string; priority: string | null }>(
      `select extract(epoch from (kickoff_at - signup_closes_at))/3600 || '' as signup_gap,
              priority_window::text as priority
         from public.matches where title = $1`,
      [title],
    );
    expect(Number(created[0]?.signup_gap)).toBe(1);
    expect(created[0]?.priority).toBeNull();
  });
});
