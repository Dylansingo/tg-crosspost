import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Bot } from 'grammy';
import { loadConfig, logStartup, type AppConfig } from './config.js';
import { createGrammyFileApi } from './ingest/grammy.js';
import {
  createHttpFetcher,
  createIngestor,
  createSeenStore,
  webhookSecretMatches,
  type FileFetcher,
  type SeenStore,
  type TelegramFileApi,
  type TimerControls,
} from './ingest/index.js';
import { logError } from './log.js';
import { createStager, type Stager } from './media/index.js';
import { isDirectRun } from './runtime.js';
import { defaultJobHandler, type JobHandler } from './types.js';

export const WEBHOOK_PATH = '/webhook/telegram';
const PORT = 3000;

export interface CreateAppDeps {
  channelId: number;
  webhookSecret: string;
  token: string;
  seen: SeenStore;
  files: TelegramFileApi;
  fetcher: FileFetcher;
  handler?: JobHandler;
  stager?: Stager;
  timers?: TimerControls;
  now?: () => number;
}

export interface AppHandle {
  app: Express;
  drain: () => Promise<void>;
  close: () => void;
}

export function createApp(deps: CreateAppDeps): AppHandle {
  const ingestor = createIngestor({
    channelId: deps.channelId,
    seen: deps.seen,
    handler: deps.handler ?? defaultJobHandler,
    token: deps.token,
    files: deps.files,
    fetcher: deps.fetcher,
    ...(deps.stager ? { stager: deps.stager } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.post(WEBHOOK_PATH, (req, res) => {
    const provided = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (!webhookSecretMatches(provided, deps.webhookSecret)) {
      res.sendStatus(401);
      return;
    }
    const body: unknown = req.body;
    res.sendStatus(200);
    ingestor.enqueue(body);
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    void req;
    if (error instanceof SyntaxError && 'body' in error) {
      res.sendStatus(400);
      return;
    }
    next(error);
  });

  return {
    app,
    drain: () => ingestor.drain(),
    close: () => {
      ingestor.close();
      deps.seen.close();
    },
  };
}

export async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env, { mode: 'normal' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  logStartup(config);
  if (!config.telegram) {
    console.error(
      'Missing required configuration: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, CHANNEL_ID, ADMIN_CHAT_ID.',
    );
    process.exitCode = 1;
    return;
  }

  const bot = new Bot(config.telegram.botToken);
  const seen = createSeenStore(config.sqlitePath);
  seen.startHourlyPrune();
  const stager = await createStager(config);
  const handle = createApp({
    channelId: config.telegram.channelId,
    webhookSecret: config.telegram.webhookSecret,
    token: config.telegram.botToken,
    seen,
    files: createGrammyFileApi(bot),
    fetcher: createHttpFetcher(),
    stager,
  });

  const server = handle.app.listen(PORT, () => {
    console.log(`Listening on port ${PORT} for POST ${WEBHOOK_PATH}`);
  });

  const shutdown = () => {
    server.close();
    handle.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    logError(error);
    process.exitCode = 1;
  });
}
