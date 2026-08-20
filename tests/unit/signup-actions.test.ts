import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Phase 4 server actions at the boundary the database cannot cover.
 *
 * What matters here is what the action *sends* and what it does with a failure
 * — not the signup logic, which lives in the database because two concurrent
 * requests run in two Node processes with no shared state and only PostgreSQL
 * can serialize them.
 *
 * The single most important assertion in this file is that no action forwards
 * an actor, a membership, a league or an eligibility flag on the player path.
 * If one ever did, a crafted request could sign somebody else up.
 */

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireLeagueAdmin: vi.fn(),
  rpc: vi.fn(),
  dispatchPushForKeyPrefix: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
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
vi.mock('@/lib/push/notify', () => ({
  dispatchPushForKeyPrefix: mocks.dispatchPushForKeyPrefix,
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ rpc: mocks.rpc }),
}));

const {
  addMemberToMatchAction,
  finalizeRosterAction,
  joinMatchAction,
  markUnavailableAction,
  reorderWaitlistAction,
  requestSpotAction,
  setSignupDecisionAction,
} = await import('@/server/actions/signups');

const LEAGUE_ID = '22222222-2222-4222-8222-000000000001';
const MATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const MEMBERSHIP_ID = '33333333-3333-4333-8333-000000000003';

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const entry of value) data.append(key, entry);
    } else {
      data.set(key, value);
    }
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLeagueAdmin.mockResolvedValue({
    league: { id: LEAGUE_ID },
    membership: { user_id: 'user-1', role: 'league_admin', status: 'active' },
  });
  mocks.rpc.mockResolvedValue({
    data: { status: 'confirmed', waitlist_position: null },
    error: null,
  });
  mocks.dispatchPushForKeyPrefix.mockResolvedValue(undefined);
});

