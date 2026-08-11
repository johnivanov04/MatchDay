import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueMembershipRow, LeagueRow, MatchLifecycleStatus, MatchRow } from '@/types/database';

/**
 * Who can reach the edit route, and what the match detail page offers them.
 *
 * The guards are exercised for real — only the session, the league lookup and
 * the match query are stood in for. What is under test is the *kind* of outcome
 * each unauthorized case produces: `redirect()` throws `NEXT_REDIRECT`, which
 * Next.js handles silently, while anything else escaping a Server Component
 * render is reported as an unhandled application error. A player following a
 * stale link must get the first.
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
    getSessionUser: vi.fn(),
    getCurrentProfile: vi.fn(),
    findMyLeagueBySlug: vi.fn(),
    getMatch: vi.fn(),
    getMatchAdminNotes: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
  getCurrentProfile: mocks.getCurrentProfile,
}));
vi.mock('@/lib/leagues/league-admin', () => ({ findMyLeagueBySlug: mocks.findMyLeagueBySlug }));
vi.mock('@/lib/matches/matches', () => ({
  getMatch: mocks.getMatch,
  getMatchAdminNotes: mocks.getMatchAdminNotes,
}));

// The forms are client components whose own module graph reaches the server
// actions. Stubbing them keeps this test about routing, and gives each form a
// stable identity to assert on.
const EditDraftMatchForm = () => null;
const EditOpenMatchForm = () => null;
const MatchAdminNotesForm = () => null;
vi.mock('@/components/edit-match', () => ({
  EditDraftMatchForm,
  EditOpenMatchForm,
  MatchAdminNotesForm,
}));
vi.mock('@/components/matches', () => ({
  CancelMatchForm: () => null,
  PublishMatchButton: () => null,
}));

const { default: EditMatchPage } = await import(
  '@/app/(app)/leagues/[slug]/matches/[matchId]/edit/page'
);
const { default: MatchDetailPage } = await import(
  '@/app/(app)/leagues/[slug]/matches/[matchId]/page'
);

const SLUG = 'rmvfc';
const MATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const LEAGUE = { id: 'league-1', slug: SLUG, name: 'RMV Football Club' } as LeagueRow;
const OTHER_LEAGUE = { id: 'league-2', slug: 'fives', name: 'Weeknight 5v5' } as LeagueRow;

function membership(
  role: 'league_admin' | 'player',
  status: 'active' | 'pending' | 'suspended' | 'removed' = 'active',
): LeagueMembershipRow {
  return { id: 'm-1', league_id: LEAGUE.id, user_id: 'user-1', role, status } as LeagueMembershipRow;
}

function match(status: MatchLifecycleStatus, overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: MATCH_ID,
    league_id: LEAGUE.id,
    title: 'Monday night 11v11',
    match_date: '2026-09-21',
    timezone: 'America/Los_Angeles',
    arrival_at: '2026-09-22T01:30:00.000Z',
    kickoff_at: '2026-09-22T02:00:00.000Z',
    end_at: '2026-09-22T03:30:00.000Z',
    location_name: 'RMV Community Pitch',
    location_map_url: null,
    capacity: 22,
    min_players: 14,
    selection_mode: 'admin_approval',
    waitlist_mode: 'admin_controlled',
    team_count: 2,
    priority_window: null,
    priority_window_ends_at: null,
    signup_closes_at: '2026-09-21T20:00:00.000Z',
    cancellation_cutoff_at: '2026-09-21T07:00:00.000Z',
    roster_publish_target_at: null,
    status,
    public_notes: null,
    revision: 3,
    created_by: null,
    published_at: status === 'draft' ? null : '2026-09-01T00:00:00.000Z',
    canceled_at: status === 'canceled' ? '2026-09-10T00:00:00.000Z' : null,
    cancellation_reason: status === 'canceled' ? 'Waterlogged' : null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as MatchRow;
}

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in a rendered tree, so assertions can ask what it contains. */
function flatten(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isElement(node)) return [];
  return [node, ...flatten(node.props['children'])];
}

function linkTargets(tree: unknown): string[] {
  return flatten(tree)
    .map((element) => element.props['href'])
    .filter((href): href is string => typeof href === 'string');
}

function contains(tree: unknown, component: unknown): boolean {
  return flatten(tree).some((element) => element.type === component);
}

