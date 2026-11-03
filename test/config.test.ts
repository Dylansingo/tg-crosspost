import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatStartupReport, loadConfig } from '../src/config.js';

const telegram = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  CHANNEL_ID: '-100123',
  ADMIN_CHAT_ID: '42',
};

function platform(config: ReturnType<typeof loadConfig>, id: string) {
  const found = config.platforms.find((item) => item.id === id);
  if (!found) throw new Error(`Missing platform ${id}`);
  return found;
}

describe('config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names every missing Telegram key in normal mode', () => {
    expect(() => loadConfig({}, { mode: 'normal' })).toThrow(
      'Missing required configuration: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, CHANNEL_ID, ADMIN_CHAT_ID.',
    );
  });

  it('names only the Telegram keys that are still missing', () => {
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: '123:abc', CHANNEL_ID: '-100' }, { mode: 'normal' }),
    ).toThrow('Missing required configuration: TELEGRAM_WEBHOOK_SECRET, ADMIN_CHAT_ID.');
  });

  it('defaults DRY_RUN to true and can switch it off in normal mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defaults = loadConfig(telegram, { mode: 'normal' });
    expect(defaults.dryRun).toBe(true);
    expect(defaults.telegram).toEqual({
      botToken: '123:abc',
      webhookSecret: 'hook-secret',
      channelId: -100123,
      adminChatId: 42,
    });
    expect(platform(defaults, 'telegram').enabled).toBe(true);
    expect(platform(defaults, 'r2').enabled).toBe(false);

    const live = loadConfig({ ...telegram, DRY_RUN: 'false' }, { mode: 'normal' });
    expect(live.dryRun).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('forces DRY_RUN in demo mode and allows an empty environment', () => {
    const config = loadConfig({ DRY_RUN: 'false' }, { mode: 'demo' });
    expect(config.dryRun).toBe(true);
    expect(config.mode).toBe('demo');
    expect(config.warnings).toEqual([]);
    expect(config.platforms.every((item) => item.enabled === false)).toBe(true);
    const report = formatStartupReport(config);
    expect(report).toContain('DRY_RUN: true (demo mode forces DRY_RUN)');
    expect(report).toContain('disabled');
    expect(report).not.toContain('enabled');
    expect(report).toContain('Telegram ingestion');
    expect(report).toContain('TikTok/Zernio');
  });

  it('warns with the missing names when a platform group is only partly set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      {
        ...telegram,
        R2_BUCKET: 'media',
        R2_SECRET_ACCESS_KEY: 'super-secret-value',
        IG_USER_ID: '1789',
      },
      { mode: 'normal' },
    );
    expect(platform(config, 'r2').enabled).toBe(false);
    expect(platform(config, 'instagram').enabled).toBe(false);
    const text = config.warnings.join('\n');
    expect(text).toContain('R2 is partly configured and remains disabled.');
    expect(text).toContain('R2_ACCOUNT_ID');
    expect(text).toContain('R2_ACCESS_KEY_ID');
    expect(text).toContain('R2_PUBLIC_BASE_URL');
    expect(text).not.toContain('super-secret-value');
    expect(text).toContain('Missing: IG_ACCESS_TOKEN.');
    expect(warn).toHaveBeenCalled();
    expect(platform(config, 'r2').missing).toEqual([
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_PUBLIC_BASE_URL',
    ]);
  });

  it('enables Instagram, R2, and Snapchat when each group is complete', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      {
        ...telegram,
        R2_ACCOUNT_ID: 'acc',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_BUCKET: 'bucket',
        R2_PUBLIC_BASE_URL: 'https://media.example.com',
        IG_USER_ID: '1789',
        IG_ACCESS_TOKEN: 'ig-token',
        ZERNIO_API_KEY: 'zernio-key',
        ZERNIO_SNAPCHAT_ACCOUNT_ID: 'snap-1',
      },
      { mode: 'normal' },
    );
    expect(platform(config, 'instagram').enabled).toBe(true);
    expect(platform(config, 'r2').enabled).toBe(true);
    expect(platform(config, 'snapchat').enabled).toBe(true);
    expect(config.instagram).toEqual({ userId: '1789', accessToken: 'ig-token' });
    expect(config.r2?.publicBaseUrl).toBe('https://media.example.com');
    expect(config.snapchat).toEqual({
      apiKey: 'zernio-key',
      baseUrl: 'https://api.zernio.com',
      accountId: 'snap-1',
    });
    expect(config.warnings.some((warning) => warning.startsWith('R2'))).toBe(false);
    const report = formatStartupReport(config);
    expect(report).toContain('Instagram           enabled');
    expect(report).toContain('TikTok/Zernio       disabled');
  });

  it('enables TikTok from the Zernio route or the native route', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viaZernio = loadConfig(
      {
        ...telegram,
        TIKTOK_VIA: 'zernio',
        ZERNIO_API_KEY: 'zernio-key',
        ZERNIO_TIKTOK_ACCOUNT_ID: 'tt-1',
        ZERNIO_SNAPCHAT_ACCOUNT_ID: 'snap-1',
        TIKTOK_CLIENT_KEY: 'unused-native',
      },
      { mode: 'normal' },
    );
    expect(platform(viaZernio, 'tiktok').enabled).toBe(true);
    expect(platform(viaZernio, 'tiktok').label).toBe('TikTok/Zernio');
    expect(viaZernio.tiktok).toEqual({
      via: 'zernio',
      apiKey: 'zernio-key',
      baseUrl: 'https://api.zernio.com',
      accountId: 'tt-1',
    });
    expect(viaZernio.tiktokPrivacy).toBe('SELF_ONLY');
    expect(viaZernio.warnings.some((warning) => warning.startsWith('TikTok'))).toBe(false);

    const viaNative = loadConfig(
      {
        ...telegram,
        TIKTOK_VIA: 'native',
        TIKTOK_CLIENT_KEY: 'ck',
        TIKTOK_CLIENT_SECRET: 'cs',
        TIKTOK_ACCESS_TOKEN: 'at',
        ZERNIO_API_KEY: 'zernio-key',
        ZERNIO_TIKTOK_ACCOUNT_ID: 'tt-ignored',
        ZERNIO_SNAPCHAT_ACCOUNT_ID: 'snap-1',
      },
      { mode: 'normal' },
    );
    expect(platform(viaNative, 'tiktok').enabled).toBe(true);
    expect(platform(viaNative, 'tiktok').label).toBe('TikTok/native');
    expect(viaNative.tiktok).toEqual({
      via: 'native',
      clientKey: 'ck',
      clientSecret: 'cs',
      accessToken: 'at',
      privacy: 'SELF_ONLY',
    });
    expect(platform(viaNative, 'snapchat').enabled).toBe(true);
    expect(viaNative.warnings).toEqual([]);
  });

  it('warns when the chosen TikTok route is incomplete', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      {
        ...telegram,
        TIKTOK_VIA: 'native',
        TIKTOK_CLIENT_KEY: 'ck',
        TIKTOK_PRIVACY: 'PUBLIC_TO_EVERYONE',
      },
      { mode: 'normal' },
    );
    expect(platform(config, 'tiktok').enabled).toBe(false);
    expect(config.tiktok).toBeUndefined();
    expect(config.tiktokPrivacy).toBe('PUBLIC_TO_EVERYONE');
    const text = config.warnings.join('\n');
    expect(text).toContain('TikTok/native is partly configured and remains disabled.');
    expect(text).toContain('TIKTOK_CLIENT_SECRET');
    expect(text).toContain('TIKTOK_ACCESS_TOKEN');
    expect(text).not.toContain('ck');
    expect(warn).toHaveBeenCalled();
  });

  it('names invalid keys without repeating their values', () => {
    expect(() => loadConfig({ ...telegram, TIKTOK_VIA: 'official' }, { mode: 'normal' })).toThrow(
      /TIKTOK_VIA must be "zernio" or "native"/,
    );
    expect(() => loadConfig({ ...telegram, CHANNEL_ID: 'channel' }, { mode: 'normal' })).toThrow(
      /CHANNEL_ID must be an integer/,
    );
    expect(() => loadConfig({ ...telegram, DRY_RUN: 'yes' }, { mode: 'normal' })).toThrow(
      /DRY_RUN must be "true" or "false"/,
    );
    expect(() =>
      loadConfig({ ...telegram, R2_PUBLIC_BASE_URL: 'media.example.com' }, { mode: 'normal' }),
    ).toThrow(/R2_PUBLIC_BASE_URL must be an absolute http\(s\) URL/);
    expect(() => loadConfig({ ...telegram, TIKTOK_PRIVACY: 'FRIENDS' }, { mode: 'demo' })).toThrow(
      /TIKTOK_PRIVACY/,
    );
  });

  it('treats blank values as unset', () => {
    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: '   ',
          TELEGRAM_WEBHOOK_SECRET: '',
          CHANNEL_ID: '',
          ADMIN_CHAT_ID: '',
        },
        { mode: 'normal' },
      ),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
