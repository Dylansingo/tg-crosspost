import type { Target } from '../types.js';

export const ALL_TARGETS: readonly Target[] = ['ig_feed', 'ig_story', 'snap_story', 'tiktok'];
export const STORY_TARGETS: readonly Target[] = ['ig_story', 'snap_story', 'tiktok'];
export const FEED_TARGETS: readonly Target[] = ['ig_feed'];

export interface RoutedCaption {
  caption: string;
  targets: Target[];
  /** True when both routing hashtags are present. Callers log a warning and keep every target. */
  conflict: boolean;
}

/**
 * Route on #storyonly / #feedonly (any case) and remove those tags.
 * Other hashtags are part of the caption and stay.
 */
export function routeCaption(input: string | undefined): RoutedCaption {
  const raw = input ?? '';
  const story = /#storyonly\b/i.test(raw);
  const feed = /#feedonly\b/i.test(raw);
  const caption = raw
    .replace(/#storyonly\b/gi, '')
    .replace(/#feedonly\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  if (story && feed) return { caption, targets: [...ALL_TARGETS], conflict: true };
  if (story) return { caption, targets: [...STORY_TARGETS], conflict: false };
  if (feed) return { caption, targets: [...FEED_TARGETS], conflict: false };
  return { caption, targets: [...ALL_TARGETS], conflict: false };
}
