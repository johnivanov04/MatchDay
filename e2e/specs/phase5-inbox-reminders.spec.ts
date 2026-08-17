import { execFileSync } from 'node:child_process';
import { expect, expectNoServerError, test } from '../support/fixtures';
import { readSupabaseEnvironment } from '../support/environment';
import type { TestDataFactory, TestLeague, TestUser } from '../support/factory';

/**
 * Phase 5 — the notification centre, reminders and the Web Push surface.
 *
 * Parallel-safe. The reminder tests each create their own match and their own
 * reminder occurrence, and the generator claims by row, so two of them running
 * at once cannot take each other's work.
 */

/** Gives `user` one unread notification to act on. */
async function seedNotification(
  factory: TestDataFactory,
  league: TestLeague,
  user: TestUser,
  title = 'A match to notice',
): Promise<string> {
  const rows = await factory.query<{ id: string }>(
    `insert into public.notifications
       (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
     values ($1, $2, 'match_published', $3, 'Tonight at the usual place', '/dashboard', $4)
     returning id`,
    [user.id, league.id, title, `e2e-inbox-${crypto.randomUUID()}`],
  );
  return rows[0]!.id;
}

test.describe('notification inbox', () => {
  test('marks read, marks unread again, and the badge follows', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    await seedNotification(factory, league, member);

    const page = await asUser(member.email);
    await page.goto('/notifications');

    await expect(page.getByText('1 unread notification.')).toBeVisible();

    await page.getByRole('button', { name: 'Mark as read' }).click();
    await expect(page.getByText('You are all caught up.')).toBeVisible();

    await page.getByRole('button', { name: 'Mark as unread' }).click();
    await expect(page.getByText('1 unread notification.')).toBeVisible();
  });

  test('archiving removes it from the inbox and from the unread count', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const id = await seedNotification(factory, league, member, 'Archive me');

    const page = await asUser(member.email);
    await page.goto('/notifications');
    await expect(page.getByText('Archive me')).toBeVisible();

    await page.getByRole('button', { name: 'Archive' }).click();

    await expect(page.getByText('Archive me')).toHaveCount(0);
    await expect(page.getByText('You are all caught up.')).toBeVisible();

    // Nothing was deleted, and the read state was left alone — "I am done with
    // this" is not the claim "I read this".
    const rows = await factory.query<{ archived: string | null; read: string | null }>(
      `select archived_at::text as archived, read_at::text as read
         from public.notifications where id = $1`,
      [id],
    );
    expect(rows[0]?.archived).not.toBeNull();
    expect(rows[0]?.read).toBeNull();
  });

  test('a deep link opens the authorized target', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await adminPage.getByRole('button', { name: 'Publish to members' }).click();
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
    // A button rather than a link since opening also marks the notification
    // read — one action, one submission. See `openNotificationAction`.
    await page.getByRole('button', { name: 'Open' }).first().click();

    await expect(page).toHaveURL(new RegExp(`/matches/${match.id}`));
    await expect(page.getByRole('heading', { name: match.title })).toBeVisible();
  });

  test('losing membership closes an old deep link, cleanly', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league);
    await seedNotification(factory, league, member);

    // Removed after the notification was created — the case a deep link must
    // re-authorize rather than trust.
    await factory.query(
      `update public.league_memberships set status = 'removed' where id = $1`,
      [member.membershipId],
    );

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page).toHaveURL(/\/dashboard/);
    await expectNoServerError(page);
  });

  test('one member cannot act on another member’s notification', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const owner = await factory.createMember(league);
    const stranger = await factory.createMember(league);
    const id = await seedNotification(factory, league, owner, 'Private to the owner');

    const page = await asUser(stranger.email);
    await page.goto('/notifications');

    // It is not even listed: the policy scopes rows to their recipient.
    await expect(page.getByText('Private to the owner')).toHaveCount(0);

    // And the mutation is refused at the database, so a forged request changes
    // nothing.
    await expect(
      factory.callAs(stranger, 'select public.archive_notification($1)', [id]),
    ).rejects.toThrow(/NOTIFICATION_NOT_FOUND/);

    const rows = await factory.query<{ archived: string | null }>(
      'select archived_at::text as archived from public.notifications where id = $1',
      [id],
    );
    expect(rows[0]?.archived).toBeNull();
  });
});

