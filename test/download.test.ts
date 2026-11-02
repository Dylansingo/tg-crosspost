import { describe, expect, it } from 'vitest';
import {
  createHttpFetcher,
  filePathFromTelegramUrl,
  telegramFileUrl,
} from '../src/ingest/download.js';

describe('telegram file download', () => {
  it('builds a file URL and reads the path back without using the network', () => {
    const url = telegramFileUrl('123456:TEST', 'photos/big image.jpg');
    expect(url).toBe('https://api.telegram.org/file/bot123456:TEST/photos/big%20image.jpg');
    expect(filePathFromTelegramUrl(url)).toBe('photos/big image.jpg');
  });

  it('refuses hosts other than api.telegram.org', async () => {
    const fetcher = createHttpFetcher();
    await expect(fetcher('https://example.com/secret')).rejects.toThrow(/api\.telegram\.org/);
  });
});
