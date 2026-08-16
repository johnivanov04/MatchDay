'use server';

import { revalidatePath } from 'next/cache';
import { requireCurrentProfile } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { logInfo, logWarn } from '@/lib/observability/log';
import {
  AVATAR_BUCKET,
  AVATAR_CONTENT_TYPE,
  AVATAR_FILE_FIELD,
  isManagedAvatarPath,
  MAX_PROCESSED_BYTES,
} from '@/lib/profile/avatar';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Uploading, replacing and removing a profile photo.
 *
 * ── THIS IS A PUBLIC MUTATION ENDPOINT ─────────────────────────────────────
 *
 * A Server Action is an HTTP endpoint with a generated name. Anybody can POST
 * to it with any body they like; the form in the browser is a convenience, not
 * a gate. So nothing here trusts the submission for anything that matters:
 *
 *   * **who** comes from `requireCurrentProfile()`, which revalidates the
 *     session token with Supabase. There is no user id in the form to forge,
 *     and one submitted anyway is simply never read;
 *   * **where** is `{authenticated user id}/{server-generated uuid}.jpg`. The
 *     caller cannot influence either half, so no path traversal, no collision
 *     with somebody else's folder, and no overwriting of an existing object;
 *   * **what** is checked three ways — declared content type, actual size, and
 *     the JPEG signature in the leading bytes — before a single byte reaches
 *     Storage.
 *
 * On top of that the Storage policies confine writes to the caller's own folder
 * and the `profiles_photo_path_shape` constraint refuses to record a path
 * belonging to anybody else. Every one of these three layers is independently
 * sufficient; that is the point of having them.
 *
 * The client here is the ordinary session-scoped one. The service-role key is
 * never involved: an avatar upload is a thing a user does as themselves, and
 * borrowing an RLS-bypassing key to do it would discard the strongest guarantee
 * in the design.
 */

/** `FF D8 FF` — start-of-image plus the first marker. Every JPEG begins here. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

function invalid(message: string): DomainError {
  // Reported against the picker's own field so it renders next to the control
  // rather than as a page-level banner.
  return new DomainError('VALIDATION_FAILED', { fieldErrors: { avatar: message } });
}

/** A `File`-shaped entry, without depending on the global class identity. */
function isUploadedFile(value: unknown): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === 'function' &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).type === 'string'
  );
}

/**
 * Stores a new avatar and points the profile at it.
 *
 * ── ORDER OF OPERATIONS, AND WHY ───────────────────────────────────────────
 *
 * There is no transaction spanning object storage and PostgreSQL, so the order
 * is chosen to make every possible interruption leave the player with a working
 * profile:
 *
 *   1. **Upload the new object.** It is immutable and unreferenced, so a crash
 *      here costs an orphan and nothing else. The profile still shows the old
 *      photo.
 *   2. **Point the profile at it, clearing the legacy URL.** This is the commit
 *      point: before it the old avatar is live, after it the new one is.
 *   3. **If (2) failed**, delete the object written in (1) and report the
 *      failure. The player keeps the avatar they had.
 *   4. **Only once (2) succeeded**, delete the object the profile used to
 *      reference. Failure here is logged and swallowed — the upload genuinely
 *      worked, and turning a successful save into an error message because a
 *      *previous* file could not be tidied away would be a lie about what
 *      happened.
 *
 * The one thing never attempted is a deletion derived from `profile_photo_url`.
 * That column can hold any address on the internet on a legacy row; only a
 * value that came out of `profile_photo_path` and passes `isManagedAvatarPath`
 * is ever handed to Storage.
 */