test.describe('reminders', () => {
  /** Runs the documented operation a production scheduler invokes. */
  function runReminderGenerator(): string {
    const { apiUrl, serviceRoleKey } = readSupabaseEnvironment();
    return execFileSync('node', ['scripts/run-due-reminders.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: apiUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      },
    });
  }

  test('a due reminder arrives exactly once, however often the generator runs', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const playing = await factory.createMember(league);
    await factory.joinMatch(match, playing);
    await factory.createDueReminder(match);

    runReminderGenerator();

    const page = await asUser(playing.email);
    await page.goto('/notifications');
    await expect(page.getByText(match.title).first()).toBeVisible();

    const countReminders = async () => {
      const rows = await factory.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'reminder'`,
        [match.id],
      );
      return rows[0]?.count;
    };
    expect(await countReminders()).toBe('1');

    // Running again cannot produce a second reminder for this match: the
    // occurrence is already claimed, and the idempotency key would refuse a
    // duplicate anyway.
    //
    // Asserted per match rather than on the generator's own total, because the
    // generator is global by design — a parallel test's reminder may legitimately
    // be in the same batch.
    runReminderGenerator();
    runReminderGenerator();
    expect(await countReminders()).toBe('1');

    const claims = await factory.query<{ generated: string | null; notified: number }>(
      `select generated_at::text as generated, notified_count as notified
         from public.match_reminders where match_id = $1`,
      [match.id],
    );
    expect(claims[0]?.generated).not.toBeNull();
    expect(claims[0]?.notified).toBe(1);

    await page.reload();
    await expect(page.getByText(match.title).first()).toBeVisible();
  });

  test('a canceled match sends no reminder', async ({ factory }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const playing = await factory.createMember(league);
    await factory.joinMatch(match, playing);
    await factory.createDueReminder(match);

    await factory.callAs(league.admin, 'select public.cancel_match($1)', [match.id]);

    runReminderGenerator();

    const rows = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type = 'reminder'`,
      [match.id],
    );
    // Members were told it was canceled; reminding them to turn up would be
    // worse than silence.
    expect(rows[0]?.count).toBe('0');
  });

  test('a member who is not playing gets no reminder', async ({ factory }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const playing = await factory.createMember(league);
    const notPlaying = await factory.createMember(league);
    await factory.joinMatch(match, playing);
    await factory.createDueReminder(match);

    runReminderGenerator();

    const rows = await factory.query<{ recipient_user_id: string }>(
      `select recipient_user_id from public.notifications
        where match_id = $1 and type = 'reminder'`,
      [match.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient_user_id).toBe(playing.id);
    expect(rows.map((row) => row.recipient_user_id)).not.toContain(notPlaying.id);
  });

  test('the cron route refuses a caller without the shared secret', async ({ request }) => {
    // No CRON_SECRET is configured for the E2E server, so the route does not
    // exist at all — the safe default, since an unprotected trigger would let
    // anybody flush a league's reminders early.
    //
    // Both verbs, because Vercel Cron issues GET while the documented curl and
    // the local script use POST. The authorized path needs a configured secret
    // and is proved in `tests/unit/cron-reminders-route.test.ts`.
    for (const response of [
      await request.post('/api/cron/reminders'),
      await request.get('/api/cron/reminders'),
    ]) {
      expect([401, 404]).toContain(response.status());
    }
  });

  test('a wrong shared secret is refused exactly like no secret at all', async ({ request }) => {
    const wrong = await request.get('/api/cron/reminders', {
      headers: { authorization: 'Bearer not-the-configured-secret' },
    });
    const none = await request.get('/api/cron/reminders');

    // Identical, so the endpoint cannot be probed for existence.
    expect(wrong.status()).toBe(none.status());
  });
});

test.describe('health check', () => {
  test('reports the database as reachable using only the anonymous key', async ({ request }) => {
    // THE TEST THAT WOULD HAVE CAUGHT THE PRODUCTION DEFECT.
    //
    // The route probed the `leagues` base table, which `anon` holds no grant
    // on, so PostgREST refused it with a 401 and every production health check
    // reported a healthy database as unreachable. Nothing exercised the route,
    // so nothing noticed.
    //
    // This runs against the real Next.js server, the real Supabase stack and
    // the real anonymous key, so it exercises the grant rather than a mock of
    // it. If the probe is ever pointed back at a table `anon` cannot read, this
    // fails with a 503.
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  test('is never cached', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.headers()['cache-control']).toBe('no-store, max-age=0');
  });

  test('reveals nothing beyond the two contract fields', async ({ request }) => {
    const body = (await (await request.get('/api/health')).json()) as Record<string, unknown>;

    // Unauthenticated, so anything it returns is public.
    expect(Object.keys(body).sort()).toEqual(['database', 'status']);
  });
});

test.describe('Web Push surface', () => {
  test('the manifest and the service worker are served', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);
    const body = (await manifest.json()) as { name?: string; icons?: unknown[] };
    expect(body.name).toBeTruthy();

    const worker = await request.get('/sw.js');
    expect(worker.ok()).toBe(true);
  });

  test('permission is never requested on page load', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    // Instrument before navigating, so a request during load would be caught.
    await page.addInitScript(() => {
      (window as unknown as { __permissionAsked: boolean }).__permissionAsked = false;
      if ('Notification' in window) {
        const original = Notification.requestPermission.bind(Notification);
        Notification.requestPermission = async (...args: unknown[]) => {
          (window as unknown as { __permissionAsked: boolean }).__permissionAsked = true;
          return original(...(args as []));
        };
      }
    });

    await page.goto('/settings/devices');
    await expect(page.getByRole('heading', { name: 'Phone notifications' })).toBeVisible();

    const asked = await page.evaluate(
      () => (window as unknown as { __permissionAsked: boolean }).__permissionAsked,
    );
    // The prompt belongs to a deliberate press, not to arriving on a page.
    expect(asked).toBe(false);
  });

  test('an unsupported or blocked browser degrades to an explanation', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/settings/devices');
    await expectNoServerError(page);

    // Whatever the browser supports, the page must say what happens and never
    // promise delivery it cannot make.
    await expect(page.locator('body')).toContainText(/alerts|notification/i);
  });
});
