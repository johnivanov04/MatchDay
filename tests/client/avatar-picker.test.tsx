import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AvatarImage from '@/lib/profile/image';
import { chooseFile, click, render, settle } from './helpers/render';

/**
 * The picker, as somebody's thumb experiences it.
 *
 * The image pipeline is stubbed here and tested for real in
 * `avatar-image.test.ts`; what this file is about is the *flow* — that a
 * preview appears before any upload happens, that Save is the only thing that
 * sends anything, that a failure says something a person can act on, and that
 * the text field which used to accept a pasted URL is gone from the DOM rather
 * than merely hidden.
 */

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  process: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/server/actions/avatar', () => ({
  uploadAvatarAction: mocks.upload,
  removeAvatarAction: mocks.remove,
}));
vi.mock('@/lib/profile/image', async (importOriginal) => ({
  ...(await importOriginal<typeof AvatarImage>()),
  processAvatarImage: mocks.process,
}));

const { AvatarPicker } = await import('@/components/avatar-picker');
const { AvatarImageError } = await import('@/lib/profile/image');

const STORED = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/avatars/a/b.jpg';

function chosenPhoto(): File {
  return new File([new Uint8Array(4096)], 'IMG_0042.jpg', { type: 'image/jpeg' });
}

function processedPhoto(): File {
  return new File([new Uint8Array(48 * 1024)], 'avatar.jpg', { type: 'image/jpeg' });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[type="file"]')!;
}

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes(label),
    ) ?? null
  );
}

let objectUrlSerial = 0;

beforeEach(() => {
  vi.clearAllMocks();
  objectUrlSerial = 0;

  // jsdom implements neither.
  URL.createObjectURL = vi.fn(() => {
    objectUrlSerial += 1;
    return `blob:preview-${String(objectUrlSerial)}`;
  });
  URL.revokeObjectURL = vi.fn();

  mocks.process.mockResolvedValue(processedPhoto());
  mocks.upload.mockResolvedValue({ ok: true, data: undefined });
  mocks.remove.mockResolvedValue({ ok: true, data: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ══ The control surface ═══════════════════════════════════════════════════

describe('what is on screen', () => {
  it('offers a native file input that opens the photo library on iOS', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    const input = fileInput(container);
    expect(input.getAttribute('type')).toBe('file');
    // `image/*` is what makes iOS offer Photo Library, Take Photo and Browse
    // rather than a raw document picker.
    expect(input.getAttribute('accept')).toBe('image/*');
    unmount();
  });

  it('has no text input for pasting an image address', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    // The field that used to live on this page accepted any https URL. Gone
    // from the DOM, not merely hidden — `saveProfileAction` no longer reads
    // one either, which `profile-validation.test.ts` pins from the other side.
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.querySelector('input[name="profile_photo_url"]')).toBeNull();
    expect(container.querySelector('input[name="profile_photo_path"]')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    unmount();
  });

  it('says Add photo with none and Change photo with one', async () => {
    const empty = await render(<AvatarPicker currentSrc={null} initials="SO" label="Sam" />);
    expect(empty.container.textContent).toContain('Add photo');
    expect(empty.container.textContent).not.toContain('Change photo');
    empty.unmount();

    const filled = await render(<AvatarPicker currentSrc={STORED} initials="SO" label="Sam" />);
    expect(filled.container.textContent).toContain('Change photo');
    filled.unmount();
  });

  it('offers Remove only when there is a photo to remove', async () => {
    const empty = await render(<AvatarPicker currentSrc={null} initials="SO" label="Sam" />);
    expect(buttonLabelled(empty.container, 'Remove photo')).toBeNull();
    empty.unmount();

    const filled = await render(<AvatarPicker currentSrc={STORED} initials="SO" label="Sam" />);
    expect(buttonLabelled(filled.container, 'Remove photo')).not.toBeNull();
    filled.unmount();
  });

  it('shows initials until a photo exists', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    expect(container.textContent).toContain('SO');
    expect(container.querySelector('img')).toBeNull();
    unmount();
  });
});

// ══ Choosing ══════════════════════════════════════════════════════════════

describe('choosing a photo', () => {
  it('shows a preview and does not upload anything', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:preview-/);
    // Nothing leaves the device until Save. The picker is easy to mis-tap on a
    // phone, and an upload that begins on selection cannot be taken back.
    expect(mocks.upload).not.toHaveBeenCalled();
    unmount();
  });

  it('previews the original first, then the processed result', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    // Two object URLs: the instant preview, then the squared 512x512 version
    // that will actually be stored. What is on screen at Save time is what
    // gets uploaded, crop and all.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    unmount();
  });

  it('reveals Save and Cancel once a photo is ready', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    expect(buttonLabelled(container, 'Save photo')).toBeNull();

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    expect(buttonLabelled(container, 'Save photo')).not.toBeNull();
    expect(buttonLabelled(container, 'Cancel')).not.toBeNull();
    unmount();
  });

  it('drops the preview on Cancel', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Cancel')!);
    await settle();

    // Back to the stored photo, and nothing was sent.
    expect(container.querySelector('img')?.getAttribute('src')).toBe(STORED);
    expect(mocks.upload).not.toHaveBeenCalled();
    unmount();
  });
});

