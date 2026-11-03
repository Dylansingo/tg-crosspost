import type { TikTokDisclosure } from '../config.js';
import { isRecord, send, type HttpRuntime, type OutboundRequest } from './http.js';
import {
  payloadName,
  planInstagramPosts,
  type PayloadFile,
  type PlannedInstagramPost,
  type PlatformOutcome,
  type StagedPhoto,
} from './instagram.js';
import type { Target } from '../types.js';

export const BLOTATO_ORIGIN = 'https://backend.blotato.com/v2';
export const BLOTATO_API_KEY_HEADER = 'blotato-api-key';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

export interface BlotatoPost {
  accountId: string;
  text: string;
  mediaUrls: string[];
  platform: 'instagram' | 'tiktok';
  target: Record<string, unknown>;
}

export function blotatoBody(post: BlotatoPost): Record<string, unknown> {
  return {
    post: {
      accountId: post.accountId,
      content: {
        text: post.text,
        mediaUrls: post.mediaUrls,
        platform: post.platform,
      },
      target: { targetType: post.platform, ...post.target },
    },
  };
}

export function blotatoSubmitRequest(post: BlotatoPost, apiKey: string): OutboundRequest {
  return {
    method: 'POST',
    url: `${BLOTATO_ORIGIN}/posts`,
    headers: { [BLOTATO_API_KEY_HEADER]: apiKey, ...JSON_HEADERS },
    body: blotatoBody(post),
  };
}

export function blotatoPollRequest(submissionId: string, apiKey: string): OutboundRequest {
  return {
    method: 'GET',
    url: `${BLOTATO_ORIGIN}/posts/${submissionId}`,
    headers: { [BLOTATO_API_KEY_HEADER]: apiKey, Accept: 'application/json' },
  };
}

export function instagramBlotatoPosts(options: {
  caption: string;
  photos: readonly StagedPhoto[];
  targets: readonly Target[];
  accountId: string;
}): BlotatoPost[] {
  return planInstagramPosts(options.photos, options.targets).map((planned) =>
    instagramPost(planned, options.caption, options.accountId),
  );
}

export function tiktokBlotatoPosts(options: {
  caption: string;
  imageUrls: readonly string[];
  accountId: string;
  disclosure: TikTokDisclosure;
}): BlotatoPost[] {
  const posts: BlotatoPost[] = [];
  for (let index = 0; index < options.imageUrls.length; index += 35) {
    const urls = options.imageUrls.slice(index, index + 35);
    const title = options.caption.trim().slice(0, 90);
    posts.push({
      accountId: options.accountId,
      text: options.caption,
      mediaUrls: [...urls],
      platform: 'tiktok',
      target: {
        privacyLevel: options.disclosure.privacyLevel,
        disabledComments: options.disclosure.disabledComments,
        disabledDuet: options.disclosure.disabledDuet,
        disabledStitch: options.disclosure.disabledStitch,
        isBrandedContent: options.disclosure.isBrandedContent,
        isYourBrand: options.disclosure.isYourBrand,
        isAiGenerated: options.disclosure.isAiGenerated,
        autoAddMusic: true,
        imageCoverIndex: 0,
        ...(title.length > 0 ? { title } : {}),
      },
    });
  }
  return posts;
}

export function blotatoPayloadFiles(options: {
  jobId: string;
  platform: 'instagram' | 'tiktok';
  kind: 'feed' | 'carousel' | 'story' | 'photo';
  posts: readonly BlotatoPost[];
  apiKey: string;
}): PayloadFile[] {
  return options.posts.map((post, index) => ({
    fileName: payloadName(
      options.jobId,
      options.platform,
      options.kind,
      index,
      options.posts.length,
    ),
    json: {
      platform: options.platform,
      kind: options.kind,
      via: 'blotato',
      jobId: options.jobId,
      note: 'Blotato request. The API key is a placeholder in dry-run. Poll GET /v2/posts/{postSubmissionId} until published, failed, or scheduled. Publishing needs a paid Blotato plan.',
      requests: [
        blotatoSubmitRequest(post, options.apiKey),
        blotatoPollRequest('<POST_SUBMISSION_ID>', options.apiKey),
      ],
    },
  }));
}

