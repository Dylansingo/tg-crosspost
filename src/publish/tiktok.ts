import type { TikTokPrivacy } from '../config.js';
import { isRecord, send, type HttpRuntime, type OutboundRequest } from './http.js';
import { payloadName, type PayloadFile, type PlatformOutcome } from './instagram.js';
import { assertZernioOk } from './snapchat.js';

export const TIKTOK_PHOTO_LIMIT = 35;
export const TIKTOK_NATIVE_URL = 'https://open.tiktokapis.com/v2/post/publish/content/init/';

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export function tiktokZernioBody(
  imageUrls: readonly string[],
  caption: string,
  accountId: string,
  privacy: TikTokPrivacy,
): Record<string, unknown> {
  const title = caption.trim().slice(0, 90);
  return {
    ...(title.length > 0 ? { content: title } : {}),
    mediaItems: imageUrls.map((url) => ({ type: 'image', url })),
    platforms: [{ platform: 'tiktok', accountId }],
    tiktokSettings: {
      privacy_level: privacy,
      allow_comment: true,
      media_type: 'photo',
      photo_cover_index: 0,
      description: caption,
      auto_add_music: true,
      content_preview_confirmed: true,
      express_consent_given: true,
    },
    publishNow: true,
  };
}

export function tiktokZernioRequest(
  imageUrls: readonly string[],
  caption: string,
  accountId: string,
  privacy: TikTokPrivacy,
  apiKey: string,
  postsUrl: string,
): OutboundRequest {
  return {
    method: 'POST',
    url: postsUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...JSON_HEADERS,
    },
    body: tiktokZernioBody(imageUrls, caption, accountId, privacy),
  };
}

export function tiktokNativeBody(
  imageUrls: readonly string[],
  caption: string,
  privacy: TikTokPrivacy,
): Record<string, unknown> {
  const title = caption.trim().slice(0, 90);
  return {
    post_info: {
      ...(title.length > 0 ? { title } : {}),
      description: caption,
      privacy_level: privacy,
      disable_comment: false,
      auto_add_music: true,
      brand_content_toggle: false,
      brand_organic_toggle: false,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [...imageUrls],
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO',
  };
}

export function tiktokNativeRequest(
  imageUrls: readonly string[],
  caption: string,
  privacy: TikTokPrivacy,
  accessToken: string,
): OutboundRequest {
  return {
    method: 'POST',
    url: TIKTOK_NATIVE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...JSON_HEADERS,
    },
    body: tiktokNativeBody(imageUrls, caption, privacy),
  };
}

export function tiktokPayloadFiles(options: {
  jobId: string;
  imageUrls: readonly string[];
  caption: string;
  privacy: TikTokPrivacy;
  via: 'zernio' | 'native';
  apiKey: string;
  accountId: string;
  accessToken: string;
  postsUrl: string;
}): PayloadFile[] {
  const groups = chunk(options.imageUrls, TIKTOK_PHOTO_LIMIT);
  return groups.map((group, index) => {
    const request =
      options.via === 'native'
        ? tiktokNativeRequest(group, options.caption, options.privacy, options.accessToken)
        : tiktokZernioRequest(
            group,
            options.caption,
            options.accountId,
            options.privacy,
            options.apiKey,
            options.postsUrl,
          );
    return {
      fileName: payloadName(options.jobId, 'tiktok', 'photo', index, groups.length),
      json: {
        platform: 'tiktok',
        kind: 'photo',
        via: options.via,
        jobId: options.jobId,
        note:
          options.via === 'native'
            ? 'Native Content Posting API photo post. privacy_level defaults to SELF_ONLY. Public posting needs a TikTok app audit, and PULL_FROM_URL needs a verified domain. Image URLs are stand-ins for R2 URLs when they use the file scheme.'
            : 'TikTok photo post via Zernio. privacy_level defaults to SELF_ONLY. Image URLs are stand-ins for R2 URLs when they use the file scheme.',
        requests: [request],
      },
    };
  });
}

export async function publishTikTok(options: {
  imageUrls: readonly string[];
  caption: string;
  privacy: TikTokPrivacy;
  via: 'zernio' | 'native';
  apiKey?: string;
  accountId?: string;
  accessToken?: string;
  postsUrl: string;
  http: HttpRuntime;
}): Promise<PlatformOutcome> {
  if (options.imageUrls.length === 0) {
    return { platform: 'tiktok', status: 'skipped', detail: 'No image to publish.' };
  }
  const groups = chunk(options.imageUrls, TIKTOK_PHOTO_LIMIT);
  for (const group of groups) {
    if (options.via === 'native') {
      if (!options.accessToken)
        throw new Error('TikTok native publishing needs TIKTOK_ACCESS_TOKEN.');
      const result = await send(
        tiktokNativeRequest(group, options.caption, options.privacy, options.accessToken),
        options.http,
      );
      assertNativeOk(result.body);
      continue;
    }
    if (!options.apiKey || !options.accountId) {
      throw new Error('TikTok via Zernio needs ZERNIO_API_KEY and ZERNIO_TIKTOK_ACCOUNT_ID.');
    }
    const result = await send(
      tiktokZernioRequest(
        group,
        options.caption,
        options.accountId,
        options.privacy,
        options.apiKey,
        options.postsUrl,
      ),
      options.http,
    );
    assertZernioOk(result.body, 'tiktok');
  }
  return { platform: 'tiktok', status: 'published' };
}

function assertNativeOk(body: unknown): void {
  const record = isRecord(body) ? body : {};
  const error = isRecord(record.error) ? record.error : {};
  const code = typeof error.code === 'string' ? error.code : '';
  if (code !== '' && code !== 'ok') {
    const message =
      typeof error.message === 'string' && error.message.length > 0 ? error.message : code;
    throw new Error(`TikTok content posting failed: ${message}`);
  }
  const data = isRecord(record.data) ? record.data : {};
  if (typeof data.publish_id !== 'string' || data.publish_id.length === 0) {
    throw new Error('TikTok content posting did not return a publish id.');
  }
}

function chunk(items: readonly string[], size: number): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
