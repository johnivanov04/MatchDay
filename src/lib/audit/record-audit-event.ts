import 'server-only';

import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { DomainError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Audit-event foundation.
 *
 * Phase 1 has no administrator mutations to record — league settings,
 * memberships, rosters and attendance all arrive later — so this exists to give
 * those phases one reviewed way to write an audit trail, rather than each
 * feature inventing its own.
 */

export interface AuditEventInput {
  leagueId: string;
  /** Snake-case singular, e.g. `league`, `league_membership`. */
  entityType: string;
  entityId: string | null;
  /** Dotted snake-case, e.g. `membership.status_changed`. */
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Records one administrator audit event.
 *
 * Note the deliberate absence of an `actorId` parameter. The actor is taken
 * from the session by `public.record_audit_event`, which also re-checks league
 * administration in the database. The `requireLeagueAdmin` call below is the
 * server-side half of the same check: it fails earlier and with a clearer
 * error, but it is not what makes the operation safe.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<string> {
  await requireLeagueAdmin(input.leagueId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_audit_event', {
    p_league_id: input.leagueId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_action: input.action,
    p_before: input.before ?? null,
    p_after: input.after ?? null,
    p_reason: input.reason ?? null,
  });

  if (error !== null) {
    throw new DomainError('NOT_AUTHORIZED', { cause: error });
  }

  return data;
}
