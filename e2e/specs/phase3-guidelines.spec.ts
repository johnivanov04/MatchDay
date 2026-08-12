import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';

/**
 * Phase 3 — versioned guidelines and acknowledgement.
 *
 * Parallel-safe: every test builds its own league, guidelines and members.
 */

test('a draft guideline is invisible to members until it is published', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);

  const adminPage = await asUser(league.admin.email);
  await adminPage.goto(`/leagues/${league.slug}/guidelines/manage`);

  const label = `draft-${Date.now().toString(36)}`;
  await adminPage.getByLabel('Version label').fill(label);
  await adminPage.getByLabel('Title').fill('House rules');
  await adminPage.getByLabel('Guidelines', { exact: true }).fill(
    'Turn up on time and tell the administrator if you cannot make it.',
  );
  await adminPage.getByRole('button', { name: 'Save draft' }).click();

  // The draft is stored immediately; the list reflects it on the next render.
  await expect
    .poll(async () => {
      const rows = await factory.query<{ count: string }>(
        `select count(*)::text as count from public.guideline_versions
          where league_id = $1 and version_label = $2`,
        [league.id, label],
      );
      return rows[0]?.count;
    })
    .toBe('1');
  await adminPage.reload();
  // A Publish control exists only for an unpublished version, so its presence
  // is the administrator-visible proof that the draft is there.
  await expect(adminPage.getByRole('button', { name: 'Publish' })).toHaveCount(1);

  // A draft has no published_at, so a member must not see it at all.
  const memberPage = await asUser(member.email);
  await memberPage.goto(`/leagues/${league.slug}/guidelines`);
  await expect(memberPage.locator('body')).not.toContainText('House rules');

  // Publishing makes it visible.
  await adminPage.getByRole('button', { name: 'Publish' }).first().click();
  await expect
    .poll(async () => {
      const rows = await factory.query<{ published: string | null }>(
        `select published_at::text as published from public.guideline_versions
          where league_id = $1 and version_label = $2`,
        [league.id, label],
      );
      return rows[0]?.published === null ? 'draft' : 'published';
    })
    .toBe('published');

  await memberPage.reload();
  await expect(memberPage.getByText('House rules').first()).toBeVisible();
});

test.describe('acceptance', () => {
  test('starts unticked, is refused without ticking, and then persists', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    await factory.publishRequiredGuideline(league);
    // `acceptsGuidelines: false` leaves them genuinely outstanding.
    const member = await factory.createMember(league, { acceptsGuidelines: false });

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/guidelines`);

    await expect(page.getByRole('heading', { name: 'Acceptance needed' })).toBeVisible();

    // 02 §8: acceptance is explicit and never prechecked.
    const checkbox = page.getByRole('checkbox');
    await expect(checkbox).not.toBeChecked();

    // Submitting without ticking must not silently create an acceptance.
    await page.getByRole('button', { name: 'Accept guidelines' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();

    const before = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.guideline_acceptances
        where membership_id = $1`,
      [member.membershipId],
    );
    expect(before[0]?.count).toBe('0');

    // A fresh form after the refusal: the failed attempt left an error state
    // rendered, and ticking the box in that tree is not what a person would do.
    await page.reload();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Accept guidelines' }).click();

    // The acknowledgement is stored immediately; the page reflects it on the
    // next render. Asserting after a reload also proves it persisted rather
    // than only changing on screen.
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          `select count(*)::text as count from public.guideline_acceptances
            where membership_id = $1`,
          [member.membershipId],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'You are up to date' })).toBeVisible();
  });

  test('a new required version blocks the same member again', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    await factory.publishRequiredGuideline(league, 'first');
    const member = await factory.createMember(league); // accepts the first version

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/guidelines`);
    await expect(page.getByRole('heading', { name: 'You are up to date' })).toBeVisible();

    // A newer required version supersedes it.
    await factory.publishRequiredGuideline(league, 'second');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Acceptance needed' })).toBeVisible();
  });

  test('is league-specific: eligible in one, blocked in another', async ({ factory, asUser }) => {
    // The tenancy property from 02 §8, and the reason the predicate takes a
    // league id rather than answering globally.
    const blocking = await factory.createLeague();
    const relaxed = await factory.createLeague();
    await factory.publishRequiredGuideline(blocking);

    const member = await factory.createMember(blocking, { acceptsGuidelines: false });
    await factory.query(
      `insert into public.league_memberships (league_id, user_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [relaxed.id, member.id],
    );

    const page = await asUser(member.email);

    await page.goto(`/leagues/${blocking.slug}/guidelines`);
    await expect(page.getByRole('heading', { name: 'Acceptance needed' })).toBeVisible();

    await page.goto(`/leagues/${relaxed.slug}/guidelines`);
    await expect(page.getByRole('heading', { name: 'Acceptance needed' })).toHaveCount(0);
  });
});

test('an administrator can see who has acknowledged', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  await factory.publishRequiredGuideline(league);
  const accepted = await factory.createMember(league);
  await factory.createMember(league, { acceptsGuidelines: false });

  const page = await asUser(league.admin.email);
  await page.goto(`/leagues/${league.slug}/guidelines/manage`);

  await expectNoServerError(page);
  // Reported as an aggregate — "N of M members have not yet accepted" — rather
  // than as a list of names. Who has not signed a document is exactly the kind
  // of per-person detail the administrator does not need spelled out to act.
  await expect(page.getByText(/members have not yet accepted/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(accepted.email);
});

test('a non-member cannot read a private league’s guidelines', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  await factory.publishRequiredGuideline(league);
  const outsider = await factory.createOutsider();

  const page = await asUser(outsider.email);
  await expectRedirectedTo(page, `/leagues/${league.slug}/guidelines`, '/dashboard');
});

test('a player cannot open the guideline management page', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);

  const page = await asUser(member.email);
  await expectRedirectedTo(page, `/leagues/${league.slug}/guidelines/manage`, '/dashboard');
});

test('a published version stays readable after a newer one supersedes it', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  await factory.publishRequiredGuideline(league, 'older');
  const member = await factory.createMember(league);
  await factory.publishRequiredGuideline(league, 'newer');

  const page = await asUser(member.email);
  await page.goto(`/leagues/${league.slug}/guidelines`);

  // History is immutable and stays visible: a member can still read what they
  // agreed to previously.
  await expect(page.locator('body')).toContainText('older');
  await expect(page.locator('body')).toContainText('newer');
});
