import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { sanitizeSearchQuery } from '@/lib/validation/league';
import type { SearchableLeaguePublicRow } from '@/types/database';

/**
 * Public league discovery.
 *
 * Every read here goes through `public.searchable_leagues_public`, never
 * through `leagues`. That view is the security boundary: it filters to
 * `visibility = 'searchable'` and exposes seven columns. Because the query
 * cannot name a column the view does not have, a mistake in this file cannot
 * widen what is published — the worst it can do is show fewer fields.
 */

/** The exact column list. Written out so a reviewer can see it without opening the view. */
const PUBLIC_COLUMNS = 'id, slug, name, general_area, sport_label, typical_schedule, description';

const MAX_RESULTS = 50;

/**
 * Searches searchable leagues by name or general area.
 *
 * An empty query lists recent searchable leagues rather than returning nothing,
 * so the discovery page is useful before the user types.
 */
export async function searchPublicLeagues(
  rawQuery: string,
): Promise<SearchableLeaguePublicRow[]> {
  const query = sanitizeSearchQuery(rawQuery);
  const supabase = await createSupabaseServerClient();

  let request = supabase
    .from('searchable_leagues_public')
    .select(PUBLIC_COLUMNS)
    .order('name', { ascending: true })
    .limit(MAX_RESULTS);

  if (query !== '') {
    // `sanitizeSearchQuery` has already stripped `%`, `_` and `,`, so the
    // pattern below cannot become a wildcard match or inject a second filter.
    request = request.or(`name.ilike.%${query}%,general_area.ilike.%${query}%`);
  }

  const { data, error } = await request;

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

/** One searchable league by slug, or `null`. Private leagues are simply absent. */
export async function getPublicLeagueBySlug(
  slug: string,
): Promise<SearchableLeaguePublicRow | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('searchable_leagues_public')
    .select(PUBLIC_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();

  if (error !== null) {
    return null;
  }

  return data;
}
