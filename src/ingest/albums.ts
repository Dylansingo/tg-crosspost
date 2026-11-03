import type { Photo } from '../types.js';
import type { TimerControls } from './timers.js';

/** Quiet period after the last album item before one job is emitted. */
export const ALBUM_DEBOUNCE_MS = 2000;

export interface AlbumItem {
  messageId: number;
  caption?: string;
  photo: Photo;
}

interface Group {
  chatId: number;
  mediaGroupId: string;
  items: AlbumItem[];
  timer: unknown;
}

export interface FlushedAlbum {
  chatId: number;
  mediaGroupId: string;
  items: AlbumItem[];
}

/**
 * Buffer channel posts that share a media_group_id. Each new item resets a
 * 2 second timer. The flush emits one group, sorted by message id.
 */
export class AlbumBuffer {
  private readonly groups = new Map<string, Group>();

  constructor(
    private readonly delayMs: number,
    private readonly emit: (group: FlushedAlbum) => void,
    private readonly timers: TimerControls,
  ) {}

  add(chatId: number, mediaGroupId: string, item: AlbumItem): void {
    const key = `${chatId}:${mediaGroupId}`;
    const existing = this.groups.get(key);
    if (existing) {
      if (existing.items.some((current) => current.messageId === item.messageId)) return;
      existing.items.push(item);
      this.timers.clearTimeout(existing.timer);
      existing.timer = this.timers.setTimeout(() => this.flush(key), this.delayMs);
      return;
    }
    const timer = this.timers.setTimeout(() => this.flush(key), this.delayMs);
    this.groups.set(key, { chatId, mediaGroupId, items: [item], timer });
  }

  close(): void {
    for (const group of this.groups.values()) {
      this.timers.clearTimeout(group.timer);
    }
    this.groups.clear();
  }

  private flush(key: string): void {
    const group = this.groups.get(key);
    if (!group) return;
    this.groups.delete(key);
    const items = [...group.items].sort((left, right) => left.messageId - right.messageId);
    this.emit({ chatId: group.chatId, mediaGroupId: group.mediaGroupId, items });
  }
}
