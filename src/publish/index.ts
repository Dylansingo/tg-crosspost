import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ZERNIO_BASE_URL, type AppConfig, type TikTokPrivacy } from '../config.js';
import { logError } from '../log.js';
import type { Stager } from '../media/index.js';
import type { Job, Target } from '../types.js';
import {
  blotatoPayloadFiles,
  instagramBlotatoPayloadFiles,
  instagramBlotatoPosts,
  publishBlotato,
  tiktokBlotatoPosts,
} from './blotato.js';
import { createHttpRuntime, type HttpRuntime } from './http.js';
import {
  instagramPayloadFiles,
  publishInstagram,
  type InstagramCredentials,
  type PayloadFile,
  type PlatformOutcome,
  type StagedPhoto,
} from './instagram.js';
import type { PublishNotifier } from './notify.js';
import { previewImageSrc, writePreview, type PreviewEntry } from './preview.js';
import { publishSnapchat, snapchatPayloadFiles, zernioPostsUrl } from './snapchat.js';
import { publishTikTok, tiktokPayloadFiles } from './tiktok.js';

export type { PublishNotifier, ReactionApi } from './notify.js';
export { createGrammyNotifier, notifierFromGrammy } from './notify.js';
export { createLocalStager } from './local-stager.js';

const IG_USER_PLACEHOLDER = '<IG_USER_ID>';
const IG_TOKEN_PLACEHOLDER = '<IG_ACCESS_TOKEN>';
const ZERNIO_KEY_PLACEHOLDER = '<ZERNIO_API_KEY>';
const SNAP_ACCOUNT_PLACEHOLDER = '<ZERNIO_SNAPCHAT_ACCOUNT_ID>';
const TIKTOK_ACCOUNT_PLACEHOLDER = '<ZERNIO_TIKTOK_ACCOUNT_ID>';
const TIKTOK_TOKEN_PLACEHOLDER = '<TIKTOK_ACCESS_TOKEN>';
const BLOTATO_KEY_PLACEHOLDER = '<BLOTATO_API_KEY>';
const BLOTATO_IG_ACCOUNT_PLACEHOLDER = '<BLOTATO_INSTAGRAM_ACCOUNT_ID>';
const BLOTATO_TT_ACCOUNT_PLACEHOLDER = '<BLOTATO_TIKTOK_ACCOUNT_ID>';

export const LIVE_MEDIA_ERROR = 'R2 keys required for live publishing';

export interface Publisher {
  publish(job: Job): Promise<void>;
}

export interface PublisherDeps {
  config: AppConfig;
  stager: Stager;
  outDir?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  notifier?: PublishNotifier;
  pollTimeoutMs?: number;
  pollInitialDelayMs?: number;
  maxAttempts?: number;
}

class PlatformFailure extends Error {
  readonly platform: PlatformOutcome['platform'];

  constructor(platform: PlatformOutcome['platform'], message: string) {
    super(message);
    this.name = 'PlatformFailure';
    this.platform = platform;
  }
}

/**
 * Turn a job into Instagram, Snapchat, and TikTok posts.
 * Media URLs come only from {@link Stager.stage}. Dry-run (the default)
 * writes request payloads and a preview and does not use the network.
 */
