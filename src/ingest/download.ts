export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export type FileFetcher = (url: string) => Promise<Buffer>;

export function telegramFileUrl(token: string, filePath: string): string {
  const encodedPath = filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://api.telegram.org/file/bot${token}/${encodedPath}`;
}

/** Pull the file path back out of a Telegram file URL without logging the token. */
export function filePathFromTelegramUrl(url: string): string {
  const parsed = new URL(url);
  const marker = '/file/bot';
  const index = parsed.pathname.indexOf(marker);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.telegram.org' || index === -1) {
    throw new Error('Unexpected Telegram file URL.');
  }
  const afterToken = parsed.pathname.slice(index + marker.length);
  const slash = afterToken.indexOf('/');
  if (slash === -1) throw new Error('Telegram file URL is missing a path.');
  return afterToken
    .slice(slash + 1)
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join('/');
}

export async function downloadTelegramFile(
  fileId: string,
  deps: { api: TelegramFileApi; token: string; fetcher: FileFetcher },
): Promise<Buffer> {
  const file = await deps.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}.`);
  }
  return deps.fetcher(telegramFileUrl(deps.token, file.file_path));
}

/** Production fetcher. Tests and the demo inject their own and never reach this. */
export function createHttpFetcher(): FileFetcher {
  return async (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.telegram.org') {
      throw new Error('Refusing to download outside https://api.telegram.org.');
    }
    const response = await fetch(parsed);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  };
}
