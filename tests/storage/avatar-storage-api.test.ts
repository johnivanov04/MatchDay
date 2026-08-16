import { afterAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  jpegBlob,
  OTHER,
  OWNER,
  resolveStack,
  STACK_REQUIRED,
  uniqueObjectName,
  type LocalStack,
} from './helpers/stack';

/**
 * The half of the avatar contract that only a running Storage service can prove.
 *
 * See `helpers/stack.ts` for why this suite is separate and why it refuses to
 * skip in CI. In short: the MIME allowlist, the size cap and public object
 * retrieval are enforced by the service and by nothing in the database, so a
 * SQL test cannot reach them and a skipped run would report them as fine.
 */

// Resolved at module load rather than in `beforeAll`, so `describe.runIf` can
// see it. The difference matters: a suite guarded by an early `return` inside
// each test reports **passed** when the stack is absent, which is the exact
// outcome this file exists to make impossible.
const stack: LocalStack | null = await resolveStack();

// Two real GoTrue sessions, minted once. Also at module scope, because a
// `describe` callback is synchronous and cannot await.
const ownerToken = stack === null ? '' : await accessTokenFor(stack, OWNER);
const otherToken = stack === null ? '' : await accessTokenFor(stack, OTHER);

const object = (path: string) => `${stack!.apiUrl}/storage/v1/object/avatars/${path}`;
const publicObject = (path: string) =>
  `${stack!.apiUrl}/storage/v1/object/public/avatars/${path}`;

const written: string[] = [];

afterAll(async () => {
  if (stack === null) {
    return;
  }
  // Service role, so cleanup cannot fail for a policy reason and leave residue
  // that a later run mistakes for a test fixture.
  for (const path of written) {
    await fetch(object(path), {
      method: 'DELETE',
      headers: {
        apikey: stack.serviceRoleKey,
        Authorization: `Bearer ${stack.serviceRoleKey}`,
      },
    }).catch(() => undefined);
  }
});

describe('the stack these tests need', () => {
  it('is present whenever a missing one would have to fail the run', () => {
    // The tripwire. If `STACK_REQUIRED` is on and `resolveStack` somehow
    // returned null instead of throwing, every test below would silently skip
    // and the job would go green — so assert the invariant directly.
    if (STACK_REQUIRED) {
      expect(stack).not.toBeNull();
    } else {
      expect(true).toBe(true);
    }
  });
});