export function createPublisher(deps: PublisherDeps): Publisher {
  const outDir = deps.outDir ?? './out';
  const http = createHttpRuntime({
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.pollTimeoutMs !== undefined ? { pollTimeoutMs: deps.pollTimeoutMs } : {}),
    ...(deps.pollInitialDelayMs !== undefined
      ? { pollInitialDelayMs: deps.pollInitialDelayMs }
      : {}),
    ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
  });
  const preview: PreviewEntry[] = [];
  let tail: Promise<void> = Promise.resolve();

  function publish(job: Job): Promise<void> {
    const run = tail.then(
      () => publishJob(job),
      () => publishJob(job),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function publishJob(job: Job): Promise<void> {
    const photos = await stagePhotos(job, deps.stager);
    const targets = new Set(job.targets);
    if (deps.config.dryRun) {
      const files = writeDryRun(outDir, job, photos, targets, deps.config);
      const requestNotes = files
        .filter((file) => isBlotatoPayload(file.json))
        .map((file) => JSON.stringify(file.json, null, 2));
      preview.push({
        ...toPreview(outDir, job, photos),
        ...(requestNotes.length > 0 ? { requestNotes } : {}),
      });
      writePreview(outDir, preview);
      console.log(
        `[DRY_RUN] job ${job.id}: wrote payloads under ${path.join(outDir, 'payloads')} and updated preview.html`,
      );
      return;
    }

    if (photos.some((photo) => photo.url.startsWith('file:'))) {
      const text = `Publishing refused for job ${job.id} (Telegram messages ${job.messageIds.join(', ')}).\n${LIVE_MEDIA_ERROR}`;
      console.error(text);
      await notifySafely(deps.notifier, text);
      throw new Error(LIVE_MEDIA_ERROR);
    }

    const tasks: Promise<PlatformOutcome>[] = [];
    if (targets.has('ig_feed') || targets.has('ig_story')) {
      tasks.push(
        runPlatform('instagram', () => publishInstagramLive(job, photos, deps.config, http)),
      );
    }
    if (targets.has('snap_story')) {
      tasks.push(
        runPlatform('snapchat', () => publishSnapchatLive(job, photos, deps.config, http)),
      );
    }
    if (targets.has('tiktok')) {
      tasks.push(runPlatform('tiktok', () => publishTikTokLive(job, photos, deps.config, http)));
    }

    const settled = await Promise.allSettled(tasks);
    const rejected = settled.filter((result) => result.status === 'rejected');
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    if (rejected.length > 0) {
      const text = failureReport(job, settled);
      console.error(text);
      await notifySafely(deps.notifier, text);
      return;
    }

    const publishedAny = fulfilled.some(
      (result) => result.status === 'fulfilled' && result.value.status === 'published',
    );
    if (!publishedAny || !deps.notifier) return;
    try {
      for (const messageId of job.messageIds) {
        await deps.notifier.react(job.chatId, messageId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const text = `Published job ${job.id}, but the ✅ reaction failed. The bot has to be an administrator of the channel.\n${detail}`;
      console.error(text);
      await notifySafely(deps.notifier, text);
    }
  }

  return { publish };
}

async function stagePhotos(job: Job, stager: Stager): Promise<StagedPhoto[]> {
  if (job.photos.length === 0) throw new Error(`Job ${job.id} has no photos.`);
  const staged: StagedPhoto[] = [];
  for (const [index, photo] of job.photos.entries()) {
    if (!photo.buffer) {
      throw new Error(`Job ${job.id} is missing the image buffer for photo ${index}.`);
    }
    const url = await stager.stage(photo.buffer, `${job.id}-${index}`);
    staged.push({ url, index });
  }
  return staged;
}

function writeDryRun(
  outDir: string,
  job: Job,
  photos: readonly StagedPhoto[],
  targets: Set<Target>,
  config: AppConfig,
): PayloadFile[] {
  const files: PayloadFile[] = [];
  const postsUrl = zernioPostsUrl(zernioBase(config));
  if (targets.has('ig_feed') || targets.has('ig_story')) {
    files.push(
      ...(config.instagramVia === 'blotato'
        ? instagramBlotatoPayloadFiles({
            jobId: job.id,
            caption: job.caption,
            photos,
            targets: job.targets,
            accountId: BLOTATO_IG_ACCOUNT_PLACEHOLDER,
            apiKey: BLOTATO_KEY_PLACEHOLDER,
          })
        : instagramPayloadFiles({
            jobId: job.id,
            caption: job.caption,
            photos,
            targets: job.targets,
            credentials: { userId: IG_USER_PLACEHOLDER, accessToken: IG_TOKEN_PLACEHOLDER },
          })),
    );
  }
  if (targets.has('snap_story')) {
    files.push(
      ...snapchatPayloadFiles({
        jobId: job.id,
        photos,
        accountId: SNAP_ACCOUNT_PLACEHOLDER,
        apiKey: ZERNIO_KEY_PLACEHOLDER,
        postsUrl,
      }),
    );
  }
  if (targets.has('tiktok')) {
    files.push(
      ...(config.tiktokVia === 'blotato'
        ? blotatoPayloadFiles({
            jobId: job.id,
            platform: 'tiktok',
            kind: 'photo',
            apiKey: BLOTATO_KEY_PLACEHOLDER,
            posts: tiktokBlotatoPosts({
              caption: job.caption,
              imageUrls: photos.map((photo) => photo.url),
              accountId: BLOTATO_TT_ACCOUNT_PLACEHOLDER,
              disclosure: config.tiktokDisclosure,
            }),
          })
        : tiktokPayloadFiles({
            jobId: job.id,
            imageUrls: photos.map((photo) => photo.url),
            caption: job.caption,
            privacy: privacyFor(config),
            via: config.tiktokVia,
            apiKey: ZERNIO_KEY_PLACEHOLDER,
            accountId: TIKTOK_ACCOUNT_PLACEHOLDER,
            accessToken: TIKTOK_TOKEN_PLACEHOLDER,
            postsUrl,
          })),
    );
  }
  const directory = path.join(outDir, 'payloads');
  mkdirSync(directory, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(directory, file.fileName), `${JSON.stringify(file.json, null, 2)}\n`);
  }
  return files;
}

async function publishInstagramLive(
  job: Job,
  photos: readonly StagedPhoto[],
  config: AppConfig,
  http: HttpRuntime,
): Promise<PlatformOutcome> {
  if (config.instagramVia === 'blotato') {
    if (!config.instagram || config.instagram.via !== 'blotato') {
      throw new Error(
        'Instagram is not configured (BLOTATO_API_KEY and BLOTATO_INSTAGRAM_ACCOUNT_ID).',
      );
    }
    return publishBlotato({
      platform: 'instagram',
      apiKey: config.instagram.apiKey,
      http,
      posts: instagramBlotatoPosts({
        caption: job.caption,
        photos,
        targets: job.targets,
        accountId: config.instagram.accountId,
      }),
    });
  }
  const credentials = instagramCredentials(config);
  return publishInstagram(
    { jobId: job.id, caption: job.caption, photos, targets: job.targets, credentials },
    http,
  );
}

async function publishSnapchatLive(
  job: Job,
  photos: readonly StagedPhoto[],
  config: AppConfig,
  http: HttpRuntime,
): Promise<PlatformOutcome> {
  if (!config.snapchat) {
    throw new Error('Snapchat is not configured (ZERNIO_API_KEY and ZERNIO_SNAPCHAT_ACCOUNT_ID).');
  }
  return publishSnapchat({
    jobId: job.id,
    photos,
    accountId: config.snapchat.accountId,
    apiKey: config.snapchat.apiKey,
    postsUrl: zernioPostsUrl(config.snapchat.baseUrl),
    http,
  });
}

async function publishTikTokLive(
  job: Job,
  photos: readonly StagedPhoto[],
  config: AppConfig,
  http: HttpRuntime,
): Promise<PlatformOutcome> {
  if (!config.tiktok) {
    throw new Error('TikTok is not configured.');
  }
  const privacy = privacyFor(config);
  if (config.tiktok.via === 'native') {
    return publishTikTok({
      imageUrls: photos.map((photo) => photo.url),
      caption: job.caption,
      privacy,
      via: 'native',
      accessToken: config.tiktok.accessToken,
      postsUrl: zernioPostsUrl(DEFAULT_ZERNIO_BASE_URL),
      http,
    });
  }
  if (config.tiktok.via === 'blotato') {
    return publishBlotato({
      platform: 'tiktok',
      apiKey: config.tiktok.apiKey,
      http,
      posts: tiktokBlotatoPosts({
        caption: job.caption,
        imageUrls: photos.map((photo) => photo.url),
        accountId: config.tiktok.accountId,
        disclosure: config.tiktokDisclosure,
      }),
    });
  }
  return publishTikTok({
    imageUrls: photos.map((photo) => photo.url),
    caption: job.caption,
    privacy,
    via: 'zernio',
    apiKey: config.tiktok.apiKey,
    accountId: config.tiktok.accountId,
    postsUrl: zernioPostsUrl(config.tiktok.baseUrl),
    http,
  });
}

function instagramCredentials(config: AppConfig): InstagramCredentials {
  if (!config.instagram || config.instagram.via !== 'graph') {
    throw new Error('Instagram is not configured (IG_USER_ID and IG_ACCESS_TOKEN).');
  }
  return { userId: config.instagram.userId, accessToken: config.instagram.accessToken };
}

function isBlotatoPayload(json: unknown): boolean {
  return typeof json === 'object' && json !== null && 'via' in json && json.via === 'blotato';
}

function privacyFor(config: AppConfig): TikTokPrivacy {
  if (config.tiktok?.via === 'native') return config.tiktok.privacy;
  return config.tiktokPrivacy;
}

function zernioBase(config: AppConfig): string {
  if (config.snapchat) return config.snapchat.baseUrl;
  if (config.tiktok?.via === 'zernio') return config.tiktok.baseUrl;
  return DEFAULT_ZERNIO_BASE_URL;
}

function toPreview(outDir: string, job: Job, photos: readonly StagedPhoto[]): PreviewEntry {
  return {
    jobId: job.id,
    caption: job.caption,
    messageIds: job.messageIds,
    targets: job.targets,
    images: photos.map((photo) => ({ src: previewImageSrc(photo.url, outDir) })),
  };
}

async function runPlatform(
  platform: PlatformOutcome['platform'],
  fn: () => Promise<PlatformOutcome>,
): Promise<PlatformOutcome> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlatformFailure(platform, message);
  }
}

function failureReport(job: Job, settled: PromiseSettledResult<PlatformOutcome>[]): string {
  const lines = settled.map((result) => {
    if (result.status === 'fulfilled') {
      const detail = result.value.detail ? ` (${result.value.detail})` : '';
      return `${platformLabel(result.value.platform)}: ${result.value.status}${detail}`;
    }
    if (result.reason instanceof PlatformFailure) {
      return `${platformLabel(result.reason.platform)}: ${result.reason.message}`;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return `Unknown: ${message}`;
  });
  return [
    `Publishing failed for job ${job.id} (Telegram messages ${job.messageIds.join(', ')}).`,
    ...lines,
  ].join('\n');
}

function platformLabel(platform: PlatformOutcome['platform']): string {
  if (platform === 'instagram') return 'Instagram';
  if (platform === 'snapchat') return 'Snapchat';
  return 'TikTok';
}

async function notifySafely(notifier: PublishNotifier | undefined, text: string): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyAdmin(text);
  } catch (error) {
    logError(error);
  }
}
