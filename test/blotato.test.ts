import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { Stager } from '../src/media/index.js';
import { createPublisher } from '../src/publish/index.js';
import type { Job, Target } from '../src/types.js';

const TELEGRAM = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  CHANNEL_ID: '-100123',
  ADMIN_CHAT_ID: '42',
};

function job(targets: Target[], photos = 1, caption = 'Towpath'): Job {
  return {
    id: 'job-1',
    chatId: -100,
    messageIds: [11],
    caption,
    targets,
    receivedAt: new Date('2026-11-03T09:00:00.000Z'),
    photos: Array.from({ length: photos }, (_, index) => ({
      fileId: `p${index}.jpg`,
      fileUniqueId: `u${index}`,
      width: 1080,
      height: 1350,
      buffer: Buffer.from(`img-${index}`),
    })),
  };
}

const stager: Stager = {
  async stage(_buf, name) {
    return `https://media.example/${name}.jpg`;
  },
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function blotatoConfig(extra: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig(
    {
      ...TELEGRAM,
      DRY_RUN: 'false',
      INSTAGRAM_VIA: 'blotato',
      TIKTOK_VIA: 'blotato',
      BLOTATO_API_KEY: 'blotato-secret',
      BLOTATO_INSTAGRAM_ACCOUNT_ID: 'ig-acc',
      BLOTATO_TIKTOK_ACCOUNT_ID: 'tt-acc',
      ...extra,
    },
    { mode: 'normal' },
  );
}

describe('Blotato publishing', () => {
  it('submits a post and polls until published', async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/v2/posts')) return json({ postSubmissionId: 'sub-1' });
      if (url.endsWith('/v2/posts/sub-1')) {
        polls += 1;
        return json({ status: polls === 1 ? 'in-progress' : 'published' });
      }
      throw new Error(`unexpected ${url}`);
    });
    const publisher = createPublisher({
      config: blotatoConfig(),
      stager,
      fetchImpl,
      pollInitialDelayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await publisher.publish(job(['ig_feed']));
    expect(polls).toBe(2);
    expect(sleeps).toEqual([250]);
    const submit = fetchImpl.mock.calls.find((call) => requestUrl(call[0]).endsWith('/v2/posts'));
    expect(submit?.[1]?.headers).toMatchObject({ 'blotato-api-key': 'blotato-secret' });
    expect(requestUrl(submit?.[0] ?? '')).toBe('https://backend.blotato.com/v2/posts');
  });

  it('stops polling when the submission fails and does not submit again', async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/v2/posts')) {
        posts += 1;
        return json({ postSubmissionId: 'sub-fail' });
      }
      return json({ status: 'failed', errorMessage: 'Rejected by the platform' });
    });
    const messages: string[] = [];
    const publisher = createPublisher({
      config: blotatoConfig(),
      stager,
      fetchImpl,
      notifier: {
        async react() {
          throw new Error('must not react');
        },
        async notifyAdmin(text: string) {
          messages.push(text);
        },
      },
    });
    await publisher.publish(job(['tiktok']));
    expect(posts).toBe(1);
    expect(
      fetchImpl.mock.calls.filter((call) => requestUrl(call[0]).includes('/v2/posts/')),
    ).toHaveLength(1);
    expect(messages.join('\n')).toContain('Blotato post sub-fail failed: Rejected by the platform');
  });

  it('sends TikTok disclosure defaults and an empty story caption', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/v2/posts')) {
        bodies.push(requestBody(init));
        return json({ postSubmissionId: `sub-${bodies.length}` });
      }
      return json({ status: 'published' });
    });
    const publisher = createPublisher({
      config: blotatoConfig(),
      stager,
      fetchImpl,
    });
    await publisher.publish(job(['ig_story', 'tiktok'], 2));
    const stories = bodies.filter((body) => nestedPlatform(body) === 'instagram');
    const tiktok = bodies.filter((body) => nestedPlatform(body) === 'tiktok');
    expect(stories).toHaveLength(2);
    for (const body of stories) {
      expect(contentOf(body).text).toBe('');
      expect(targetOf(body).mediaType).toBe('story');
      expect(contentOf(body).mediaUrls).toHaveLength(1);
    }
    expect(tiktok).toHaveLength(1);
    expect(targetOf(tiktok[0] ?? {})).toMatchObject({
      targetType: 'tiktok',
      privacyLevel: 'SELF_ONLY',
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: false,
      isAiGenerated: false,
    });
    expect(contentOf(tiktok[0] ?? {}).mediaUrls).toEqual([
      'https://media.example/job-1-0.jpg',
      'https://media.example/job-1-1.jpg',
    ]);
  });

  it('keeps Graph and Zernio unless the route is blotato', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes('content_publishing_limit')) {
        return json({
          data: [{ quota_usage: 0, config: { quota_total: 50, quota_duration: 86400 } }],
        });
      }
      if (url.includes('/media_publish') || url.includes('/media?')) return json({ id: 'c1' });
      if (url.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
      if (url.includes('/v1/posts')) return json({ post: { status: 'published' } }, 201);
      throw new Error(`unexpected ${url}`);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = loadConfig(
      {
        ...TELEGRAM,
        DRY_RUN: 'false',
        IG_USER_ID: '1789',
        IG_ACCESS_TOKEN: 'ig-token',
        ZERNIO_API_KEY: 'zernio-key',
        ZERNIO_TIKTOK_ACCOUNT_ID: 'tt-1',
        BLOTATO_API_KEY: 'should-not-be-used',
      },
      { mode: 'normal' },
    );
    await createPublisher({ config: graph, stager, fetchImpl }).publish(job(['ig_feed', 'tiktok']));
    expect(urls.some((url) => url.includes('graph.facebook.com'))).toBe(true);
    expect(urls.some((url) => url.includes('zernio.com'))).toBe(true);
    expect(urls.some((url) => url.includes('blotato.com'))).toBe(false);
  });

  it('writes Blotato dry-run payloads and preview notes without calling fetch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blotato-dry-'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('dry-run must not call fetch');
    });
    const config = loadConfig(
      {
        ...TELEGRAM,
        DRY_RUN: 'true',
        INSTAGRAM_VIA: 'blotato',
        TIKTOK_VIA: 'blotato',
        BLOTATO_API_KEY: 'blotato-secret',
        BLOTATO_INSTAGRAM_ACCOUNT_ID: 'ig-real',
        BLOTATO_TIKTOK_ACCOUNT_ID: 'tt-real',
      },
      { mode: 'normal' },
    );
    await createPublisher({
      config,
      stager,
      outDir,
      fetchImpl,
    }).publish(job(['ig_feed', 'ig_story', 'tiktok']));
    expect(fetchImpl).not.toHaveBeenCalled();
    const names = fs.readdirSync(path.join(outDir, 'payloads')).sort();
    expect(names).toEqual([
      'job-1-instagram-feed.json',
      'job-1-instagram-story.json',
      'job-1-tiktok-photo.json',
    ]);
    const raw = names
      .map((name) => fs.readFileSync(path.join(outDir, 'payloads', name), 'utf8'))
      .join('\n');
    expect(raw).toContain('"blotato-api-key": "<BLOTATO_API_KEY>"');
    expect(raw).toContain('https://backend.blotato.com/v2/posts');
    expect(raw).toContain('/v2/posts/<POST_SUBMISSION_ID>');
    expect(raw).toContain('"text": ""');
    expect(raw).toContain('"privacyLevel": "SELF_ONLY"');
    expect(raw).not.toContain('blotato-secret');
    expect(raw).not.toContain('ig-real');
    const preview = fs.readFileSync(path.join(outDir, 'preview.html'), 'utf8');
    expect(preview).toContain('Blotato request');
    expect(preview).toContain('&lt;BLOTATO_API_KEY&gt;');
    expect(preview).toContain('backend.blotato.com');
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

function nestedPlatform(body: Record<string, unknown>): string {
  const post = isRecord(body.post) ? body.post : {};
  const content = isRecord(post.content) ? post.content : {};
  return typeof content.platform === 'string' ? content.platform : '';
}

function contentOf(body: Record<string, unknown>): Record<string, unknown> {
  const post = isRecord(body.post) ? body.post : {};
  return isRecord(post.content) ? post.content : {};
}

function targetOf(body: Record<string, unknown>): Record<string, unknown> {
  const post = isRecord(body.post) ? body.post : {};
  return isRecord(post.target) ? post.target : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