/**
 * The visible text of a rendered tree.
 *
 * Walks children rather than serialising, because a React element graph holds
 * references back to its component modules and cannot be stringified — and
 * because what a player must not see is the *text*, not the object.
 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';
  return textOf(node.props['children']);
}

/** Runs a page, returning the path it redirected to. Fails if it rendered. */
async function expectRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof mocks.RedirectSignal) {
      return error.path;
    }
    // A DomainError reaching this point is the bug: Next.js would report it as
    // an unhandled application error rather than a clean redirect.
    throw error;
  }
  throw new Error('Expected the page to redirect, but it rendered.');
}

const editPage = () =>
  EditMatchPage({ params: Promise.resolve({ slug: SLUG, matchId: MATCH_ID }) });

const detailPage = (notice?: string) =>
  MatchDetailPage({
    params: Promise.resolve({ slug: SLUG, matchId: MATCH_ID }),
    searchParams: Promise.resolve(notice === undefined ? {} : { notice }),
  });

function signInAs(role: 'league_admin' | 'player' | 'none', status?: 'pending' | 'suspended') {
  mocks.getSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@matchday.test' });
  mocks.getCurrentProfile.mockResolvedValue({ id: 'user-1', first_name: 'Jo', last_name: 'Ng' });
  mocks.findMyLeagueBySlug.mockResolvedValue(
    role === 'none'
      ? null
      : { league: LEAGUE, membership: membership(role, status ?? 'active') },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMatchAdminNotes.mockResolvedValue(null);
});

describe('the edit route', () => {
  it('lets the league administrator open a draft, on the draft form', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('draft'));

    const tree = await editPage();

    expect(contains(tree, EditDraftMatchForm)).toBe(true);
    expect(contains(tree, EditOpenMatchForm)).toBe(false);
  });

  it('lets the league administrator open an open match, on the published form', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('open'));

    const tree = await editPage();

    expect(contains(tree, EditOpenMatchForm)).toBe(true);
    expect(contains(tree, EditDraftMatchForm)).toBe(false);
  });

  it('offers administrator notes on both forms', async () => {
    signInAs('league_admin');

    for (const status of ['draft', 'open'] as const) {
      mocks.getMatch.mockResolvedValue(match(status));
      expect(contains(await editPage(), MatchAdminNotesForm)).toBe(true);
    }
  });

  it('redirects a player cleanly', async () => {
    signInAs('player');
    mocks.getMatch.mockResolvedValue(match('open'));

    expect(await expectRedirect(editPage)).toBe('/dashboard?notice=not-league-admin');
    // The guard refuses before the match is ever looked up.
    expect(mocks.getMatch).not.toHaveBeenCalled();
  });

  it('redirects a pending or suspended member cleanly', async () => {
    for (const status of ['pending', 'suspended'] as const) {
      vi.clearAllMocks();
      signInAs('league_admin', status);
      expect(await expectRedirect(editPage)).toBe('/dashboard?notice=not-league-admin');
    }
  });

  it('redirects a non-member cleanly', async () => {
    signInAs('none');
    expect(await expectRedirect(editPage)).toBe('/dashboard?notice=not-league-admin');
  });

  it('sends an unauthenticated visitor to sign-in', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    expect(await expectRedirect(editPage)).toBe('/sign-in');
  });

  it('gives a cross-league administrator the same answer as a stranger', async () => {
    // Administrator of another league entirely: `findMyLeagueBySlug` finds no
    // membership under this slug, exactly as for somebody with no leagues.
    mocks.getSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@matchday.test' });
    mocks.getCurrentProfile.mockResolvedValue({ id: 'user-1', first_name: 'Jo', last_name: 'Ng' });
    mocks.findMyLeagueBySlug.mockResolvedValue(null);
    const crossLeague = await expectRedirect(editPage);

    signInAs('none');
    const stranger = await expectRedirect(editPage);

    expect(crossLeague).toBe(stranger);
  });

  it('answers an unknown match exactly as an unauthorized league', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(null);
    const unknownMatch = await expectRedirect(editPage);

    signInAs('player');
    const unauthorized = await expectRedirect(editPage);

    // Identical, so a guessed identifier cannot confirm that a private match
    // exists — the same rule Phase 2 established for league slugs.
    expect(unknownMatch).toBe(unauthorized);
    expect(unknownMatch).toBe('/dashboard?notice=not-league-admin');
  });

  it('answers a match from another league as if it did not exist', async () => {
    signInAs('league_admin');
    // getMatch filters on league_id, so a cross-league identifier returns null
    // rather than another tenant's row.
    mocks.getMatch.mockResolvedValue(null);

    expect(await expectRedirect(editPage)).toBe('/dashboard?notice=not-league-admin');
    expect(mocks.getMatch).toHaveBeenCalledWith(LEAGUE.id, MATCH_ID);
    expect(mocks.getMatch).not.toHaveBeenCalledWith(OTHER_LEAGUE.id, MATCH_ID);
  });

  it('sends the administrator of a canceled match back to read it', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('canceled'));

    expect(await expectRedirect(editPage)).toBe(
      `/leagues/${SLUG}/matches/${MATCH_ID}?notice=not-editable`,
    );
  });

  it('offers no form for a lifecycle state no edit path understands', async () => {
    signInAs('league_admin');

    for (const status of ['roster_finalized', 'teams_published', 'completed'] as const) {
      mocks.getMatch.mockResolvedValue(match(status));
      expect(await expectRedirect(editPage)).toContain('notice=not-editable');
    }
  });
});

