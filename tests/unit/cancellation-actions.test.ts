import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Phase 5 actions at the boundary the database cannot cover.
 *
 * The most important assertion here is negative: nothing a browser sends can
 * argue that a cancellation was on time. `cancelSpotAction` forwards a match id
 * and an optional reason, and nothing else — no timestamp, no classification,
 * no membership, no late flag.
 */

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireLeagueAdmin: vi.fn(),
  requireSessionUser: vi.fn(),
  rpc: vi.fn(),
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
  requireSessionUser: mocks.requireSessionUser,
  getSessionUser: vi.fn(),
  getCurrentProfile: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ rpc: mocks.rpc }),
}));

const { cancelSpotAction, promoteWaitlistedPlayerAction } = await import(
  '@/server/actions/signups'
);
const {
  archiveNotificationAction,
  markNotificationUnreadAction,
  unarchiveNotificationAction,
} = await import('@/server/actions/notifications');

const LEAGUE_ID = '22222222-2222-4222-8222-000000000001';
const MATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const MEMBERSHIP_ID = '33333333-3333-4333-8333-000000000003';
const NOTIFICATION_ID = '99999999-9999-4999-8999-000000000001';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSessionUser.mockResolvedValue({ id: 'user-1' });
  mocks.requireLeagueAdmin.mockResolvedValue({
    league: { id: LEAGUE_ID },
    membership: { user_id: 'user-1', role: 'league_admin', status: 'active' },
  });
  mocks.rpc.mockResolvedValue({
    data: { status: 'canceled', waitlist_position: null },
    error: null,
  });
});

describe('cancelling a spot', () => {
  it('sends only the match and the reason', async () => {
    await cancelSpotAction(null, form({ match_id: MATCH_ID, reason: 'Injured' }));

    expect(mocks.rpc.mock.calls[0]?.[0]).toBe('cancel_spot');
    // The whole payload. A timestamp, a late flag or a membership appearing
    // here would be a client-supplied trusted input.
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({
      p_match_id: MATCH_ID,
      p_reason: 'Injured',
    });
  });

  it('ignores anything else a crafted request adds', async () => {
    await cancelSpotAction(
      null,
      form({
        match_id: MATCH_ID,
        late: 'false',
        canceled_at: '2020-01-01T00:00:00Z',
        status: 'canceled',
        membership_id: MEMBERSHIP_ID,
        league_id: LEAGUE_ID,
      }),
    );

    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_match_id: MATCH_ID, p_reason: null });
  });

  it('normalises an empty reason to null', async () => {
    await cancelSpotAction(null, form({ match_id: MATCH_ID, reason: '   ' }));
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_reason: null });
  });

  it('returns the classification the database decided', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'withdrawn_late', waitlist_position: null },
      error: null,
    });

    const result = await cancelSpotAction(null, form({ match_id: MATCH_ID }));
    expect(result).toMatchObject({ ok: true, data: { status: 'withdrawn_late' } });
  });

  it('cancels on the RPC alone, with no provider round trip', async () => {
    // PHASE 3B. A late cancellation is the worst of the old inline paths: one
    // tap could fan out three separate batches — the promotion, the late
    // withdrawal alert, the replacement call — and the player who cancelled
    // waited for every device in all three before their screen came back.
    //
    // All three still happen. The database writes them and enqueues their
    // delivery jobs in the same transaction; the player no longer waits.
    const result = await cancelSpotAction(null, form({ match_id: MATCH_ID }));

    expect(result?.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('cancel_spot', expect.anything());
  });

  it('reports a refusal with its domain code', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'SIGNUP_DECISION_INVALID: only a confirmed spot or a waitlist place',
      },
    });

    const result = await cancelSpotAction(null, form({ match_id: MATCH_ID }));
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('SIGNUP_DECISION_INVALID');
    }
  });

  it('refuses a malformed match id before reaching the database', async () => {
    const result = await cancelSpotAction(null, form({ match_id: 'nope' }));
    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('administrator promotion', () => {
  beforeEach(() => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'confirmed', waitlist_position: null },
      error: null,
    });
  });

  it('sends nulls when no target or reason is chosen, so the database recommends', async () => {
    await promoteWaitlistedPlayerAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID }),
    );

    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({
      p_match_id: MATCH_ID,
      p_membership_id: null,
      p_reason: null,
    });
  });

  it('forwards an explicit target and its reason', async () => {
    await promoteWaitlistedPlayerAction(
      null,
      form({
        league_id: LEAGUE_ID,
        match_id: MATCH_ID,
        membership_id: MEMBERSHIP_ID,
        reason: 'Only keeper available',
      }),
    );

    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({
      p_match_id: MATCH_ID,
      p_membership_id: MEMBERSHIP_ID,
      p_reason: 'Only keeper available',
    });
  });

  it('checks administration before touching the database', async () => {
    const { DomainError } = await import('@/lib/errors');
    mocks.requireLeagueAdmin.mockRejectedValue(new DomainError('NOT_LEAGUE_ADMIN'));

    const result = await promoteWaitlistedPlayerAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID }),
    );

    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('attaches a missing override reason to the reason field', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'SIGNUP_DECISION_INVALID: promoting out of order needs a reason',
      },
    });

    const result = await promoteWaitlistedPlayerAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID, membership_id: MEMBERSHIP_ID }),
    );

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.fieldErrors).toHaveProperty('reason');
    }
  });

  it('promotes without waiting on the promoted player\'s devices', async () => {
    const result = await promoteWaitlistedPlayerAction(
      null,
      form({ league_id: LEAGUE_ID, match_id: MATCH_ID }),
    );

    expect(result?.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('inbox mutations', () => {
  beforeEach(() => {
    mocks.rpc.mockResolvedValue({ data: NOTIFICATION_ID, error: null });
  });

  it.each([
    ['markNotificationUnreadAction', markNotificationUnreadAction, 'mark_notification_unread'],
    ['archiveNotificationAction', archiveNotificationAction, 'archive_notification'],
    ['unarchiveNotificationAction', unarchiveNotificationAction, 'unarchive_notification'],
  ])('%s sends only the notification id', async (_name, action, rpc) => {
    await action(null, form({ notification_id: NOTIFICATION_ID, user_id: 'somebody-else' }));

    expect(mocks.rpc.mock.calls[0]?.[0]).toBe(rpc);
    // No user id: the database scopes every one of these to auth.uid().
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_notification_id: NOTIFICATION_ID });
  });

  it('reports another user’s notification as not found', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'NOTIFICATION_NOT_FOUND: no such notification' },
    });

    const result = await archiveNotificationAction(
      null,
      form({ notification_id: NOTIFICATION_ID }),
    );

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('NOTIFICATION_NOT_FOUND');
    }
  });

  it('requires a session', async () => {
    const { DomainError } = await import('@/lib/errors');
    mocks.requireSessionUser.mockRejectedValue(new DomainError('AUTH_REQUIRED'));

    const result = await archiveNotificationAction(
      null,
      form({ notification_id: NOTIFICATION_ID }),
    );
    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
