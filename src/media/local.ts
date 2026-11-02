import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StagedMedia, Stager } from './contract.js';
import { feedFileName, MEDIA_DIRECTORY, safeStem, storyFileName } from './names.js';
import { toFeed, toStory } from './render.js';

/**
 * Writes `./out/media/{name}-feed.jpg` and `-story.jpg` and returns `file://` URLs.
 * This is the default stager: demo mode, and whenever any R2 key is missing.
 */
export class LocalStager implements Stager {
  constructor(private readonly directory: string = MEDIA_DIRECTORY) {}

  async stage(buf: Buffer, name: string): Promise<StagedMedia> {
    const stem = safeStem(name);
    const feed = await toFeed(buf);
    const story = await toStory(buf);
    await mkdir(this.directory, { recursive: true });
    const feedPath = path.resolve(this.directory, feedFileName(stem));
    const storyPath = path.resolve(this.directory, storyFileName(stem));
    await writeFile(feedPath, feed);
    await writeFile(storyPath, story);
    const storyUrl = pathToFileURL(storyPath).href;
    return {
      feed: pathToFileURL(feedPath).href,
      story: storyUrl,
      tiktok: storyUrl,
    };
  }
}
