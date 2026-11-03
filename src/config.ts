import { z, type ZodIssue } from 'zod';

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'CHANNEL_ID',
  'ADMIN_CHAT_ID',
  'DRY_RUN',
  'SQLITE_PATH',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'IG_USER_ID',
  'IG_ACCESS_TOKEN',
  'ZERNIO_API_KEY',
  'ZERNIO_BASE_URL',
  'ZERNIO_SNAPCHAT_ACCOUNT_ID',
  'ZERNIO_TIKTOK_ACCOUNT_ID',
  'TIKTOK_VIA',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'TIKTOK_ACCESS_TOKEN',
  'TIKTOK_PRIVACY',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const httpUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'));

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  CHANNEL_ID: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
  ADMIN_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
  DRY_RUN: z.enum(['true', 'false']).optional(),
  SQLITE_PATH: z.string().min(1).optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_PUBLIC_BASE_URL: httpUrl.optional(),
  IG_USER_ID: z.string().min(1).optional(),
  IG_ACCESS_TOKEN: z.string().min(1).optional(),
  ZERNIO_API_KEY: z.string().min(1).optional(),
  ZERNIO_BASE_URL: httpUrl.optional(),
  ZERNIO_SNAPCHAT_ACCOUNT_ID: z.string().min(1).optional(),
  ZERNIO_TIKTOK_ACCOUNT_ID: z.string().min(1).optional(),
  TIKTOK_VIA: z.enum(['zernio', 'native']).optional(),
  TIKTOK_CLIENT_KEY: z.string().min(1).optional(),
  TIKTOK_CLIENT_SECRET: z.string().min(1).optional(),
  TIKTOK_ACCESS_TOKEN: z.string().min(1).optional(),
  TIKTOK_PRIVACY: z
    .enum(['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'])
    .optional(),
});

type ParsedEnv = z.infer<typeof EnvSchema>;

export type TikTokPrivacy = NonNullable<ParsedEnv['TIKTOK_PRIVACY']>;
export type ConfigMode = 'normal' | 'demo';

export type PlatformId = 'telegram' | 'r2' | 'instagram' | 'snapchat' | 'tiktok';

export interface PlatformState {
  id: PlatformId;
  label: string;
  enabled: boolean;
  missing: string[];
}

export interface TelegramSettings {
  botToken: string;
  webhookSecret: string;
  channelId: number;
  adminChatId: number;
}

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

export interface InstagramSettings {
  userId: string;
  accessToken: string;
}

export interface SnapchatSettings {
  apiKey: string;
  baseUrl: string;
  accountId: string;
}

export type TikTokSettings =
  | { via: 'zernio'; apiKey: string; baseUrl: string; accountId: string }
  | {
      via: 'native';
      clientKey: string;
      clientSecret: string;
      accessToken: string;
      privacy: TikTokPrivacy;
    };

export interface AppConfig {
  mode: ConfigMode;
  dryRun: boolean;
  sqlitePath: string;
  tiktokVia: 'zernio' | 'native';
  tiktokPrivacy: TikTokPrivacy;
  warnings: string[];
  platforms: PlatformState[];
  telegram?: TelegramSettings;
  r2?: R2Settings;
  instagram?: InstagramSettings;
  snapchat?: SnapchatSettings;
  tiktok?: TikTokSettings;
}

interface Field {
  key: string;
  value: string | undefined;
}

interface Assessment {
  enabled: boolean;
  missing: string[];
  warning?: string;
}

const DEFAULT_SQLITE_PATH = './data/tg-crosspost.db';
/** Documented Zernio origin. The client appends `/v1/posts`. */
export const DEFAULT_ZERNIO_BASE_URL = 'https://zernio.com/api';

export interface LoadConfigOptions {
  mode?: ConfigMode;
}

