import type { Target } from '../types.js';
import { isRecord, send, type HttpRuntime, type OutboundRequest } from './http.js';

export const IG_GRAPH_VERSION = 'v21.0';
export const IG_GRAPH_ORIGIN = 'https://graph.facebook.com';
export const INSTAGRAM_CAROUSEL_LIMIT = 10;
export const INSTAGRAM_DEFAULT_QUOTA = 50;

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export interface StagedPhoto {
  url: string;
  index: number;
}

export interface PlannedInstagramPost {
  kind: 'feed' | 'carousel' | 'story';
  photos: readonly StagedPhoto[];
}

export interface InstagramCredentials {
  userId: string;
  accessToken: string;
}

export interface InstagramInput {
  jobId: string;
  caption: string;
  photos: readonly StagedPhoto[];
  targets: readonly Target[];
  credentials: InstagramCredentials;
}

export interface PayloadFile {
  fileName: string;
  json: unknown;
}

export interface PlatformOutcome {
  platform: 'instagram' | 'snapchat' | 'tiktok';
  status: 'published' | 'skipped';
  detail?: string;
}

export function planInstagramPosts(
  photos: readonly StagedPhoto[],
  targets: readonly Target[],
): PlannedInstagramPost[] {
  const posts: PlannedInstagramPost[] = [];
  if (targets.includes('ig_feed')) {
    if (photos.length <= 1) {
      posts.push({ kind: 'feed', photos: [...photos] });
    } else {
      for (let index = 0; index < photos.length; index += INSTAGRAM_CAROUSEL_LIMIT) {
        const slice = photos.slice(index, index + INSTAGRAM_CAROUSEL_LIMIT);
        posts.push({ kind: slice.length === 1 ? 'feed' : 'carousel', photos: slice });
      }
    }
  }
  if (targets.includes('ig_story')) {
    for (const photo of photos) posts.push({ kind: 'story', photos: [photo] });
  }
  return posts;
}

export function feedBody(imageUrl: string, caption: string): Record<string, unknown> {
  return { image_url: imageUrl, caption };
}

export function storyBody(imageUrl: string): Record<string, unknown> {
  return { image_url: imageUrl, media_type: 'STORIES' };
}

export function carouselChildBody(imageUrl: string): Record<string, unknown> {
  return { image_url: imageUrl, is_carousel_item: true };
}

export function carouselParentBody(
  caption: string,
  childIds: readonly string[],
): Record<string, unknown> {
  return { media_type: 'CAROUSEL', caption, children: childIds.join(',') };
}

export function graphUrl(path: string, query: Record<string, string>, accessToken: string): string {
  const pairs = Object.entries(query).map(([key, value]) => `${key}=${value}`);
  pairs.push(`access_token=${encodeAccessToken(accessToken)}`);
  return `${IG_GRAPH_ORIGIN}/${IG_GRAPH_VERSION}/${path}?${pairs.join('&')}`;
}

/** Dry-run description of the requests for one planned post. Container ids are placeholders. */
export function instagramPayloadFiles(input: InstagramInput): PayloadFile[] {
  const posts = planInstagramPosts(input.photos, input.targets);
  const totals = countKinds(posts);
  const seen = { feed: 0, carousel: 0, story: 0 };
  return posts.map((post) => {
    const index = seen[post.kind];
    seen[post.kind] += 1;
    return {
      fileName: payloadName(input.jobId, 'instagram', post.kind, index, totals[post.kind]),
      json: {
        platform: 'instagram',
        kind: post.kind,
        jobId: input.jobId,
        note: 'image_url is a local stand-in for the R2 URL from Stager.stage when it uses the file scheme. Tokens are placeholders. The status request is repeated with backoff until FINISHED.',
        requests: requestsFor(post, input.credentials, input.caption),
      },
    };
  });
}

