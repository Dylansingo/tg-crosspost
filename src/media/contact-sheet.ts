import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FEED_HEIGHT, FEED_WIDTH, STORY_HEIGHT, STORY_WIDTH } from './render.js';

export interface ContactSheetRow {
  label: string;
  feed: Buffer;
  story: Buffer;
}

const MARGIN = 32;
const GAP = 20;
const THUMB_WIDTH = 360;
const FEED_THUMB_HEIGHT = Math.round((THUMB_WIDTH * FEED_HEIGHT) / FEED_WIDTH);
const STORY_THUMB_HEIGHT = Math.round((THUMB_WIDTH * STORY_HEIGHT) / STORY_WIDTH);
const TITLE_HEIGHT = 52;
const COLUMN_HEIGHT = 32;
const LABEL_HEIGHT = 34;
const SHEET_BACKGROUND = { r: 0x2c, g: 0x2c, b: 0x30 };

interface SheetOverlay {
  input: Buffer;
  left: number;
  top: number;
}

/**
 * A labelled grid of feed and story renders, one row per sample, for the client.
 * Columns are the 4:5 feed and the 9:16 story (also used for TikTok).
 */
export async function writeContactSheet(
  rows: ContactSheetRow[],
  destination: string,
): Promise<void> {
  if (rows.length === 0) throw new Error('Contact sheet needs at least one render.');
  const width = MARGIN * 2 + THUMB_WIDTH * 2 + GAP;
  const rowHeight = LABEL_HEIGHT + STORY_THUMB_HEIGHT + GAP;
  const height = MARGIN + TITLE_HEIGHT + COLUMN_HEIGHT + rows.length * rowHeight - GAP + MARGIN;

  const overlays: SheetOverlay[] = [];
  overlays.push(
    await textOverlay('Sample renders', 0, MARGIN, width - MARGIN * 2, TITLE_HEIGHT, 28),
  );
  const columnsTop = MARGIN + TITLE_HEIGHT;
  overlays.push(await textOverlay('Feed 4:5', MARGIN, columnsTop, THUMB_WIDTH, COLUMN_HEIGHT, 20));
  overlays.push(
    await textOverlay(
      'Story / TikTok 9:16',
      MARGIN + THUMB_WIDTH + GAP,
      columnsTop,
      THUMB_WIDTH,
      COLUMN_HEIGHT,
      20,
    ),
  );

  let top = columnsTop + COLUMN_HEIGHT;
  for (const row of rows) {
    overlays.push(await textOverlay(row.label, MARGIN, top, width - MARGIN * 2, LABEL_HEIGHT, 22));
    const imagesTop = top + LABEL_HEIGHT;
    const feedTop = imagesTop + Math.round((STORY_THUMB_HEIGHT - FEED_THUMB_HEIGHT) / 2);
    overlays.push({
      input: await thumbnail(row.feed, THUMB_WIDTH, FEED_THUMB_HEIGHT),
      left: MARGIN,
      top: feedTop,
    });
    overlays.push({
      input: await thumbnail(row.story, THUMB_WIDTH, STORY_THUMB_HEIGHT),
      left: MARGIN + THUMB_WIDTH + GAP,
      top: imagesTop,
    });
    top += rowHeight;
  }

  const sheet = await sharp({
    create: { width, height, channels: 3, background: SHEET_BACKGROUND },
  })
    .composite(overlays)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, sheet);
}

async function thumbnail(source: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(source).resize(width, height, { fit: 'fill' }).jpeg({ quality: 80 }).toBuffer();
}

async function textOverlay(
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fontSize: number,
): Promise<SheetOverlay> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="${Math.round(height * 0.72)}" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}" fill="#f4f4f5">${escapeXml(text)}</text></svg>`;
  const input = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input, left, top };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
