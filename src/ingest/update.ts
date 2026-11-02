export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface ChannelPost {
  message_id: number;
  chat: { id: number; type?: string };
  caption?: string;
  media_group_id?: string;
  photo?: PhotoSize[];
  document?: TelegramDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPhotoSize(value: unknown): PhotoSize | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file_id !== 'string' || typeof value.file_unique_id !== 'string')
    return undefined;
  const photo: PhotoSize = {
    file_id: value.file_id,
    file_unique_id: value.file_unique_id,
  };
  if (typeof value.width === 'number') photo.width = value.width;
  if (typeof value.height === 'number') photo.height = value.height;
  if (typeof value.file_size === 'number') photo.file_size = value.file_size;
  return photo;
}

function readDocument(value: unknown): TelegramDocument | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file_id !== 'string' || typeof value.file_unique_id !== 'string')
    return undefined;
  const document: TelegramDocument = {
    file_id: value.file_id,
    file_unique_id: value.file_unique_id,
  };
  if (typeof value.mime_type === 'string') document.mime_type = value.mime_type;
  if (typeof value.file_size === 'number') document.file_size = value.file_size;
  return document;
}

/** Accept only a channel_post that has a numeric chat id and message id. */
export function readChannelPost(update: unknown): ChannelPost | undefined {
  if (!isRecord(update)) return undefined;
  const post = update.channel_post;
  if (!isRecord(post)) return undefined;
  if (typeof post.message_id !== 'number' || !Number.isInteger(post.message_id)) return undefined;
  const chat = post.chat;
  if (!isRecord(chat) || typeof chat.id !== 'number' || !Number.isInteger(chat.id))
    return undefined;

  const channelPost: ChannelPost = {
    message_id: post.message_id,
    chat: { id: chat.id },
  };
  if (typeof chat.type === 'string') channelPost.chat.type = chat.type;
  if (typeof post.caption === 'string') channelPost.caption = post.caption;
  if (typeof post.media_group_id === 'string' && post.media_group_id.length > 0) {
    channelPost.media_group_id = post.media_group_id;
  }
  if (Array.isArray(post.photo)) {
    const photos = post.photo.flatMap((item) => {
      const photo = readPhotoSize(item);
      return photo ? [photo] : [];
    });
    if (photos.length > 0) channelPost.photo = photos;
  }
  const document = readDocument(post.document);
  if (document) channelPost.document = document;
  return channelPost;
}