export function instagramBlotatoPayloadFiles(options: {
  jobId: string;
  caption: string;
  photos: readonly StagedPhoto[];
  targets: readonly Target[];
  accountId: string;
  apiKey: string;
}): PayloadFile[] {
  const planned = planInstagramPosts(options.photos, options.targets);
  const posts = planned.map((item) => instagramPost(item, options.caption, options.accountId));
  const totals = {
    feed: planned.filter((item) => item.kind === 'feed').length,
    carousel: planned.filter((item) => item.kind === 'carousel').length,
    story: planned.filter((item) => item.kind === 'story').length,
  };
  const seen = { feed: 0, carousel: 0, story: 0 };
  return posts.map((post, index) => {
    const kind = planned[index]?.kind ?? 'feed';
    const sequence = seen[kind];
    seen[kind] += 1;
    return {
      fileName: payloadName(options.jobId, 'instagram', kind, sequence, totals[kind]),
      json: {
        platform: 'instagram',
        kind,
        via: 'blotato',
        jobId: options.jobId,
        note: 'Blotato Instagram request. Stories send an empty text field. The API key is a placeholder in dry-run. Poll until published, failed, or scheduled.',
        requests: [
          blotatoSubmitRequest(post, options.apiKey),
          blotatoPollRequest('<POST_SUBMISSION_ID>', options.apiKey),
        ],
      },
    };
  });
}

export async function publishBlotato(options: {
  posts: readonly BlotatoPost[];
  apiKey: string;
  http: HttpRuntime;
  platform: PlatformOutcome['platform'];
}): Promise<PlatformOutcome> {
  if (options.posts.length === 0) {
    return { platform: options.platform, status: 'skipped', detail: 'No Blotato post to send.' };
  }
  for (const post of options.posts) {
    await submitAndPoll(post, options.apiKey, options.http);
  }
  return { platform: options.platform, status: 'published' };
}

async function submitAndPoll(post: BlotatoPost, apiKey: string, http: HttpRuntime): Promise<void> {
  const created = await send(blotatoSubmitRequest(post, apiKey), http);
  const submissionId = readSubmissionId(created.body);
  if (!submissionId) throw new Error('Blotato did not return a postSubmissionId.');
  await pollSubmission(submissionId, apiKey, http);
}

async function pollSubmission(
  submissionId: string,
  apiKey: string,
  http: HttpRuntime,
): Promise<void> {
  const deadline = http.now() + http.pollTimeoutMs;
  let delay = http.pollInitialDelayMs;
  let last = 'unknown';
  while (true) {
    const result = await send(blotatoPollRequest(submissionId, apiKey), http);
    const status = readStatus(result.body);
    last = status.status ?? last;
    if (status.status === 'published' || status.status === 'scheduled') return;
    if (status.status === 'failed') {
      const detail = status.errorMessage ? `: ${status.errorMessage}` : '';
      throw new Error(`Blotato post ${submissionId} failed${detail}.`);
    }
    if (http.now() >= deadline) {
      throw new Error(
        `Blotato post ${submissionId} timed out after ${http.pollTimeoutMs}ms (last status ${last}).`,
      );
    }
    await http.sleep(delay);
    delay = Math.min(delay * 2, http.pollMaxDelayMs);
  }
}

function instagramPost(
  planned: PlannedInstagramPost,
  caption: string,
  accountId: string,
): BlotatoPost {
  const story = planned.kind === 'story';
  return {
    accountId,
    text: story ? '' : caption,
    mediaUrls: planned.photos.map((photo) => photo.url),
    platform: 'instagram',
    target: story ? { mediaType: 'story' } : {},
  };
}

function readSubmissionId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.postSubmissionId === 'string' && body.postSubmissionId.length > 0
    ? body.postSubmissionId
    : undefined;
}

function readStatus(body: unknown): { status?: string; errorMessage?: string } {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.post)
    ? root.post
    : isRecord(root.submission)
      ? root.submission
      : root;
  const status =
    typeof nested.status === 'string'
      ? nested.status
      : typeof root.status === 'string'
        ? root.status
        : undefined;
  const errorMessage =
    typeof nested.errorMessage === 'string'
      ? nested.errorMessage
      : typeof root.errorMessage === 'string'
        ? root.errorMessage
        : undefined;
  if (status === undefined) return {};
  if (errorMessage === undefined) return { status };
  return { status, errorMessage };
}
