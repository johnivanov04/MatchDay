'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/field';
import { CheckIcon, ImageIcon } from '@/components/ui/icon';
import { AVATAR_FILE_FIELD } from '@/lib/profile/avatar';
import { AvatarImageError, avatarImageMessage, processAvatarImage } from '@/lib/profile/image';
import { removeAvatarAction, uploadAvatarAction } from '@/server/actions/avatar';

/**
 * Choosing, previewing and saving a profile photo.
 *
 * ── THE WHOLE FLOW, IN ORDER ───────────────────────────────────────────────
 *
 *   tap → native picker → preview appears at once → the browser re-encodes it
 *   → tap Save → upload → the profile points at the new object
 *
 * The preview appears from the *original* file, immediately, because decoding
 * and re-encoding an 8 MB photo takes a noticeable moment on a phone and an
 * empty circle during it reads as nothing having happened. It is then replaced
 * by a preview of the processed image, which is what will actually be stored —
 * so what is on screen when Save is tapped is exactly what gets uploaded,
 * cropping and all.
 *
 * ── NOTHING IS UPLOADED UNTIL SAVE ─────────────────────────────────────────
 *
 * Choosing a photo is reversible and costs no bandwidth. This is deliberate on
 * a phone: the picker is easy to mis-tap, and an upload that begins the instant
 * a thumbnail is touched cannot be taken back.
 *
 * ── NO URL INPUT ───────────────────────────────────────────────────────────
 *
 * There used to be a text field here for pasting an image address. It is gone,
 * and `saveProfileAction` no longer reads such a field even if one were added
 * to the DOM by hand. Existing pasted addresses still render, and Remove still
 * clears them; they just cannot be authored any more.
 */

export interface AvatarPickerProps {
  /** The avatar currently stored, already resolved to a URL. */
  currentSrc: string | null;
  initials: string;
  label: string;
}

type Phase = 'idle' | 'processing' | 'saving' | 'removing';

