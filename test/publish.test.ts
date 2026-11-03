import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig, type TikTokPrivacy } from '../src/config.js';
import type { Stager } from '../src/media/index.js';
import { retryDelayMs } from '../src/publish/http.js';
import {
  createGrammyNotifier,
  createPublisher,
  LIVE_MEDIA_ERROR,
  type PublishNotifier,
} from '../src/publish/index.js';
import { zernioPostsUrl } from '../src/publish/snapchat.js';
import type { Job, Photo, Target } from '../src/types.js';

const TELEGRAM = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  CHANNEL_ID: '-100123',
  ADMIN_CHAT_ID: '42',
};

function photo(index: number): Photo {
  return {
    fileId: `p${index}.jpg`,
    fileUniqueId: `u${index}`,
    width: 1080,
    height: 1350,
    buffer: Buffer.from(`image-${index}`),
  };
}

function makeJob(options: {
  id?: string;
  targets: Target[];
  photos?: number;
  caption?: string;
  messageIds?: number[];
}): Job {
  const count = options.photos ?? 1;
  return {
    id: options.id ?? 'job-1',
    chatId: -100555,
    messageIds: options.messageIds ?? [101],
    caption: options.caption ?? 'Hello from the towpath',
    targets: options.targets,
    receivedAt: new Date('2026-11-02T12:00:00.000Z'),
    photos: Array.from({ length: count }, (_, index) => photo(index)),
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'normal',
    dryRun: true,
    sqlitePath: ':memory:',
    instagramVia: 'graph',
    tiktokVia: 'zernio',
    tiktokPrivacy: 'SELF_ONLY',
    tiktokDisclosure: {
      privacyLevel: 'SELF_ONLY',
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: false,
      isAiGenerated: false,
    },
    warnings: [],
    platforms: [],
    ...overrides,
  };
}

