#!/usr/bin/env node
/**
 * Runs one pass of the due-reminder generator against the local database.
 *
 * THIS IS NOT A SCHEDULER. It is the operation a scheduler invokes, exposed for
 * local development and for verifying the behaviour by hand. Nothing in this
 * repository runs it on a cadence, because no cron or queue infrastructure is
 * configured here — `POST /api/cron/reminders` is the production entry point
 * and `NEXT_STEPS.md` records what must call it. Pretending a scheduler exists
 * would leave a product whose reminders silently never arrive.
 *
 * Safe to run repeatedly and safe to run twice at once: `generate_due_reminders`
 * claims pending rows with `for update skip locked`, so a second concurrent
 * pass finds nothing rather than sending a second copy, and every notification
 * carries an idempotency key as a second line of defence.
 *
 * This script creates the canonical notifications only. Web Push for reminders
 * is dispatched by the cron route, which can reach the push pipeline; the inbox
 * is the source of truth either way.
 *
 *   npm run reminders:run [limit]
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadLocalEnv() {
  // `.env.local` is loaded by Next.js, not by a plain node script.
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match !== null && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}

loadLocalEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const limit = Number(process.argv[2] ?? '100');

if (url === undefined || serviceRoleKey === undefined) {
  console.error(
    'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running reminders.',
  );
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await supabase.rpc('generate_due_reminders', { p_limit: limit });

if (error !== null) {
  console.error('Reminder generation failed:', error.message);
  process.exit(1);
}

const claimed = data ?? [];
const notified = claimed.reduce((total, row) => total + row.notified, 0);

console.log(
  `Claimed ${String(claimed.length)} reminder occurrence(s); ` +
    `created ${String(notified)} notification(s).`,
);