describe.runIf(stack !== null)('avatar storage, through the real Storage service', () => {
  /** Uploads as `token`, recording the object so it is cleaned up afterwards. */
  async function upload(
    token: string,
    path: string,
    body: Blob,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const response = await fetch(object(path), {
      method: 'POST',
      headers: {
        apikey: stack!.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        ...extraHeaders,
      },
      body,
    });

    if (response.ok) {
      written.push(path);
    }
    return response;
  }

  async function list(authorization: string, prefix: string): Promise<unknown[]> {
    const response = await fetch(`${stack!.apiUrl}/storage/v1/object/list/avatars`, {
      method: 'POST',
      headers: {
        apikey: stack!.anonKey,
        Authorization: `Bearer ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix, limit: 100, offset: 0 }),
    });

    expect(response.ok, 'listing itself must not error').toBe(true);
    return (await response.json()) as unknown[];
  }

  // ══ What may be written ══════════════════════════════════════════════════

  describe('uploading', () => {
    it('accepts a JPEG under the caller own prefix', async () => {
      const response = await upload(
        ownerToken,
        uniqueObjectName(OWNER.id),
        jpegBlob(),
        'image/jpeg',
      );

      expect(response.status).toBe(200);
    });

    it('refuses a non-JPEG content type', async () => {
      const response = await upload(
        ownerToken,
        uniqueObjectName(OWNER.id),
        jpegBlob(),
        'image/png',
      );

      // `allowed_mime_types` is enforced here and nowhere else — a database
      // insert would have accepted this happily.
      expect(response.ok).toBe(false);
      expect([400, 415, 422]).toContain(response.status);
    });

    it('refuses text/html, which would be stored XSS on the Supabase origin', async () => {
      const response = await upload(
        ownerToken,
        uniqueObjectName(OWNER.id),
        new Blob(['<script>alert(1)</script>']),
        'text/html',
      );

      expect(response.ok).toBe(false);
    });

    it('refuses a JPEG larger than the bucket cap', async () => {
      // 1 MiB + a little. The application refuses anything over 750 KiB before
      // this point; the bucket is the backstop behind it, and this is the only
      // way to exercise it.
      const oversized = jpegBlob(1024 * 1024 + 1024);
      expect(oversized.size).toBeGreaterThan(1_048_576);

      const response = await upload(
        ownerToken,
        uniqueObjectName(OWNER.id),
        oversized,
        'image/jpeg',
      );

      expect(response.ok).toBe(false);
      expect([400, 413]).toContain(response.status);
    });

    it('refuses an upload under another user prefix', async () => {
      const response = await upload(
        ownerToken,
        uniqueObjectName(OTHER.id),
        jpegBlob(),
        'image/jpeg',
      );

      expect(response.ok).toBe(false);
      expect([400, 403]).toContain(response.status);
    });

    it('refuses an unauthenticated upload', async () => {
      const path = uniqueObjectName(OWNER.id);
      const response = await fetch(object(path), {
        method: 'POST',
        headers: {
          apikey: stack!.anonKey,
          Authorization: `Bearer ${stack!.anonKey}`,
          'Content-Type': 'image/jpeg',
        },
        body: jpegBlob(),
      });

      expect(response.ok).toBe(false);
    });
  });

  // ══ Immutability ═════════════════════════════════════════════════════════

  describe('an object cannot be overwritten', () => {
    it('refuses a second upload to the same path', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const again = await upload(ownerToken, path, jpegBlob(64), 'image/jpeg');

      expect(again.ok).toBe(false);
      // Asserted on the body rather than the HTTP status. This Storage version
      // answers 400 while reporting `statusCode: "409"` in the payload, and
      // pinning the transport status would make this test a tripwire for a
      // Supabase release note rather than for our own behaviour. The code is
      // the part that means "this object already exists".
      expect(await again.json()).toMatchObject({ code: 'KeyAlreadyExists' });
    });

    it('refuses an explicit upsert, because there is no UPDATE policy', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      // `x-upsert: true` is how the Supabase client asks for a replacement.
      // Without an UPDATE policy the database refuses it, which is what makes
      // "every avatar URL is immutable" a property rather than a convention —
      // and is why a CDN can cache these forever.
      const upsert = await upload(ownerToken, path, jpegBlob(64), 'image/jpeg', {
        'x-upsert': 'true',
      });

      expect(upsert.ok).toBe(false);
    });

    it('refuses a PUT to an existing object', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const replaced = await fetch(object(path), {
        method: 'PUT',
        headers: {
          apikey: stack!.anonKey,
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'image/jpeg',
        },
        body: jpegBlob(64),
      });

      expect(replaced.ok).toBe(false);
    });
  });

  // ══ Reading ══════════════════════════════════════════════════════════════

  describe('retrieval and enumeration are different things', () => {
    it('serves an uploaded avatar to a signed-out reader', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      // No apikey, no Authorization — a bare public fetch, the way an <img>
      // tag and a CDN do it. This works because the bucket is public, NOT
      // because of any SELECT policy: the public endpoint never consults Row
      // Level Security. That is the distinction the whole design rests on.
      const read = await fetch(publicObject(path));

      expect(read.status).toBe(200);
      expect(read.headers.get('content-type')).toContain('image/jpeg');
    });

    it('lets a user see their own object in a listing', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const entries = await list(ownerToken, `${OWNER.id}/`);
      const names = entries.map((entry) => (entry as { name?: string }).name);

      // Needed for its own sake: Storage resolves an object row before deleting
      // it, so without SELECT on their own folder a user could not remove their
      // own avatar.
      expect(names).toContain(path.split('/')[1]);
    });

    it('shows a signed-out visitor nothing at all', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      expect(await list(stack!.anonKey, `${OWNER.id}/`)).toEqual([]);
      expect(await list(stack!.anonKey, '')).toEqual([]);
    });

    it('shows another signed-in member nothing of this user', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      // The point of scoping SELECT to the caller's own folder: a public bucket
      // must not come with a public index. Holding a URL is one thing;
      // discovering every avatar in the product, and who changed theirs and
      // when, is another.
      expect(await list(otherToken, `${OWNER.id}/`)).toEqual([]);
      expect(await list(otherToken, '')).toEqual([]);
    });

    it('describes an object to anybody who already has its exact path', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const info = await fetch(`${stack!.apiUrl}/storage/v1/object/info/avatars/${path}`, {
        headers: { apikey: stack!.anonKey, Authorization: `Bearer ${otherToken}` },
      });

      // ── PINNING THE COST OF A PUBLIC BUCKET, NOT ENDORSING IT ────────────
      //
      // This is what `public = true` buys and what it costs. Storage answers
      // `info` for a public bucket without consulting RLS, so a caller holding
      // the full path learns the object's size, content type and etag.
      //
      // That is the *same* disclosure as the image itself, to somebody who
      // already had the URL — the accepted trade written into the migration.
      // What is not possible, and is asserted above and below, is arriving at
      // that path without being given it: listing returns nothing, so there is
      // no route from "a member exists" to "here is their avatar URL".
      //
      // Asserted rather than left implicit so that a future switch to a private
      // bucket, or a Supabase change, shows up here as a decision to make.
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({ bucket_id: 'avatars' });
    });
  });

  // ══ Deleting ═════════════════════════════════════════════════════════════

  describe('deleting', () => {
    it('lets a user delete their own object, which needs SELECT as well', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const response = await fetch(object(path), {
        method: 'DELETE',
        headers: { apikey: stack!.anonKey, Authorization: `Bearer ${ownerToken}` },
      });

      expect(response.status).toBe(200);

      // Gone from the public endpoint too, which is what "remove my photo" has
      // to mean. On the body again: this version answers 400 carrying
      // `code: "NoSuchKey"`.
      const gone = await fetch(publicObject(path));
      expect(gone.ok).toBe(false);
      expect(await gone.json()).toMatchObject({ code: 'NoSuchKey' });
    });

    it('refuses a delete of another user object', async () => {
      const path = uniqueObjectName(OTHER.id);
      expect((await upload(otherToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const response = await fetch(object(path), {
        method: 'DELETE',
        headers: { apikey: stack!.anonKey, Authorization: `Bearer ${ownerToken}` },
      });

      expect(response.ok).toBe(false);
      // Still there.
      expect((await fetch(publicObject(path))).status).toBe(200);
    });

    it('refuses an unauthenticated delete', async () => {
      const path = uniqueObjectName(OWNER.id);
      expect((await upload(ownerToken, path, jpegBlob(), 'image/jpeg')).status).toBe(200);

      const response = await fetch(object(path), {
        method: 'DELETE',
        headers: { apikey: stack!.anonKey, Authorization: `Bearer ${stack!.anonKey}` },
      });

      expect(response.ok).toBe(false);
      expect((await fetch(publicObject(path))).status).toBe(200);
    });
  });

  // ══ The bucket itself ════════════════════════════════════════════════════

  describe('bucket configuration', () => {
    it('is public, JPEG-only and capped at 1 MiB', async () => {
      const response = await fetch(`${stack!.apiUrl}/storage/v1/bucket/avatars`, {
        headers: {
          apikey: stack!.serviceRoleKey,
          Authorization: `Bearer ${stack!.serviceRoleKey}`,
        },
      });

      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({
        id: 'avatars',
        public: true,
        allowed_mime_types: ['image/jpeg'],
        file_size_limit: 1_048_576,
      });
    });
  });
});
