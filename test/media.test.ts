import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  encodeJpeg,
  FEED_HEIGHT,
  FEED_WIDTH,
  feedFit,
  LETTERBOX,
  MAX_JPEG_BYTES,
  STORY_DARKEN,
  STORY_HEIGHT,
  STORY_WIDTH,
  toFeed,
  toStory,
  toTikTok,
} from '../src/media/index.js';

type Rgb = [number, number, number];

const RED: Rgb = [210, 40, 50];
const GREEN: Rgb = [30, 170, 60];
const BLUE: Rgb = [30, 50, 200];
const GOLD: Rgb = [220, 170, 40];
const LETTERBOX_RGB: Rgb = [LETTERBOX.r, LETTERBOX.g, LETTERBOX.b];

async function canvas(
  width: number,
  height: number,
  colour: { r: number; g: number; b: number },
  format: 'png' | 'jpeg' | 'webp' = 'png',
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: colour },
  });
  if (format === 'jpeg') return image.jpeg().toBuffer();
  if (format === 'webp') return image.webp().toBuffer();
  return image.png().toBuffer();
}

async function rgbAt(image: Buffer, x: number, y: number): Promise<Rgb> {
  const { data } = await sharp(image)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}

function expectNear(actual: Rgb, expected: Rgb, tolerance = 12): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

async function expectCleanJpeg(image: Buffer, width: number, height: number): Promise<void> {
  expect(image.length).toBeGreaterThan(0);
  expect(image.length).toBeLessThanOrEqual(MAX_JPEG_BYTES);
  expect(image[0]).toBe(0xff);
  expect(image[1]).toBe(0xd8);
  expect(image.includes(Buffer.from('Exif\0\0', 'binary'))).toBe(false);
  expect(image.includes(Buffer.from('GPSLAT51.5074N'))).toBe(false);
  const meta = await sharp(image).metadata();
  expect(meta.format).toBe('jpeg');
  expect(meta.width).toBe(width);
  expect(meta.height).toBe(height);
  expect(meta.space).toBe('srgb');
  expect(meta.exif).toBeUndefined();
  expect(meta.orientation).toBeUndefined();
  expect(meta.hasAlpha).toBeFalsy();
}

describe('feed fit', () => {
  it('uses cover within 15% of 4:5 and contain outside that', () => {
    expect(feedFit(FEED_WIDTH, FEED_HEIGHT)).toBe('cover');
    expect(feedFit(920, 1000)).toBe('cover');
    expect(feedFit(680, 1000)).toBe('cover');
    expect(feedFit(930, 1000)).toBe('contain');
    expect(feedFit(670, 1000)).toBe('contain');
    expect(feedFit(1000, 1000)).toBe('contain');
    expect(feedFit(1600, 900)).toBe('contain');
    expect(feedFit(2400, 200)).toBe('contain');
    expect(feedFit(800, 1600)).toBe('contain');
  });

  it('covers a portrait that is close to 4:5 and letterboxes the others', async () => {
    const close = await toFeed(await canvas(1000, 1200, { r: RED[0], g: RED[1], b: RED[2] }));
    const square = await toFeed(await canvas(800, 800, { r: GREEN[0], g: GREEN[1], b: GREEN[2] }));
    const landscape = await toFeed(
      await canvas(1600, 900, { r: BLUE[0], g: BLUE[1], b: BLUE[2] }, 'jpeg'),
    );
    const panorama = await toFeed(await canvas(2400, 200, { r: GOLD[0], g: GOLD[1], b: GOLD[2] }));
    const tall = await toFeed(await canvas(800, 1600, { r: RED[0], g: RED[1], b: RED[2] }));

    await expectCleanJpeg(close, FEED_WIDTH, FEED_HEIGHT);
    await expectCleanJpeg(square, FEED_WIDTH, FEED_HEIGHT);
    await expectCleanJpeg(landscape, FEED_WIDTH, FEED_HEIGHT);
    await expectCleanJpeg(panorama, FEED_WIDTH, FEED_HEIGHT);
    await expectCleanJpeg(tall, FEED_WIDTH, FEED_HEIGHT);

    expectNear(await rgbAt(close, 4, 4), RED);
    expectNear(await rgbAt(close, FEED_WIDTH - 5, FEED_HEIGHT - 5), RED);

    expectNear(await rgbAt(square, 4, 4), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(square, FEED_WIDTH / 2, FEED_HEIGHT / 2), GREEN);

    expectNear(await rgbAt(landscape, 4, 4), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(landscape, FEED_WIDTH / 2, FEED_HEIGHT / 2), BLUE);

    expectNear(await rgbAt(panorama, 4, 4), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(panorama, FEED_WIDTH - 5, 4), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(panorama, FEED_WIDTH / 2, FEED_HEIGHT / 2), GOLD);

    expectNear(await rgbAt(tall, 4, FEED_HEIGHT / 2), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(tall, FEED_WIDTH - 5, FEED_HEIGHT / 2), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(tall, FEED_WIDTH / 2, FEED_HEIGHT / 2), RED);
  }, 30_000);
});

