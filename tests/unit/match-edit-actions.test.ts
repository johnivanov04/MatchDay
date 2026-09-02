import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three match-editing server actions, at the boundary the database does not
 * cover.
 *
 * What is asserted here is the shape of each outcome rather than the edit
 * itself: that a success navigates instead of returning, that a *committed*
 * edit is never turned back into a failure by a push that did not go out, and
 * that a refusal from the database is reported as a refusal rather than as a
 * form validation problem.
 */

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly path: string) {
      super(`NEXT_REDIRECT;${path}`);
      this.name = 'RedirectSignal';
    }
  }

  return {
    RedirectSignal,
    redirect: vi.fn((path: string): never => {
      throw new RedirectSignal(path);
    }),
    revalidatePath: vi.fn(),
    requireLeagueAdmin: vi.fn(),
    rpc: vi.fn(),
    upsert: vi.fn(),
    del: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/authorization', () => ({
  requireLeagueAdmin: mocks.requireLeagueAdmin,
  getMyMemberships: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({
  // The real implementation rather than a stub: it is a pure function of the
  // profile, and a mock that always answered false would hide the very
  // redirect it gates.
  isProfileDeleting: (profile: { deletion_started_at?: string | null; deleted_at?: string | null }) =>
    (profile.deletion_started_at ?? null) !== null || (profile.deleted_at ?? null) !== null,
  requireSessionUser: vi.fn(async () => ({ id: 'user-1' })),
  getSessionUser: vi.fn(),
  getCurrentProfile: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    rpc: mocks.rpc,
    from: () => ({
      upsert: mocks.upsert,
      delete: () => ({ eq: () => ({ eq: mocks.del }) }),
    }),
  }),
}));

const { saveMatchAdminNotesAction, updateDraftMatchAction, updatePublishedMatchAction } =
  await import('@/server/actions/matches');

const LEAGUE_ID = '22222222-2222-4222-8222-000000000001';
const MATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const SLUG = 'rmvfc';
const DETAIL = `/leagues/${SLUG}/matches/${MATCH_ID}`;

function baseForm(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const fields: Record<string, string> = {
    league_id: LEAGUE_ID,
    match_id: MATCH_ID,
    league_slug: SLUG,
    title: 'Monday night 11v11',
    match_date: '2026-09-21',
    arrival_time: '18:30',
    kickoff_time: '19:00',
    end_time: '20:30',
    location_name: 'RMV Community Pitch',
    location_map_url: '',
    capacity: '22',
    min_players: '14',
    team_count: '2',
    selection_mode: 'admin_approval',
    waitlist_mode: 'admin_controlled',
    priority_window_hours: '24',
    signup_closes_before_hours: '6',
    cancellation_cutoff_before_hours: '19',
    roster_publish_before_hours: '8',
    public_notes: '',
    change_note: '',
    expected_revision: '3',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

type ActionUnderTest = (
  previous: null,
  formData: FormData,
) => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> } | undefined>;

/** Runs an action, reporting the redirect it performed instead of letting it escape. */
async function run(action: ActionUnderTest, formData: FormData) {
  try {
    const result = await action(null, formData);
    return { redirectedTo: null as string | null, result };
  } catch (error: unknown) {
    if (error instanceof mocks.RedirectSignal) {
      return { redirectedTo: error.path, result: null };
    }
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLeagueAdmin.mockResolvedValue({
    league: { id: LEAGUE_ID, slug: SLUG },
    membership: { user_id: 'user-1', role: 'league_admin', status: 'active' },
  });
  mocks.rpc.mockResolvedValue({ data: 4, error: null });
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.del.mockResolvedValue({ error: null });
});

describe('editing a draft', () => {
  it('redirects to the match with a success notice', async () => {
    const { redirectedTo } = await run(updateDraftMatchAction, baseForm());
    expect(redirectedTo).toBe(`${DETAIL}?notice=saved`);
  });

  it('revalidates before navigating, so the detail page renders fresh data', async () => {
    await run(updateDraftMatchAction, baseForm());

    const revalidateOrder = mocks.revalidatePath.mock.invocationCallOrder[0] ?? Infinity;
    const redirectOrder = mocks.redirect.mock.invocationCallOrder[0] ?? -Infinity;
    expect(revalidateOrder).toBeLessThan(redirectOrder);
  });

  it('goes through update_draft_match, not a direct table update', async () => {
    await run(updateDraftMatchAction, baseForm());

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0]?.[0]).toBe('update_draft_match');
  });

  it('sends the local wall-clock time, leaving the zone conversion to the database', async () => {
    await run(updateDraftMatchAction, baseForm());

    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_match_date: '2026-09-21',
      p_arrival_time: '18:30',
      p_kickoff_time: '19:00',
      p_end_time: '20:30',
    });
    // No instant, no offset, no browser timezone anywhere in the payload.
    expect(JSON.stringify(mocks.rpc.mock.calls[0]?.[1])).not.toContain('Z"');
  });

  it('notifies nobody', async () => {
    await run(updateDraftMatchAction, baseForm());
    // A draft has no members watching it. The RPC is the only call, and it
    // creates no notification — so there is nothing to enqueue either.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('returns field errors in the form rather than navigating', async () => {
    const { redirectedTo, result } = await run(
      updateDraftMatchAction,
      baseForm({ title: '', capacity: '0' }),
    );

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(Object.keys(result?.fieldErrors ?? {})).toEqual(
      expect.arrayContaining(['title', 'capacity']),
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('reports a database refusal as a refusal, not as a validation problem', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'NOT_LEAGUE_ADMIN: not the administrator of that league' },
    });

    const { redirectedTo, result } = await run(updateDraftMatchAction, baseForm());

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    // A field-level error would tell the administrator to fix the form, which
    // is not the problem and cannot fix it.
    expect(result?.fieldErrors ?? {}).toEqual({});
  });
});

