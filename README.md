# tg-crosspost

Cross-posts photos from a Telegram channel to Instagram Feed and Stories, Snapchat Stories, and later TikTok. This repository is the ingestion service: it turns channel posts into jobs. Media staging and publishing are extension points.

The demo runs on the machine with no Telegram account, no cloud keys, and no network.

## Requirements

- Node.js 20 or newer

## Set up

```bash
npm install
cp .env.example .env   # only for the webhook server; the demo does not read it
```

`.env.example` documents every key. Each one is optional. Real tokens stay out of the repo: `.gitignore` covers `.env` and `*.db`.

## Demo

From a fresh clone:

```bash
npm i && npm run demo
```

`npm run demo` reads `./samples`. `npm run demo -- ./samples` selects that folder explicitly. The command:

1. Forces `DRY_RUN` and stages locally, even when R2 keys are present. No network and no `.env`.
2. Feeds the sample images and captions through the same routing, deduplication, and album grouping as the webhook.
3. Passes each photo buffer on the job and renders a 4:5 feed JPEG and a 9:16 story JPEG.
4. Writes `./out/jobs.json` (with the `file://` URLs publishers would use) and logs a DRY_RUN line per job.
5. Writes `./out/media/{id}-feed.jpg`, `./out/media/{id}-story.jpg`, and `./out/media/contact-sheet.jpg`.

The samples are synthetic JPEG and PNG files plus `samples/manifest.json`:

| Post                          | What it shows                                  |
| ----------------------------- | ---------------------------------------------- |
| `single.jpg`                  | One photo, every target                        |
| `album-1.png` … `album-3.png` | One album job, three photos, `#feedonly`       |
| `story.png`                   | `#storyonly` (any case) for Stories and TikTok |

Regenerate the images with `node scripts/generate-samples.mjs`.

## Configuration

`src/config.ts` parses the environment with zod.

- **Normal mode** (`npm run dev`) requires the Telegram group. A missing key is named in the error, for example `Missing required configuration: TELEGRAM_BOT_TOKEN, CHANNEL_ID.`
- **Demo mode** treats every platform as optional and forces `DRY_RUN`, even when the environment says `false`.
- A platform is **enabled** only when every key in its group is present. An empty group is **disabled**. A partly filled group stays disabled and a warning names the missing keys.
- `DRY_RUN` defaults to `true`.
- `TIKTOK_VIA` is `zernio` (default) or `native`. TikTok enables from the keys of the chosen route only. `TIKTOK_PRIVACY` defaults to `SELF_ONLY` and does not enable the native route on its own.

On startup the process logs `DRY_RUN`, a table of enabled and disabled platforms, and which stager is active (`local files` or `R2`):

| Platform           | Keys                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Telegram ingestion | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CHANNEL_ID`, `ADMIN_CHAT_ID`                 |
| R2                 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` |
| Instagram          | `IG_USER_ID`, `IG_ACCESS_TOKEN`                                                                |
| Snapchat/Zernio    | `ZERNIO_API_KEY`, `ZERNIO_SNAPCHAT_ACCOUNT_ID`                                                 |
| TikTok/Zernio      | `ZERNIO_API_KEY`, `ZERNIO_TIKTOK_ACCOUNT_ID`                                                   |
| TikTok/native      | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN`                             |

`ZERNIO_BASE_URL` defaults to `https://api.zernio.com`. `SQLITE_PATH` defaults to `./data/tg-crosspost.db`.

R2 turns on only when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_PUBLIC_BASE_URL` are all set, and the process is not in demo mode. Otherwise renders stay in `./out/media`. Bucket layout, the one-day delete rule, and the TikTok domain check are in [docs/R2.md](docs/R2.md).

## Media

Each photo becomes two sRGB JPEGs. EXIF orientation is applied first, then metadata (including GPS) is stripped. PNG alpha is flattened onto the letterbox colour. WebP is accepted as well. Mozjpeg starts at quality 90 and steps down so the file stays under 8 MB.

| Render           | Size             | Fit                                                                                                                               |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Feed (`ig_feed`) | 1080×1350 (4:5)  | Cover when the aspect is within 15% of 4:5, otherwise contain                                                                     |
| Story and TikTok | 1080×1920 (9:16) | The photo is contained and centred. Behind it, the same photo is cover-scaled, blurred (sigma 24), and darkened to 40% brightness |

The letterbox and flatten colour is `#1a1a1a`. `staged.tiktok` is the same URL as `staged.story`.

