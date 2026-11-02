import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeenStore, SEEN_PRUNE_INTERVAL_MS, SEEN_WINDOW_MS } from '../src/ingest/seen.js';

describe('seen store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips a message inside 24 hours and accepts it again on expiry', () => {
    let now = 1_000;
    const seen = createSeenStore(':memory:', { now: () => now });
    try {
      expect(seen.claim(5, 9)).toBe(true);
      expect(seen.claim(5, 9)).toBe(false);
      now += SEEN_WINDOW_MS - 1;
      expect(seen.claim(5, 9)).toBe(false);
      now += 1;
      expect(seen.claim(5, 9)).toBe(true);
    } finally {
      seen.close();
    }
  });

  it('prunes expired rows on startup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-crosspost-'));
    const file = path.join(dir, 'seen.db');
    let now = 0;
    const first = createSeenStore(file, { now: () => now });
    first.claim(1, 1);
    first.claim(1, 2);
    first.close();

    now = SEEN_WINDOW_MS + 1;
    const second = createSeenStore(file, { now: () => now });
    try {
      expect(second.count()).toBe(0);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes expired rows on the hourly timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const seen = createSeenStore(':memory:', { now: () => now });
    try {
      seen.claim(7, 1);
      expect(seen.count()).toBe(1);
      now = SEEN_WINDOW_MS + 1;
      seen.startHourlyPrune(SEEN_PRUNE_INTERVAL_MS);
      expect(seen.count()).toBe(1);
      await vi.advanceTimersByTimeAsync(SEEN_PRUNE_INTERVAL_MS);
      expect(seen.count()).toBe(0);
    } finally {
      seen.close();
    }
  });
});