describe('editing a published match', () => {
  it('redirects to the match with a success notice', async () => {
    const { redirectedTo } = await run(updatePublishedMatchAction, baseForm());
    expect(redirectedTo).toBe(`${DETAIL}?notice=saved`);
  });

  it('forwards the revision the form was rendered from', async () => {
    await run(updatePublishedMatchAction, baseForm({ expected_revision: '3' }));

    expect(mocks.rpc.mock.calls[0]?.[0]).toBe('update_published_match');
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_expected_revision: 3 });
  });

  it('sends no participation-policy fields, whatever the form contains', async () => {
    // Even a hand-crafted request carrying them cannot change the terms: the
    // action never reads them, and the function has no parameter for them.
    await run(
      updatePublishedMatchAction,
      baseForm({ selection_mode: 'first_come', waitlist_mode: 'automatic' }),
    );

    const payload = mocks.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    for (const forbidden of [
      'p_selection_mode',
      'p_waitlist_mode',
      'p_priority_window',
      'p_signup_closes_before',
      'p_cancellation_cutoff_before',
      'p_roster_publish_before',
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('returns without waiting on any push provider', async () => {
    // PHASE 3B. This action used to publish the edit and then sit in the
    // request talking to APNs and Web Push, once per device of every member of
    // the league. It now returns as soon as the database has committed; the
    // trigger enqueued a delivery job in that same transaction, and the worker
    // drains it.
    //
    // Asserted as "the RPC is the only thing awaited", because that is the
    // property an administrator actually feels — anything else added here would
    // be latency they pay for a copy of something already in their inbox.
    mocks.rpc.mockResolvedValue({ data: 4, error: null });

    const { redirectedTo, result } = await run(updatePublishedMatchAction, baseForm());

    expect(result).toBeNull();
    expect(redirectedTo).toBe(`${DETAIL}?notice=saved`);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('reports a stale revision with an actionable message', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'MATCH_REVISION_STALE: this match was changed by somebody else',
      },
    });

    const { redirectedTo, result } = await run(updatePublishedMatchAction, baseForm());

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('Reload');
  });

  it('returns field errors in the form rather than navigating', async () => {
    const { redirectedTo, result } = await run(
      updatePublishedMatchAction,
      baseForm({ end_time: '' }),
    );

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.fieldErrors).toHaveProperty('end_time');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('saving administrator notes', () => {
  it('redirects with a notice that says nobody was told', async () => {
    const { redirectedTo } = await run(saveMatchAdminNotesAction, baseForm({ notes: 'Private' }));
    expect(redirectedTo).toBe(`${DETAIL}?notice=notes-saved`);
  });

  it('writes to the admin-only table and never to the match row', async () => {
    await run(saveMatchAdminNotesAction, baseForm({ notes: 'Watch the ankle' }));

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({
      match_id: MATCH_ID,
      league_id: LEAGUE_ID,
      notes: 'Watch the ankle',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('records the author from the verified membership, never from the form', async () => {
    await run(
      saveMatchAdminNotesAction,
      baseForm({ notes: 'Private', updated_by: 'somebody-else' }),
    );

    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({ updated_by: 'user-1' });
  });

  it('deletes the row when the note is cleared', async () => {
    await run(saveMatchAdminNotesAction, baseForm({ notes: '   ' }));

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('notifies and pushes nobody', async () => {
    await run(saveMatchAdminNotesAction, baseForm({ notes: 'Private' }));
    // Notes are the administrator's private working memory. No RPC that
    // creates a notification runs, so nothing is enqueued for delivery.
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('refuses before touching anything when the caller is not the administrator', async () => {
    const { DomainError } = await import('@/lib/errors');
    mocks.requireLeagueAdmin.mockRejectedValue(new DomainError('NOT_LEAGUE_ADMIN'));

    const { redirectedTo, result } = await run(
      saveMatchAdminNotesAction,
      baseForm({ notes: 'Private' }),
    );

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('rejects a note longer than the column allows, in the form', async () => {
    const { redirectedTo, result } = await run(
      saveMatchAdminNotesAction,
      baseForm({ notes: 'x'.repeat(4001) }),
    );

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.fieldErrors).toHaveProperty('notes');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
