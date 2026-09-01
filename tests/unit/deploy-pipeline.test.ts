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
    const order = [
      'Apply pending migrations',
      'Verify migration parity',
      'Create a staged production deployment',
    ];
    const positions = order.map((step) => DEPLOY.indexOf(step));

    for (const position of positions) expect(position).toBeGreaterThan(-1);
    // The whole point, expressed as a comparison rather than a comment.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  describe('the application is staged before it is promoted', () => {
    /**
     * ── WHAT THIS PREVENTS ─────────────────────────────────────────────────
     *
     * The first version of this workflow built on the runner and shipped the
     * result with `--prebuilt`. The runner used Node 22; the Vercel project
     * runs Node 24. The output was assembled for a runtime it would never
     * execute on — and every gate passed, because the build succeeded, the
     * deploy succeeded and the deployment reported READY.
     *
     * Production served 500 on every dynamic route until it was rolled back.
     *
     * Two defects, fixed together: Vercel now performs the build, so the
     * runtime cannot be mismatched; and the deployment is health-checked while
     * the production domains still point elsewhere, so a bad build is never
     * served rather than merely being noticed afterwards.
     */
    it('never builds locally or deploys prebuilt output', () => {
      expect(DEPLOY_COMMANDS).not.toContain('--prebuilt');
      expect(DEPLOY_COMMANDS).not.toMatch(/vercel build/);
    });

    it('does not pull the production environment onto the runner', () => {
      // `vercel pull` writes .vercel/.env.production.local — every production
      // secret, including the APNs signing key — to disk. It existed only to
      // feed the local build that no longer happens.
      expect(DEPLOY_COMMANDS).not.toMatch(/vercel pull/);
    });

    it('stages the deployment without moving the production domains', () => {
      expect(DEPLOY_COMMANDS).toMatch(/vercel deploy --prod --skip-domain/);
    });

    it('promotes explicitly rather than relying on deploy to alias', () => {
      expect(DEPLOY_COMMANDS).toMatch(/vercel promote "\$STAGED_URL"/);
    });

    it('checks the staged deployment through a protection-aware request', () => {
      // A plain curl to a staged URL is answered by Vercel's authentication
      // page, not by the application, so it would "pass" against nothing.
      expect(DEPLOY_COMMANDS).toMatch(/vercel curl .* --deployment "\$STAGED_URL"/);
    });

    it('fails the probe on any non-success HTTP status', () => {
      /**
       * ── THE HOLE THIS CLOSES ───────────────────────────────────────────
       *
       * `vercel curl` invokes the system curl, and plain curl exits 0 for an
       * HTTP 500 — it fetched a page and does not care what the status was.
       * A probe without `--fail-with-body` therefore reports success against a
       * completely broken deployment, which is exactly the deployment this gate
       * exists to catch.
       *
       * Measured against a live deployment: a 404 exits 0 without the flag and
       * 22 with it.
       */
      expect(DEPLOY_COMMANDS).toContain('--fail-with-body');

      // Every probe goes through one helper, so the flag cannot be present on
      // some requests and missing from others.
      const probeBodies = [...DEPLOY_COMMANDS.matchAll(/vercel curl [^\n]*\n[^\n]*/g)].map(
        (m) => m[0],
      );
      expect(probeBodies.length).toBeGreaterThan(0);
      for (const body of probeBodies) expect(body).toContain('--fail-with-body');
    });

    it('never passes --token to vercel curl', () => {
      /**
       * ── THE FAILURE THIS PINS ──────────────────────────────────────────
       *
       * `vercel curl` forwards unrecognised arguments to the system curl —
       * that is how `--fail-with-body` reaches curl at all. It does the same
       * with `--token`, and curl has no such option:
       *
       *     curl: option --token=***: is unknown
       *
       * Every probe died before making a request, and the staged deployment was
       * never actually checked. The gate failed closed, which is the right
       * direction, but on its own tooling rather than on the deployment.
       *
       * Authentication comes from the step environment instead.
       */
      const curlLines = [...DEPLOY_COMMANDS.matchAll(/vercel curl [^\n]*(\n[^\n]*)?/g)].map(
        (m) => m[0],
      );
      expect(curlLines.length).toBeGreaterThan(0);
      for (const line of curlLines) expect(line).not.toContain('--token');
    });

    it('supplies the token to the health step through its environment', () => {
      const step = DEPLOY.slice(
        DEPLOY.indexOf('Health-check the staged deployment'),
        DEPLOY.indexOf('Promote the staged deployment'),
      );
      expect(step).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    });

    it('keeps --token on the commands that consume it', () => {
      // `deploy` and `promote` take the flag themselves rather than forwarding
      // it, and both have already succeeded in CI. Changing them here would be
      // an unrelated refactor riding along in a one-line fix.
      expect(DEPLOY_COMMANDS).toMatch(/vercel deploy [^\n]*--token="\$VERCEL_TOKEN"/);
      expect(DEPLOY_COMMANDS).toMatch(/vercel promote [^\n]*--token="\$VERCEL_TOKEN"/);
    });

    it('promotes within the team that owns the deployment', () => {
      /**
       * ── THE FAILURE THIS PINS ──────────────────────────────────────────
       *
       * `vercel deploy` reads VERCEL_ORG_ID and VERCEL_PROJECT_ID from the
       * environment and is pinned to the team by them. `promote` takes a URL
       * and resolves it against whatever scope the CLI is currently in — for a
       * Full Account token on a fresh runner with no default team, the personal
       * account. The deployment the previous step had just created then looked
       * foreign:
       *
       *     Error: Deployment belongs to a different team
       *
       * Staged health had already passed at that point, so a verified build sat
       * one flag away from being served.
       */
      expect(DEPLOY_COMMANDS).toMatch(/vercel promote [^\n]*--scope "\$VERCEL_ORG_ID"/);
    });

    it('gives the promote step the org id it scopes by', () => {
      const step = DEPLOY.slice(
        DEPLOY.indexOf('- name: Promote the staged deployment'),
        DEPLOY.indexOf('- name: Verify production is healthy'),
      );
      expect(step).toContain('VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}');
    });

    it('does not decide health by matching text in the body', () => {
      // The first version looked for the string "Internal Server Error", which
      // any differently-shaped error page walks straight past. Status is the
      // assertion now.
      expect(DEPLOY_COMMANDS).not.toContain("*'Internal Server Error'*");
    });

    it('requires the health body to report the database, not just a 200', () => {
      // A deployment that boots but cannot reach Supabase answers 200 with a
      // body saying so. Status alone would promote it.
      expect(DEPLOY_COMMANDS).toContain('"status":"ok"');
      expect(DEPLOY_COMMANDS).toContain('"database":"ok"');
    });

    it('probes the routes that a failed runtime takes down', () => {
      for (const path of ['/api/health', '/sign-in', '/privacy', '/.well-known/apple-app-site-association']) {
        expect(DEPLOY_COMMANDS).toContain(path);
      }
    });

    it('health-checks the staged deployment strictly before promoting it', () => {
      const staged = DEPLOY.indexOf('Health-check the staged deployment');
      const promote = DEPLOY.indexOf('Promote the staged deployment');
      const after = DEPLOY.indexOf('Verify production is healthy');

      for (const position of [staged, promote, after]) expect(position).toBeGreaterThan(-1);
      // Staged check, then promote, then the post-promotion check. Any other
      // order means production can be serving a build nothing verified.
      expect([staged, promote, after]).toEqual([staged, promote, after].sort((a, b) => a - b));
    });

    it('still verifies production after promotion', () => {
      expect(DEPLOY_COMMANDS).toContain('https://app.matchdayapps.com/api/health');
    });

    it('keeps migration parity ahead of every deployment step', () => {
      const parity = DEPLOY.indexOf('Verify migration parity');
      const stage = DEPLOY.indexOf('Create a staged production deployment');

      expect(parity).toBeGreaterThan(-1);
      expect(stage).toBeGreaterThan(parity);
    });
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