describe('story render', () => {
  it('centres the source and keeps the backdrop darker', async () => {
    const source = await canvas(400, 400, { r: RED[0], g: RED[1], b: RED[2] });
    const story = await toStory(source);
    await expectCleanJpeg(story, STORY_WIDTH, STORY_HEIGHT);

    const centre = await rgbAt(story, STORY_WIDTH / 2, STORY_HEIGHT / 2);
    const corner = await rgbAt(story, 8, 8);
    expectNear(centre, RED);
    expect(luminance(corner)).toBeLessThan(luminance(centre) * (STORY_DARKEN + 0.15));
    expect(luminance(corner)).toBeGreaterThan(luminance(RED) * (STORY_DARKEN - 0.15));
    expect(toTikTok).toBe(toStory);
  }, 20_000);

  it('keeps the centred quadrants aligned with the source', async () => {
    const half = 100;
    const cell = (colour: { r: number; g: number; b: number }) =>
      sharp({ create: { width: half, height: half, channels: 3, background: colour } })
        .png()
        .toBuffer();
    const source = await sharp({
      create: { width: 200, height: 200, channels: 3, background: 'black' },
    })
      .composite([
        { input: await cell({ r: 220, g: 30, b: 30 }), left: 0, top: 0 },
        { input: await cell({ r: 30, g: 180, b: 40 }), left: half, top: 0 },
        { input: await cell({ r: 30, g: 40, b: 210 }), left: 0, top: half },
        { input: await cell({ r: 230, g: 230, b: 230 }), left: half, top: half },
      ])
      .png()
      .toBuffer();

    const story = await toStory(source);
    const contained = 1080;
    const offsetY = (STORY_HEIGHT - contained) / 2;
    const quarter = contained / 4;
    expectNear(await rgbAt(story, quarter, offsetY + quarter), [220, 30, 30]);
    expectNear(await rgbAt(story, contained - quarter, offsetY + quarter), [30, 180, 40]);
    expectNear(await rgbAt(story, quarter, offsetY + contained - quarter), [30, 40, 210]);
    expectNear(
      await rgbAt(story, contained - quarter, offsetY + contained - quarter),
      [230, 230, 230],
    );

    const backdrop = await rgbAt(story, STORY_WIDTH / 2, 12);
    const foreground = await rgbAt(story, contained - quarter, offsetY + contained - quarter);
    expect(luminance(backdrop)).toBeLessThan(luminance(foreground) * 0.7);
  }, 20_000);
});

