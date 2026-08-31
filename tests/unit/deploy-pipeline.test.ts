import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The production deployment pipeline, asserted from the files that define it.
 *
 * ── WHAT THIS PROTECTS ─────────────────────────────────────────────────────
 *
 * Build #2 shipped application code to production while two Supabase migrations
 * were still pending. Vercel deployed on merge; the schema was applied by hand
 * some time later; and in between, players tapping "Enable phone notifications"
 * were told they lacked permission, because the function the code called did not
 * exist yet.
 *
 * The fix is an ordering: migrations, then deploy, in one workflow, with
 * Vercel's own production trigger switched off so there is only one path. Every
 * part of that is configuration, and configuration drifts silently — nothing at
 * runtime would notice if `deploymentEnabled` were removed, and the next
 * incident would look exactly like the last one.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

const VERCEL = JSON.parse(read('vercel.json')) as {
  git?: { deploymentEnabled?: Record<string, boolean> };
  crons?: Array<{ path: string; schedule: string }>;
};
const DEPLOY = read('.github/workflows/deploy-production.yml');

/**
 * The workflow with its comment lines stripped.
 *
 * The comments explain, at length, which approaches were tried and rejected —
 * so they mention `supabase link` and the credentials it needed. An assertion
 * that a command is absent has to look at commands, or it fails on the prose
 * describing why the command was removed.
 */
const DEPLOY_COMMANDS = DEPLOY.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const CI = read('.github/workflows/ci.yml');

describe('Vercel does not deploy production by itself', () => {
  it('disables automatic production deployment from main', () => {
    // The other half of "exactly one path to production". With this absent,
    // Vercel deploys on merge and races the workflow that is supposed to be
    // sequencing it.
    expect(VERCEL.git?.deploymentEnabled).toBeDefined();
    expect(VERCEL.git?.deploymentEnabled?.main).toBe(false);
  });

  it('leaves preview deployments for every other branch alone', () => {
    // Only `main` may appear. A blanket `"*": false` would take previews with
    // it, and previews are how a pull request gets reviewed at all.
    expect(Object.keys(VERCEL.git?.deploymentEnabled ?? {})).toEqual(['main']);
  });

  it('preserves the existing cron configuration', () => {
    // The file was edited rather than rewritten; the reminder and
    // account-deletion schedules must survive that edit.
    expect(VERCEL.crons?.map((c) => c.path).sort()).toEqual([
      '/api/cron/account-deletion',
      '/api/cron/reminders',
    ]);
  });
});

describe('the production workflow is ordered and gated', () => {
  it('runs only for main', () => {
    // `workflow_dispatch` lets a person choose any ref in the UI. The job guard
    // is what stops that deploying a feature branch to production.
    expect(DEPLOY).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('deploys the exact commit that was verified, not a branch name', () => {
    // `main` can move while the verify job runs. Checking out the branch would
    // deploy a commit nothing tested.
    expect(DEPLOY).toContain('ref: ${{ github.sha }}');
  });

  it('scopes production credentials to the production environment', () => {
    // Environment-scoped secrets are unreadable by any workflow that does not
    // declare the environment — which is what keeps pull-request code away
    // from the production database.
    expect(DEPLOY).toContain('environment: production');
  });

  describe('the database credential model', () => {
    /**
     * Migrations reach production over a plain connection string. `supabase
     * link` was tried first and refused twice — "Authorization failed for the
     * access token and project ref pair" — because a project-scoped token that
     * authenticates correctly is still not authorised for the endpoint `link`
     * calls. Talking to Postgres directly removes the management API from the
     * path, and with it a permission model that can change underneath us.
     */
    it('uses a connection string and never links', () => {
      expect(DEPLOY_COMMANDS).not.toContain('supabase link');
      for (const step of ['db push --db-url', 'migration list --db-url']) {
        expect(DEPLOY_COMMANDS).toContain(step);
      }
    });

    it('no longer depends on the management-API credentials', () => {
      // Three secrets collapsed into one. Leaving them referenced would keep
      // the pipeline failing on a permission it no longer needs.
      for (const gone of [
        'SUPABASE_ACCESS_TOKEN',
        'SUPABASE_PROJECT_ID',
        'SUPABASE_DB_PASSWORD',
      ]) {
        expect(DEPLOY_COMMANDS).not.toContain(gone);
      }
    });

    it('reads the URL from the production environment and nowhere else', () => {
      expect(DEPLOY).toContain('SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}');
    });

    it('passes the URL by environment variable, never on a command line', () => {
      /**
       * A connection string carries the database password. Interpolating the
       * secret into the `run:` text would put it in the rendered command that
       * Actions prints; `"$SUPABASE_DB_URL"` is expanded by the shell instead,
       * so only the variable name is ever displayed.
       */
      expect(DEPLOY_COMMANDS).not.toMatch(/--db-url "\$\{\{/);
      const uses = [...DEPLOY_COMMANDS.matchAll(/--db-url (\S+)/g)].map((m) => m[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(use).toBe('"$SUPABASE_DB_URL"');
    });

    it('never echoes the URL and never enables shell tracing', () => {
      // `set -x` would print every expanded command, including the connection
      // string, into a log this repository cannot redact after the fact.
      expect(DEPLOY_COMMANDS).not.toMatch(/set -x|set -o xtrace/);
      expect(DEPLOY_COMMANDS).not.toMatch(/echo .*SUPABASE_DB_URL/);
    });
  });

  it('applies migrations before it deploys, and verifies parity in between', () => {
    const order = ['Apply pending migrations', 'Verify migration parity', 'Deploy this commit'];
    const positions = order.map((step) => DEPLOY.indexOf(step));

    for (const position of positions) expect(position).toBeGreaterThan(-1);
    // The whole point, expressed as a comparison rather than a comment.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('waits for the full verification suite first', () => {
    expect(DEPLOY).toContain('needs: verify');
    expect(DEPLOY).toContain('uses: ./.github/workflows/ci.yml');
  });

  it('does not cancel a run in flight', () => {
    // A cancellation between `db push` and the deploy leaves production in the
    // split state this pipeline exists to prevent.
    expect(DEPLOY).toContain('cancel-in-progress: false');
  });

  it('pins its deployment tooling', () => {
    // A pipeline that silently changes its own tools between runs cannot be
    // reasoned about after a failure.
    expect(DEPLOY).toMatch(/version: \d+\.\d+\.\d+/);
    expect(DEPLOY).toMatch(/vercel@\d+\.\d+\.\d+/);
    expect(DEPLOY).not.toContain('@latest');
  });
});

describe('CI is reused rather than restated', () => {
  it('is callable by the production workflow', () => {
    expect(CI).toContain('workflow_call:');
  });

  it('does not also run itself on main', () => {
    // Otherwise every merge runs the suite twice, and the standalone run
    // produces a green tick on main that says nothing about what shipped.
    expect(CI).toContain("branches: ['**', '!main']");
  });

  it('still runs for pull requests', () => {
    expect(CI).toMatch(/pull_request:\s*\n\s*branches:/);
  });

  it('uses no secrets, so it stays safe to run on untrusted code', () => {
    expect(CI).not.toContain('secrets.');
  });
});