/**
 * Parse the environment. In normal mode the Telegram ingestion keys are
 * required and any missing name is listed. Other platforms enable only when
 * their group is complete. A partial group adds a warning that names the gaps.
 * Demo mode forces DRY_RUN and treats Telegram as optional.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const mode = options.mode ?? 'normal';
  const parsed = parseEnv(env);
  const warnings: string[] = [];

  const telegramFields: Field[] = [
    { key: 'TELEGRAM_BOT_TOKEN', value: parsed.TELEGRAM_BOT_TOKEN },
    { key: 'TELEGRAM_WEBHOOK_SECRET', value: parsed.TELEGRAM_WEBHOOK_SECRET },
    { key: 'CHANNEL_ID', value: parsed.CHANNEL_ID },
    { key: 'ADMIN_CHAT_ID', value: parsed.ADMIN_CHAT_ID },
  ];
  const telegramAssessment = assess('Telegram ingestion', telegramFields);
  if (mode === 'normal' && !telegramAssessment.enabled) {
    const missing = telegramFields
      .filter((field) => field.value === undefined)
      .map((field) => field.key);
    throw new Error(`Missing required configuration: ${missing.join(', ')}.`);
  }
  remember(warnings, telegramAssessment);

  const r2Fields: Field[] = [
    { key: 'R2_ACCOUNT_ID', value: parsed.R2_ACCOUNT_ID },
    { key: 'R2_ACCESS_KEY_ID', value: parsed.R2_ACCESS_KEY_ID },
    { key: 'R2_SECRET_ACCESS_KEY', value: parsed.R2_SECRET_ACCESS_KEY },
    { key: 'R2_BUCKET', value: parsed.R2_BUCKET },
    { key: 'R2_PUBLIC_BASE_URL', value: parsed.R2_PUBLIC_BASE_URL },
  ];
  const r2Assessment = assess('R2', r2Fields);
  remember(warnings, r2Assessment);

  const instagramFields: Field[] = [
    { key: 'IG_USER_ID', value: parsed.IG_USER_ID },
    { key: 'IG_ACCESS_TOKEN', value: parsed.IG_ACCESS_TOKEN },
  ];
  const instagramAssessment = assess('Instagram', instagramFields);
  remember(warnings, instagramAssessment);

  const snapchatFields: Field[] = [
    { key: 'ZERNIO_API_KEY', value: parsed.ZERNIO_API_KEY },
    { key: 'ZERNIO_SNAPCHAT_ACCOUNT_ID', value: parsed.ZERNIO_SNAPCHAT_ACCOUNT_ID },
  ];
  const snapchatAssessment = assess('Snapchat/Zernio', snapchatFields);
  remember(warnings, snapchatAssessment);

  const tiktokVia = parsed.TIKTOK_VIA ?? 'zernio';
  const tiktokPrivacy = parsed.TIKTOK_PRIVACY ?? 'SELF_ONLY';
  const tiktokLabel = tiktokVia === 'native' ? 'TikTok/native' : 'TikTok/Zernio';
  const tiktokFields: Field[] =
    tiktokVia === 'native'
      ? [
          { key: 'TIKTOK_CLIENT_KEY', value: parsed.TIKTOK_CLIENT_KEY },
          { key: 'TIKTOK_CLIENT_SECRET', value: parsed.TIKTOK_CLIENT_SECRET },
          { key: 'TIKTOK_ACCESS_TOKEN', value: parsed.TIKTOK_ACCESS_TOKEN },
        ]
      : [
          { key: 'ZERNIO_API_KEY', value: parsed.ZERNIO_API_KEY },
          { key: 'ZERNIO_TIKTOK_ACCOUNT_ID', value: parsed.ZERNIO_TIKTOK_ACCOUNT_ID },
        ];
  const tiktokAssessment = assess(tiktokLabel, tiktokFields);
  remember(warnings, tiktokAssessment);

  const zernioBaseUrl = parsed.ZERNIO_BASE_URL ?? DEFAULT_ZERNIO_BASE_URL;
  const dryRun = mode === 'demo' ? true : parsed.DRY_RUN !== 'false';

  const platforms: PlatformState[] = [
    state('telegram', 'Telegram ingestion', telegramAssessment),
    state('r2', 'R2', r2Assessment),
    state('instagram', 'Instagram', instagramAssessment),
    state('snapchat', 'Snapchat/Zernio', snapchatAssessment),
    state('tiktok', tiktokLabel, tiktokAssessment),
  ];

  const config: AppConfig = {
    mode,
    dryRun,
    sqlitePath: parsed.SQLITE_PATH ?? DEFAULT_SQLITE_PATH,
    tiktokVia,
    tiktokPrivacy,
    warnings,
    platforms,
  };

  if (telegramAssessment.enabled) {
    config.telegram = {
      botToken: required(parsed.TELEGRAM_BOT_TOKEN),
      webhookSecret: required(parsed.TELEGRAM_WEBHOOK_SECRET),
      channelId: Number(parsed.CHANNEL_ID),
      adminChatId: Number(parsed.ADMIN_CHAT_ID),
    };
  }
  if (r2Assessment.enabled) {
    config.r2 = {
      accountId: required(parsed.R2_ACCOUNT_ID),
      accessKeyId: required(parsed.R2_ACCESS_KEY_ID),
      secretAccessKey: required(parsed.R2_SECRET_ACCESS_KEY),
      bucket: required(parsed.R2_BUCKET),
      publicBaseUrl: required(parsed.R2_PUBLIC_BASE_URL),
    };
  }
  if (instagramAssessment.enabled) {
    config.instagram = {
      userId: required(parsed.IG_USER_ID),
      accessToken: required(parsed.IG_ACCESS_TOKEN),
    };
  }
  if (snapchatAssessment.enabled) {
    config.snapchat = {
      apiKey: required(parsed.ZERNIO_API_KEY),
      baseUrl: zernioBaseUrl,
      accountId: required(parsed.ZERNIO_SNAPCHAT_ACCOUNT_ID),
    };
  }
  if (tiktokAssessment.enabled && tiktokVia === 'zernio') {
    config.tiktok = {
      via: 'zernio',
      apiKey: required(parsed.ZERNIO_API_KEY),
      baseUrl: zernioBaseUrl,
      accountId: required(parsed.ZERNIO_TIKTOK_ACCOUNT_ID),
    };
  }
  if (tiktokAssessment.enabled && tiktokVia === 'native') {
    config.tiktok = {
      via: 'native',
      clientKey: required(parsed.TIKTOK_CLIENT_KEY),
      clientSecret: required(parsed.TIKTOK_CLIENT_SECRET),
      accessToken: required(parsed.TIKTOK_ACCESS_TOKEN),
      privacy: tiktokPrivacy,
    };
  }

  return config;
}

export function formatPlatformTable(config: AppConfig): string {
  const rows = config.platforms.map(
    (platform) => [platform.label, platform.enabled ? 'enabled' : 'disabled'] as const,
  );
  const labelWidth = Math.max('Platform'.length, ...rows.map((row) => row[0].length));
  const line = (label: string, status: string) => `${label.padEnd(labelWidth)}  ${status}`;
  return [
    line('Platform', 'Status'),
    line('-'.repeat(labelWidth), '--------'),
    ...rows.map((row) => line(row[0], row[1])),
  ].join('\n');
}

export function formatStartupReport(config: AppConfig): string {
  const dryRun = `DRY_RUN: ${config.dryRun ? 'true' : 'false'}${
    config.mode === 'demo' ? ' (demo mode forces DRY_RUN)' : ''
  }`;
  return `${dryRun}\n\n${formatPlatformTable(config)}`;
}

/** Log the platform table. Partial-group warnings are emitted by {@link loadConfig}. */
export function logStartup(config: AppConfig): void {
  console.log(formatStartupReport(config));
  if (config.mode === 'normal' && !config.dryRun) {
    console.warn(
      'DRY_RUN is false. Live publishing will post to every enabled platform. A file:// media URL is refused until R2 returns an https URL.',
    );
  }
}