describe('the edit button on the match detail page', () => {
  const EDIT_HREF = `/leagues/${SLUG}/matches/${MATCH_ID}/edit`;

  it('is shown to the administrator of a draft or open match', async () => {
    signInAs('league_admin');

    for (const status of ['draft', 'open'] as const) {
      mocks.getMatch.mockResolvedValue(match(status));
      expect(linkTargets(await detailPage())).toContain(EDIT_HREF);
    }
  });

  it('is hidden from a player', async () => {
    signInAs('player');
    mocks.getMatch.mockResolvedValue(match('open'));

    expect(linkTargets(await detailPage())).not.toContain(EDIT_HREF);
  });

  it('is hidden on a canceled match, even from the administrator', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('canceled'));

    const tree = await detailPage();
    expect(linkTargets(tree)).not.toContain(EDIT_HREF);
    // Still readable, though — a cancellation is information a member needs.
    expect(textOf(tree)).toContain('Waterlogged');
  });

  it('is hidden on every lifecycle state with no edit path', async () => {
    signInAs('league_admin');

    for (const status of ['roster_finalized', 'teams_published', 'completed'] as const) {
      mocks.getMatch.mockResolvedValue(match(status));
      expect(linkTargets(await detailPage())).not.toContain(EDIT_HREF);
    }
  });

  it('redirects a non-member rather than revealing the match', async () => {
    signInAs('none');
    expect(await expectRedirect(() => detailPage())).toBe('/dashboard?notice=not-league-member');
  });

  it('redirects when the match is not visible to the caller', async () => {
    signInAs('player');
    mocks.getMatch.mockResolvedValue(null);

    // Drafts are invisible to members, and so is a match that does not exist.
    expect(await expectRedirect(() => detailPage())).toBe('/dashboard?notice=not-league-member');
  });
});

describe('the success notice on the match detail page', () => {
  beforeEach(() => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('open'));
  });

  it('shows the message the edit form redirected with', async () => {
    expect(textOf(await detailPage('saved'))).toContain('Match saved.');
  });

  it('shows a distinct message for notes, making clear nobody was notified', async () => {
    const rendered = textOf(await detailPage('notes-saved'));
    expect(rendered).toContain('Members were not notified.');
  });

  it('renders nothing for an unrecognised notice', async () => {
    const rendered = textOf(await detailPage('anything-else'));
    expect(rendered).not.toContain('anything-else');
    expect(rendered).not.toContain('Match saved.');
  });
});

describe('administrator notes on the match detail page', () => {
  it('are rendered for the administrator', async () => {
    signInAs('league_admin');
    mocks.getMatch.mockResolvedValue(match('open'));
    mocks.getMatchAdminNotes.mockResolvedValue({ notes: 'SECRETNOTE' });

    expect(textOf(await detailPage())).toContain('SECRETNOTE');
  });

  it('are never fetched for a player, let alone rendered', async () => {
    signInAs('player');
    mocks.getMatch.mockResolvedValue(match('open'));
    // Row Level Security would refuse them anyway; not asking is the second
    // layer, and the one that keeps the note out of this render entirely.
    mocks.getMatchAdminNotes.mockResolvedValue({ notes: 'SECRETNOTE' });

    const rendered = textOf(await detailPage());
    expect(mocks.getMatchAdminNotes).not.toHaveBeenCalled();
    expect(rendered).not.toContain('SECRETNOTE');
  });
});
