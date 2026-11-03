import type { Express } from 'express';
import request from 'supertest';
import { createApp, type AppHandle } from '../src/server.js';
import { createSeenStore, type SeenStore } from '../src/ingest/seen.js';
import type { Stager } from '../src/media/index.js';
import type { Job, JobHandler } from '../src/types.js';

export const CHANNEL_ID = -100555;
export const SECRET = 'test-secret';
export const TOKEN = '123456:TEST';

export interface TestContext {
  app: Express;
  drain: () => Promise<void>;
  close: () => void;
  jobs: Job[];
  fileIds: string[];
  urls: string[];
  seen: SeenStore;
}

interface PhotoInput {
  fileId: string;
  fileUniqueId?: string;
  width: number;
  height: number;
  fileSize?: number;
}

interface DocumentInput {
  fileId: string;
  fileUniqueId?: string;
  mimeType: string;
  fileSize?: number;
}

export function channelPost(options: {
  messageId: number;
  chatId?: number;
  caption?: string;
  mediaGroupId?: string;
  photo?: PhotoInput[];
  document?: DocumentInput;
}): Record<string, unknown> {
  const post: Record<string, unknown> = {
    message_id: options.messageId,
    chat: { id: options.chatId ?? CHANNEL_ID, type: 'channel' },
  };
  if (options.caption !== undefined) post.caption = options.caption;
  if (options.mediaGroupId !== undefined) post.media_group_id = options.mediaGroupId;
  if (options.photo) {
    post.photo = options.photo.map((photo) => ({
      file_id: photo.fileId,
      file_unique_id: photo.fileUniqueId ?? `u-${photo.fileId}`,
      width: photo.width,
      height: photo.height,
      ...(photo.fileSize === undefined ? {} : { file_size: photo.fileSize }),
    }));
  }
  if (options.document) {
    post.document = {
      file_id: options.document.fileId,
      file_unique_id: options.document.fileUniqueId ?? `u-${options.document.fileId}`,
      mime_type: options.document.mimeType,
      ...(options.document.fileSize === undefined ? {} : { file_size: options.document.fileSize }),
    };
  }
  return { update_id: options.messageId, channel_post: post };
}

export function createTestApp(options?: {
  now?: () => number;
  handler?: JobHandler;
  stager?: Stager;
  channelId?: number;
}): TestContext {
  const jobs: Job[] = [];
  const fileIds: string[] = [];
  const urls: string[] = [];
  const seen = createSeenStore(':memory:', { now: options?.now });
  const handle: AppHandle = createApp({
    channelId: options?.channelId ?? CHANNEL_ID,
    webhookSecret: SECRET,
    token: TOKEN,
    seen,
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.stager ? { stager: options.stager } : {}),
    handler:
      options?.handler ??
      ((job) => {
        jobs.push(job);
      }),
    files: {
      async getFile(fileId: string) {
        fileIds.push(fileId);
        return { file_path: `files/${fileId}` };
      },
    },
    fetcher: async (url: string) => {
      urls.push(url);
      return Buffer.from(`fetched:${url}`);
    },
  });
  return {
    app: handle.app,
    drain: () => handle.drain(),
    close: () => handle.close(),
    jobs,
    fileIds,
    urls,
    seen,
  };
}

export function postUpdate(
  app: Express,
  body: unknown,
  secret: string | false = SECRET,
): request.Test {
  const req = request(app).post('/webhook/telegram');
  if (secret !== false) {
    req.set('X-Telegram-Bot-Api-Secret-Token', secret);
  }
  return req.send(body as object);
}
