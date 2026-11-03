import { randomUUID } from 'node:crypto';
import { logError } from '../log.js';
import type { Stager } from '../media/index.js';
import type { Job, JobHandler, Photo } from '../types.js';
import { ALBUM_DEBOUNCE_MS, AlbumBuffer, type AlbumItem } from './albums.js';
import { downloadTelegramFile, type FileFetcher, type TelegramFileApi } from './download.js';
import { selectImage } from './photos.js';
import { routeCaption } from './routing.js';
import type { SeenStore } from './seen.js';
import { systemTimers, type TimerControls } from './timers.js';
import { readChannelPost } from './update.js';

export interface IngestDeps {
  channelId: number;
  seen: SeenStore;
  handler: JobHandler;
  token: string;
  files: TelegramFileApi;
  fetcher: FileFetcher;
  /** ME-1. Called with each photo buffer before the job handler when present. */
  stager?: Stager;
  timers?: TimerControls;
  now?: () => number;
}

export interface Ingestor {
  /** Webhook path: return control to the caller, then process on a later turn. */
  enqueue(update: unknown): void;
  /** Demo and tests: run routing, dedup, download, and album grouping to completion. */
  handleUpdate(update: unknown): Promise<void>;
  drain(): Promise<void>;
  close(): void;
}

export function createIngestor(deps: IngestDeps): Ingestor {
  const now = deps.now ?? (() => Date.now());
  const timers = deps.timers ?? systemTimers();
  const inflight = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {
    inflight.add(promise);
    void promise.finally(() => {
      inflight.delete(promise);
    });
  }

  async function emit(job: Job): Promise<void> {
    // Stage each buffer. Publishers use photo.staged and do not re-render.
    if (deps.stager) {
      for (const [index, photo] of job.photos.entries()) {
        if (!photo.buffer) continue;
        photo.staged = await deps.stager.stage(photo.buffer, `${job.id}-${index}`);
      }
    }

    // PE-1 hook: dry-run payloads and a preview. The default handler logs the
    // job and writes ./out/jobs.json until a Publisher is wired.
    await deps.handler(job);
  }

  function buildJob(chatId: number, items: AlbumItem[], mediaGroupId: string | undefined): Job {
    const ordered = [...items].sort((left, right) => left.messageId - right.messageId);
    const captionSource = ordered.find(
      (item) => item.caption && item.caption.trim().length > 0,
    )?.caption;
    const routed = routeCaption(captionSource);
    if (routed.conflict) {
      const ids = ordered.map((item) => item.messageId).join(', ');
      console.warn(
        `Both #storyonly and #feedonly are set on message ${ids} in chat ${chatId}; the post will use every target.`,
      );
    }
    const job: Job = {
      id: randomUUID(),
      chatId,
      messageIds: ordered.map((item) => item.messageId),
      photos: ordered.map((item) => item.photo),
      caption: routed.caption,
      targets: routed.targets,
      receivedAt: new Date(now()),
    };
    if (mediaGroupId !== undefined) job.mediaGroupId = mediaGroupId;
    return job;
  }

  const albums = new AlbumBuffer(
    ALBUM_DEBOUNCE_MS,
    (group) => {
      const pending = emit(buildJob(group.chatId, group.items, group.mediaGroupId)).catch(logError);
      track(pending);
    },
    timers,
  );

  async function process(update: unknown): Promise<void> {
    const post = readChannelPost(update);
    if (!post || post.chat.id !== deps.channelId) return;
    const selected = selectImage(post);
    if (!selected) return;
    // Claim before the first await so a second delivery cannot pass the check
    // while this one is still downloading.
    if (!deps.seen.claim(post.chat.id, post.message_id)) return;

    const buffer = await downloadTelegramFile(selected.fileId, {
      api: deps.files,
      token: deps.token,
      fetcher: deps.fetcher,
    });
    const photo: Photo = { ...selected, buffer };
    const item: AlbumItem = { messageId: post.message_id, photo };
    if (post.caption !== undefined) item.caption = post.caption;

    if (post.media_group_id) {
      albums.add(post.chat.id, post.media_group_id, item);
      return;
    }
    await emit(buildJob(post.chat.id, [item], undefined));
  }

  async function handleUpdate(update: unknown): Promise<void> {
    try {
      await process(update);
    } catch (error) {
      logError(error);
    }
  }

  function enqueue(update: unknown): void {
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        handleUpdate(update).then(resolve, (error: unknown) => {
          logError(error);
          resolve();
        });
      });
    });
    track(task);
  }

  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
    }
  }

  function close(): void {
    albums.close();
  }

  return { enqueue, handleUpdate, drain, close };
}
