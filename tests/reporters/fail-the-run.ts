import type { Reporter } from 'vitest/node';

/**
 * Makes a failing test actually fail the process.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ──────────────────────────────────────
 *
 * A failing test in the `db` project printed its failure, reported
 * `Tests 1 failed`, and exited **0**. CI therefore showed a green tick over a
 * red suite, and did so for every phase that relies on database tests.
 *
 * What is happening, established by instrumenting `process.exit`:
 *
 *   • Vitest sets `process.exitCode = 1` correctly — a reporter observes
 *     `reason: "failed"` and `exitCode: 1` at `onTestRunEnd`.
 *   • The `db` project's `globalSetup` returns an ASYNC teardown. During that
 *     teardown's continuation something calls `process.exit(0)` — with an
 *     explicit zero, which overrides the exit code Vitest had already set.
 *   • It is the asynchrony that matters, not the embedded server: a teardown
 *     reduced to a synchronous `rmSync` exits 1, while both real teardowns —
 *     stopping embedded PostgreSQL, and dropping the template databases on an
 *     external server — exit 0.
 *   • `unit` and `client` have no `globalSetup` and were never affected.
 *
 * ── WHY A REPORTER, AND WHY AN EXIT LISTENER ───────────────────────────────
 *
 * The failure signal is taken from Vitest's own structured run result, not by
 * reading console output — `reason` and each module's `state()` are the same
 * values the CLI itself uses to decide.
 *
 * The listener is the only thing that can win. `process.exit(0)` begins exiting
 * immediately, so anything scheduled afterwards never runs; but a handler
 * registered on `'exit'` still executes synchronously during teardown, and
 * assigning `process.exitCode` there overrides the code passed to
 * `process.exit`. Verified directly:
 *
 *     process.exitCode = 1; process.exit(0)                      → 0
 *     process.exitCode = 1; on('exit', …=1); process.exit(0)     → 1
 *
 * Nothing here calls `process.exit` itself, so teardown still runs to
 * completion and a genuine error is still reported by Vitest in the normal way.
 * On a passing run the listener is never registered and the exit code is
 * untouched.
 */
export default class FailTheRun implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<{ state?: () => string; ok?: () => boolean }>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason?: string,
  ): void {
    const moduleFailed = testModules.some(
      (module) => module.state?.() === 'failed' || module.ok?.() === false,
    );

    // `reason` is Vitest's own verdict for the whole run and covers the cases a
    // per-module check cannot see — an interrupted run, or a failure that
    // happened before any module produced state.
    const runFailed = reason !== undefined && reason !== 'passed';

    if (!moduleFailed && !runFailed && unhandledErrors.length === 0) {
      return;
    }

    process.once('exit', () => {
      // Deliberately unconditional: by the time this runs, an explicit
      // `process.exit(0)` may already have discarded the code Vitest set.
      process.exitCode = 1;
    });
  }
}
