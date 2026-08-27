import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstallationId } from '@/lib/platform/apns-client';

/**
 * The installation identity.
 *
 * Small, but it is the thing that makes APNs token rotation survivable and
 * sign-out cleanable, so its two properties are worth stating: it is stable
 * across calls, and it is shaped so the database will accept it.
 */

const KEY = 'matchday.installation_id';
const SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getInstallationId', () => {
  it('creates one on first use and keeps returning it', () => {
    const first = getInstallationId();
    expect(first).not.toBeNull();
    expect(getInstallationId()).toBe(first);
    expect(getInstallationId()).toBe(first);
  });

  it('survives a page load, because it is what identifies the device', () => {
    const first = getInstallationId();
    // A fresh call with storage intact is what a relaunch looks like.
    expect(window.localStorage.getItem(KEY)).toBe(first);
  });

  it('is shaped the way push_subscriptions_installation_id_shape demands', () => {
    // The constraint is `^[A-Za-z0-9_-]{8,64}$`. A value that fails it is
    // rejected by `register_apns_device` as INVALID_INSTALLATION_ID, and the
    // device silently never registers.
    expect(getInstallationId()).toMatch(SHAPE);
  });

  it('replaces a stored value that would be rejected', () => {
    // Older builds, a hand-edited value, a truncated write. Anything that
    // cannot be registered is worth discarding rather than carrying forever.
    window.localStorage.setItem(KEY, 'bad value!');

    const replacement = getInstallationId();
    expect(replacement).toMatch(SHAPE);
    expect(window.localStorage.getItem(KEY)).toBe(replacement);
  });

  it('is null rather than a fresh value when storage cannot be written', () => {
    // Returning something unpersisted would be worse than nothing: every launch
    // would register a new "device", and the player's list would fill with
    // phones they do not own.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(getInstallationId()).toBeNull();
  });

  it('does not collide across installations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      window.localStorage.clear();
      seen.add(getInstallationId() ?? '');
    }
    expect(seen.size).toBe(50);
  });
});
