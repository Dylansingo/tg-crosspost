import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SAMPLES_DIR, runDemo } from '../src/demo.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = path.join(repoRoot, 'samples');

const PLATFORM_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'CHANNEL_ID',
  'ADMIN_CHAT_ID',
  'DRY_RUN',
  'SQLITE_PATH',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'IG_USER_ID',
  'IG_ACCESS_TOKEN',
  'ZERNIO_API_KEY',
  'ZERNIO_BASE_URL',
  'ZERNIO_SNAPCHAT_ACCOUNT_ID',
  'ZERNIO_TIKTOK_ACCOUNT_ID',
  'TIKTOK_VIA',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'TIKTOK_ACCESS_TOKEN',
  'TIKTOK_PRIVACY',
];

describe('demo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds one job per post and a single album job, with photo buffers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outFile = path.join(os.tmpdir(), `tg-crosspost-jobs-${process.pid}.json`);
    const jobs = await runDemo({
      samplesDir,
      outFile,
      env: { DRY_RUN: 'false' },
      advanceTime: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
    });

    expect(DEFAULT_SAMPLES_DIR).toBe('./samples');
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.messageIds)).toEqual([[101], [301], [201, 202, 203]]);

    const single = jobs[0];
    const story = jobs[1];
    const album = jobs[2];
    if (!single || !story || !album) throw new Error('Expected three jobs');

    expect(single.caption).toBe('Morning on the towpath');
    expect(single.targets).toEqual(['ig_feed', 'ig_story', 'snap_story', 'tiktok']);
    expect(single.photos).toHaveLength(1);
    expect(
      single.photos[0]?.buffer?.equals(fs.readFileSync(path.join(samplesDir, 'single.jpg'))),
    ).toBe(true);

    expect(story.caption).toBe('Green room');
    expect(story.targets).toEqual(['ig_story', 'snap_story', 'tiktok']);
    expect(
      story.photos[0]?.buffer
        ?.subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);

    expect(album.mediaGroupId).toBe('market-day');
    expect(album.caption).toBe('Saturday market');
    expect(album.targets).toEqual(['ig_feed']);
    expect(album.photos.map((photo) => photo.fileId)).toEqual([
      'album-1.png',
      'album-2.png',
      'album-3.png',
    ]);
    expect(
      album.photos.map((photo) =>
        photo.buffer?.equals(fs.readFileSync(path.join(samplesDir, photo.fileId))),
      ),
    ).toEqual([true, true, true]);

    const stored = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      photos: { byteLength: number }[];
      caption: string;
    }[];
    expect(stored).toHaveLength(3);
    expect(stored[2]?.photos).toHaveLength(3);
    expect(stored[2]?.photos[0]?.byteLength).toBe(album.photos[0]?.buffer?.length);
    expect(JSON.stringify(stored)).not.toContain('"type":"Buffer"');
    expect(log.mock.calls.flat().join('\n')).toContain('demo mode forces DRY_RUN');
    fs.rmSync(outFile, { force: true });
  });

  it('runs from the CLI with no .env and no platform keys', async () => {
    const env = { ...process.env };
    for (const key of PLATFORM_KEYS) delete env[key];
    const { stdout } = await execFileAsync('npm', ['run', 'demo', '--', './samples'], {
      cwd: repoRoot,
      env,
      timeout: 20_000,
    });
    const jobsPath = path.join(repoRoot, 'out', 'jobs.json');
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) as { photos: unknown[] }[];
    expect(jobs).toHaveLength(3);
    expect(jobs.filter((job) => job.photos.length === 3)).toHaveLength(1);
    expect(stdout).toContain('DRY_RUN: true');
    expect(stdout).toContain('disabled');
    fs.rmSync(path.join(repoRoot, 'out'), { recursive: true, force: true });
  }, 20_000);
});
