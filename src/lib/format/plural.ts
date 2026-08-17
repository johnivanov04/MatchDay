/**
 * Counted nouns.
 *
 * ── WHY A HELPER FOR SOMETHING THIS SMALL ──────────────────────────────────
 *
 * Because it was already wrong in four places and right in four others, which
 * is what happens when every screen decides for itself. The match page read
 * "Minimum — 1 players", the team builder said "1 teams", and the guidelines
 * screen managed "1 of 1 members have not yet accepted" — each one a two-second
 * fix that nobody makes because it lives somewhere else.
 *
 * English pluralisation in general is a swamp. This is deliberately not that:
 * it handles a count and a noun, takes the plural form explicitly when adding
 * "s" is wrong, and does nothing clever. Every noun this product counts —
 * player, team, member, match, place, spot, day, notification, device, league —
 * is either regular or covered by passing the second form.
 */

/**
 * `"1 player"`, `"3 players"`.
 *
 * @param plural Supply when the plural is not `singular + "s"`, e.g.
 *   `pluralize(1, 'match', 'matches')`.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${String(count)} ${word}`;
}

/**
 * The noun alone, without the number in front.
 *
 * For the cases where the count is already on screen in its own element — a
 * heading with a badge beside it, or a `<strong>` the sentence flows around —
 * and repeating it in the same breath would read as a stutter.
 */
export function pluralWord(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
