import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const SRC_ROOT = join(REPO_ROOT, 'src');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const sourceFiles = walk(SRC_ROOT).filter((path) => /\.(ts|tsx)$/.test(path));

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * "Do not expose service-role keys or other secrets to the browser" is a Phase
 * 1 engineering requirement, so it is asserted rather than assumed. These
 * checks are static: they hold whether or not any particular page is rendered.
 */
describe('secret hygiene', () => {
  it('finds source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it('references the service-role key in exactly one module', () => {
    const offenders = sourceFiles
      .filter((path) => read(path).includes('SUPABASE_SERVICE_ROLE_KEY'))
      .map((path) => relative(REPO_ROOT, path));

    expect(offenders).toEqual(['src/lib/supabase/admin.ts']);
  });

  it('never prefixes a secret with NEXT_PUBLIC_', () => {
    // A NEXT_PUBLIC_ prefix inlines the value into the client bundle.
    for (const path of sourceFiles) {
      expect(read(path), relative(REPO_ROOT, path)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SERVICE/);
      expect(read(path), relative(REPO_ROOT, path)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/);
      // The VAPID *private* key signs pushes to every subscribed device.
      expect(read(path), relative(REPO_ROOT, path)).not.toMatch(/NEXT_PUBLIC_VAPID_PRIVATE/);
    }
  });

  it('names the VAPID private key in exactly one module', () => {
    const offenders = sourceFiles
      .filter((path) => read(path).includes('VAPID_PRIVATE_KEY'))
      .map((path) => relative(REPO_ROOT, path));

    expect(offenders).toEqual(['src/lib/push/sender.ts']);
  });

  it('keeps the VAPID private key out of every client component', () => {
    const clientComponents = sourceFiles.filter((path) => {
      const contents = read(path);
      return contents.startsWith("'use client'") || contents.startsWith('"use client"');
    });

    for (const path of clientComponents) {
      const contents = read(path);
      expect(contents, relative(REPO_ROOT, path)).not.toContain('VAPID_PRIVATE_KEY');
      // The public key is browser-visible by design and may appear.
      expect(contents, relative(REPO_ROOT, path)).not.toContain('lib/push/sender');
      expect(contents, relative(REPO_ROOT, path)).not.toContain('lib/push/push-store');
    }
  });

  it('never lets the service worker reference a secret', () => {
    // sw.js is served verbatim to every visitor.
    const serviceWorker = read(join(REPO_ROOT, 'public/sw.js'));
    for (const secret of ['VAPID_PRIVATE_KEY', 'SERVICE_ROLE', 'auth_secret', 'p256dh']) {
      expect(serviceWorker).not.toContain(secret);
    }
  });

  it('keeps the service-role client out of every client component', () => {
    const clientComponents = sourceFiles.filter((path) => {
      const contents = read(path);
      return contents.startsWith("'use client'") || contents.startsWith('"use client"');
    });

    expect(clientComponents.length).toBeGreaterThan(0);

    for (const path of clientComponents) {
      expect(read(path), relative(REPO_ROOT, path)).not.toContain('supabase/admin');
    }
  });

  it('marks every privileged server module with server-only', () => {
    for (const relativePath of [
      'src/lib/supabase/admin.ts',
      'src/lib/supabase/server.ts',
      'src/lib/auth/session.ts',
      'src/lib/auth/authorization.ts',
      'src/lib/auth/page-guards.ts',
      'src/lib/leagues/active-league.ts',
      'src/lib/audit/record-audit-event.ts',
      // Phase 3: the push modules read subscription credentials and dispatch
      // to other users' devices. None may ever be bundled for a browser.
      'src/lib/push/sender.ts',
      'src/lib/push/dispatch.ts',
      'src/lib/push/push-store.ts',
      'src/lib/push/notify.ts',
      'src/lib/guidelines/guidelines.ts',
      'src/lib/matches/matches.ts',
      'src/lib/notifications/notifications.ts',
    ]) {
      expect(read(join(REPO_ROOT, relativePath)), relativePath).toContain("import 'server-only'");
    }
  });

  it('ships a .env.example with variable names and no values', () => {
    const lines = read(join(REPO_ROOT, '.env.example'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Every entry must be exactly `NAME=` — a populated value would be a
      // committed credential.
      expect(line, line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });

  it('ignores local environment files in git', () => {
    const gitignore = read(join(REPO_ROOT, '.gitignore'));
    expect(gitignore).toContain('.env.local');
    expect(gitignore).toContain('.env');
  });

  it('derives the actor from the session in every authorization helper', () => {
    // No helper may accept a caller-supplied user ID: that is the whole
    // "never trust a client-supplied actor" requirement, expressed as a test.
    const authorization = read(join(REPO_ROOT, 'src/lib/auth/authorization.ts'));
    expect(authorization).toContain('requireSessionUser');
    expect(authorization).not.toMatch(/function\s+\w+\([^)]*userId\s*:/);
    expect(authorization).not.toMatch(/function\s+\w+\([^)]*actorId\s*:/);
  });
});
