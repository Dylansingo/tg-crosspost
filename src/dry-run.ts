import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOCAL_STAGE_DIRECTORY } from './media/index.js';
import type { Job, JobHandler, Target } from './types.js';

export const DEFAULT_JOBS_FILE = path.join(LOCAL_STAGE_DIRECTORY, 'jobs.json');

interface StoredPhoto {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  byteLength: number;
}

interface StoredJob {
  id: string;
  chatId: number;
  messageIds: number[];
  mediaGroupId?: string;
  caption: string;
  targets: Target[];
  receivedAt: string;
  photos: StoredPhoto[];
}

/**
 * DRY_RUN handler. Logs the job (without pixel bytes) and appends a JSON
 * record to ./out/jobs.json. Buffers stay on the in-memory job for ME-1/PE-1.
 *
 * PE-1 replaces this with dry-run payloads and a preview.
 */
export function createDefaultJobHandler(options?: { outFile?: string }): JobHandler {
  const outFile = options?.outFile ?? DEFAULT_JOBS_FILE;
  return (job) => {
    logDryRun(job);
    appendJob(outFile, serialiseJob(job));
  };
}

export const defaultJobHandler: JobHandler = createDefaultJobHandler();

function logDryRun(job: Job): void {
  console.log(
    `[DRY_RUN] job ${job.id} chat=${job.chatId} messages=${job.messageIds.join(',')} targets=${job.targets.join(',')} photos=${job.photos.length} caption=${JSON.stringify(job.caption)}`,
  );
}

function serialiseJob(job: Job): StoredJob {
  const stored: StoredJob = {
    id: job.id,
    chatId: job.chatId,
    messageIds: job.messageIds,
    caption: job.caption,
    targets: job.targets,
    receivedAt: job.receivedAt.toISOString(),
    photos: job.photos.map((photo) => ({
      fileId: photo.fileId,
      fileUniqueId: photo.fileUniqueId,
      width: photo.width,
      height: photo.height,
      byteLength: photo.buffer?.byteLength ?? 0,
    })),
  };
  if (job.mediaGroupId !== undefined) {
    stored.mediaGroupId = job.mediaGroupId;
  }
  return stored;
}

function appendJob(outFile: string, job: StoredJob): void {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const existing = existsSync(outFile)
    ? (JSON.parse(readFileSync(outFile, 'utf8')) as StoredJob[])
    : [];
  existing.push(job);
  writeFileSync(outFile, `${JSON.stringify(existing, null, 2)}\n`);
}
