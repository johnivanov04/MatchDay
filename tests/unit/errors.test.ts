import { describe, expect, it } from 'vitest';
import {
  actionFailure,
  actionSuccess,
  DOMAIN_ERROR_CODES,
  DomainError,
  isDomainError,
  userMessageFor,
} from '@/lib/errors';

describe('domain errors', () => {
  it('defines every stable error code from the specification', () => {
    // 02 §21. Codes are part of the contract with clients, so the list is
    // asserted rather than assumed.
    for (const code of [
      'AUTH_REQUIRED',
      'PROFILE_INCOMPLETE',
      'LEAGUE_NOT_FOUND',
      'LEAGUE_PRIVATE',
      'MEMBERSHIP_REQUIRED',
      'MEMBERSHIP_INACTIVE',
      'JOIN_REQUEST_EXISTS',
      'NOT_LEAGUE_ADMIN',
      'ADMIN_TRANSFER_INVALID',
      'GUIDELINES_NOT_ACCEPTED',
      'MATCH_NOT_OPEN',
      'SIGNUP_CLOSED',
      'CAPACITY_EXCEEDED',
      'WAITLIST_CONFLICT',
      'ALREADY_CONFIRMED',
      'ALREADY_FINALIZED',
      'TEAM_ASSIGNMENT_INVALID',
      'NOTIFICATION_NOT_FOUND',
      'NOT_AUTHORIZED',
    ] as const) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });

  it('has a user-facing message for every code', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(userMessageFor(code).length).toBeGreaterThan(0);
    }
  });

  it('gives the same message for a missing league and a forbidden one', () => {
    // Otherwise the error text confirms that a private league exists, which is
    // exactly what PRD §12 forbids leaking.
    expect(userMessageFor('LEAGUE_NOT_FOUND')).toBe(userMessageFor('LEAGUE_PRIVATE'));
  });

  it('carries field errors when supplied', () => {
    const error = new DomainError('VALIDATION_FAILED', {
      fieldErrors: { first_name: 'First name is required.' },
    });
    expect(isDomainError(error)).toBe(true);
    expect(error.fieldErrors['first_name']).toBe('First name is required.');
  });
});

describe('action results', () => {
  it('reports success with and without data', () => {
    expect(actionSuccess()).toEqual({ ok: true, data: undefined });
    expect(actionSuccess({ email: 'a@matchday.test' })).toEqual({
      ok: true,
      data: { email: 'a@matchday.test' },
    });
  });

  it('passes a domain error through with its code and message', () => {
    const result = actionFailure(new DomainError('NOT_LEAGUE_ADMIN'));
    expect(result).toEqual({
      ok: false,
      code: 'NOT_LEAGUE_ADMIN',
      message: userMessageFor('NOT_LEAGUE_ADMIN'),
      fieldErrors: {},
    });
  });

  it('never leaks the text of an unexpected error', () => {
    // Database errors name tables, constraints and identifiers from other
    // tenants. None of that may reach a client response.
    const leaky = new Error(
      'duplicate key value violates unique constraint "league_memberships_league_user_key" for league 2222…',
    );
    const result = actionFailure(leaky);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(userMessageFor('NOT_AUTHORIZED'));
    expect(result.message).not.toContain('league_memberships');
    expect(JSON.stringify(result)).not.toContain('unique constraint');
  });

  it('does not leak a thrown string either', () => {
    const result = actionFailure('SUPABASE_SERVICE_ROLE_KEY=super-secret');
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});
