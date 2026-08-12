import type { Page } from '@playwright/test';
import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';
import type { TestDataFactory, TestLeague, TestMatch, TestUser } from '../support/factory';

/**
 * Phase 6 — the team builder, publication and the player team view.
 *
 * Parallel-safe: every test builds its own league, members, match and teams.
 */

/** Seats `count` members and returns them, ready to be put on teams. */
async function seatPlayers(
  factory: TestDataFactory,
  league: TestLeague,
  match: TestMatch,
  count: number,
): Promise<TestUser[]> {
  const players: TestUser[] = [];
  for (let index = 0; index < count; index += 1) {
    const player = await factory.createMember(league);
    await factory.joinMatch(match, player);
    players.push(player);
  }
  return players;
}

async function teamRevision(factory: TestDataFactory, matchId: string): Promise<number> {
  const rows = await factory.query<{ revision: number }>(
    'select team_revision as revision from public.matches where id = $1',
    [matchId],
  );
  return rows[0]?.revision ?? 0;
}

async function assignedCount(factory: TestDataFactory, matchId: string): Promise<number> {
  const rows = await factory.query<{ count: string }>(
    'select count(*)::text as count from public.match_team_assignments where match_id = $1',
    [matchId],
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * The assignment row for one player.
 *
 * Located through the select's own accessible label rather than by the name
 * text: once somebody is assigned their name also appears inside the team card,
 * and a plain text match finds that list item instead — which has no control on
 * it.
 */
function assignmentRow(page: Page, player: TestUser) {
  return page
    .locator('li')
    .filter({ has: page.getByLabel(`Team for ${player.firstName} Tester`) })
    .first();
}

test.describe('the team builder', () => {
  test('initialises the configured teams, then adds, renames and labels one', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    await seatPlayers(factory, league, match, 2);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);

    // Nothing is created by merely looking at the page.
    await expect(page.getByRole('button', { name: 'Set up teams' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up teams' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.match_teams where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('2');

    await page.reload();
    await expect(page.getByRole('heading', { name: /Team 1/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Team 2/ })).toBeVisible();

    // A third team, for a three-team match.
    await page.getByRole('button', { name: 'Add a team' }).click();
    await expect.poll(async () => {
      const rows = await factory.query<{ count: string }>(
        'select count(*)::text as count from public.match_teams where match_id = $1',
        [match.id],
      );
      return rows[0]?.count;
    }).toBe('3');

    await page.reload();
    await page.getByRole('button', { name: 'Rename' }).first().click();
    await page.getByLabel('Team name').first().fill('The Bibs');
    await page.getByLabel('Shirt or colour').first().fill('Yellow');
    await page.getByRole('button', { name: 'Save team' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ name: string }>(
          `select name from public.match_teams where match_id = $1 and name = 'The Bibs'`,
          [match.id],
        );
        return rows.length;
      })
      .toBe(1);
  });

  test('assigns, moves and unassigns a player', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = await seatPlayers(factory, league, match, 2);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);

    const teams = await factory.query<{ id: string; name: string }>(
      'select id, name from public.match_teams where match_id = $1 order by display_order',
      [match.id],
    );

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);

    const row = assignmentRow(page, players[0]!);
    await row.getByRole('combobox').selectOption(teams[0]!.id);
    await row.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => assignedCount(factory, match.id)).toBe(1);

    // Moving is the same control with a different team — the unique constraint
    // is what makes it a move rather than a second assignment.
    await page.reload();
    const moved = assignmentRow(page, players[0]!);
    await moved.getByRole('combobox').selectOption(teams[1]!.id);
    await moved.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ team_id: string }>(
          'select team_id from public.match_team_assignments where match_id = $1',
          [match.id],
        );
        return rows[0]?.team_id;
      })
      .toBe(teams[1]!.id);
    expect(await assignedCount(factory, match.id)).toBe(1);

    // And unassigning is the empty option.
    await page.reload();
    const unassign = assignmentRow(page, players[0]!);
    await unassign.getByRole('combobox').selectOption('');
    await unassign.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => assignedCount(factory, match.id)).toBe(0);
  });

  test('randomizes by count, and says so rather than claiming balance', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 12 });
    await seatPlayers(factory, league, match, 7);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);

    // The wording is a product requirement, not decoration: 04 §3 settled that
    // randomization is equal-size only and must not be presented as balanced.
    await expect(page.getByRole('button', { name: 'Randomize teams' })).toBeVisible();
    await expect(page.getByRole('button', { name: /balance/i })).toHaveCount(0);
    await expect(page.getByText(/does not consider position, goalkeeper/i)).toBeVisible();

    await page.getByRole('button', { name: 'Randomize teams' }).click();
    await expect.poll(() => assignedCount(factory, match.id)).toBe(7);

    const sizes = await factory.query<{ size: string }>(
      `select count(a.id)::text as size from public.match_teams t
         left join public.match_team_assignments a on a.team_id = t.id
        where t.match_id = $1 group by t.id`,
      [match.id],
    );
    const counts = sizes.map((row) => Number(row.size));
    // The invariant is the shape, never a particular arrangement.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((total, size) => total + size, 0)).toBe(7);
  });

  test('works with three teams end to end', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 12 });
    const players = await seatPlayers(factory, league, match, 6);
    await factory.query('update public.matches set team_count = 3 where id = $1', [match.id]);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await page.getByRole('button', { name: 'Set up teams' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.match_teams where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('3');

    await page.reload();
    await page.getByRole('button', { name: 'Randomize teams' }).click();
    await expect.poll(() => assignedCount(factory, match.id)).toBe(6);

    await page.reload();
    await page.getByRole('button', { name: 'Publish teams' }).click();
    await expect.poll(() => teamRevision(factory, match.id)).toBe(1);

    // A confirmed player sees all three.
    const playerPage = await asUser(players[0]!.email);
    await playerPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(playerPage.getByText('(your team)')).toBeVisible();
    for (const name of ['Team 1', 'Team 2', 'Team 3']) {
      await expect(playerPage.getByText(name, { exact: false }).first()).toBeVisible();
    }
  });
});

