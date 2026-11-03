# Publishing

`Publisher.publish(job)` turns one ingested job into Instagram, Snapchat, and TikTok posts. Media URLs come only from `Stager.stage(buf, name)`. This package never talks to R2. Until the media stager returns an `https` URL, a live run refuses the job.

`DRY_RUN` defaults to `true`. Demo mode forces it. A dry run makes no network calls: it does not call Instagram, Zernio, TikTok, or Telegram.

## Dry run

For each targeted post the publisher writes the request it would send:

```
./out/payloads/<job>-instagram-feed.json
./out/payloads/<job>-instagram-carousel.json
./out/payloads/<job>-instagram-story.json
./out/payloads/<job>-snapchat-story.json
./out/payloads/<job>-tiktok-photo.json
```

A second post of the same kind is `…-2.json`, then `…-3.json`. Tokens are placeholders (`<IG_ACCESS_TOKEN>`, `<ZERNIO_API_KEY>`, `<TIKTOK_ACCESS_TOKEN>`, and the matching account ids). Real tokens are not written, even when they are present in the environment.

`./out/preview.html` is a self-contained mock-up: an Instagram feed card at 4:5, a carousel strip, a 9:16 story frame, a Snapchat frame, and a TikTok frame. Pictures are the local files under `./out`, labelled as stand-ins for the R2 URLs `Stager.stage` will return later.

`npm run demo` (or `npm i && npm run demo` on a fresh clone) runs this path with no keys and no network. It still writes `./out/jobs.json`.

## Live run

Set `DRY_RUN=false` and configure the platforms you want. A platform that is not configured fails that platform only. The publisher runs every targeted platform with `Promise.allSettled`.

- When every platform succeeds, the bot calls `setMessageReaction` with ✅ on each original Telegram message. The bot has to be an administrator of the channel. Telegram's current reaction list does not include ✅ (the call returns `REACTION_INVALID`), so the client logs a warning and retries with 👍, which is on that list. If the retry also fails, the admin is told. The posts themselves stay published.
- When any platform fails, the bot sends `ADMIN_CHAT_ID` one message listing each platform and its error. Successful platforms are marked `published`. A deliberate skip is not a failure.
- `file://` media is refused with `R2 keys required for live publishing`. No platform is called.

Retries use exponential backoff and full jitter (half to all of 200 ms, 400 ms, 800 ms, … capped at 8 s, four attempts). Only HTTP 429, HTTP 5xx, and network errors are retried. Other 4xx responses, and an Instagram container status of `ERROR` or `EXPIRED`, fail immediately.

## Instagram

Graph API `v21.0` on `https://graph.facebook.com`, with the long-lived or system-user token from `IG_ACCESS_TOKEN` and the professional account id from `IG_USER_ID`. The token is sent as `access_token`.

Before posting, the client reads `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config`. Meta's published quota is about 50 posts in 24 hours (`quota_duration` 86400). The client uses `config.quota_total` when the API sends it, and 50 when that field is missing. A carousel counts as one post. Each story counts as one. When `quota_usage` has reached the total, further Instagram posts for that job are skipped and a warning is logged. The job does not fail.

| Target                                | Requests                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One feed photo                        | `POST /media` with `image_url` and `caption`, poll `GET /{container}?fields=status_code` until `FINISHED`, then `POST /media_publish` with `creation_id`.                                                                                                                                     |
| Album (`ig_feed`, two or more photos) | One child container per image (`is_carousel_item=true`), then a parent with `media_type=CAROUSEL` and `children` as a comma-separated list of ids. At most 10 children. A longer album is split. A leftover single image is a normal feed post, because a carousel needs at least two images. |
| `ig_story`                            | One container per image with `media_type=STORIES`. Stories are not given the feed caption.                                                                                                                                                                                                    |

The status poll backs off from 500 ms and gives up after 60 s. `ERROR` and `EXPIRED` fail the Instagram platform.

## Snapchat

Public Stories go through [Zernio](https://docs.zernio.com/platforms/snapchat/posts), not Ayrshare.

Zernio's documented call is `POST https://zernio.com/api/v1/posts` with `Authorization: Bearer`. `ZERNIO_BASE_URL` defaults to `https://zernio.com/api`; the client appends `/v1/posts`. A base that already ends in `/v1` only gains `/posts`.

A Public Story is `platform: "snapchat"` and `platformSpecificData.contentType: "story"` (the profile story that lasts 24 hours). That is not a Saved Story (`saved_story`) and not Spotlight. Zernio's own docs say a story carries no caption and exactly one image, so the caption stays on the preview only and each image is its own post.

Snap had not approved Zernio's app when this was written. A live call can return `403` with `PLATFORM_BETA_RESTRICTED`. That is reported as a Snapchat failure and is not retried.

## TikTok

`TIKTOK_VIA` chooses the client. The default is `zernio`.

**Zernio.** Same `POST /v1/posts` endpoint. Images are `mediaItems`. Settings sit in top-level `tiktokSettings`: `media_type` `photo`, `photo_cover_index` 0, `description` set to the caption, `privacy_level` from `TIKTOK_PRIVACY`. Zernio requires `content_preview_confirmed: true` and `express_consent_given: true` on every post; sending the job with `DRY_RUN=false` is the operator's confirmation. Up to 35 images per post.

**Native.** `POST https://open.tiktokapis.com/v2/post/publish/content/init/` with `Authorization: Bearer` set to `TIKTOK_ACCESS_TOKEN`. The body is a photo direct post: `media_type` `PHOTO`, `post_mode` `DIRECT_POST`, and `source_info.source` `PULL_FROM_URL`. `privacy_level` defaults to `SELF_ONLY`.

TikTok only serves `PULL_FROM_URL` from a domain verified for the app. An unaudited client is limited to private viewing. Posting to everyone (`PUBLIC_TO_EVERYONE`) needs TikTok's app audit as well as that verified domain. Leave the default at `SELF_ONLY` until both are in place. This client does not refresh the access token; an expired token fails the TikTok platform and the admin is told.

## Environment

See `.env.example`. Publishing reads `IG_USER_ID`, `IG_ACCESS_TOKEN`, `ZERNIO_API_KEY`, `ZERNIO_BASE_URL`, `ZERNIO_SNAPCHAT_ACCOUNT_ID`, `ZERNIO_TIKTOK_ACCOUNT_ID`, `TIKTOK_VIA`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_PRIVACY`, `ADMIN_CHAT_ID`, and `DRY_RUN`. No new secret is required beyond those names. Do not commit a filled-in `.env`.
