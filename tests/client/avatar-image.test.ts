import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AvatarImageError,
  avatarImageMessage,
  coverCrop,
  processAvatarImage,
} from '@/lib/profile/image';
import { AVATAR_DIMENSION, AVATAR_JPEG_QUALITY, MAX_SOURCE_BYTES } from '@/lib/profile/avatar';

/**
 * The browser-side pipeline: decode, centre-crop, resize, re-encode.
 *
 * ── WHAT IS STUBBED, AND WHY THAT IS HONEST ────────────────────────────────
 *
 * jsdom has `<canvas>` but no 2D rendering and no `toBlob`, so the encoder and
 * the decoder are replaced with recorders. That is not a weaker version of the
 * real test — it is a different one. What this repository is responsible for is
 * the **arguments**: which rectangle of the source is taken, what size it is
 * drawn at, what quality it is encoded with, and which failures become which
 * message. Those are asserted exactly. Whether Chromium's JPEG encoder produces
 * valid bytes is Chromium's business, and the end-to-end suite exercises the
 * whole thing in a real browser against a real photograph anyway.
 */

interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const draws: DrawCall[] = [];
const encodes: { type: string; quality: number }[] = [];
let encodedBlob: Blob | null = null;
let closedBitmaps = 0;

/** A file with a declared size, without allocating that many bytes. */
function fileOfSize(bytes: number, type = 'image/jpeg'): File {
  const file = new File([new Uint8Array(1)], 'photo.jpg', { type });
  Object.defineProperty(file, 'size', { value: bytes, configurable: true });
  return file;
}

function sourceFile(type = 'image/jpeg'): File {
  return new File([new Uint8Array(32)], 'photo.jpg', { type });
}

/** Stubs `createImageBitmap` to hand back an image of the given dimensions. */
function stubDecoder(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({
      width,
      height,
      close: () => {
        closedBitmaps += 1;
      },
    })),
  );
}

beforeEach(() => {
  draws.length = 0;
  encodes.length = 0;
  closedBitmaps = 0;
  encodedBlob = new Blob([new Uint8Array(48 * 1024)], { type: 'image/jpeg' });

  stubDecoder(4032, 3024);

  // jsdom's canvas has neither of these.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: '',
    imageSmoothingQuality: '',
    fillRect: vi.fn(),
    drawImage: (
      _source: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
    },
  })) as unknown as HTMLCanvasElement['getContext'];

  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    encodes.push({ type: type ?? '', quality: quality ?? -1 });
    callback(encodedBlob);
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ══ Geometry ══════════════════════════════════════════════════════════════

describe('coverCrop', () => {
  it('takes the largest centred square from a landscape photo', () => {
    // 4032x3024 → the middle 3024x3024, 504px in from the left.
    expect(coverCrop(4032, 3024)).toEqual({ sx: 504, sy: 0, size: 3024 });
  });

  it('takes the middle band from a portrait photo', () => {
    expect(coverCrop(3024, 4032)).toEqual({ sx: 0, sy: 504, size: 3024 });
  });

  it('leaves an already-square image alone', () => {
    expect(coverCrop(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 });
  });

  it('rounds to whole pixels', () => {
    // Fractional source coordinates make `drawImage` resample for no reason.
    const { sx, sy, size } = coverCrop(101, 100);
    expect(Number.isInteger(sx)).toBe(true);
    expect(Number.isInteger(sy)).toBe(true);
    expect(size).toBe(100);
  });
});

// ══ The happy path ════════════════════════════════════════════════════════

describe('processAvatarImage', () => {
  it('produces a 512x512 JPEG', async () => {
    const result = await processAvatarImage(sourceFile());

    expect(result.type).toBe('image/jpeg');
    expect(draws[0]).toMatchObject({
      dx: 0,
      dy: 0,
      dw: AVATAR_DIMENSION,
      dh: AVATAR_DIMENSION,
    });
  });

  it('draws the centred square, not the whole frame', async () => {
    await processAvatarImage(sourceFile());

    expect(draws[0]).toMatchObject({ sx: 504, sy: 0, sw: 3024, sh: 3024 });
  });

  it('sizes the canvas itself to 512x512', async () => {
    const created: HTMLCanvasElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = realCreateElement(tag);
      if (tag === 'canvas') {
        created.push(element as HTMLCanvasElement);
      }
      return element;
    });

    await processAvatarImage(sourceFile());

    expect(created[0]?.width).toBe(512);
    expect(created[0]?.height).toBe(512);
  });

  it('encodes at the agreed quality', async () => {
    await processAvatarImage(sourceFile());

    expect(encodes[0]).toEqual({ type: 'image/jpeg', quality: AVATAR_JPEG_QUALITY });
  });

  it('asks the decoder to honour EXIF orientation', async () => {
    await processAvatarImage(sourceFile());

    // Without this a photo taken sideways is stored sideways: the sensor data
    // is landscape and the rotation lives only in the metadata.
    const decoder = globalThis.createImageBitmap as unknown as ReturnType<typeof vi.fn>;
    expect(decoder.mock.calls[0]?.[1]).toEqual({ imageOrientation: 'from-image' });
  });

  it('releases the decoded bitmap', async () => {
    await processAvatarImage(sourceFile());

    // A full-resolution bitmap is tens of megabytes on a phone.
    expect(closedBitmaps).toBe(1);
  });

  it('names the result avatar.jpg regardless of the source name', async () => {
    const source = new File([new Uint8Array(32)], 'IMG_4021.HEIC', { type: 'image/jpeg' });

    expect((await processAvatarImage(source)).name).toBe('avatar.jpg');
  });
});

