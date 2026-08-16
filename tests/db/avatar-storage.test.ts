import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_USERS,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * The `avatars` bucket, and who may touch an object in it.
 *
 * ── WHAT THESE TESTS PROVE, AND WHAT THEY CANNOT ───────────────────────────
 *
 * The ownership model is `avatars/{auth.uid()}/{uuid}.jpg` — the first path
 * segment *is* the authorization, and every policy compares it against the
 * session. These tests evaluate those policy expressions against a real
 * PostgreSQL server with real JWT claims, which is how they behave in
 * production.
 *
 * What they deliberately do not cover: `allowed_mime_types`, `file_size_limit`
 * and public object retrieval are handled by the Storage **service**, never by
 * a constraint or a policy, so a direct SQL insert bypasses all three by
 * design. Those are covered against a running stack in
 * `tests/storage/avatar-storage-api.test.ts`, which speaks HTTP to the real
 * service and refuses to skip in CI.
 */
describe('avatar storage', () => {
  let db: TestDatabase;

  // Typed as `SeedUser` so both can be passed to the same helper; the literal
  // types inferred from the constant would otherwise be mutually incompatible.
  const OWNER: SeedUser = SEED_USERS.multiLeaguePlayer;
  const OTHER: SeedUser = SEED_USERS.rmvfcPlayer;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  const objectPath = (userId: string, file = 'a0000000-0000-4000-8000-000000000001.jpg') =>
    `${userId}/${file}`;

  /** Inserts an object as `user`, the way the Storage service does on upload. */
  function upload(user: SeedUser, path: string) {
    return asUserCommitting(db, user, (client) =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner) values ('avatars', $1, $2)`,
        [path, user.id],
      ),
    );
  }

  async function objectCount(path: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from storage.objects where bucket_id = 'avatars' and name = $1`,
      [path],
    );
    return Number(rows[0]!.n);
  }

  // ══ The bucket ═══════════════════════════════════════════════════════════

  describe('the bucket', () => {
    it('exists', async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        `select id from storage.buckets where id = 'avatars'`,
      );

      expect(rows).toHaveLength(1);
    });

    it('is public, so a face renders without signing a URL per player', async () => {
      const { rows } = await db.pool.query<{ public: boolean }>(
        `select public from storage.buckets where id = 'avatars'`,
      );

      expect(rows[0]!.public).toBe(true);
    });

    it('accepts image/jpeg and nothing else', async () => {
      const { rows } = await db.pool.query<{ allowed_mime_types: string[] }>(
        `select allowed_mime_types from storage.buckets where id = 'avatars'`,
      );

      // One stored format keeps the server-side magic-byte check to a single
      // signature, and an allowlist of one is the narrowest thing that can be
      // served from a domain we do not control.
      expect(rows[0]!.allowed_mime_types).toEqual(['image/jpeg']);
    });

    it('caps object size at 1 MiB', async () => {
      const { rows } = await db.pool.query<{ file_size_limit: string }>(
        `select file_size_limit from storage.buckets where id = 'avatars'`,
      );

      // The application refuses anything over 750 KiB first; this is the
      // backstop behind it.
      expect(Number(rows[0]!.file_size_limit)).toBe(1_048_576);
    });
  });

  // ══ Which policies exist at all ══════════════════════════════════════════

  describe('the policy set', () => {
    async function avatarPolicies(): Promise<{ policyname: string; cmd: string }[]> {
      const { rows } = await db.pool.query<{ policyname: string; cmd: string }>(
        `select policyname, cmd from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname like 'avatars_%'
          order by policyname`,
      );
      return rows;
    }

    it('is exactly select-own, insert-own and delete-own', async () => {
      expect((await avatarPolicies()).map((row) => row.policyname)).toEqual([
        'avatars_delete_own',
        'avatars_insert_own',
        'avatars_select_own',
      ]);
    });

    it('has no UPDATE policy, which is what makes an object immutable', async () => {
      // Uploads always write a new uuid and the application never upserts, so
      // the ability to modify an existing object is a capability nobody needs.
      // Its absence is why "an avatar URL never changes meaning" is a property
      // of the database rather than a promise about application code.
      expect((await avatarPolicies()).map((row) => row.cmd)).not.toContain('UPDATE');
    });

    it('grants no blanket read, so a public bucket is not a public index', async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and 'anon' = any(roles)`,
      );

      // Object *retrieval* is public and goes through the Storage service,
      // which never reads these rows. A policy letting `anon` select from
      // `storage.objects` would add nothing to that and would hand every
      // visitor a listable catalogue of every avatar in the product.
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  // ══ Writing ══════════════════════════════════════════════════════════════

  describe('uploading', () => {
    it('lets a user write under their own prefix', async () => {
      await upload(OWNER, objectPath(OWNER.id));

      expect(await objectCount(objectPath(OWNER.id))).toBe(1);
    });

    it('refuses a write under another user prefix', async () => {
      const error = await expectDatabaseError(() => upload(OWNER, objectPath(OTHER.id)));

      // The whole ownership model in one assertion: the path is the
      // authorization, so a caller cannot reach another player's folder.
      expect(error.message).toMatch(/row-level security/i);
      expect(await objectCount(objectPath(OTHER.id))).toBe(0);
    });

    it('refuses a path with no user folder at all', async () => {
      const error = await expectDatabaseError(() => upload(OWNER, 'loose-file.jpg'));

      expect(error.message).toMatch(/row-level security/i);
    });

    it('refuses a path that only looks like the caller folder', async () => {
      for (const path of [
        `${OTHER.id}/${OWNER.id}/x.jpg`,
        `nested/${OWNER.id}/x.jpg`,
        `${OWNER.id}x/x.jpg`,
      ]) {
        const error = await expectDatabaseError(() => upload(OWNER, path));
        expect(error.message, path).toMatch(/row-level security/i);
      }
    });

    it('refuses an anonymous write', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query(
            `insert into storage.objects (bucket_id, name) values ('avatars', $1)`,
            [objectPath(OWNER.id)],
          ),
        ),
      );

      expect(error.message).toMatch(/row-level security|permission denied/i);
    });
  });

  // ══ Reading rows ═════════════════════════════════════════════════════════

  describe('object metadata is not browsable', () => {
    beforeEach(async () => {
      await upload(OWNER, objectPath(OWNER.id));
      await upload(OTHER, objectPath(OTHER.id));
    });

    async function visibleNames(user: SeedUser): Promise<string[]> {
      return asUser(db, user, async (client) => {
        const result = await client.query<{ name: string }>(
          `select name from storage.objects where bucket_id = 'avatars' order by name`,
        );
        return result.rows.map((row) => row.name);
      });
    }

    it('shows a user their own object', async () => {
      // Needed for its own sake, not for rendering: Storage resolves an object
      // row before removing it, so without SELECT on their own folder a user
      // could not delete their own avatar.
      expect(await visibleNames(OWNER)).toEqual([objectPath(OWNER.id)]);
    });

    it('hides another member object from a signed-in user', async () => {
      expect(await visibleNames(OTHER)).toEqual([objectPath(OTHER.id)]);
      expect(await visibleNames(OTHER)).not.toContain(objectPath(OWNER.id));
    });

    it('shows a signed-out visitor nothing', async () => {
      const rows = await asAnon(db, async (client) => {
        const result = await client.query(
          `select name from storage.objects where bucket_id = 'avatars'`,
        );
        return result.rows;
      });

      // A public bucket serves objects by URL. It does not, and must not, come
      // with a way to discover which URLs exist.
      expect(rows).toHaveLength(0);
    });
  });

  // ══ Overwriting ══════════════════════════════════════════════════════════

  describe('an existing object cannot be modified', () => {
    beforeEach(async () => {
      await upload(OWNER, objectPath(OWNER.id));
    });

    it('refuses to rename or re-point the caller own object', async () => {
      await asUserCommitting(db, OWNER, (client) =>
        client.query(`update storage.objects set name = $1 where name = $2`, [
          objectPath(OWNER.id, 'b0000000-0000-4000-8000-000000000002.jpg'),
          objectPath(OWNER.id),
        ]),
      );

      // No UPDATE policy, so RLS filters the row out of the statement rather
      // than raising. The assertion is that nothing moved.
      expect(await objectCount(objectPath(OWNER.id))).toBe(1);
      expect(
        await objectCount(objectPath(OWNER.id, 'b0000000-0000-4000-8000-000000000002.jpg')),
      ).toBe(0);
    });

    it('refuses to overwrite the metadata of an existing object', async () => {
      await asUserCommitting(db, OWNER, (client) =>
        client.query(`update storage.objects set owner = $1 where name = $2`, [
          OTHER.id,
          objectPath(OWNER.id),
        ]),
      );

      const { rows } = await db.pool.query<{ owner: string }>(
        `select owner from storage.objects where name = $1`,
        [objectPath(OWNER.id)],
      );
      expect(rows[0]!.owner).toBe(OWNER.id);
    });
  });

  // ══ Deleting ═════════════════════════════════════════════════════════════

  describe('deleting', () => {
    beforeEach(async () => {
      await upload(OWNER, objectPath(OWNER.id));
      await upload(OTHER, objectPath(OTHER.id));
    });

    it('lets a user delete their own object', async () => {
      // This is how an old avatar is cleaned up after a replacement.
      await asUserCommitting(db, OWNER, (client) =>
        client.query(`delete from storage.objects where name = $1`, [objectPath(OWNER.id)]),
      );

      expect(await objectCount(objectPath(OWNER.id))).toBe(0);
    });

    it('cannot delete another user object', async () => {
      await asUserCommitting(db, OWNER, (client) =>
        client.query(`delete from storage.objects where name = $1`, [objectPath(OTHER.id)]),
      );

      // RLS filters the row out of the DELETE rather than raising, so the
      // assertion is that it survived.
      expect(await objectCount(objectPath(OTHER.id))).toBe(1);
    });

    it('cannot delete everything in the bucket', async () => {
      await asUserCommitting(db, OWNER, (client) =>
        client.query(`delete from storage.objects where bucket_id = 'avatars'`),
      );

      // Only their own row goes.
      expect(await objectCount(objectPath(OWNER.id))).toBe(0);
      expect(await objectCount(objectPath(OTHER.id))).toBe(1);
    });
  });

  // ══ Nothing else moved ═══════════════════════════════════════════════════

  describe('existing profile privacy is unchanged', () => {
    it('still hides another member profile row from a player', async () => {
      const rows = await asUser(db, OTHER, async (client) => {
        const result = await client.query('select id from public.profiles where id = $1', [
          OWNER.id,
        ]);
        return result.rows;
      });

      // Making avatar objects publicly *retrievable* must not have made any
      // other profile data readable. Only self and league administrators may
      // read a profile row.
      expect(rows).toHaveLength(0);
    });

    it('leaves the legacy photo url column and its constraint untouched', async () => {
      const { rows } = await db.pool.query<{ is_nullable: string; data_type: string }>(
        `select is_nullable, data_type from information_schema.columns
          where table_schema='public' and table_name='profiles'
            and column_name='profile_photo_url'`,
      );

      expect(rows[0]).toMatchObject({ is_nullable: 'YES', data_type: 'text' });
    });

    it('still refuses a non-https legacy photo url', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set profile_photo_url = $1 where id = $2', [
          'http://insecure.test/a.jpg',
          OWNER.id,
        ]),
      );

      expect(error.message).toContain('profiles_photo_url_scheme');
    });
  });
});