export function AvatarPicker({ currentSrc, initials, label }: AvatarPickerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processed, setProcessed] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * What the client knows about the stored photo that `currentSrc` does not yet.
   *
   * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
   *
   * `currentSrc` is a server prop. A save writes the new object, then calls
   * `router.refresh()`, and the prop only carries the new URL once that RSC
   * round trip lands — around 50ms locally and appreciably longer on a loaded
   * CI runner. The old code dropped the local preview the instant the action
   * resolved, in the same commit that rendered "Photo saved.", so for the whole
   * width of that window the avatar fell back to `currentSrc` and **the
   * previous photo reappeared underneath a success message**.
   *
   * Nobody noticed on the first upload, where the fallback is `null` and the
   * circle merely shows initials for a moment. Changing an existing photo is
   * where it bites, and the end-to-end suite caught it there: the assertion
   * that a change produces a different object URL read the old one and failed,
   * on CI and on 17 of 20 local repetitions.
   *
   * `against` records what `currentSrc` was when the write succeeded; the prop
   * differing from it is how this component learns the refresh has landed.
   * `src` is what to show until then — the processed preview after a save, and
   * `null` after a removal, which fixes the same race in the other direction.
   */
  const [pending, setPending] = useState<{ src: string | null; against: string | null } | null>(
    null,
  );

  // Object URLs are held by the document until revoked, so a session of trying
  // six photos would otherwise pin six full-size images in memory.
  const previewRef = useRef<string | null>(null);
  const replacePreview = (next: string | null): void => {
    if (previewRef.current !== null) {
      URL.revokeObjectURL(previewRef.current);
    }
    previewRef.current = next;
    setPreviewUrl(next);
  };

  useEffect(
    () => () => {
      if (previewRef.current !== null) {
        URL.revokeObjectURL(previewRef.current);
      }
    },
    [],
  );

  const busy = phase !== 'idle';

  // The prop moving off `against` is the refresh landing, at which point the
  // server is authoritative again and the local answer is discarded.
  const refreshLanded = pending !== null && currentSrc !== pending.against;
  const storedSrc = pending !== null && !refreshLanded ? pending.src : currentSrc;

  const shownSrc = previewUrl ?? storedSrc;
  const hasStoredPhoto = storedSrc !== null;

  function clearSelection(): void {
    setProcessed(null);
    if (inputRef.current !== null) {
      inputRef.current.value = '';
    }
  }

  /**
   * Drop the selection *and* whatever the client was holding.
   *
   * Clearing `pending` here is what keeps object-URL ownership honest: the URL
   * a save handed over is only ever revoked by `replacePreview`, and only once
   * nothing is rendering it any more.
   */
  function discard(): void {
    replacePreview(null);
    setPending(null);
    clearSelection();
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }

    setError(null);
    setNotice(null);
    setProcessed(null);
    setPending(null);
    replacePreview(URL.createObjectURL(file));
    setPhase('processing');

    try {
      const result = await processAvatarImage(file);
      replacePreview(URL.createObjectURL(result));
      setProcessed(result);
    } catch (failure: unknown) {
      discard();
      setError(
        failure instanceof AvatarImageError
          ? avatarImageMessage(failure.reason)
          : avatarImageMessage('decode_failed'),
      );
    } finally {
      setPhase('idle');
      // Clearing the input's value is what lets somebody pick the *same* file
      // again after an error; without it the change event never fires twice.
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
    }
  }

  function onSave(): void {
    if (processed === null) {
      return;
    }

    const payload = new FormData();
    payload.set(AVATAR_FILE_FIELD, processed);
    setPhase('saving');
    setError(null);

    startTransition(() => {
      void uploadAvatarAction(null, payload).then((result) => {
        setPhase('idle');
        if (result.ok) {
          // Hand the preview to `pending` instead of dropping it. It is a
          // re-encode of exactly the bytes that were just stored, so holding it
          // until the refresh lands means the avatar goes straight from the new
          // photo to the new photo — never back through the old one.
          //
          // `setPreviewUrl` rather than `replacePreview`, deliberately: the
          // object URL must stay valid while `pending` renders it. `previewRef`
          // still owns it and `discard`/`replacePreview` still revoke it, so
          // nothing leaks.
          setPending({ src: previewRef.current, against: currentSrc });
          setPreviewUrl(null);
          clearSelection();
          setNotice('Photo saved.');
          router.refresh();
          return;
        }
        setError(result.fieldErrors['avatar'] ?? result.message);
      });
    });
  }

  function onRemove(): void {
    setPhase('removing');
    setError(null);

    startTransition(() => {
      void removeAvatarAction(null, new FormData()).then((result) => {
        setPhase('idle');
        if (result.ok) {
          discard();
          // The same window, the other way round: without this the deleted
          // photo stays on screen under "Photo removed." until the refresh
          // lands. `discard()` cleared `pending`, so this sets it afresh.
          setPending({ src: null, against: currentSrc });
          setNotice('Photo removed.');
          router.refresh();
          return;
        }
        setError(result.fieldErrors['avatar'] ?? result.message);
      });
    });
  }

  return (
    <div className="flex flex-col items-center gap-3" data-testid="avatar-picker">
      <Avatar src={shownSrc} initials={initials} label={label} size={128} />

      {/* Visually hidden rather than display:none, so it stays focusable and
          keyboard users reach it through the label below. `accept="image/*"`
          is what makes iOS offer the photo library and the camera. */}
      <input
        ref={inputRef}
        id="avatar-file"
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          void onFileChosen(event);
        }}
      />

      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* A styled <label>, not a button: it has to be the file input's label
            for the native picker to open from a tap, and for keyboard users to
            reach the input at all. It borrows the secondary button's styling
            rather than sharing the component, because `Button` renders a
            <button> and a nested control here would break both. */}
        <label
          htmlFor="avatar-file"
          className={`press inline-flex min-h-control cursor-pointer select-none items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-hover)] ${
            busy ? 'pointer-events-none opacity-55' : ''
          }`}
        >
          <ImageIcon size={16} />
          {hasStoredPhoto || processed !== null ? 'Change photo' : 'Add photo'}
        </label>

        {processed === null ? null : (
          <>
            <Button variant="primary" onClick={onSave} disabled={busy} icon={<CheckIcon size={16} />}>
              {phase === 'saving' ? 'Saving…' : 'Save photo'}
            </Button>
            <Button variant="ghost" onClick={discard} disabled={busy}>
              Cancel
            </Button>
          </>
        )}

        {hasStoredPhoto && processed === null ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="press inline-flex min-h-control items-center justify-center rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium text-whistle-700 hover:bg-whistle-50 disabled:opacity-55 dark:text-whistle-300 dark:hover:bg-whistle-900/30"
          >
            {phase === 'removing' ? 'Removing…' : 'Remove photo'}
          </button>
        ) : null}
      </div>

      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
        {phase === 'processing' ? <Spinner size={13} /> : null}
        {phase === 'processing'
          ? 'Preparing your photo…'
          : 'Squared and resized on your device before it is uploaded.'}
      </p>

      {error === null ? null : (
        <p role="alert" className="text-center text-sm text-whistle-600 dark:text-whistle-300">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="text-center text-sm text-pitch-800 dark:text-pitch-200">
          {notice}
        </p>
      )}
    </div>
  );
}
