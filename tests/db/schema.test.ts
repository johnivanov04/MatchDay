import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/harness';
import { listMigrationFiles } from './helpers/sql';

const TENANT_TABLES = [
  'league_memberships',
  'league_membership_admin_notes',
  'audit_events',
] as const;

const ALL_PUBLIC_TABLES = [
  'profiles',
  'leagues',
  'league_memberships',
  'league_membership_admin_notes',
  'audit_events',
  'user_app_state',
] as const;

describe('schema', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('schema');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('migrations', () => {
    it('are named forward-only: <14-digit timestamp>_<snake_case>.sql', () => {
      const files = listMigrationFiles();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      }
    });

    it('have unique, strictly increasing timestamps', () => {
      const timestamps = listMigrationFiles().map((file) => file.slice(0, 14));
      expect(new Set(timestamps).size).toBe(timestamps.length);
      expect([...timestamps].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(timestamps);
    });
  });

  describe('domain enums', () => {
    it.each([
      ['league_visibility', ['private', 'searchable']],
      ['league_role', ['league_admin', 'player']],
      ['membership_status', ['pending', 'active', 'suspended', 'removed']],
      ['selection_mode', ['first_come', 'admin_approval']],
      ['waitlist_mode', ['automatic', 'admin_controlled']],
    ])('%s has exactly the specified labels', async (typeName, labels) => {
      const { rows } = await db.pool.query<{ label: string }>(
        `select e.enumlabel as label
           from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typname = $1
          order by e.enumsortorder`,
        [typeName],
      );
      expect(rows.map((row) => row.label)).toEqual(labels);
    });
  });

  describe('product constraint: no skill level or skill rating exists', () => {
    it('has no column resembling a skill field', async () => {
      const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public'
            and (column_name ilike '%skill%' or column_name ilike '%rating%')`,
      );
      expect(rows).toEqual([]);
    });

    it('has no enum label resembling a skill field', async () => {
      const { rows } = await db.pool.query<{ label: string }>(
        `select e.enumlabel as label
           from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
            and (e.enumlabel ilike '%skill%' or e.enumlabel ilike '%rating%')`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('profile fields', () => {
    it('stores every required and optional profile field from the specification', async () => {
      const { rows } = await db.pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'profiles'`,
      );
      const nullability = new Map(rows.map((row) => [row.column_name, row.is_nullable]));

      for (const required of ['first_name', 'last_name', 'email_normalized']) {
        expect(nullability.get(required), `${required} must exist and be required`).toBe('NO');
      }
      for (const optional of ['phone', 'gender', 'goalkeeper_willing', 'profile_photo_url']) {
        expect(nullability.get(optional), `${optional} must exist and be optional`).toBe('YES');
      }
      // Array column: NOT NULL with an empty-array default, so "no positions"
      // is an empty list rather than a null that every caller must handle.
      expect(nullability.get('preferred_positions')).toBe('NO');
    });
  });

  describe('row level security', () => {
    it.each(ALL_PUBLIC_TABLES)('is enabled and forced on %s', async (table) => {
      const { rows } = await db.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.relrowsecurity).toBe(true);
      expect(rows[0]?.relforcerowsecurity).toBe(true);
    });

    it('leaves no table in the public schema without RLS', async () => {
      const { rows } = await db.pool.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`,
      );
      expect(rows.map((row) => row.relname)).toEqual([]);
    });

    it('grants the anon role no privileges on any public table', async () => {
      const { rows } = await db.pool.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public' and grantee = 'anon'`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('tenancy', () => {
    it.each(TENANT_TABLES)('%s carries a non-null league_id', async (table) => {
      const { rows } = await db.pool.query<{ is_nullable: string }>(
        `select is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = 'league_id'`,
        [table],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_nullable).toBe('NO');
    });

    it.each(TENANT_TABLES)('%s.league_id references leagues', async (table) => {
      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on kcu.constraint_name = tc.constraint_name
            and kcu.table_schema = tc.table_schema
           join information_schema.constraint_column_usage ccu
             on ccu.constraint_name = tc.constraint_name
            and ccu.table_schema = tc.table_schema
          where tc.constraint_type = 'FOREIGN KEY'
            and tc.table_schema = 'public'
            and tc.table_name = $1
            and kcu.column_name = 'league_id'
            and ccu.table_name = 'leagues'`,
        [table],
      );
      expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);
    });
  });

  describe('indexes for common league and membership queries', () => {
    it.each([
      'profiles_email_normalized_key',
      'leagues_slug_key',
      'leagues_searchable_idx',
      'league_memberships_league_user_key',
      'league_memberships_single_active_admin_key',
      'league_memberships_user_status_idx',
      'league_memberships_league_status_idx',
      'league_memberships_league_role_active_idx',
      'audit_events_league_created_idx',
      'audit_events_entity_idx',
      'audit_events_actor_created_idx',
      'user_app_state_active_league_idx',
    ])('%s exists', async (indexName) => {
      const { rows } = await db.pool.query(
        `select 1 from pg_indexes where schemaname = 'public' and indexname = $1`,
        [indexName],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