export async function publishInstagram(
  input: InstagramInput,
  http: HttpRuntime,
): Promise<PlatformOutcome> {
  const posts = planInstagramPosts(input.photos, input.targets);
  if (posts.length === 0) {
    return { platform: 'instagram', status: 'skipped', detail: 'No Instagram target on the job.' };
  }
  const quota = await readQuota(input.credentials, http);
  let remaining = quota.total - quota.usage;
  let published = 0;
  const skipped: string[] = [];
  for (const post of posts) {
    if (remaining <= 0) {
      const message = `Instagram publishing limit reached (${quota.usage} of ${quota.total} posts in the last 24h). Skipping ${post.kind} for job ${input.jobId}.`;
      console.warn(message);
      skipped.push(post.kind);
      continue;
    }
    await publishPlanned(post, input, http);
    published += 1;
    remaining -= 1;
    quota.usage += 1;
  }
  if (published === 0) {
    return { platform: 'instagram', status: 'skipped', detail: 'publishing limit' };
  }
  if (skipped.length > 0) {
    return {
      platform: 'instagram',
      status: 'published',
      detail: `Skipped after the publishing limit: ${skipped.join(', ')}.`,
    };
  }
  return { platform: 'instagram', status: 'published' };
}

async function publishPlanned(
  post: PlannedInstagramPost,
  input: InstagramInput,
  http: HttpRuntime,
): Promise<void> {
  if (post.kind === 'carousel') {
    await publishCarousel(post.photos, input.caption, input.credentials, http);
    return;
  }
  const photo = post.photos[0];
  if (!photo) throw new Error(`Instagram ${post.kind} post has no image.`);
  const body = post.kind === 'story' ? storyBody(photo.url) : feedBody(photo.url, input.caption);
  const containerId = await createContainer(body, input.credentials, http);
  await pollContainer(containerId, input.credentials, http);
  await publishContainer(containerId, input.credentials, http);
}

async function publishCarousel(
  photos: readonly StagedPhoto[],
  caption: string,
  credentials: InstagramCredentials,
  http: HttpRuntime,
): Promise<void> {
  const childIds: string[] = [];
  for (const photo of photos) {
    const childId = await createContainer(carouselChildBody(photo.url), credentials, http);
    await pollContainer(childId, credentials, http);
    childIds.push(childId);
  }
  const parentId = await createContainer(carouselParentBody(caption, childIds), credentials, http);
  await pollContainer(parentId, credentials, http);
  await publishContainer(parentId, credentials, http);
}

async function readQuota(
  credentials: InstagramCredentials,
  http: HttpRuntime,
): Promise<{ usage: number; total: number }> {
  const result = await send(
    {
      method: 'GET',
      url: graphUrl(
        `${credentials.userId}/content_publishing_limit`,
        { fields: 'quota_usage,config' },
        credentials.accessToken,
      ),
      headers: { Accept: 'application/json' },
    },
    http,
  );
  return parseQuota(result.body);
}

async function createContainer(
  body: Record<string, unknown>,
  credentials: InstagramCredentials,
  http: HttpRuntime,
): Promise<string> {
  const result = await send(
    {
      method: 'POST',
      url: graphUrl(`${credentials.userId}/media`, {}, credentials.accessToken),
      headers: JSON_HEADERS,
      body,
    },
    http,
  );
  if (!isRecord(result.body) || typeof result.body.id !== 'string' || result.body.id.length === 0) {
    throw new Error('Instagram did not return a container id.');
  }
  return result.body.id;
}

async function pollContainer(
  containerId: string,
  credentials: InstagramCredentials,
  http: HttpRuntime,
): Promise<void> {
  const deadline = http.now() + http.pollTimeoutMs;
  let delay = http.pollInitialDelayMs;
  while (true) {
    const result = await send(
      {
        method: 'GET',
        url: graphUrl(containerId, { fields: 'status_code' }, credentials.accessToken),
        headers: { Accept: 'application/json' },
      },
      http,
    );
    const status = readStatus(result.body);
    if (status.code === 'FINISHED') return;
    if (status.code === 'ERROR' || status.code === 'EXPIRED') {
      const detail = status.detail ? `: ${status.detail}` : '';
      throw new Error(
        `Instagram container ${containerId} returned status ${status.code}${detail}.`,
      );
    }
    if (http.now() >= deadline) {
      const last = status.code ?? 'unknown';
      throw new Error(
        `Instagram container ${containerId} timed out after ${http.pollTimeoutMs}ms (last status ${last}).`,
      );
    }
    await http.sleep(delay);
    delay = Math.min(delay * 2, http.pollMaxDelayMs);
  }
}

