import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Skip a message that was accepted inside this window. */
export const SEEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How often a long-running process deletes expired rows. */
export const SEEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface SeenStoreOptions {
  now?: () => number;
}

/**
 * Idempotency table. A row is written when a photo is accepted, before the
 * download, so a duplicate delivery during that work does not open a second job.
 * Rows older than 24 hours are pruned on startup and, when started, every hour.
 */
export class SeenStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(sqlitePath: string, options: SeenStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    if (sqlitePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }
    this.db = new Database(sqlitePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    this.prune();
  }

  /** @returns true when this delivery should be processed. */
  claim(chatId: number, messageId: number): boolean {
    const now = this.now();
    const row = this.db
      .prepare('SELECT seen_at FROM seen WHERE chat_id = ? AND message_id = ?')
      .get(chatId, messageId) as { seen_at: number } | undefined;
    if (row && now - row.seen_at < SEEN_WINDOW_MS) return false;
    this.db
      .prepare(
        `INSERT INTO seen (chat_id, message_id, seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET seen_at = excluded.seen_at`,
      )
      .run(chatId, messageId, now);
    return true;
  }

  prune(): void {
    const cutoff = this.now() - SEEN_WINDOW_MS;
    this.db.prepare('DELETE FROM seen WHERE seen_at < ?').run(cutoff);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM seen').get() as { n: number };
    return row.n;
  }

  startHourlyPrune(intervalMs = SEEN_PRUNE_INTERVAL_MS): void {
    this.stopPruneLoop();
    const timer = setInterval(() => {
      this.prune();
    }, intervalMs);
    if (
      typeof timer === 'object' &&
      timer &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref();
    }
    this.pruneTimer = timer;
  }

  close(): void {
    this.stopPruneLoop();
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private stopPruneLoop(): void {
    if (this.pruneTimer === undefined) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }
}

export function createSeenStore(sqlitePath: string, options?: SeenStoreOptions): SeenStore {
  return new SeenStore(sqlitePath, options);
}
