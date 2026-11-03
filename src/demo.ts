import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig, logStartup } from './config.js';
import { createDefaultJobHandler } from './dry-run.js';
import { ALBUM_DEBOUNCE_MS } from './ingest/albums.js';
import { filePathFromTelegramUrl } from './ingest/download.js';
import { createIngestor } from './ingest/pipeline.js';
import { createSeenStore } from './ingest/seen.js';
import type { TimerControls } from './ingest/timers.js';
import { logError } from './log.js';
import { isDirectRun } from './runtime.js';
import type { Job, JobHandler } from './types.js';

/** Placeholder token. It is only placed in an in-memory file URL and is never sent. */
const DEMO_TOKEN = 'demo-offline';

export const DEFAULT_SAMPLES_DIR = './samples';

const ManifestSchema = z.object({
  channelId: z.number().int(),
  posts: z
    .array(
      z.object({
        messageId: z.number().int(),
        file: z.string().min(1),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        caption: z.string().optional(),
        mediaGroupId: z.string().min(1).optional(),
      }),
    )
    .min(1),
});

type Manifest = z.infer<typeof ManifestSchema>;
type ManifestPost = Manifest['posts'][number];

export interface DemoOptions {
  samplesDir?: string;
  outFile?: string;
  env?: NodeJS.ProcessEnv;
  timers?: TimerControls;
  now?: () => number;
  /**
   * Test hook. Advances the album clock instead of waiting on a real timer.
   * The CLI leaves this unset and waits {@link ALBUM_DEBOUNCE_MS} milliseconds.
   */
  advanceTime?: (ms: number) => Promise<void> | void;
}

/**
 * Run the ingestion pipeline over local samples. No Telegram token is read
 * and fetch is blocked for the duration of the run. DRY_RUN is forced on.
 */
export async function runDemo(options: DemoOptions = {}): Promise<Job[]> {
  const samplesDir = path.resolve(options.samplesDir ?? DEFAULT_SAMPLES_DIR);
  const outFile = path.resolve(options.outFile ?? './out/jobs.json');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Demo mode does not use the network.');
  }) as typeof fetch;

  try {
    const config = loadConfig(options.env ?? process.env, { mode: 'demo' });
    logStartup(config);
    console.log(`Demo: reading samples from ${samplesDir}`);

    const manifest = readManifest(samplesDir);
    const files = new Map<string, Buffer>();
    const updates = manifest.posts.map((post) => {
      const buffer = readSample(samplesDir, post.file);
      files.set(post.file, buffer);
      return toUpdate(manifest.channelId, post, buffer);
    });

    const jobs: Job[] = [];
    mkdirSync(path.dirname(outFile), { recursive: true });
    rmSync(outFile, { force: true });
    const record = createDefaultJobHandler({ outFile });
    const handler: JobHandler = (job) => {
      jobs.push(job);
      return record(job);
    };

    const seen = createSeenStore(':memory:', { now: options.now });
    const ingestor = createIngestor({
      channelId: manifest.channelId,
      seen,
      handler,
      token: DEMO_TOKEN,
      files: {
        async getFile(fileId: string) {
          if (!files.has(fileId)) throw new Error(`Demo sample is missing for ${fileId}.`);
          return { file_path: fileId };
        },
      },
      fetcher: async (url: string) => {
        const filePath = filePathFromTelegramUrl(url);
        const buffer = files.get(filePath);
        if (!buffer) throw new Error(`Demo sample is missing for ${filePath}.`);
        return buffer;
      },
      ...(options.timers ? { timers: options.timers } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    try {
      for (const update of updates) {
        await ingestor.handleUpdate(update);
      }
      if (options.advanceTime) {
        await options.advanceTime(ALBUM_DEBOUNCE_MS);
      } else {
        await new Promise<void>((resolve) => {
          const timers = options.timers ?? {
            setTimeout: (callback: () => void, delayMs: number) =>
              globalThis.setTimeout(callback, delayMs),
            clearTimeout: (handle: unknown) => {
              globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
            },
          };
          timers.setTimeout(() => resolve(), ALBUM_DEBOUNCE_MS);
        });
      }
      await ingestor.drain();
    } finally {
      ingestor.close();
      seen.close();
    }

    console.log(`Demo wrote ${jobs.length} job(s) to ${outFile}`);
    return jobs;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const samplesDir = argv[2] ?? DEFAULT_SAMPLES_DIR;
  try {
    await runDemo({ samplesDir });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function readManifest(samplesDir: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(samplesDir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`Sample manifest not found in ${samplesDir}.`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'manifest')),
    ];
    throw new Error(`Invalid samples manifest: ${fields.join(', ')}.`);
  }
  return parsed.data;
}

function readSample(root: string, file: string): Buffer {
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Sample path escapes the samples directory: ${file}`);
  }
  try {
    return readFileSync(resolved);
  } catch {
    throw new Error(`Sample file not found: ${file}`);
  }
}

function toUpdate(channelId: number, post: ManifestPost, buffer: Buffer): unknown {
  const channelPost: Record<string, unknown> = {
    message_id: post.messageId,
    chat: { id: channelId, type: 'channel' },
    photo: [
      {
        file_id: post.file,
        file_unique_id: `local-${post.messageId}`,
        width: post.width,
        height: post.height,
        file_size: buffer.length,
      },
    ],
  };
  if (post.caption !== undefined) channelPost.caption = post.caption;
  if (post.mediaGroupId !== undefined) channelPost.media_group_id = post.mediaGroupId;
  return { update_id: post.messageId, channel_post: channelPost };
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    logError(error);
    process.exitCode = 1;
  });
}
