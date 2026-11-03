import type { AppConfig } from '../config.js';
import { usesR2Stager } from '../config.js';
import type { Stager } from './contract.js';
import { LocalStager } from './local.js';
import { MEDIA_DIRECTORY } from './names.js';

/**
 * Media staging.
 *
 * `stage(buf, name)` renders a 4:5 feed JPEG and a 9:16 story JPEG (the TikTok
 * photo uses the story URL) and returns the URLs publishers should post.
 * `LocalStager` is the default. `R2Stager` is loaded only when every R2 key is
 * set and the process is not in demo mode, so the S3 client stays off the
 * offline path.
 */
export const LOCAL_STAGE_DIRECTORY = './out';

export { MEDIA_DIRECTORY };
export type { StagedMedia, Stager } from './contract.js';
export { LocalStager } from './local.js';
export {
  FEED_ASPECT_TOLERANCE,
  FEED_HEIGHT,
  FEED_WIDTH,
  LETTERBOX,
  MAX_JPEG_BYTES,
  STORY_BLUR_SIGMA,
  STORY_DARKEN,
  STORY_HEIGHT,
  STORY_WIDTH,
  encodeJpeg,
  feedFit,
  toFeed,
  toStory,
  toTikTok,
} from './render.js';
export { writeContactSheet, type ContactSheetRow } from './contact-sheet.js';

export interface CreateStagerOptions {
  /** Directory for {@link LocalStager}. Defaults to `./out/media`. */
  directory?: string;
}

export async function createStager(
  config: Pick<AppConfig, 'mode' | 'r2'>,
  options: CreateStagerOptions = {},
): Promise<Stager> {
  if (usesR2Stager(config) && config.r2) {
    const { R2Stager } = await import('./r2.js');
    return new R2Stager(config.r2);
  }
  return new LocalStager(options.directory ?? MEDIA_DIRECTORY);
}
