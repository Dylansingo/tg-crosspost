import type { Job } from '../types.js';

/**
 * Publishing (PE-1).
 *
 * The Publish Engineer turns a job into dry-run payloads and a local preview,
 * and later posts to Instagram, Snapchat, and TikTok. Until that lands, the
 * default job handler logs the job and writes `./out/jobs.json`.
 */
export interface Publisher {
  publish(job: Job): Promise<void>;
}
