/** Offline renders. Demo mode and any incomplete R2 configuration write here. */
export const MEDIA_DIRECTORY = './out/media';

/** Object key prefix. The one-day lifecycle rule in docs/R2.md targets this prefix. */
export const OBJECT_PREFIX = 'media';

/**
 * Keep the caller-supplied name as a single path segment. Job ids are UUIDs;
 * this still refuses separators so a name cannot escape the media directory.
 */
export function safeStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new Error('Media name is empty.');
  }
  return cleaned.slice(0, 160);
}

export function feedFileName(stem: string): string {
  return `${stem}-feed.jpg`;
}

export function storyFileName(stem: string): string {
  return `${stem}-story.jpg`;
}

export function objectKey(fileName: string): string {
  return `${OBJECT_PREFIX}/${fileName}`;
}

export function joinPublicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key}`;
}
