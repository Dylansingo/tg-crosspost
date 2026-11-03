import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALBUM_DEBOUNCE_MS } from '../src/ingest/albums.js';
import { SEEN_WINDOW_MS } from '../src/ingest/seen.js';
import type { Stager } from '../src/media/index.js';
import type { Target } from '../src/types.js';
import { CHANNEL_ID, TOKEN, channelPost, createTestApp, postUpdate } from './helpers.js';

describe('telegram webhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 401 for a missing or wrong secret and does not open a job', async () => {
    const ctx = createTestApp();
    try {
      const update = channelPost({
        messageId: 1,
        photo: [{ fileId: 'a.jpg', width: 10, height: 10 }],
      });
      await postUpdate(ctx.app, update, false).expect(401);
      await postUpdate(ctx.app, update, 'wrong-secret').expect(401);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(0);
      expect(ctx.fileIds).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it('ignores a post from another chat', async () => {
    const ctx = createTestApp();
    try {
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 2,
          chatId: CHANNEL_ID - 1,
          photo: [{ fileId: 'other.jpg', width: 20, height: 20 }],
        }),
      ).expect(200);
      await postUpdate(ctx.app, {
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: CHANNEL_ID, type: 'private' },
          photo: [{ file_id: 'dm.jpg', file_unique_id: 'u', width: 10, height: 10 }],
        },
      }).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(0);
      expect(ctx.fileIds).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it('opens one job when the same update is delivered twice', async () => {
    const ctx = createTestApp();
    try {
      const update = channelPost({
        messageId: 4,
        caption: 'Hello',
        photo: [{ fileId: 'once.jpg', width: 30, height: 40 }],
      });
      await postUpdate(ctx.app, update).expect(200);
      await postUpdate(ctx.app, update).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(1);
      expect(ctx.jobs[0]?.messageIds).toEqual([4]);
      expect(ctx.fileIds).toEqual(['once.jpg']);
      expect(ctx.urls).toEqual([`https://api.telegram.org/file/bot${TOKEN}/files/once.jpg`]);
      expect(ctx.jobs[0]?.photos[0]?.buffer?.toString()).toContain('once.jpg');
    } finally {
      ctx.close();
    }
  });

  it('accepts the same message again once 24 hours have passed', async () => {
    let now = 1_700_000_000_000;
    const ctx = createTestApp({ now: () => now });
    try {
      const update = channelPost({
        messageId: 5,
        photo: [{ fileId: 'again.jpg', width: 8, height: 8 }],
      });
      await postUpdate(ctx.app, update).expect(200);
      await ctx.drain();
      await postUpdate(ctx.app, update).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(1);

      now += SEEN_WINDOW_MS - 1;
      await postUpdate(ctx.app, update).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(1);

      now += 1;
      await postUpdate(ctx.app, update).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(2);
    } finally {
      ctx.close();
    }
  });

  it('routes captions and strips the routing hashtags', async () => {
    const ctx = createTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: {
      caption?: string;
      targets: Target[];
      cleaned: string;
      warn: boolean;
    }[] = [
      {
        caption: 'Hello',
        targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'],
        cleaned: 'Hello',
        warn: false,
      },
      {
        caption: 'Hello #storyonly',
        targets: ['ig_story', 'snap_story', 'tiktok'],
        cleaned: 'Hello',
        warn: false,
      },
      {
        caption: 'Hello #StoryOnly!',
        targets: ['ig_story', 'snap_story', 'tiktok'],
        cleaned: 'Hello!',
        warn: false,
      },
      {
        caption: '#feedonly Hello #london',
        targets: ['ig_feed'],
        cleaned: 'Hello #london',
        warn: false,
      },
      {
        caption: '#feedonly #STORYONLY Picnic',
        targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'],
        cleaned: 'Picnic',
        warn: true,
      },
      {
        caption: '#storyonlyplease',
        targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'],
        cleaned: '#storyonlyplease',
        warn: false,
      },
      {
        targets: ['ig_feed', 'ig_story', 'snap_story', 'tiktok'],
        cleaned: '',
        warn: false,
      },
    ];
    try {
      for (const [index, item] of cases.entries()) {
        warn.mockClear();
        await postUpdate(
          ctx.app,
          channelPost({
            messageId: 100 + index,
            ...(item.caption === undefined ? {} : { caption: item.caption }),
            photo: [{ fileId: `route-${index}.jpg`, width: 12, height: 12 }],
          }),
        ).expect(200);
        await ctx.drain();
        const job = ctx.jobs[index];
        expect(job?.targets).toEqual(item.targets);
        expect(job?.caption).toBe(item.cleaned);
        if (item.warn) {
          expect(warn).toHaveBeenCalledTimes(1);
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      }
    } finally {
      ctx.close();
    }
  });

  it('downloads the largest photo size, with file_size as the tie break', async () => {
    const ctx = createTestApp();
    try {
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 20,
          photo: [
            { fileId: 'small', width: 100, height: 100, fileSize: 99_000 },
            { fileId: 'large', width: 400, height: 300, fileSize: 10 },
            { fileId: 'medium', width: 200, height: 200, fileSize: 50_000 },
          ],
        }),
      ).expect(200);
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 21,
          photo: [
            { fileId: 'low-bytes', width: 10, height: 10, fileSize: 5 },
            { fileId: 'high-bytes', width: 5, height: 20, fileSize: 9 },
          ],
        }),
      ).expect(200);
      await ctx.drain();
      expect(ctx.fileIds).toEqual(['large', 'high-bytes']);
      expect(ctx.jobs[0]?.photos[0]).toMatchObject({
        fileId: 'large',
        fileUniqueId: 'u-large',
        width: 400,
        height: 300,
      });
      expect(ctx.jobs[1]?.photos[0]?.fileId).toBe('high-bytes');
    } finally {
      ctx.close();
    }
  });

  it('accepts a document that is a jpeg or png and ignores other documents', async () => {
    const ctx = createTestApp();
    try {
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 30,
          caption: 'Scan',
          document: { fileId: 'scan.png', mimeType: 'image/PNG' },
        }),
      ).expect(200);
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 31,
          document: { fileId: 'notes.pdf', mimeType: 'application/pdf' },
        }),
      ).expect(200);
      await ctx.drain();
      expect(ctx.jobs).toHaveLength(1);
      expect(ctx.jobs[0]?.photos[0]).toMatchObject({
        fileId: 'scan.png',
        width: 0,
        height: 0,
      });
      expect(ctx.fileIds).toEqual(['scan.png']);
    } finally {
      ctx.close();
    }
  });

  it('emits one job for a three-photo album, sorted by message id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = createTestApp();
    try {
      const group = 'album-9';
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 30,
          mediaGroupId: group,
          photo: [{ fileId: 'c.jpg', width: 10, height: 10 }],
        }),
      ).expect(200);
      await ctx.drain();
      await vi.advanceTimersByTimeAsync(1_500);

      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 10,
          mediaGroupId: group,
          caption: '#feedonly Three frames',
          photo: [{ fileId: 'a.jpg', width: 10, height: 10 }],
        }),
      ).expect(200);
      await ctx.drain();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(ctx.jobs).toHaveLength(0);

      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 20,
          mediaGroupId: group,
          photo: [{ fileId: 'b.jpg', width: 10, height: 10 }],
        }),
      ).expect(200);
      await ctx.drain();
      await vi.advanceTimersByTimeAsync(ALBUM_DEBOUNCE_MS - 1);
      expect(ctx.jobs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await ctx.drain();

      expect(ctx.jobs).toHaveLength(1);
      expect(ctx.jobs[0]?.mediaGroupId).toBe(group);
      expect(ctx.jobs[0]?.messageIds).toEqual([10, 20, 30]);
      expect(ctx.jobs[0]?.photos.map((photo) => photo.fileId)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
      expect(ctx.jobs[0]?.caption).toBe('Three frames');
      expect(ctx.jobs[0]?.targets).toEqual(['ig_feed']);
      expect(ctx.jobs[0]?.photos.every((photo) => (photo.buffer?.length ?? 0) > 0)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it('still returns 200 when the job handler fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = createTestApp({
      handler: async () => {
        throw new Error('handler failed');
      },
    });
    try {
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 40,
          photo: [{ fileId: 'boom.jpg', width: 4, height: 4 }],
        }),
      ).expect(200);
      await ctx.drain();
      expect(error).toHaveBeenCalled();
      expect(ctx.jobs).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it('offers each buffer to the media stager hook', async () => {
    const staged: { name: string; bytes: number }[] = [];
    const stager: Stager = {
      async stage(buf, name) {
        staged.push({ name, bytes: buf.length });
        const story = `file:///tmp/${name}-story.jpg`;
        return {
          feed: `file:///tmp/${name}-feed.jpg`,
          story,
          tiktok: story,
        };
      },
    };
    const ctx = createTestApp({ stager });
    try {
      await postUpdate(
        ctx.app,
        channelPost({
          messageId: 41,
          photo: [{ fileId: 'stage.jpg', width: 6, height: 6 }],
        }),
      ).expect(200);
      await ctx.drain();
      expect(staged).toHaveLength(1);
      expect(staged[0]?.name).toMatch(/-0$/);
      expect(staged[0]?.bytes).toBeGreaterThan(0);
      expect(ctx.jobs).toHaveLength(1);
      expect(ctx.jobs[0]?.photos[0]?.staged?.feed).toContain(staged[0]?.name ?? '');
      expect(ctx.jobs[0]?.photos[0]?.staged?.tiktok).toBe(ctx.jobs[0]?.photos[0]?.staged?.story);
    } finally {
      ctx.close();
    }
  });
});