describe('player signup actions', () => {
  it.each([
    ['joinMatchAction', joinMatchAction, 'join_match'],
    ['requestSpotAction', requestSpotAction, 'request_spot'],
    ['markUnavailableAction', markUnavailableAction, 'mark_unavailable'],
  ])('%s calls %s with the match id and nothing else', async (_name, action, rpcName) => {
    await action(null, form({ match_id: MATCH_ID }));

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0]?.[0]).toBe(rpcName);
    // The whole payload. A membership, a league, a user or a "priority"
    // flag appearing here would be a client-supplied trusted input.
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_match_id: MATCH_ID });
  });

  it('ignores extra fields a crafted request might add', async () => {
    await action_with_extras();

    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_match_id: MATCH_ID });

    async function action_with_extras() {
      return joinMatchAction(
        null,
        form({
          match_id: MATCH_ID,
          membership_id: MEMBERSHIP_ID,
          league_id: LEAGUE_ID,
          user_id: 'somebody-else',
          status: 'confirmed',
          priority_qualified: 'true',
        }),
      );
    }
  });

  it('returns the outcome the database decided', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'waitlisted', waitlist_position: 3 },
      error: null,
    });

    const result = await joinMatchAction(null, form({ match_id: MATCH_ID }));

    expect(result).toMatchObject({ ok: true, data: { status: 'waitlisted', waitlist_position: 3 } });
  });

  it('pushes the batch matching the outcome', async () => {
    await joinMatchAction(null, form({ match_id: MATCH_ID }));
    expect(mocks.dispatchPushForKeyPrefix).toHaveBeenCalledWith(`signup_confirmed:${MATCH_ID}`);

    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({
      data: { status: 'waitlisted', waitlist_position: 1 },
      error: null,
    });
    await joinMatchAction(null, form({ match_id: MATCH_ID }));
    expect(mocks.dispatchPushForKeyPrefix).toHaveBeenCalledWith(`waitlisted:${MATCH_ID}`);
  });

  it('pushes nothing for responses that notify nobody', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'not_available', waitlist_position: null },
      error: null,
    });
    await markUnavailableAction(null, form({ match_id: MATCH_ID }));
    expect(mocks.dispatchPushForKeyPrefix).not.toHaveBeenCalled();
  });

  it('still succeeds when Web Push fails outright', async () => {
    // The signup and its canonical notification are already committed. Losing
    // the push copy must not turn a real outcome into an error.
    mocks.dispatchPushForKeyPrefix.mockRejectedValue(new Error('push service unreachable'));

    const result = await joinMatchAction(null, form({ match_id: MATCH_ID }));

    expect(result?.ok).toBe(true);
  });

  it('reports a database refusal with its domain code', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'GUIDELINES_NOT_ACCEPTED: signup refused' },
    });

    const result = await joinMatchAction(null, form({ match_id: MATCH_ID }));

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('GUIDELINES_NOT_ACCEPTED');
      expect(result.message).toContain('guidelines');
    }
  });

  it('says plainly that cancelling a confirmed spot does not exist yet', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'SIGNUP_CANCELLATION_UNAVAILABLE: cancelling a confirmed spot is not implemented',
      },
    });

    const result = await markUnavailableAction(null, form({ match_id: MATCH_ID }));

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      // Not "something went wrong": the feature is absent, and saying so stops
      // a player retrying and assuming they are released.
      expect(result.message).toContain('not available yet');
    }
  });

  it('refuses a malformed match id before reaching the database', async () => {
    const result = await joinMatchAction(null, form({ match_id: 'not-a-uuid' }));

    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('administrator decisions', () => {
  it('sends the target membership and decision', async () => {
    await setSignupDecisionAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        status: 'confirmed',
        reason: 'Regular keeper',
      }),
    );

    expect(mocks.rpc.mock.calls[0]?.[0]).toBe('set_signup_decision');
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({
      p_match_id: MATCH_ID,
      p_membership_id: MEMBERSHIP_ID,
      p_status: 'confirmed',
      p_reason: 'Regular keeper',
    });
  });

  it('refuses a status that is not an administrator decision', async () => {
    for (const status of ['canceled', 'withdrawn_late', 'not_available', 'nonsense']) {
      vi.clearAllMocks();
      const result = await setSignupDecisionAction(
        null,
        form({
          league_id: LEAGUE_ID,
          match_id: MATCH_ID,
          membership_id: MEMBERSHIP_ID,
          status,
        }),
      );
      expect(result?.ok).toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  });

  it('checks administration before touching the database', async () => {
    const { DomainError } = await import('@/lib/errors');
    mocks.requireLeagueAdmin.mockRejectedValue(new DomainError('NOT_LEAGUE_ADMIN'));

    const result = await setSignupDecisionAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        status: 'confirmed',
      }),
    );

    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('sends the whole waitlist order', async () => {
    mocks.rpc.mockResolvedValue({ data: 3, error: null });
    const ids = [MEMBERSHIP_ID, '33333333-3333-4333-8333-000000000004'];

    await reorderWaitlistAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID, membership_ids: ids }),
    );

    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({
      p_match_id: MATCH_ID,
      p_membership_ids: ids,
    });
  });

  it('surfaces a stale reorder as a waitlist conflict', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'WAITLIST_CONFLICT: the ordering must list exactly' },
    });

    const result = await reorderWaitlistAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID, membership_ids: [MEMBERSHIP_ID] }),
    );

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('WAITLIST_CONFLICT');
    }
  });

  it('manually adds a member without any email or user id', async () => {
    await addMemberToMatchAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        status: 'waitlisted',
        override_reason: '',
      }),
    );

    const payload = mocks.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({
      p_match_id: MATCH_ID,
      p_membership_id: MEMBERSHIP_ID,
      p_status: 'waitlisted',
      p_override_reason: null,
    });
    // No route exists here to invite somebody into the league.
    expect(JSON.stringify(payload)).not.toContain('@');
  });

  it('refuses a manual add to any status other than confirmed or waitlisted', async () => {
    const result = await addMemberToMatchAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        status: 'interested',
      }),
    );
    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('attaches a closed-deadline refusal to the reason field', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'SIGNUP_CLOSED: signup has closed; supply a reason' },
    });

    const result = await addMemberToMatchAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        status: 'confirmed',
      }),
    );

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      // Shown against the field the administrator must fill in, not as a
      // generic banner.
      expect(result.fieldErrors).toHaveProperty('override_reason');
    }
  });

  it('pushes the roster batch keyed on the revision the database produced', async () => {
    mocks.rpc.mockResolvedValue({ data: 2, error: null });

    await finalizeRosterAction(null, form({ league_id: LEAGUE_ID, match_id: MATCH_ID }));

    expect(mocks.dispatchPushForKeyPrefix).toHaveBeenCalledWith(
      `roster_outcome:${MATCH_ID}:2`,
    );
  });

  it('publishes successfully even when Web Push fails', async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null });
    mocks.dispatchPushForKeyPrefix.mockRejectedValue(new Error('push down'));

    const result = await finalizeRosterAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID }),
    );

    expect(result).toMatchObject({ ok: true, data: 1 });
  });
});