async function publishContainer(
  containerId: string,
  credentials: InstagramCredentials,
  http: HttpRuntime,
): Promise<void> {
  await send(
    {
      method: 'POST',
      url: graphUrl(`${credentials.userId}/media_publish`, {}, credentials.accessToken),
      headers: JSON_HEADERS,
      body: { creation_id: containerId },
    },
    http,
  );
}

function requestsFor(
  post: PlannedInstagramPost,
  credentials: InstagramCredentials,
  caption: string,
): OutboundRequest[] {
  const quota: OutboundRequest = {
    method: 'GET',
    url: graphUrl(
      `${credentials.userId}/content_publishing_limit`,
      { fields: 'quota_usage,config' },
      credentials.accessToken,
    ),
    headers: { Accept: 'application/json' },
  };
  if (post.kind === 'carousel') {
    const requests: OutboundRequest[] = [quota];
    const childIds = post.photos.map((_, index) => `<CONTAINER_ID_${index + 1}>`);
    post.photos.forEach((photo, index) => {
      const containerId = childIds[index] ?? `<CONTAINER_ID_${index + 1}>`;
      requests.push(mediaPost(carouselChildBody(photo.url), credentials));
      requests.push(statusGet(containerId, credentials));
    });
    const parentId = '<CONTAINER_ID_PARENT>';
    requests.push(mediaPost(carouselParentBody(caption, childIds), credentials));
    requests.push(statusGet(parentId, credentials));
    requests.push(publishPost(parentId, credentials));
    return requests;
  }
  const photo = post.photos[0];
  const body = !photo
    ? {}
    : post.kind === 'story'
      ? storyBody(photo.url)
      : feedBody(photo.url, caption);
  const containerId = '<CONTAINER_ID>';
  return [
    quota,
    mediaPost(body, credentials),
    statusGet(containerId, credentials),
    publishPost(containerId, credentials),
  ];
}

function mediaPost(
  body: Record<string, unknown>,
  credentials: InstagramCredentials,
): OutboundRequest {
  return {
    method: 'POST',
    url: graphUrl(`${credentials.userId}/media`, {}, credentials.accessToken),
    headers: JSON_HEADERS,
    body,
  };
}

function statusGet(containerId: string, credentials: InstagramCredentials): OutboundRequest {
  return {
    method: 'GET',
    url: graphUrl(containerId, { fields: 'status_code' }, credentials.accessToken),
    headers: { Accept: 'application/json' },
  };
}

function publishPost(containerId: string, credentials: InstagramCredentials): OutboundRequest {
  return {
    method: 'POST',
    url: graphUrl(`${credentials.userId}/media_publish`, {}, credentials.accessToken),
    headers: JSON_HEADERS,
    body: { creation_id: containerId },
  };
}

function parseQuota(body: unknown): { usage: number; total: number } {
  const root = isRecord(body) ? body : {};
  const entry = Array.isArray(root.data) ? root.data[0] : root;
  const record = isRecord(entry) ? entry : {};
  const config = isRecord(record.config) ? record.config : {};
  return {
    usage: asNumber(record.quota_usage) ?? 0,
    total: asNumber(config.quota_total) ?? INSTAGRAM_DEFAULT_QUOTA,
  };
}

function readStatus(body: unknown): { code?: string; detail?: string } {
  if (!isRecord(body)) return {};
  const code = typeof body.status_code === 'string' ? body.status_code : undefined;
  const detail = typeof body.status === 'string' ? body.status : undefined;
  if (code === undefined) return {};
  if (detail === undefined) return { code };
  return { code, detail };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function countKinds(
  posts: readonly PlannedInstagramPost[],
): Record<PlannedInstagramPost['kind'], number> {
  return {
    feed: posts.filter((post) => post.kind === 'feed').length,
    carousel: posts.filter((post) => post.kind === 'carousel').length,
    story: posts.filter((post) => post.kind === 'story').length,
  };
}

export function payloadName(
  jobId: string,
  platform: string,
  kind: string,
  index: number,
  total: number,
): string {
  const suffix = total > 1 ? `-${index + 1}` : '';
  return `${safeSegment(jobId)}-${platform}-${kind}${suffix}.json`;
}

function encodeAccessToken(token: string): string {
  if (token.startsWith('<') && token.endsWith('>')) return token;
  return encodeURIComponent(token);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}