function httpsStager(): Stager {
  return {
    async stage(_buf: Buffer, name: string) {
      return `https://media.example/${name}.jpg`;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return undefined;
  return JSON.parse(init.body) as unknown;
}

interface NotifierProbe extends PublishNotifier {
  reactions: { chatId: number; messageId: number }[];
  messages: string[];
}

function notifier(): NotifierProbe {
  const reactions: { chatId: number; messageId: number }[] = [];
  const messages: string[] = [];
  return {
    reactions,
    messages,
    async react(chatId: number, messageId: number) {
      reactions.push({ chatId, messageId });
    },
    async notifyAdmin(text: string) {
      messages.push(text);
    },
  };
}

const QUOTA_OK = {
  data: [{ quota_usage: 0, config: { quota_total: 50, quota_duration: 86400 } }],
};

function liveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return baseConfig({
    dryRun: false,
    instagram: { via: 'graph', userId: '1789', accessToken: 'ig-secret-token' },
    snapchat: {
      apiKey: 'zernio-secret',
      baseUrl: 'https://zernio.com/api',
      accountId: 'snap-1',
    },
    tiktok: {
      via: 'zernio',
      apiKey: 'zernio-secret',
      baseUrl: 'https://zernio.com/api',
      accountId: 'tt-1',
    },
    ...overrides,
  });
}

describe('retry delay', () => {
  it('applies exponential backoff with jitter between half and the full delay', () => {
    expect(retryDelayMs(0, () => 0)).toBe(100);
    expect(retryDelayMs(0, () => 1)).toBe(200);
    expect(retryDelayMs(1, () => 0)).toBe(200);
    expect(retryDelayMs(2, () => 1)).toBe(800);
    expect(retryDelayMs(20, () => 1)).toBe(8_000);
  });
});

describe('Zernio posts URL', () => {
  it('builds the documented /v1/posts path', () => {
    expect(zernioPostsUrl('https://zernio.com/api')).toBe('https://zernio.com/api/v1/posts');
    expect(zernioPostsUrl('https://zernio.com/api/')).toBe('https://zernio.com/api/v1/posts');
    expect(zernioPostsUrl('https://zernio.com/api/v1')).toBe('https://zernio.com/api/v1/posts');
  });
});

describe('publisher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls a container until FINISHED, then publishes', async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-1' });
      if (url.includes('/media?')) return jsonResponse({ id: 'c1' });
      if (url.includes('fields=status_code')) {
        polls += 1;
        return jsonResponse({ status_code: polls === 1 ? 'IN_PROGRESS' : 'FINISHED' });
      }
      throw new Error(`unexpected ${url} ${init?.method ?? ''}`);
    });
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollInitialDelayMs: 250,
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'] }));
    expect(polls).toBe(2);
    expect(sleeps).toEqual([250]);
    const publishCall = fetchImpl.mock.calls.find((call) =>
      requestUrl(call[0]).includes('/media_publish'),
    );
    expect(publishCall).toBeTruthy();
    expect(requestBody(publishCall?.[1])).toEqual({ creation_id: 'c1' });
  });

  it('fails the post when the container status is ERROR and does not publish it', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'should-not-publish' });
      if (url.includes('/media?')) return jsonResponse({ id: 'c-err' });
      if (url.includes('fields=status_code')) {
        return jsonResponse({ status_code: 'ERROR', status: 'Media download failed' });
      }
      throw new Error(`unexpected ${url}`);
    });
    const probe = notifier();
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
      notifier: probe,
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'] }));
    expect(
      fetchImpl.mock.calls.some((call) => requestUrl(call[0]).includes('/media_publish')),
    ).toBe(false);
    expect(probe.reactions).toEqual([]);
    expect(probe.messages.join('\n')).toContain('returned status ERROR: Media download failed');
  });

  it('gives up when a container stays IN_PROGRESS past the timeout', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media?')) return jsonResponse({ id: 'c-slow' });
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'IN_PROGRESS' });
      throw new Error(`unexpected ${url}`);
    });
    const probe = notifier();
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
      notifier: probe,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      pollTimeoutMs: 1_000,
      pollInitialDelayMs: 400,
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'] }));
    expect(sleeps).toEqual([400, 800]);
    expect(probe.messages.join('\n')).toContain('timed out after 1000ms');
  });

  it('splits an album longer than 10 into a carousel and a feed post', async () => {
    let container = 0;
    const created: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'published' });
      if (url.includes('/media?')) {
        created.push(requestBody(init));
        container += 1;
        return jsonResponse({ id: `c${container}` });
      }
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      throw new Error(`unexpected ${url}`);
    });
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'], photos: 11 }));
    const children = created.filter((body) => isRecord(body) && body.is_carousel_item === true);
    const parents = created.filter((body) => isRecord(body) && body.media_type === 'CAROUSEL');
    const feeds = created.filter(
      (body) => isRecord(body) && body.is_carousel_item !== true && body.media_type !== 'CAROUSEL',
    );
    expect(children).toHaveLength(10);
    expect(parents).toHaveLength(1);
    expect(
      String(parents[0] && isRecord(parents[0]) ? parents[0].children : '').split(','),
    ).toHaveLength(10);
    expect(feeds).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter((call) => requestUrl(call[0]).includes('/media_publish')),
    ).toHaveLength(2);
  });

  it('creates one story container per image', async () => {
    const created: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'published' });
      if (url.includes('/media?')) {
        created.push(requestBody(init));
        return jsonResponse({ id: `story-${created.length}` });
      }
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      throw new Error(`unexpected ${url}`);
    });
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
    });
    await publisher.publish(makeJob({ targets: ['ig_story'], photos: 3 }));
    expect(created).toEqual([
      { image_url: 'https://media.example/job-1-0.jpg', media_type: 'STORIES' },
      { image_url: 'https://media.example/job-1-1.jpg', media_type: 'STORIES' },
      { image_url: 'https://media.example/job-1-2.jpg', media_type: 'STORIES' },
    ]);
    expect(
      fetchImpl.mock.calls.filter((call) => requestUrl(call[0]).includes('/media_publish')),
    ).toHaveLength(3);
  });

  it('skips Instagram with a warning when the publishing limit is already reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) {
        return jsonResponse({
          data: [{ quota_usage: 50, config: { quota_total: 50, quota_duration: 86400 } }],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const probe = notifier();
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
      notifier: probe,
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'] }));
    expect(fetchImpl.mock.calls.some((call) => requestUrl(call[0]).includes('/media?'))).toBe(
      false,
    );
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Instagram publishing limit reached (50 of 50 posts in the last 24h). Skipping feed for job job-1.',
    );
    expect(probe.reactions).toEqual([]);
    expect(probe.messages).toEqual([]);
  });

  it('retries 429 and network errors with backoff, and does not retry a 400', async () => {
    const sleeps: number[] = [];
    let mediaAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-1' });
      if (url.includes('/media?')) {
        mediaAttempts += 1;
        if (mediaAttempts < 3) return new Response('slow down', { status: 429 });
        return jsonResponse({ id: 'c1' });
      }
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      throw new Error(`unexpected ${url}`);
    });
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await publisher.publish(makeJob({ targets: ['ig_feed'] }));
    expect(mediaAttempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);

    let networkAttempts = 0;
    const networkSleeps: number[] = [];
    const networkFetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-1' });
      if (url.includes('/media?')) {
        networkAttempts += 1;
        if (networkAttempts === 1) throw new TypeError('network down');
        return jsonResponse({ id: 'c1' });
      }
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      throw new Error(`unexpected ${url}`);
    });
    const retried = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl: networkFetch,
      random: () => 0,
      sleep: async (ms) => {
        networkSleeps.push(ms);
      },
    });
    await retried.publish(makeJob({ id: 'job-net', targets: ['ig_feed'] }));
    expect(networkAttempts).toBe(2);
    expect(networkSleeps).toEqual([100]);

    const rejected = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media?')) return new Response('bad request', { status: 400 });
      throw new Error(`unexpected ${url}`);
    });
    const probe = notifier();
    const once = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl: rejected,
      notifier: probe,
      sleep: async () => {
        throw new Error('400 must not be retried');
      },
    });
    await once.publish(makeJob({ id: 'job-400', targets: ['ig_feed'] }));
    expect(
      rejected.mock.calls.filter((call) => requestUrl(call[0]).includes('/media?')),
    ).toHaveLength(1);
    expect(probe.messages.join('\n')).toContain('failed with 400');
    expect(probe.messages.join('\n')).not.toContain('ig-secret-token');
  });

  it('sends one Snapchat story per image and defaults TikTok to SELF_ONLY', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('tiktokapis.com')) {
        bodies.push(requestBody(init));
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer tt-secret' });
        return jsonResponse({ data: { publish_id: 'p1' }, error: { code: 'ok', message: '' } });
      }
      if (url.includes('/v1/posts')) {
        bodies.push(requestBody(init));
        return jsonResponse({ post: { status: 'published' } }, 201);
      }
      throw new Error(`unexpected ${url}`);
    });
    const native = createPublisher({
      config: liveConfig({
        tiktokVia: 'native',
        tiktokPrivacy: 'SELF_ONLY',
        tiktok: {
          via: 'native',
          clientKey: 'ck',
          clientSecret: 'cs-secret',
          accessToken: 'tt-secret',
          privacy: 'SELF_ONLY' satisfies TikTokPrivacy,
        },
      }),
      stager: httpsStager(),
      fetchImpl,
    });
    await native.publish(makeJob({ targets: ['snap_story', 'tiktok'], photos: 2 }));
    const snapBodies = bodies.filter(
      (body) =>
        isRecord(body) &&
        Array.isArray(body.platforms) &&
        isRecord(body.platforms[0]) &&
        body.platforms[0].platform === 'snapchat',
    );
    expect(snapBodies).toHaveLength(2);
    for (const body of snapBodies) {
      expect(isRecord(body) ? body.content : 'present').toBeUndefined();
      expect(isRecord(body) ? body.mediaItems : []).toEqual([
        expect.objectContaining({ type: 'image' }),
      ]);
      const platform =
        isRecord(body) && Array.isArray(body.platforms) ? body.platforms[0] : undefined;
      const specific =
        isRecord(platform) && isRecord(platform.platformSpecificData)
          ? platform.platformSpecificData
          : {};
      expect(specific).toEqual({ contentType: 'story' });
    }
    const tiktokBody = bodies.find((body) => isRecord(body) && body.media_type === 'PHOTO');
    expect(tiktokBody && isRecord(tiktokBody) ? tiktokBody.post_info : {}).toMatchObject({
      privacy_level: 'SELF_ONLY',
    });
    expect(tiktokBody && isRecord(tiktokBody) ? tiktokBody.source_info : {}).toEqual({
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: ['https://media.example/job-1-0.jpg', 'https://media.example/job-1-1.jpg'],
    });
  });

  it('DMs the admin on a partial failure and reacts only when every platform succeeds', async () => {
    const failing = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('graph.facebook.com')) return new Response('no', { status: 400 });
      if (url.includes('/v1/posts')) return jsonResponse({ post: { status: 'published' } }, 201);
      throw new Error(`unexpected ${url}`);
    });
    const probe = notifier();
    const publisher = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl: failing,
      notifier: probe,
    });
    await publisher.publish(
      makeJob({ targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'], messageIds: [7, 8] }),
    );
    expect(probe.reactions).toEqual([]);
    const report = probe.messages.join('\n');
    expect(report).toContain('Publishing failed for job job-1 (Telegram messages 7, 8).');
    expect(report).toContain('Instagram:');
    expect(report).toContain('failed with 400');
    expect(report).toContain('Snapchat: published');
    expect(report).toContain('TikTok: published');

    let container = 0;
    const succeeding = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('content_publishing_limit')) return jsonResponse(QUOTA_OK);
      if (url.includes('/media_publish')) return jsonResponse({ id: 'm1' });
      if (url.includes('/media?')) {
        container += 1;
        return jsonResponse({ id: `c${container}` });
      }
      if (url.includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      if (url.includes('/v1/posts')) return jsonResponse({ post: { status: 'published' } }, 201);
      throw new Error(`unexpected ${url}`);
    });
    const ok = notifier();
    const happy = createPublisher({
      config: liveConfig(),
      stager: httpsStager(),
      fetchImpl: succeeding,
      notifier: ok,
    });
    await happy.publish(
      makeJob({
        id: 'job-ok',
        targets: ['ig_feed', 'snap_story', 'tiktok'],
        messageIds: [7, 8],
      }),
    );
    expect(ok.messages).toEqual([]);
    expect(ok.reactions).toEqual([
      { chatId: -100555, messageId: 7 },
      { chatId: -100555, messageId: 8 },
    ]);
  });

  it('writes dry-run payloads and a preview without calling fetch', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-publish-'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('dry-run must not call fetch');
    });
    const stager: Stager = {
      async stage(buf, name) {
        const file = path.join(outDir, `${name}.jpg`);
        fs.writeFileSync(file, buf);
        return pathToFileURL(file).href;
      },
    };
    const publisher = createPublisher({
      config: liveConfig({ dryRun: true, tiktokVia: 'native', tiktokPrivacy: 'SELF_ONLY' }),
      stager,
      outDir,
      fetchImpl,
    });
    await publisher.publish(
      makeJob({
        id: 'job dry',
        caption: 'A & B <tag>',
        targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'],
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const payloads = path.join(outDir, 'payloads');
    const names = fs.readdirSync(payloads).sort();
    expect(names).toEqual([
      'job_dry-instagram-feed.json',
      'job_dry-instagram-story.json',
      'job_dry-snapchat-story.json',
      'job_dry-tiktok-photo.json',
    ]);
    const raw = names.map((name) => fs.readFileSync(path.join(payloads, name), 'utf8')).join('\n');
    expect(raw).toContain('<IG_ACCESS_TOKEN>');
    expect(raw).toContain('<IG_USER_ID>');
    expect(raw).toContain('<ZERNIO_API_KEY>');
    expect(raw).toContain('<TIKTOK_ACCESS_TOKEN>');
    expect(raw).not.toContain('ig-secret-token');
    expect(raw).not.toContain('zernio-secret');
    expect(raw).toContain('A & B <tag>');
    expect(raw).toContain('media_type": "STORIES"');
    expect(raw).toContain('PULL_FROM_URL');
    expect(raw).toContain('SELF_ONLY');
    expect(raw).toContain('contentType": "story"');
    const preview = fs.readFileSync(path.join(outDir, 'preview.html'), 'utf8');
    expect(preview).toContain('A &amp; B &lt;tag&gt;');
    expect(preview).not.toContain('<tag>');
    expect(preview).toContain('job dry-0.jpg');
    expect(preview).toContain('Local stand-in for an R2 URL');
    expect(preview).toContain('aspect-ratio: 4 / 5');
    expect(preview).toContain('aspect-ratio: 9 / 16');
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('uses SELF_ONLY from loadConfig when TIKTOK_PRIVACY is unset', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      {
        ...TELEGRAM,
        DRY_RUN: 'true',
        TIKTOK_VIA: 'native',
        TIKTOK_CLIENT_KEY: 'ck',
        TIKTOK_CLIENT_SECRET: 'cs-secret',
        TIKTOK_ACCESS_TOKEN: 'tt-secret',
      },
      { mode: 'normal' },
    );
    expect(config.tiktokPrivacy).toBe('SELF_ONLY');
    expect(config.tiktok?.via).toBe('native');
  });

  it('refuses a file URL when DRY_RUN is false and does not call fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('live file URL must not be fetched');
    });
    const probe = notifier();
    const publisher = createPublisher({
      config: liveConfig(),
      stager: {
        async stage(_buf, name) {
          return `file:///tmp/${name}.jpg`;
        },
      },
      fetchImpl,
      notifier: probe,
    });
    await expect(publisher.publish(makeJob({ targets: ['ig_feed', 'tiktok'] }))).rejects.toThrow(
      LIVE_MEDIA_ERROR,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probe.messages.join('\n')).toContain(LIVE_MEDIA_ERROR);
    expect(probe.reactions).toEqual([]);
  });

  it('asks Grammy to react with a check mark and to message the admin', async () => {
    const api = {
      setMessageReaction: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    };
    const adapter = createGrammyNotifier(api, 42);
    await adapter.react(-100, 9);
    await adapter.notifyAdmin('Instagram failed');
    expect(api.setMessageReaction).toHaveBeenCalledWith(-100, 9, [{ type: 'emoji', emoji: '✅' }]);
    expect(api.sendMessage).toHaveBeenCalledWith(42, 'Instagram failed');

    const fallback = {
      setMessageReaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('Bad Request: REACTION_INVALID'))
        .mockResolvedValueOnce(true),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createGrammyNotifier(fallback, 42).react(-100, 9);
    expect(fallback.setMessageReaction).toHaveBeenNthCalledWith(1, -100, 9, [
      { type: 'emoji', emoji: '✅' },
    ]);
    expect(fallback.setMessageReaction).toHaveBeenNthCalledWith(2, -100, 9, [
      { type: 'emoji', emoji: '👍' },
    ]);
    expect(warn).toHaveBeenCalled();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