test.describe('publication', () => {
  test('refuses while a confirmed player has no team', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    await seatPlayers(factory, league, match, 3);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);

    await expect(page.getByText(/still need a team before you can publish/)).toBeVisible();
    await page.getByRole('button', { name: 'Publish teams' }).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoServerError(page);
    expect(await teamRevision(factory, match.id)).toBe(0);
  });

  test('publishes, shows the player their team, and notifies once', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = await seatPlayers(factory, league, match, 4);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);

    // Before publication the player is told nothing about teams.
    const playerPage = await asUser(players[0]!.email);
    await playerPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(playerPage.getByText('Teams have not been published yet.')).toBeVisible();
    await expect(playerPage.getByText('(your team)')).toHaveCount(0);

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await adminPage.getByRole('button', { name: 'Publish teams' }).click();
    await expect.poll(() => teamRevision(factory, match.id)).toBe(1);

    await playerPage.reload();
    // Scoped to the teams section: the confirmed roster above also marks the
    // caller with "(you)", so an unscoped match is ambiguous.
    const teamsSection = playerPage
      .locator('section')
      .filter({ has: playerPage.getByRole('heading', { name: 'Teams' }) });
    await expect(teamsSection.getByText('(your team)')).toBeVisible();
    await expect(teamsSection.getByText('(you)')).toBeVisible();

    await playerPage.goto('/notifications');
    await expect(playerPage.getByText(/Teams are up:/)).toBeVisible();

    // Publishing again with an unchanged draft announces nothing new.
    await adminPage.reload();
    await adminPage.getByRole('button', { name: 'Publish updated teams' }).click();
    await adminPage.waitForTimeout(600);

    expect(await teamRevision(factory, match.id)).toBe(1);
    const notifications = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type in ('teams_published', 'teams_changed')`,
      [match.id],
    );
    expect(notifications[0]?.count).toBe('4');
  });

  test('a draft edit stays private until the administrator republishes', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = await seatPlayers(factory, league, match, 4);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    const playerPage = await asUser(players[0]!.email);
    await playerPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    const publishedTeam = await playerPage
      .locator('div', { hasText: '(your team)' })
      .first()
      .innerText();

    // The administrator moves everybody onto one team in the draft.
    const teams = await factory.query<{ id: string }>(
      'select id from public.match_teams where match_id = $1 order by display_order',
      [match.id],
    );
    for (const player of players) {
      await factory.callAs(league.admin, 'select public.assign_player_to_team($1, $2)', [
        teams[0]!.id,
        player.membershipId,
      ]);
    }

    // The player still sees revision 1. The publication boundary is the
    // communication boundary.
    await playerPage.reload();
    const afterEdit = await playerPage
      .locator('div', { hasText: '(your team)' })
      .first()
      .innerText();
    expect(afterEdit).toBe(publishedTeam);
    expect(await teamRevision(factory, match.id)).toBe(1);

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await adminPage.getByRole('button', { name: 'Publish updated teams' }).click();
    await expect.poll(() => teamRevision(factory, match.id)).toBe(2);

    await playerPage.goto('/notifications');
    await expect(playerPage.getByText(/Teams changed:/)).toBeVisible();

    const changed = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type = 'teams_changed'`,
      [match.id],
    );
    expect(changed[0]?.count).toBe('4');
  });
});

