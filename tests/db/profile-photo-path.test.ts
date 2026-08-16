import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_USERS,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * `profiles.profile_photo_path` and the constraint that gives it meaning.
 *
 * The column exists so that "is this value safe to hand to a Storage delete?"
 * is answered by *which column it came from* rather than by parsing. That only
 * holds if the column cannot hold anything else — which is what
 * `profiles_photo_path_shape` is for, and what these tests pin.
 *
 * Every case here is written through the **pool** (no `set role`), so RLS is
 * out of the picture and the constraint is the only thing that can refuse. A
 * value rejected here is rejected for service-role maintenance code and for a
 * future migration too, not merely for a signed-in user.
 */
describe('profile photo path', () => {
  let db: TestDatabase;

  const OWNER: SeedUser = SEED_USERS.multiLeaguePlayer;
  const OTHER: SeedUser = SEED_USERS.rmvfcPlayer;

  const UUID = 'a0000000-0000-4000-8000-000000000001';

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  function setPath(userId: string, path: string | null) {
    return db.pool.query('update public.profiles set profile_photo_path = $1 where id = $2', [
      path,
      userId,
    ]);
  }

  async function storedPath(userId: string): Promise<string | null> {
    const { rows } = await db.pool.query<{ profile_photo_path: string | null }>(
      'select profile_photo_path from public.profiles where id = $1',
      [userId],
    );
    return rows[0]!.profile_photo_path;
  }

  // ══ The column ═══════════════════════════════════════════════════════════

  describe('the column', () => {
    it('is nullable text, because most profiles have no photo', async () => {
      const { rows } = await db.pool.query<{ is_nullable: string; data_type: string }>(
        `select is_nullable, data_type from information_schema.columns
          where table_schema='public' and table_name='profiles'
            and column_name='profile_photo_path'`,
      );

      expect(rows[0]).toMatchObject({ is_nullable: 'YES', data_type: 'text' });
    });

    it('starts null for every seeded profile', async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.profiles where profile_photo_path is not null`,
      );

      // The migration adds a column; it must not invent values for rows that
      // predate it.
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  // ══ What it accepts ══════════════════════════════════════════════════════

  describe('accepts a well-formed path', () => {
    it('takes the row own id followed by one uuid-named jpg', async () => {
      await setPath(OWNER.id, `${OWNER.id}/${UUID}.jpg`);

      expect(await storedPath(OWNER.id)).toBe(`${OWNER.id}/${UUID}.jpg`);
    });

    it('takes a real crypto.randomUUID() value', async () => {
      // The server generates these, so the constraint has to accept whatever
      // that function produces rather than a shape somebody hand-wrote.
      const path = `${OWNER.id}/${crypto.randomUUID()}.jpg`;
      await setPath(OWNER.id, path);

      expect(await storedPath(OWNER.id)).toBe(path);
    });

    it('takes null, which is how a photo is removed', async () => {
      await setPath(OWNER.id, `${OWNER.id}/${UUID}.jpg`);
      await setPath(OWNER.id, null);

      expect(await storedPath(OWNER.id)).toBeNull();
    });
  });

  // ══ What it refuses ══════════════════════════════════════════════════════

  describe('refuses anything else', () => {
    async function expectRejected(userId: string, path: string): Promise<void> {
      const error = await expectDatabaseError(() => setPath(userId, path));
      expect(error.code, path).toBe(PG_ERROR.checkViolation);
      expect(error.message, path).toContain('profiles_photo_path_shape');
    }

    it('refuses another member folder', async () => {
      // The one that matters most. A row recording somebody else's path would
      // turn "clean up my old avatar" into "delete theirs".
      await expectRejected(OWNER.id, `${OTHER.id}/${UUID}.jpg`);
    });

    it('refuses a nested path', async () => {
      for (const path of [
        `${OWNER.id}/nested/${UUID}.jpg`,
        `${OWNER.id}/${OWNER.id}/${UUID}.jpg`,
        `other/${OWNER.id}/${UUID}.jpg`,
      ]) {
        await expectRejected(OWNER.id, path);
      }
    });

    it('refuses a bare filename with no folder', async () => {
      await expectRejected(OWNER.id, `${UUID}.jpg`);
    });

    it('refuses a wrong extension', async () => {
      for (const extension of ['.png', '.jpeg', '.JPG', '.jpg.html', '.svg', '']) {
        await expectRejected(OWNER.id, `${OWNER.id}/${UUID}${extension}`);
      }
    });

    it('refuses a filename that is not a uuid', async () => {
      for (const filename of ['avatar.jpg', 'not-a-uuid.jpg', `${UUID}x.jpg`, `x${UUID}.jpg`]) {
        await expectRejected(OWNER.id, `${OWNER.id}/${filename}`);
      }
    });

    it('refuses an upper-case uuid, because the server never produces one', async () => {
      await expectRejected(OWNER.id, `${OWNER.id}/${UUID.toUpperCase()}.jpg`);
    });

    it('refuses traversal and separator tricks', async () => {
      for (const path of [
        `${OWNER.id}/../${OTHER.id}/${UUID}.jpg`,
        `../${OWNER.id}/${UUID}.jpg`,
        `${OWNER.id}//${UUID}.jpg`,
        `/${OWNER.id}/${UUID}.jpg`,
        `${OWNER.id}/${UUID}.jpg/`,
      ]) {
        await expectRejected(OWNER.id, path);
      }
    });

    it('refuses an empty string, which is not the same as no photo', async () => {
      await expectRejected(OWNER.id, '');
    });

    it('refuses a full URL', async () => {
      await expectRejected(
        OWNER.id,
        `https://example.supabase.co/storage/v1/object/public/avatars/${OWNER.id}/${UUID}.jpg`,
      );
    });
  });

  // ══ Interaction with the rest of the row ═════════════════════════════════

  describe('alongside the legacy column', () => {
    it('lets both be set, because a legacy row is not something to trust', async () => {
      // Nothing this product does leaves both populated — a managed upload
      // clears the URL. The constraint does not forbid it, and pinning that is
      // the honest thing: the rendering priority in `avatarImageUrl` is what
      // resolves the case, not a database rule that does not exist.
      await db.pool.query(
        `update public.profiles
            set profile_photo_path = $1, profile_photo_url = $2
          where id = $3`,
        [`${OWNER.id}/${UUID}.jpg`, 'https://legacy.test/old.jpg', OWNER.id],
      );

      const { rows } = await db.pool.query<{
        profile_photo_path: string;
        profile_photo_url: string;
      }>('select profile_photo_path, profile_photo_url from public.profiles where id = $1', [
        OWNER.id,
      ]);

      expect(rows[0]!.profile_photo_path).toBe(`${OWNER.id}/${UUID}.jpg`);
      expect(rows[0]!.profile_photo_url).toBe('https://legacy.test/old.jpg');
    });

    it('does not loosen the legacy https rule', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set profile_photo_url = $1 where id = $2', [
          'http://insecure.test/a.jpg',
          OWNER.id,
        ]),
      );

      expect(error.message).toContain('profiles_photo_url_scheme');
    });
  });

  // ══ Through RLS, as the application writes it ════════════════════════════

  describe('written by the user themselves', () => {
    it('lets a member set their own path', async () => {
      await asUser(db, OWNER, (client) =>
        client.query('update public.profiles set profile_photo_path = $1 where id = $2', [
          `${OWNER.id}/${UUID}.jpg`,
          OWNER.id,
        ]),
      );
      // Rolled back by `asUser`; the assertion is that it did not raise.
      expect(true).toBe(true);
    });

    it('does not let a member touch another profile row', async () => {
      await asUser(db, OWNER, (client) =>
        client.query('update public.profiles set profile_photo_path = $1 where id = $2', [
          `${OTHER.id}/${UUID}.jpg`,
          OTHER.id,
        ]),
      );

      // RLS filters the row out entirely, so the constraint is never even
      // reached. Two independent layers, and this asserts the outer one.
      expect(await storedPath(OTHER.id)).toBeNull();
    });
  });
});