export async function uploadAvatarAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    // Identity first, and from the session only. Anything the form claims about
    // who is uploading is ignored — there is no branch that reads it.
    const profile = await requireCurrentProfile();

    const submitted: unknown = formData.get(AVATAR_FILE_FIELD);
    if (!isUploadedFile(submitted)) {
      throw invalid('Choose a photo to upload.');
    }

    if (submitted.type !== AVATAR_CONTENT_TYPE) {
      throw invalid('That photo could not be prepared. Try choosing it again.');
    }
    if (submitted.size === 0) {
      throw invalid('That photo appears to be empty. Try another one.');
    }
    if (submitted.size > MAX_PROCESSED_BYTES) {
      throw invalid('That photo is too large. Try another one.');
    }

    const bytes = new Uint8Array(await submitted.arrayBuffer());

    // Re-measured from the bytes actually received rather than from the
    // declared size, which is a claim made by the sender.
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROCESSED_BYTES) {
      throw invalid('That photo is too large. Try another one.');
    }

    // A declared content type is a string somebody chose. This is the file.
    if (!JPEG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      throw invalid('That file is not a JPEG image. Try another photo.');
    }

    const objectName = `${profile.id}/${crypto.randomUUID()}.jpg`;
    const supabase = await createSupabaseServerClient();

    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(objectName, bytes, {
        contentType: AVATAR_CONTENT_TYPE,
        // Immutable objects, always. Without this a replayed request could
        // overwrite an object already being served, and a CDN would keep
        // handing out whichever version it cached first.
        upsert: false,
      });

    if (uploadError !== null) {
      throw invalid('We could not save that photo. Please try again.');
    }

    const previousPath = isManagedAvatarPath(profile.profile_photo_path, profile.id)
      ? profile.profile_photo_path
      : null;

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ profile_photo_path: objectName, profile_photo_url: null })
      .eq('id', profile.id);

    if (profileError !== null) {
      // Nothing references the new object, so removing it is safe and leaves
      // the previous avatar exactly as it was.
      await removeObject(supabase, objectName, 'rollback');
      throw invalid('We could not save that photo. Please try again.');
    }

    if (previousPath !== null && previousPath !== objectName) {
      await removeObject(supabase, previousPath, 'previous');
    }

    logInfo('avatar.uploaded', { bytes: bytes.byteLength, replaced: previousPath !== null });

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Removes the current avatar.
 *
 * The profile is cleared **first**, then the object is deleted. That ordering is
 * the opposite of the upload's for the same reason: whichever step fails, the
 * player must end up seeing what they asked for. Deleting the object first
 * would, on a failed update, leave a profile pointing at a file that no longer
 * exists — a broken image, which is worse than an orphaned one nobody can find.
 *
 * `profile_photo_url` is cleared too, so a legacy photo is removed by the same
 * button. It is never deleted from wherever it is hosted, because this product
 * did not put it there.
 */
export async function removeAvatarAction(
  _previous: ActionResult<undefined> | null,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const profile = await requireCurrentProfile();
    const supabase = await createSupabaseServerClient();

    const previousPath = isManagedAvatarPath(profile.profile_photo_path, profile.id)
      ? profile.profile_photo_path
      : null;

    const { error } = await supabase
      .from('profiles')
      .update({ profile_photo_path: null, profile_photo_url: null })
      .eq('id', profile.id);

    if (error !== null) {
      throw invalid('We could not remove that photo. Please try again.');
    }

    if (previousPath !== null) {
      await removeObject(supabase, previousPath, 'removed');
    }

    logInfo('avatar.removed', { had_object: previousPath !== null });

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Best-effort object deletion. Never throws, never logs the path.
 *
 * An orphaned 50 KB object is a housekeeping matter. A profile that will not
 * save because Storage was briefly unreachable is an outage the player
 * experiences. Only `stage` is recorded, which is enough to notice a pattern
 * without putting an object key — and therefore a live public URL — into a log
 * aggregator.
 */
async function removeObject(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  path: string,
  stage: 'rollback' | 'previous' | 'removed',
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([path]);
    if (error !== null) {
      logWarn('avatar.cleanup_failed', { stage });
    }
  } catch {
    logWarn('avatar.cleanup_failed', { stage });
  }
}
