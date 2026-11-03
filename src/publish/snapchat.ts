import { isRecord, send, type HttpRuntime, type OutboundRequest } from './http.js';
import {
  payloadName,
  type PayloadFile,
  type PlatformOutcome,
  type StagedPhoto,
} from './instagram.js';

/**
 * Public Story on a Snapchat Public Profile.
 * Zernio models that as `contentType: "story"` (24 hours, no caption).
 * Saved Stories and Spotlight are different products and are not used here.
 */
export function snapchatStoryBody(imageUrl: string, accountId: string): Record<string, unknown> {
  return {
    mediaItems: [{ type: 'image', url: imageUrl }],
    platforms: [
      {
        platform: 'snapchat',
        accountId,
        platformSpecificData: { contentType: 'story' },
      },
    ],
    publishNow: true,
  };
}

export function snapchatRequest(
  imageUrl: string,
  accountId: string,
  apiKey: string,
  postsUrl: string,
): OutboundRequest {
  return {
    method: 'POST',
    url: postsUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: snapchatStoryBody(imageUrl, accountId),
  };
}

/** One story per image. Snapchat accepts a single media item and no caption. */
export function snapchatPayloadFiles(options: {
  jobId: string;
  photos: readonly StagedPhoto[];
  accountId: string;
  apiKey: string;
  postsUrl: string;
}): PayloadFile[] {
  return options.photos.map((photo, index) => ({
    fileName: payloadName(options.jobId, 'snapchat', 'story', index, options.photos.length),
    json: {
      platform: 'snapchat',
      kind: 'story',
      jobId: options.jobId,
      note: 'Public Story via Zernio contentType "story". One image per post. Snapchat stories do not take a caption. The image URL is a stand-in for the R2 URL when it uses the file scheme.',
      requests: [snapchatRequest(photo.url, options.accountId, options.apiKey, options.postsUrl)],
    },
  }));
}

export async function publishSnapchat(options: {
  jobId: string;
  photos: readonly StagedPhoto[];
  accountId: string;
  apiKey: string;
  postsUrl: string;
  http: HttpRuntime;
}): Promise<PlatformOutcome> {
  if (options.photos.length === 0) {
    return { platform: 'snapchat', status: 'skipped', detail: 'No image to publish.' };
  }
  for (const photo of options.photos) {
    const result = await send(
      snapchatRequest(photo.url, options.accountId, options.apiKey, options.postsUrl),
      options.http,
    );
    assertZernioOk(result.body, 'snapchat');
  }
  return { platform: 'snapchat', status: 'published' };
}

export function zernioPostsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) return `${trimmed}/posts`;
  return `${trimmed}/v1/posts`;
}

export function assertZernioOk(body: unknown, platform: string): void {
  if (!isRecord(body) || !isRecord(body.post)) return;
  const post = body.post;
  if (post.status === 'failed') {
    throw new Error(`Zernio reported the ${platform} post as failed.`);
  }
  if (!Array.isArray(post.platforms)) return;
  for (const entry of post.platforms) {
    if (!isRecord(entry) || entry.status !== 'failed') continue;
    const name = typeof entry.platform === 'string' ? entry.platform : platform;
    throw new Error(`Zernio ${name} post failed.`);
  }
}