function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
  const normalised: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) normalised[key] = trimmed;
  }
  const parsed = EnvSchema.safeParse(normalised);
  if (!parsed.success) {
    const messages = [...new Set(parsed.error.issues.map(formatIssue))];
    throw new Error(`Invalid configuration: ${messages.join('; ')}.`);
  }
  return parsed.data;
}

function formatIssue(issue: ZodIssue): string {
  const key = String(issue.path[0] ?? 'configuration');
  if (key === 'TIKTOK_VIA') return 'TIKTOK_VIA must be "zernio" or "native"';
  if (key === 'TIKTOK_PRIVACY') {
    return 'TIKTOK_PRIVACY must be SELF_ONLY, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, or PUBLIC_TO_EVERYONE';
  }
  if (key === 'DRY_RUN') return 'DRY_RUN must be "true" or "false"';
  if (key === 'CHANNEL_ID' || key === 'ADMIN_CHAT_ID') return `${key} must be an integer`;
  if (key === 'R2_PUBLIC_BASE_URL' || key === 'ZERNIO_BASE_URL') {
    return `${key} must be an absolute http(s) URL`;
  }
  return `${key} is invalid`;
}

function assess(label: string, fields: Field[]): Assessment {
  const provided = fields.filter((field) => field.value !== undefined);
  const missing = fields.filter((field) => field.value === undefined).map((field) => field.key);
  if (provided.length === 0) return { enabled: false, missing: [] };
  if (missing.length === 0) return { enabled: true, missing: [] };
  return {
    enabled: false,
    missing,
    warning: `${label} is partly configured and remains disabled. Missing: ${missing.join(', ')}.`,
  };
}

function remember(warnings: string[], assessment: Assessment): void {
  if (!assessment.warning) return;
  warnings.push(assessment.warning);
  console.warn(assessment.warning);
}

function state(id: PlatformId, label: string, assessment: Assessment): PlatformState {
  return {
    id,
    label,
    enabled: assessment.enabled,
    missing: assessment.missing,
  };
}

function required(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Internal configuration error: an enabled platform is missing a value.');
  }
  return value;
}