test.describe('cancellation after publication', () => {
  test('drops the canceled player and leaves the replacement unassigned', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ waitlistMode: 'automatic' });
    const match = await factory.createMatch(league, { capacity: 4, waitlistMode: 'automatic' });
    const players = await seatPlayers(factory, league, match, 4);
    const waiting = await factory.createMember(league);
    await factory.joinMatch(match, waiting);

    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    // A confirmed, assigned player cancels.
    const leaver = await asUser(players[0]!.email);
    await leaver.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await leaver.getByRole('button', { name: 'Cancel my spot' }).click();
    await leaver.getByRole('button', { name: 'Yes, cancel my spot' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ status: string }>(
          `select status::text from public.match_signups
            where match_id = $1 and membership_id = $2`,
          [match.id, players[0]!.membershipId],
        );
        return rows[0]?.status;
      })
      .toBe('canceled');

    // They lose access to the team view entirely.
    await leaver.reload();
    await expect(leaver.getByText('(your team)')).toHaveCount(0);

    // And the remaining players no longer see them on a team.
    const stayed = await asUser(players[1]!.email);
    await stayed.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(stayed.getByText('(your team)')).toBeVisible();
    await expect(stayed.locator('body')).not.toContainText(`${players[0]!.firstName} Tester`);

    // The withdrawal is itself a change to the published teams, so it has its
    // own revision and the players still involved were told once.
    expect(await teamRevision(factory, match.id)).toBe(2);
    await stayed.goto('/notifications');
    await expect(stayed.getByText(/Teams changed:/)).toBeVisible();

    // The promoted replacement is confirmed but deliberately unassigned.
    const promotedPage = await asUser(waiting.email);
    await promotedPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(promotedPage.getByText('You have not been assigned to a team yet.')).toBeVisible();

    // The builder shows the gap, and refuses to republish until it is filled.
    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await expect(adminPage.getByText(/1 player still need/)).toBeVisible();

    const teams = await factory.query<{ id: string }>(
      'select id from public.match_teams where match_id = $1 order by display_order',
      [match.id],
    );
    const row = assignmentRow(adminPage, waiting);
    await row.getByRole('combobox').selectOption(teams[0]!.id);
    await row.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => assignedCount(factory, match.id)).toBe(4);

    await adminPage.reload();
    await adminPage.getByRole('button', { name: 'Publish updated teams' }).click();
    // Revision 2 was the withdrawal; this republication is revision 3.
    await expect.poll(() => teamRevision(factory, match.id)).toBe(3);

    await promotedPage.reload();
    await expect(promotedPage.getByText('(your team)')).toBeVisible();
  });
});

test.describe('privacy', () => {
  test('a player cannot open the team builder', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await expectRedirectedTo(
      page,
      `/leagues/${league.slug}/matches/${match.id}/teams`,
      '/dashboard',
    );
  });

  test('a cross-league administrator cannot open it either', async ({ factory, asUser }) => {
    const mine = await factory.createLeague();
    const theirs = await factory.createLeague();
    const match = await factory.createMatch(theirs, { capacity: 4 });

    const page = await asUser(mine.admin.email);
    await expectRedirectedTo(
      page,
      `/leagues/${theirs.slug}/matches/${match.id}/teams`,
      '/dashboard',
    );
  });

  test('a waitlisted player sees no teams, published or not', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ waitlistMode: 'admin_controlled' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'admin_controlled',
    });
    const seated = await seatPlayers(factory, league, match, 2);
    const queued = await factory.createMember(league);
    await factory.joinMatch(match, queued);

    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    const page = await asUser(queued.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByText('Waitlisted — position 1')).toBeVisible();

    // The teams section is absent entirely, not merely empty — the projection
    // returns a non-confirmed player nothing at all.
    await expect(page.getByRole('heading', { name: 'Teams' })).toHaveCount(0);
    await expect(page.getByText('(your team)')).toHaveCount(0);

    // They do still see the confirmed *roster*, which 02 §12 makes
    // member-visible. What they must not learn is who is on which team.
    await expect(page.getByText(`${seated[0]!.firstName} Tester`).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Team 1');
  });

  test('the player team view carries none of the builder’s indicators', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ genderFieldEnabled: true });
    const match = await factory.createMatch(league, { capacity: 4 });
    const players = await seatPlayers(factory, league, match, 2);

    await factory.query(
      `update public.profiles
          set gender = 'PRIVATE-GENDER', preferred_positions = array['Striker'],
              phone = '+15550002222'
        where id = $1`,
      [players[1]!.id],
    );

    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    // The administrator may use the permitted indicators while choosing.
    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await expect(adminPage.getByText('Striker').first()).toBeVisible();

    // The player's team view has none of it.
    const playerPage = await asUser(players[0]!.email);
    await playerPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(playerPage.getByText('(your team)')).toBeVisible();

    const body = playerPage.locator('body');
    await expect(body).not.toContainText('PRIVATE-GENDER');
    await expect(body).not.toContainText('Striker');
    await expect(body).not.toContainText('+15550002222');
  });
});
