import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { R2Settings } from '../config.js';
import type { StagedMedia, Stager } from './contract.js';
import { feedFileName, joinPublicUrl, objectKey, safeStem, storyFileName } from './names.js';
import { toFeed, toStory } from './render.js';

const JPEG_CONTENT_TYPE = 'image/jpeg';

/** S3 client aimed at the account's R2 endpoint. Region `auto` is what R2 expects. */
export function createR2Client(settings: R2Settings): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  });
}

/**
 * Uploads the feed and story JPEGs with `ContentType: image/jpeg` and returns
 * public URLs under `R2_PUBLIC_BASE_URL`. The story URL is also the TikTok URL.
 * Construct this only when every R2 key is present. See docs/R2.md.
 */
export class R2Stager implements Stager {
  private readonly client: S3Client;

  constructor(
    private readonly settings: R2Settings,
    client?: S3Client,
  ) {
    this.client = client ?? createR2Client(settings);
  }

  async stage(buf: Buffer, name: string): Promise<StagedMedia> {
    const stem = safeStem(name);
    const feed = await toFeed(buf);
    const story = await toStory(buf);
    const feedKey = objectKey(feedFileName(stem));
    const storyKey = objectKey(storyFileName(stem));
    await this.put(feedKey, feed);
    await this.put(storyKey, story);
    const storyUrl = joinPublicUrl(this.settings.publicBaseUrl, storyKey);
    return {
      feed: joinPublicUrl(this.settings.publicBaseUrl, feedKey),
      story: storyUrl,
      tiktok: storyUrl,
    };
  }

  private async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: JPEG_CONTENT_TYPE,
      }),
    );
  }
}
