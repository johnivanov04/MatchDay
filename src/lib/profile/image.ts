import {
  AVATAR_CONTENT_TYPE,
  AVATAR_DIMENSION,
  AVATAR_JPEG_QUALITY,
  MAX_PROCESSED_BYTES,
  MAX_SOURCE_BYTES,
} from '@/lib/profile/avatar';

/**
 * Turning whatever came out of the photo picker into the one file we upload.
 *
 * ── WHY THE BROWSER DOES THIS AND NOT THE SERVER ───────────────────────────
 *
 * The original never leaves the device. A phone photo is 3–8 MB of full-frame
 * sensor data carrying EXIF that routinely includes GPS coordinates, the
 * camera's serial number and a capture timestamp — none of which anybody
 * intends to publish by choosing a profile picture. Re-encoding through a
 * canvas produces a fresh JPEG built only from pixels: **there is no metadata
 * to strip, because none is carried over**. That is the privacy property, and
 * it is a consequence of the pipeline rather than a step in it.
 *
 * It also means the upload is ~50 KB on a touchline 4G connection instead of
 * several megabytes, and that the server's job reduces to verifying a small
 * file rather than decoding an untrusted one.
 *
 * ── NO IMAGE LIBRARY ───────────────────────────────────────────────────────
 *
 * `createImageBitmap` and `<canvas>` are in every browser this product
 * supports. A cropping library would add hundreds of kilobytes to the bundle to
 * offer a drag-to-position UI nobody asked for; centre-cropping a square is
 * four numbers.
 *
 * ── HEIC IS NOT DECODED HERE, ON PURPOSE ───────────────────────────────────
 *
 * An iPhone shooting in "High Efficiency" stores HEIC. In practice
 * `<input type="file" accept="image/*">` hands over a JPEG anyway — iOS
 * transcodes on the way out of the photo library — but a file picked out of
 * Files, or an image shared from another app, can still arrive as HEIC, and no
 * browser engine outside Safari decodes it. A WASM decoder is ~1 MB of payload
 * to rescue a case iOS already handles, so this phase declines it and fails
 * with a sentence somebody can act on instead.
 */

export type AvatarImageFailure =
  | 'source_too_large'
  | 'not_an_image'
  | 'decode_failed'
  | 'encode_failed'
  | 'processed_too_large';

export class AvatarImageError extends Error {
  readonly reason: AvatarImageFailure;

  constructor(reason: AvatarImageFailure) {
    super(reason);
    this.name = 'AvatarImageError';
    this.reason = reason;
  }
}

/** What the picker shows. Plain sentences; each one names the next action. */
export function avatarImageMessage(reason: AvatarImageFailure): string {
  switch (reason) {
    case 'source_too_large':
      return 'That photo is too large. Choose one under 10 MB.';
    case 'not_an_image':
      return 'That file is not an image. Try another photo.';
    // Deliberately the same sentence for an undecodable file and an
    // unsupported format: from where the player is standing they are the same
    // problem with the same fix, and "HEIF" is not a word a fix can be built
    // from.
    case 'decode_failed':
      return "That photo format isn't supported. Try another photo.";
    case 'encode_failed':
      return 'We could not prepare that photo. Try another one.';
    case 'processed_too_large':
      return 'We could not compress that photo enough. Try another one.';
  }
}

export interface CropBox {
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
}

/**
 * The largest centred square inside a rectangle — "cover", not "contain".
 *
 * A 4032x3024 photo yields a 3024x3024 square starting 504px from the left, so
 * the subject stays centred and nothing is letterboxed. Rounded to whole pixels
 * because `drawImage` with fractional source coordinates resamples for no
 * reason.
 */
export function coverCrop(width: number, height: number): CropBox {
  const size = Math.min(width, height);
  return {
    sx: Math.round((width - size) / 2),
    sy: Math.round((height - size) / 2),
    size,
  };
}

interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  release(): void;
}

/**
 * Decodes a file into something `drawImage` accepts, honouring orientation.
 *
 * TWO PATHS, AND THE ORDER MATTERS FOR ROTATION. `createImageBitmap` ignores
 * EXIF orientation unless asked, so it is asked — `imageOrientation:
 * 'from-image'` is supported by every current engine, and a browser that
 * rejects the option throws, which falls through to the second path. There,
 * `<img>` applies orientation itself and has done for years. So a photo taken
 * sideways lands the right way up on both paths.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
          bitmap.close();
        },
      };
    } catch {
      // Fall through. An unsupported option and an undecodable file are
      // indistinguishable here, and the second path answers both.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const element = await loadImageElement(objectUrl);
    return {
      source: element,
      width: element.naturalWidth,
      height: element.naturalHeight,
      release: () => {
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new AvatarImageError('decode_failed');
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => {
      if (element.naturalWidth === 0 || element.naturalHeight === 0) {
        reject(new AvatarImageError('decode_failed'));
        return;
      }
      resolve(element);
    };
    element.onerror = () => {
      reject(new AvatarImageError('decode_failed'));
    };
    element.src = src;
  });
}

function encodeJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new AvatarImageError('encode_failed'));
          return;
        }
        resolve(blob);
      },
      AVATAR_CONTENT_TYPE,
      AVATAR_JPEG_QUALITY,
    );
  });
}

/**
 * Selected photo in, uploadable avatar out.
 *
 * Rejects with an `AvatarImageError` and never with anything else, so the
 * caller has exactly one thing to render. The size check comes **first**, before
 * a single byte is decoded, which is what stops a 60 MB image from being read
 * into memory on a phone in order to discover it is too big.
 */
export async function processAvatarImage(file: File): Promise<File> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new AvatarImageError('source_too_large');
  }
  // `type` is a hint from the OS and is empty surprisingly often, so an empty
  // value is allowed through to the decoder — which is the real check. A
  // declared non-image, on the other hand, is refused without decoding.
  if (file.type !== '' && !file.type.startsWith('image/')) {
    throw new AvatarImageError('not_an_image');
  }

  const decoded = await decodeImage(file);
  let blob: Blob;
  try {
    const { sx, sy, size } = coverCrop(decoded.width, decoded.height);
    if (size <= 0) {
      throw new AvatarImageError('decode_failed');
    }

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_DIMENSION;
    canvas.height = AVATAR_DIMENSION;

    const context = canvas.getContext('2d');
    if (context === null) {
      throw new AvatarImageError('encode_failed');
    }
    // The canvas starts transparent and JPEG has no alpha, so a source with
    // transparency would otherwise composite onto black. White matches the
    // initials fallback behind it.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, AVATAR_DIMENSION, AVATAR_DIMENSION);
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, sx, sy, size, size, 0, 0, AVATAR_DIMENSION, AVATAR_DIMENSION);

    blob = await encodeJpeg(canvas);
  } finally {
    decoded.release();
  }

  // The backstop, not the working limit: 512x512 at q0.82 lands two orders of
  // magnitude below this. Failing cleanly beats silently re-encoding at a
  // quality nobody chose, and beats sending a body the server would refuse.
  if (blob.size > MAX_PROCESSED_BYTES || blob.size === 0) {
    throw new AvatarImageError(blob.size === 0 ? 'encode_failed' : 'processed_too_large');
  }

  return new File([blob], 'avatar.jpg', { type: AVATAR_CONTENT_TYPE });
}
