import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import type { ProvidedContext } from 'vitest';
import { applyAuthShim, applyMigrations, applySeed, REPO_ROOT } from './sql';

/**
 * Structural type for the global-setup argument. Declared locally rather than
 * imported so the suite does not depend on which Vitest release exports the
 * corresponding name.
 */
interface GlobalSetupContext {
  provide<Key extends keyof ProvidedContext>(key: Key, value: ProvidedContext[Key]): void;
}

export interface DbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Maintenance database used to CREATE/DROP the per-file test databases. */
  maintenanceDatabase: string;
  /** Schema only: migrations applied, no rows. */
  schemaTemplate: string;
  /** Schema plus `supabase/seed.sql`. */
  seededTemplate: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    matchdayDb: DbConnection;
  }
}

const SCHEMA_TEMPLATE = 'matchday_tpl_schema';
const SEEDED_TEMPLATE = 'matchday_tpl_seeded';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function parseExternalUrl(rawUrl: string): Omit<
  DbConnection,
  'schemaTemplate' | 'seededTemplate'
> {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username) || 'postgres',
    password: decodeURIComponent(url.password),
    maintenanceDatabase: url.pathname.replace(/^\//, '') || 'postgres',
  };
}

async function connect(connection: DbConnection, database: string): Promise<Client> {
  const client = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database,
  });
  await client.connect();
  return client;
}

/**
 * Builds a template database and populates it, then disconnects. Test files
 * clone these with `CREATE DATABASE ... TEMPLATE ...`, which requires that no
 * session is connected to the template — hence the careful close below.
 */
async function buildTemplate(
  connection: DbConnection,
  templateName: string,
  withSeed: boolean,
): Promise<void> {
  const maintenance = await connect(connection, connection.maintenanceDatabase);
  try {
    await maintenance.query(`drop database if exists ${templateName} with (force)`);
    await maintenance.query(`create database ${templateName}`);
  } finally {
    await maintenance.end();
  }

  const template = await connect(connection, templateName);
  try {
    await applyAuthShim(template);
    await applyMigrations(template);
    if (withSeed) {
      await applySeed(template);
    }
  } finally {
    await template.end();
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const externalUrl = process.env['TEST_DATABASE_URL'];

  if (externalUrl !== undefined && externalUrl.trim() !== '') {
    // Reuse a database the developer already has running — for example
    // `supabase start`, which listens on 54322.
    const connection: DbConnection = {
      ...parseExternalUrl(externalUrl),
      schemaTemplate: SCHEMA_TEMPLATE,
      seededTemplate: SEEDED_TEMPLATE,
    };

    await buildTemplate(connection, SCHEMA_TEMPLATE, false);
    await buildTemplate(connection, SEEDED_TEMPLATE, true);
    provide('matchdayDb', connection);

    return async () => {
      const maintenance = await connect(connection, connection.maintenanceDatabase);
      try {
        await maintenance.query(`drop database if exists ${SCHEMA_TEMPLATE} with (force)`);
        await maintenance.query(`drop database if exists ${SEEDED_TEMPLATE} with (force)`);
      } finally {
        await maintenance.end();
      }
    };
  }

  // No external database configured: boot a throwaway PostgreSQL server. This
  // is a real server, so the RLS, deferred-constraint and trigger behaviour
  // under test is real behaviour, not a simulation.
  const tmpRoot = join(REPO_ROOT, '.tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const dataDir = mkdtempSync(join(tmpRoot, 'pg-'));
  const port = await findFreePort();

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => {
      /* PostgreSQL's startup chatter is not useful test output. */
    },
  });

  await server.initialise();
  await server.start();

  const connection: DbConnection = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    maintenanceDatabase: 'postgres',
    schemaTemplate: SCHEMA_TEMPLATE,
    seededTemplate: SEEDED_TEMPLATE,
  };

  try {
    await buildTemplate(connection, SCHEMA_TEMPLATE, false);
    await buildTemplate(connection, SEEDED_TEMPLATE, true);
  } catch (error) {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  provide('matchdayDb', connection);

  return async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
