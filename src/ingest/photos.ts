import type { ChannelPost, PhotoSize, TelegramDocument } from './update.js';

export interface SelectedImage {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
}

function area(photo: PhotoSize): number {
  return (photo.width ?? 0) * (photo.height ?? 0);
}

/** Largest size by width×height, then by file_size when the area ties or is unknown. */
export function pickLargestPhoto(photos: readonly PhotoSize[]): PhotoSize | undefined {
  let best: PhotoSize | undefined;
  for (const photo of photos) {
    if (!best) {
      best = photo;
      continue;
    }
    const areaDiff = area(photo) - area(best);
    if (areaDiff > 0 || (areaDiff === 0 && (photo.file_size ?? 0) > (best.file_size ?? 0))) {
      best = photo;
    }
  }
  return best;
}

function isImageDocument(document: TelegramDocument): boolean {
  const mime = document.mime_type?.toLowerCase();
  return mime === 'image/jpeg' || mime === 'image/png';
}

export function selectImage(post: ChannelPost): SelectedImage | undefined {
  if (post.photo && post.photo.length > 0) {
    const best = pickLargestPhoto(post.photo);
    if (!best) return undefined;
    return {
      fileId: best.file_id,
      fileUniqueId: best.file_unique_id,
      width: best.width ?? 0,
      height: best.height ?? 0,
    };
  }
  if (post.document && isImageDocument(post.document)) {
    return {
      fileId: post.document.file_id,
      fileUniqueId: post.document.file_unique_id,
      width: 0,
      height: 0,
    };
  }
  return undefined;
}
