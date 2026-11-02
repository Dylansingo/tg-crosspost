import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, usesR2Stager } from '../src/config.js';
import { createStager, LocalStager } from '../src/media/index.js';
import { createR2Client, R2Stager } from '../src/media/r2.js';
import { FEED_HEIGHT, FEED_WIDTH, STORY_HEIGHT, STORY_WIDTH } from '../src/media/render.js';

const s3Mock = mockClient(S3Client);

const telegram = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  CHANNEL_ID: '-100123',
  ADMIN_CHAT_ID: '42',
};

const r2Env = {
  R2_ACCOUNT_ID: 'account-1',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET: 'media-bucket',
  R2_PUBLIC_BASE_URL: 'https://media.example.com/',
};

afterEach(() => {
  s3Mock.reset();
});

afterAll(() => {
  s3Mock.restore();
});

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 20, channels: 3, background: { r: 40, g: 140, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe('LocalStager', () => {
  it('writes feed and story JPEGs and returns file URLs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stage-'));
    try {
      const stager = new LocalStager(directory);
      const staged = await stager.stage(await tinyPng(), 'job-1');
      const feedPath = path.join(directory, 'job-1-feed.jpg');
      const storyPath = path.join(directory, 'job-1-story.jpg');
      expect(fs.existsSync(feedPath)).toBe(true);
      expect(fs.existsSync(storyPath)).toBe(true);
      expect(staged.feed).toBe(pathToFileURL(feedPath).href);
      expect(staged.story).toBe(pathToFileURL(storyPath).href);
      expect(staged.tiktok).toBe(staged.story);
      const feed = await sharp(feedPath).metadata();
      const story = await sharp(storyPath).metadata();
      expect(feed).toMatchObject({ format: 'jpeg', width: FEED_WIDTH, height: FEED_HEIGHT });
      expect(story).toMatchObject({ format: 'jpeg', width: STORY_WIDTH, height: STORY_HEIGHT });
      expect(fs.readdirSync(directory)).toEqual(['job-1-feed.jpg', 'job-1-story.jpg']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a hostile name inside the media directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stage-'));
    const outside = path.join(directory, 'escape-feed.jpg');
    try {
      const staged = await new LocalStager(directory).stage(await tinyPng(), '../escape');
      expect(staged.feed.startsWith(pathToFileURL(directory).href)).toBe(true);
      expect(fs.existsSync(outside)).toBe(false);
      expect(fs.readdirSync(directory).some((name) => name.endsWith('-feed.jpg'))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('R2Stager', () => {
  it('points the client at the account R2 endpoint', async () => {
    const client = createR2Client({
      accountId: 'account-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      bucket: 'media-bucket',
      publicBaseUrl: 'https://media.example.com',
    });
    const resolveEndpoint = client.config.endpoint;
    if (!resolveEndpoint) throw new Error('S3 client has no endpoint.');
    const endpoint = await resolveEndpoint();
    expect(endpoint.protocol).toBe('https:');
    expect(endpoint.hostname).toBe('account-1.r2.cloudflarestorage.com');
  });

  it('puts feed and story JPEGs and returns the public URLs', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const stager = new R2Stager({
      accountId: 'account-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      bucket: 'media-bucket',
      publicBaseUrl: 'https://media.example.com/',
    });
    const staged = await stager.stage(await tinyPng(), 'job-7');
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(2);

    const inputs = calls.map((call) => call.args[0].input);
    expect(inputs.map((input) => input.Key).sort()).toEqual([
      'media/job-7-feed.jpg',
      'media/job-7-story.jpg',
    ]);
    for (const input of inputs) {
      expect(input.Bucket).toBe('media-bucket');
      expect(input.ContentType).toBe('image/jpeg');
      const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body as Uint8Array);
      expect(body[0]).toBe(0xff);
      expect(body[1]).toBe(0xd8);
    }

    expect(staged.feed).toBe('https://media.example.com/media/job-7-feed.jpg');
    expect(staged.story).toBe('https://media.example.com/media/job-7-story.jpg');
    expect(staged.tiktok).toBe(staged.story);
    expect(s3Mock.calls().length).toBe(2);
  }, 20_000);
});

describe('stager selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses R2 only when every key is set outside demo mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enabled = loadConfig({ ...telegram, ...r2Env }, { mode: 'normal' });
    expect(usesR2Stager(enabled)).toBe(true);
    expect(await createStager(enabled)).toBeInstanceOf(R2Stager);

    const demo = loadConfig({ ...telegram, ...r2Env }, { mode: 'demo' });
    expect(usesR2Stager(demo)).toBe(false);
    expect(await createStager(demo)).toBeInstanceOf(LocalStager);

    for (const key of Object.keys(r2Env)) {
      const partial = { ...telegram, ...r2Env };
      delete partial[key as keyof typeof r2Env];
      const config = loadConfig(partial, { mode: 'normal' });
      expect(usesR2Stager(config)).toBe(false);
      expect(await createStager(config)).toBeInstanceOf(LocalStager);
    }
  });

  it('treats a blank R2 key as missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({ ...telegram, ...r2Env, R2_BUCKET: '   ' }, { mode: 'normal' });
    expect(config.r2).toBeUndefined();
    expect(await createStager(config)).toBeInstanceOf(LocalStager);
  });
});
