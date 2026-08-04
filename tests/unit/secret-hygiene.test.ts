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