// ══ Refusals ══════════════════════════════════════════════════════════════

describe('a source that is too large', () => {
  it('is rejected before anything is decoded', async () => {
    const decoder = globalThis.createImageBitmap as unknown as ReturnType<typeof vi.fn>;

    await expect(processAvatarImage(fileOfSize(MAX_SOURCE_BYTES + 1))).rejects.toMatchObject({
      reason: 'source_too_large',
    });

    // The whole point of checking size first: a 60 MB image must not be read
    // into memory on a phone in order to discover that it is too big.
    expect(decoder).not.toHaveBeenCalled();
  });

  it('accepts a source exactly at the limit', async () => {
    await expect(processAvatarImage(fileOfSize(MAX_SOURCE_BYTES))).resolves.toBeInstanceOf(File);
  });

  it('accepts an ordinary 8 MB phone photo', async () => {
    await expect(processAvatarImage(fileOfSize(8 * 1024 * 1024))).resolves.toBeInstanceOf(File);
  });
});

describe('a source that is not an image', () => {
  it('is rejected on its declared type without decoding', async () => {
    await expect(processAvatarImage(sourceFile('application/pdf'))).rejects.toMatchObject({
      reason: 'not_an_image',
    });
  });

  it('is still attempted when the operating system declared nothing', async () => {
    // `type` is empty surprisingly often — the decoder is the real check.
    await expect(processAvatarImage(sourceFile(''))).resolves.toBeInstanceOf(File);
  });
});

describe('a source the browser cannot decode', () => {
  beforeEach(() => {
    // What an unsupported HEIC looks like from here: `createImageBitmap`
    // rejects, and the <img> fallback fires `onerror`.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('The source image could not be decoded');
      }),
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:stub'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('produces a friendly, actionable message rather than crashing', async () => {
    // jsdom never loads an <img>, so `onerror` is fired by hand.
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      set(this: HTMLImageElement) {
        setTimeout(() => this.dispatchEvent(new Event('error')), 0);
      },
    });

    try {
      const failure = await processAvatarImage(sourceFile('image/heic')).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AvatarImageError);
      expect((failure as AvatarImageError).reason).toBe('decode_failed');
      expect(avatarImageMessage('decode_failed')).toBe(
        "That photo format isn't supported. Try another photo.",
      );
    } finally {
      if (original !== undefined) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', original);
      }
    }
  });
});

describe('an encode that goes wrong', () => {
  it('reports a clean failure when the canvas yields nothing', async () => {
    encodedBlob = null;

    await expect(processAvatarImage(sourceFile())).rejects.toMatchObject({
      reason: 'encode_failed',
    });
  });

  it('refuses a result over the final cap instead of sending it', async () => {
    // 512x512 at q0.82 lands two orders of magnitude below this, so it is a
    // backstop. Failing cleanly beats silently re-encoding at a quality nobody
    // chose, and beats a body the server would reject.
    encodedBlob = new Blob([new Uint8Array(751 * 1024)], { type: 'image/jpeg' });

    await expect(processAvatarImage(sourceFile())).rejects.toMatchObject({
      reason: 'processed_too_large',
    });
  });

  it('accepts a result exactly at the cap', async () => {
    encodedBlob = new Blob([new Uint8Array(750 * 1024)], { type: 'image/jpeg' });

    await expect(processAvatarImage(sourceFile())).resolves.toBeInstanceOf(File);
  });
});

describe('every failure has a sentence somebody can act on', () => {
  it('names a next step and never leaks a technical term', () => {
    const reasons = [
      'source_too_large',
      'not_an_image',
      'decode_failed',
      'encode_failed',
      'processed_too_large',
    ] as const;

    for (const reason of reasons) {
      const message = avatarImageMessage(reason);
      expect(message.length, reason).toBeGreaterThan(20);
      expect(message, reason).toMatch(/Try|Choose/);
      expect(message, reason).not.toMatch(/HEIF|codec|canvas|blob|undefined|Error/i);
    }
  });
});