// ══ Failures on the device ════════════════════════════════════════════════

describe('when the photo cannot be prepared', () => {
  it('shows the friendly message for an undecodable format', async () => {
    mocks.process.mockRejectedValue(new AvatarImageError('decode_failed'));

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("That photo format isn't supported. Try another photo.");
    // No crash, no preview left behind, nothing to save.
    expect(buttonLabelled(container, 'Save photo')).toBeNull();
    unmount();
  });

  it('shows the size message for a source over 10 MB', async () => {
    mocks.process.mockRejectedValue(new AvatarImageError('source_too_large'));

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That photo is too large. Choose one under 10 MB.',
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the existing photo on screen after a failure', async () => {
    mocks.process.mockRejectedValue(new AvatarImageError('decode_failed'));

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    expect(container.querySelector('img')?.getAttribute('src')).toBe(STORED);
    unmount();
  });

  it('turns an unexpected throw into the same friendly message', async () => {
    mocks.process.mockRejectedValue(new TypeError('cannot read property of undefined'));

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toBe("That photo format isn't supported. Try another photo.");
    // Never the raw error.
    expect(alert).not.toContain('undefined');
    unmount();
  });
});

// ══ Saving ════════════════════════════════════════════════════════════════

describe('saving', () => {
  it('sends the processed file and nothing else', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    const payload = mocks.upload.mock.calls[0]?.[1] as FormData;
    expect([...payload.keys()]).toEqual(['avatar']);

    const sent = payload.get('avatar') as File;
    // The 48 KB processed result, not the 4 KB original stand-in — and no user
    // id, which the action would ignore anyway.
    expect(sent.size).toBe(48 * 1024);
    expect(sent.type).toBe('image/jpeg');
    unmount();
  });

  it('refreshes so the new face appears everywhere', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    expect(mocks.refresh).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Photo saved.');
    unmount();
  });

  /**
   * The regression this exists for.
   *
   * `router.refresh()` is asynchronous, so `currentSrc` still names the OLD
   * object for as long as the round trip takes. Dropping the preview when the
   * action resolves therefore put the *previous* photo back on screen,
   * underneath "Photo saved.", until the refresh landed — 50ms locally, long
   * enough on CI that the end-to-end suite read the old URL and failed.
   *
   * `currentSrc` is deliberately not changed here: this asserts what the picker
   * shows during the window, which is the whole bug.
   */
  it('never falls back to the previous photo while the refresh is in flight', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    const src = container.querySelector('img')?.getAttribute('src');
    expect(src).not.toBe(STORED);
    // The processed preview: the same bytes that were just uploaded.
    expect(src).toMatch(/^blob:/);
    unmount();
  });

  /** And it hands back to the server the moment the refresh does land. */
  it('shows the stored object once the refreshed prop carries it', async () => {
    const { container, rerender, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    const next = STORED.replace('b.jpg', 'c.jpg');
    await rerender(<AvatarPicker currentSrc={next} initials="SO" label="Sam Okafor" />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe(next);
    unmount();
  });

  /** The same window, the other way round: a removal must not linger either. */
  it('drops the photo immediately on removal rather than waiting for the refresh', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await click(buttonLabelled(container, 'Remove photo')!);
    await settle();

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Photo removed.');
    unmount();
  });

  it('surfaces the server field error and keeps the preview', async () => {
    mocks.upload.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Please check the highlighted fields and try again.',
      fieldErrors: { avatar: 'That file is not a JPEG image. Try another photo.' },
    });

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That file is not a JPEG image. Try another photo.',
    );
    // Still there to retry with, rather than making somebody pick it again.
    expect(buttonLabelled(container, 'Save photo')).not.toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
    unmount();
  });

  it('falls back to the general message when there is no field error', async () => {
    mocks.upload.mockResolvedValue({
      ok: false,
      code: 'AUTH_REQUIRED',
      message: 'Please sign in to continue.',
      fieldErrors: {},
    });

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={null} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();
    await click(buttonLabelled(container, 'Save photo')!);
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Please sign in to continue.',
    );
    unmount();
  });
});

// ══ Removing ══════════════════════════════════════════════════════════════

describe('removing', () => {
  it('calls the remove action and refreshes', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await click(buttonLabelled(container, 'Remove photo')!);
    await settle();

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Photo removed.');
    unmount();
  });

  it('reports a failure without claiming the photo is gone', async () => {
    mocks.remove.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Please check the highlighted fields and try again.',
      fieldErrors: { avatar: 'We could not remove that photo. Please try again.' },
    });

    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await click(buttonLabelled(container, 'Remove photo')!);
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not remove that photo. Please try again.',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    unmount();
  });

  it('is not offered while a new photo is waiting to be saved', async () => {
    const { container, unmount } = await render(
      <AvatarPicker currentSrc={STORED} initials="SO" label="Sam Okafor" />,
    );

    await chooseFile(fileInput(container), chosenPhoto());
    await settle();

    // Two destructive-looking choices side by side, one of which discards work
    // in progress, is a mis-tap waiting to happen.
    expect(buttonLabelled(container, 'Remove photo')).toBeNull();
    unmount();
  });
});
