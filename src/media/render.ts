import sharp from 'sharp';

export const FEED_WIDTH = 1080;
export const FEED_HEIGHT = 1350;
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/**
 * Cover is used when the source aspect is within this fraction of 4:5.
 * The comparison is `|aspect - 4/5| / (4/5) <= 0.15`.
 */
export const FEED_ASPECT_TOLERANCE = 0.15;

/** Neutral dark letterbox, and the colour transparent pixels are flattened onto. */
export const LETTERBOX = { r: 0x1a, g: 0x1a, b: 0x1a };

/** Gaussian sigma, in pixels, for the story backdrop after it has been scaled up. */
export const STORY_BLUR_SIGMA = 24;

/**
 * Each backdrop channel is multiplied by this after the blur.
 * 0.4 leaves the backdrop at 40% of its brightness so the contained photo stays forward.
 */
export const STORY_DARKEN = 0.4;

export const MAX_JPEG_BYTES = 8 * 1024 * 1024;

const JPEG_QUALITIES = [90, 80, 70, 60, 50, 40, 30, 20, 10, 5] as const;

/** Cover when the oriented aspect is within 15% of 4:5, otherwise contain. */
export function feedFit(width: number, height: number): 'cover' | 'contain' {
  if (width <= 0 || height <= 0) return 'contain';
  const target = FEED_WIDTH / FEED_HEIGHT;
  const delta = Math.abs(width / height - target) / target;
  return delta <= FEED_ASPECT_TOLERANCE ? 'cover' : 'contain';
}

/**
 * Apply EXIF orientation, move into sRGB, flatten any alpha onto the letterbox
 * colour, and drop metadata by re-encoding to a fresh PNG. JPEG, PNG, and WebP
 * all go through this path.
 */
async function prepare(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .flatten({ background: LETTERBOX })
    .png()
    .toBuffer();
}

/**
 * Mozjpeg, starting at quality 90. Lower the quality until the buffer is within
 * `maxBytes`. Metadata is not copied onto the output.
 */
export async function encodeJpeg(pixels: Buffer, maxBytes = MAX_JPEG_BYTES): Promise<Buffer> {
  let smallest: Buffer | undefined;
  for (const quality of JPEG_QUALITIES) {
    const output = await sharp(pixels)
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();
    if (!smallest || output.length < smallest.length) smallest = output;
    if (output.length <= maxBytes) return output;
  }
  throw new Error(
    `Rendered JPEG is ${smallest?.length ?? 0} bytes, which is above the ${maxBytes} byte limit.`,
  );
}

/** 1080×1350 (4:5) sRGB JPEG. */
export async function toFeed(input: Buffer): Promise<Buffer> {
  const prepared = await prepare(input);
  const meta = await sharp(prepared).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error('Image has no dimensions.');
  const fitted = await sharp(prepared)
    .resize(FEED_WIDTH, FEED_HEIGHT, {
      fit: feedFit(width, height),
      position: 'centre',
      background: LETTERBOX,
    })
    .png()
    .toBuffer();
  return encodeJpeg(fitted);
}

/**
 * 1080×1920 (9:16) sRGB JPEG. The oriented photo is contained and centred.
 * Behind it is the same photo, cover-scaled, blurred, and darkened.
 * TikTok photo posts use this render via {@link toTikTok}.
 */
export async function toStory(input: Buffer): Promise<Buffer> {
  const prepared = await prepare(input);
  const background = await sharp(prepared)
    .resize(STORY_WIDTH, STORY_HEIGHT, { fit: 'cover', position: 'centre' })
    .blur(STORY_BLUR_SIGMA)
    .removeAlpha()
    .linear(STORY_DARKEN, 0)
    .png()
    .toBuffer();
  const foreground = await sharp(prepared)
    .ensureAlpha()
    .resize(STORY_WIDTH, STORY_HEIGHT, {
      fit: 'contain',
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const composited = await sharp(background)
    .composite([{ input: foreground, gravity: 'centre' }])
    .png()
    .toBuffer();
  return encodeJpeg(composited);
}

/** TikTok photo posts reuse the 9:16 story render. */
export const toTikTok = toStory;
