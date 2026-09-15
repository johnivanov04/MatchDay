import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import FailTheRun from '../reporters/fail-the-run';

/**
 * The guard on the guard.
 *
 * A failing `db` test once printed its failure and exited 0, so CI showed a
 * green tick over a red suite. `tests/reporters/fail-the-run.ts` is what makes
 * the process exit non-zero; this is what stops that reporter being quietly
 * removed, unwired, or broken.
 *
 * The end-to-end proof — spawning Vitest on a deliberately failing database
 * test and asserting the exit code — is deliberately NOT here: it would boot a
 * PostgreSQL server inside a unit test and take longer than the rest of this
 * file put together. It was run by hand when the fix landed, and CI now
 * exercises the real path on every run. What can regress in code is the
 * reporter's own logic and its wiring, and both are covered below.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Captures what the reporter registers, without really exiting. */
function withExitListeners<T>(fn: () => T): { result: T; listeners: number } {
  const before = process.listenerCount('exit');
  const result = fn();
  return { result, listeners: process.listenerCount('exit') - before };
}

afterEach(() => {
  // The reporter registers a real `'exit'` listener; leaving them attached
  // across tests would make the counts meaningless.
  process.removeAllListeners('exit');
});

describe('the failing-run reporter', () => {
  it('registers an exit listener when a module failed', () => {
    const reporter = new FailTheRun();
    const { listeners } = withExitListeners(() =>
      reporter.onTestRunEnd([{ state: () => 'failed', ok: () => false }], [], 'failed'),
    );

    expect(listeners).toBe(1);
  });

  it('forces a non-zero code from that listener, beating an explicit exit(0)', () => {
    // The mechanism, asserted rather than described: assigning `process.exitCode`
    // inside an `'exit'` handler overrides the code passed to `process.exit`.
    const reporter = new FailTheRun();
    reporter.onTestRunEnd([{ state: () => 'failed', ok: () => false }], [], 'failed');

    const original = process.exitCode;
    try {
      process.exitCode = 0;
      process.emit('exit', 0 as never);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = original;
    }
  });

  it('does nothing at all when the run passed', () => {
    const reporter = new FailTheRun();
    const { listeners } = withExitListeners(() =>
      reporter.onTestRunEnd([{ state: () => 'passed', ok: () => true }], [], 'passed'),
    );

    expect(listeners).toBe(0);
  });

  it.each([
    ['an unhandled error with no failed module', [], [new Error('boom')], 'passed'],
    ['an interrupted run', [], [], 'interrupted'],
    ['a module reporting ok() === false', [{ ok: () => false }], [], 'passed'],
  ])('still fails the run for %s', (_label, modules, errors, reason) => {
    const reporter = new FailTheRun();
    const { listeners } = withExitListeners(() =>
      reporter.onTestRunEnd(
        modules as ReadonlyArray<{ state?: () => string; ok?: () => boolean }>,
        errors,
        reason as string,
      ),
    );

    expect(listeners).toBe(1);
  });

  it('never calls process.exit itself, so teardown still runs', () => {
    // Forcing an exit here would kill the embedded PostgreSQL server mid-stop
    // and leave a data directory behind — the reporter only ever sets a code.
    const source = readFileSync(join(REPO_ROOT, 'tests/reporters/fail-the-run.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');

    expect(code).not.toContain('process.exit(');
  });
});

describe('the reporter is actually wired in', () => {
  it('is listed in the root Vitest config, so every project is covered', () => {
    // Unwiring it would restore the original defect silently: the suite would
    // still print its failures and still exit 0.
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.mts'), 'utf8');

    expect(config).toContain('./tests/reporters/fail-the-run.ts');
    expect(config).toContain("reporters: ['default'");
  });
});
