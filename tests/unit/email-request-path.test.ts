import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The property Phase 3B bought and every later phase has to keep.
 *
 * A notification-producing request persists the notification and the durable
 * queue job, and returns. It does not wait for APNs, it does not wait for Web
 * Push, and since Phase 3D it must not wait for Resend either.
 *
 * Stated structurally rather than by timing, because a latency assertion would
 * be flaky in CI and would not say *why* it got slow. A provider import in a
 * server action is the thing that would make it slow, so that is what is
 * asserted.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIONS = join(REPO_ROOT, 'src/server/actions');

const FORBIDDEN_IN_REQUEST_PATH = [
  '@/lib/email/resend',
  '@/lib/email/dispatch',
  '@/lib/email/email-store',
  '@/lib/push/apns',
  '@/lib/push/sender',
  '@/lib/push/dispatch',
  '@/lib/push/push-store',
  '@/server/notification-delivery',
  'api.resend.com',
  'RESEND_API_KEY',
];

describe('no server action can reach a delivery provider', () => {
  it('imports nothing that talks to APNs, Web Push or Resend', async () => {
    const files = (await readdir(ACTIONS)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(join(ACTIONS, file), 'utf8');
      // Comments legitimately discuss these modules; only real import
      // statements and literal usages matter.
      const code = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');

      for (const forbidden of FORBIDDEN_IN_REQUEST_PATH) {
        if (code.includes(forbidden)) {
          offenders.push(`${file} → ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the email preference action free of provider code', async () => {
    // Toggling a setting is a preference change, not a delivery event. A
    // settings screen is an easy place to accidentally reintroduce a send.
    const source = await readFile(
      join(REPO_ROOT, 'src/server/actions/notification-preferences.ts'),
      'utf8',
    );

    // Comments are read, not executed — the module's header explains at length
    // that it does not import the provider, and that sentence must not be what
    // fails the test.
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');

    for (const forbidden of ['resend', 'Resend', 'RESEND_API_KEY', 'EMAIL_FROM']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the email modules out of any client component', async () => {
    // A `'use client'` file importing the transport would ship the shape of the
    // provider call — and the intent to hold an API key — to the browser.
    const components = join(REPO_ROOT, 'src/components');
    const files = (await readdir(components)).filter((n) => n.endsWith('.tsx') || n.endsWith('.ts'));

    for (const file of files) {
      const source = await readFile(join(components, file), 'utf8');
      expect(source, file).not.toContain('@/lib/email/');
    }
  });
});