## Webhook server

```bash
npm run dev
```

The process listens on port 3000 for `POST /webhook/telegram`. It checks `X-Telegram-Bot-Api-Secret-Token` with a constant-time compare and answers **401** when the header is missing or wrong. A matching request answers **200** immediately, then handles the update. Failures are logged and stay off the HTTP response.

Only `channel_post` updates whose `chat.id` equals `CHANNEL_ID` are ingested. The largest photo size is chosen by width × height, then by `file_size`. JPEG and PNG documents are accepted as well. The file is fetched with Grammy's `getFile`, then downloaded from `https://api.telegram.org/file/bot<token>/<file_path>`. Grammy is not started as a poller.

Caption routing (the tags are case-insensitive and removed from the caption; other hashtags stay):

| Caption          | Targets                                       |
| ---------------- | --------------------------------------------- |
| `#storyonly`     | `ig_story`, `snap_story`, `tiktok`            |
| `#feedonly`      | `ig_feed`                                     |
| neither, or both | `ig_feed`, `ig_story`, `snap_story`, `tiktok` |

When both tags are present the server logs a warning and still uses every target.

Albums (`media_group_id`) are held for 2 seconds after the latest item, then emitted as one job. Photos are ordered by `message_id`. The caption is taken from the item that has one.

Idempotency uses SQLite table `seen(chat_id, message_id, seen_at)` with primary key `(chat_id, message_id)`. A message seen within 24 hours is skipped. Older rows are removed on startup and every hour.

### setWebhook

Register the webhook with a `secret_token`. Telegram then sends that value on every update as `X-Telegram-Bot-Api-Secret-Token`. The bot needs to be an administrator of the channel so it receives `channel_post`. Leave polling off; `getUpdates` and a webhook cannot both be active.

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhook/telegram",
    "secret_token": "'"${TELEGRAM_WEBHOOK_SECRET}"'",
    "allowed_updates": ["channel_post"]
  }'
```

`secret_token` is 1–256 characters from `A–Z`, `a–z`, `0–9`, `_`, and `-`.

While `DRY_RUN` is true (the default), the handler logs each job and appends it to `./out/jobs.json`. Photo buffers stay on the in-memory job; the JSON file records byte lengths.

## Scripts

| Script              | Purpose                             |
| ------------------- | ----------------------------------- |
| `npm run demo`      | Offline sample run                  |
| `npm run dev`       | Webhook server via tsx              |
| `npm run build`     | Compile to `dist/`                  |
| `npm test`          | Vitest                              |
| `npm run typecheck` | `tsc --noEmit` for source and tests |
| `npm run lint`      | ESLint and Prettier                 |

## Layout

```
src/ingest/     webhook, routing, albums, dedup, downloads
src/media/      feed and story renders, local and R2 stagers
src/publish/    PE-1 publisher stub
src/types.ts    Job, Target, JobHandler
src/config.ts   environment and platform table
src/server.ts   Express entrypoint
src/demo.ts     offline sample runner
```

## Extension points

**Media — `src/media/`.** `Stager.stage(buf, name)` returns `{ feed, story, tiktok }` URLs. The pipeline stores them on `photo.staged` before the job handler. `LocalStager` writes `file://` URLs under `./out/media`. `R2Stager` uploads with `ContentType: image/jpeg` and is imported only when R2 is enabled outside demo mode.

**PE-1 — `src/publish/index.ts`.** Implement `Publisher.publish(job)`. Build dry-run payloads and a preview from the job, then post to Instagram, Snapchat, and TikTok. `tiktok` on the job is a 9:16 photo. The route is `TIKTOK_VIA=zernio` (default) or `native`. Until a publisher is wired, `defaultJobHandler` logs the job and writes `./out/jobs.json`.
