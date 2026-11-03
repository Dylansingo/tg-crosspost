import type { StagedMedia } from './media/contract.js';

/**
 * Downstream post targets.
 * `tiktok` is reserved for a 9:16 photo post, via Zernio or the native route.
 */
export type Target = 'ig_feed' | 'ig_story' | 'snap_story' | 'tiktok';

export interface Photo {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  buffer?: Buffer;
  /** URLs from `Stager.stage`. Publishers use these rather than the raw buffer. */
  staged?: StagedMedia;
}

export interface Job {
  id: string;
  chatId: number;
  messageIds: number[];
  mediaGroupId?: string;
  photos: Photo[];
  /** Caption with the routing hashtags removed. Other hashtags stay. */
  caption: string;
  targets: Target[];
  receivedAt: Date;
}

/** Receives one fully assembled job. The default handler logs it and records ./out/jobs.json. */
export type JobHandler = (job: Job) => void | Promise<void>;

export { createDefaultJobHandler, defaultJobHandler } from './dry-run.js';