describe('input formats', () => {
  it('flattens PNG alpha onto the letterbox colour', async () => {
    const transparent = await sharp({
      create: {
        width: 80,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const feed = await toFeed(transparent);
    await expectCleanJpeg(feed, FEED_WIDTH, FEED_HEIGHT);
    expectNear(await rgbAt(feed, 10, 10), LETTERBOX_RGB, 8);
    expectNear(await rgbAt(feed, FEED_WIDTH / 2, FEED_HEIGHT / 2), LETTERBOX_RGB, 8);
    const black: Rgb = [0, 0, 0];
    const corner = await rgbAt(feed, 10, 10);
    expect(Math.abs(corner[0] - black[0])).toBeGreaterThan(8);
  });

  it('accepts WebP', async () => {
    const feed = await toFeed(
      await canvas(640, 360, { r: BLUE[0], g: BLUE[1], b: BLUE[2] }, 'webp'),
    );
    await expectCleanJpeg(feed, FEED_WIDTH, FEED_HEIGHT);
    expectNear(await rgbAt(feed, FEED_WIDTH / 2, FEED_HEIGHT / 2), BLUE);
    expectNear(await rgbAt(feed, 6, 6), LETTERBOX_RGB, 8);
  });

  it('applies EXIF orientation and strips EXIF and GPS', async () => {
    const wide = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 0, g: 190, b: 190 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 40, channels: 3, background: { r: 190, g: 0, b: 190 } },
          })
            .png()
            .toBuffer(),
          left: 40,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    const rotated = await sharp(wide).rotate(90).jpeg().toBuffer();
    const tagged = appendApp1(
      await sharp(wide).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
      Buffer.concat([
        Buffer.from('Exif\0\0', 'binary'),
        Buffer.from('GPSLAT51.5074N GPSLONG0.1278W'),
      ]),
    );
    expect((await sharp(tagged).metadata()).orientation).toBe(6);
    expect(tagged.includes(Buffer.from('GPSLAT51.5074N'))).toBe(true);

    const fromTagged = await toFeed(tagged);
    const fromRotated = await toFeed(rotated);
    await expectCleanJpeg(fromTagged, FEED_WIDTH, FEED_HEIGHT);

    // The oriented photo is a narrow portrait, so the feed contain leaves side bars.
    // Sample inside the photo, clear of the letterbox and of the colour boundary.
    const upper = await rgbAt(fromTagged, FEED_WIDTH / 2, 180);
    const upperRotated = await rgbAt(fromRotated, FEED_WIDTH / 2, 180);
    const lower = await rgbAt(fromTagged, FEED_WIDTH / 2, FEED_HEIGHT - 180);
    const lowerRotated = await rgbAt(fromRotated, FEED_WIDTH / 2, FEED_HEIGHT - 180);
    expectNear(upper, upperRotated, 16);
    expectNear(lower, lowerRotated, 16);
    expect(Math.abs(upper[0] - lower[0])).toBeGreaterThan(40);
  }, 20_000);
});

describe('jpeg byte limit', () => {
  it('steps quality down until the buffer fits', async () => {
    const raw = Buffer.alloc(180 * 180 * 3);
    let seed = 99;
    for (let index = 0; index < raw.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[index] = seed & 0xff;
    }
    const pixels = await sharp(raw, { raw: { width: 180, height: 180, channels: 3 } })
      .png()
      .toBuffer();
    const generous = await encodeJpeg(pixels, MAX_JPEG_BYTES);
    const limit = Math.floor(generous.length / 3);
    const tight = await encodeJpeg(pixels, limit);
    expect(generous.length).toBeLessThanOrEqual(MAX_JPEG_BYTES);
    expect(tight.length).toBeLessThanOrEqual(limit);
    expect(tight.length).toBeLessThan(generous.length);
    expect(tight[0]).toBe(0xff);
    await expect(encodeJpeg(pixels, 1)).rejects.toThrow(/byte limit/);
  });
});

function appendApp1(jpeg: Buffer, payload: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('expected a JPEG');
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(payload.length + 2, 2);
  const end = jpeg.lastIndexOf(Buffer.from([0xff, 0xd9]));
  const at = end === -1 ? jpeg.length : end;
  return Buffer.concat([jpeg.subarray(0, at), marker, payload, jpeg.subarray(at)]);
}
