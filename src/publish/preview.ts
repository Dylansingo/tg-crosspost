import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Target } from '../types.js';

export interface PreviewImage {
  src: string;
}

export interface PreviewEntry {
  jobId: string;
  caption: string;
  messageIds: readonly number[];
  targets: readonly Target[];
  images: readonly PreviewImage[];
  /** Dry-run Blotato request documents, shown under the mock-up. */
  requestNotes?: readonly string[];
}

export function previewImageSrc(mediaUrl: string, previewDir: string): string {
  if (mediaUrl.startsWith('file:')) {
    const relative = path.relative(previewDir, fileURLToPath(mediaUrl));
    return relative.split(path.sep).join('/');
  }
  return mediaUrl;
}

export function renderPreview(entries: readonly PreviewEntry[]): string {
  const jobs = entries.map(renderJob).join('\n');
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cross-post preview</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f4efe6;
      --ink: #1c1915;
      --muted: #5e564c;
      --line: #d9d0c3;
      --card: #fffdf8;
      --stamp: #b64024;
      --snap: #fffc00;
      --tiktok: #111111;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.45 Georgia, "Iowan Old Style", Palatino, serif;
    }
    header, main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 36px 0 8px; }
    .kicker {
      margin: 0 0 8px;
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--stamp);
    }
    h1 { margin: 0 0 8px; font-size: 34px; font-weight: 600; }
    header p, .job-meta, figcaption, .note { color: var(--muted); }
    .job {
      margin: 28px 0 40px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }
    h2 { margin: 16px 0 4px; font-size: 22px; }
    h3 {
      margin: 22px 0 10px;
      font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
    figure { margin: 0; }
    .standin {
      margin: 6px 0 0;
      font: 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      color: var(--muted);
    }
    .feed-card .standin, .carousel-card .standin { margin: 0; padding: 0 14px 12px; }
    .feed-card, .carousel-card {
      width: 280px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .feed-card img, .carousel-card img {
      display: block;
      width: 100%;
      aspect-ratio: 4 / 5;
      height: auto;
      object-fit: cover;
      background: #e7e0d4;
      border-radius: 11px 11px 0 0;
    }
    .feed-card figcaption, .carousel-card figcaption { padding: 12px 14px 14px; }
    .strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; }
    .carousel-card { width: 160px; flex: 0 0 auto; }
    .story-frame, .snap-frame, .tiktok-frame {
      position: relative;
      width: 180px;
      aspect-ratio: 9 / 16;
      height: 320px;
      border-radius: 18px;
      overflow: hidden;
      background: #211e1a;
    }
    .story-frame { box-shadow: 0 0 0 3px #fff, 0 0 0 6px #c4532a; }
    .snap-frame { box-shadow: 0 0 0 3px #fff, 0 0 0 6px var(--snap); }
    .tiktok-frame { width: 200px; height: 356px; box-shadow: 0 0 0 1px #000; }
    .story-frame img, .snap-frame img, .tiktok-frame img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .overlay {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 12px;
      color: white;
      font: 13px/1.3 ui-sans-serif, system-ui, sans-serif;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
    }
    .note { margin: 8px 0 0; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
    .request {
      margin-top: 16px;
      padding: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      background: var(--card);
      border: 1px solid var(--line);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <header>
    <p class="kicker">Dry run</p>
    <h1>Posts that would be published</h1>
    <p>Each picture is a local file from <code>./out</code>, labelled as a stand-in for the R2 URL that <code>Stager.stage</code> will return in a live run. Nothing has been sent.</p>
  </header>
  <main>
${jobs || '    <p>No jobs yet.</p>'}
  </main>
</body>
</html>
`;
}

export function writePreview(outDir: string, entries: readonly PreviewEntry[]): string {
  const file = path.join(outDir, 'preview.html');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, renderPreview(entries));
  return file;
}

function renderJob(entry: PreviewEntry): string {
  const sections: string[] = [];
  if (entry.targets.includes('ig_feed')) sections.push(renderFeed(entry));
  if (entry.targets.includes('ig_story'))
    sections.push(
      renderFrames(entry, 'Instagram Stories', 'story-frame', 'One story container per image.'),
    );
  if (entry.targets.includes('snap_story')) {
    sections.push(
      renderFrames(
        entry,
        'Snapchat Public Story',
        'snap-frame',
        'Caption kept for this preview. A Snapchat story does not take a caption, and each image is its own post.',
      ),
    );
  }
  if (entry.targets.includes('tiktok')) sections.push(renderTikTok(entry));
  return `    <article class="job">
      <h2>${escapeHtml(entry.caption || 'Untitled')}</h2>
      <p class="job-meta">Job ${escapeHtml(entry.jobId)} · messages ${escapeHtml(entry.messageIds.join(', '))}</p>
${sections.join('\n')}
${
  entry.requestNotes && entry.requestNotes.length > 0
    ? `      <h3>Blotato request</h3>\n      <pre class="request">${escapeHtml(entry.requestNotes.join('\n\n'))}</pre>`
    : ''
}
    </article>`;
}

function renderFeed(entry: PreviewEntry): string {
  if (entry.images.length <= 1) {
    const image = entry.images[0];
    return `      <section>
        <h3>Instagram feed</h3>
        <div class="row">
          <figure class="feed-card">
            ${image ? `<img src="${escapeHtml(image.src)}" alt="">` : ''}
            <figcaption>${escapeHtml(entry.caption)}</figcaption>
            <p class="standin">Local stand-in for an R2 URL · 4:5</p>
          </figure>
        </div>
      </section>`;
  }
  const blocks: string[] = [];
  for (let index = 0; index < entry.images.length; index += 10) {
    const slice = entry.images.slice(index, index + 10);
    if (slice.length === 1) {
      const image = slice[0];
      blocks.push(`        <p class="note">Separate feed post. A carousel needs at least two images.</p>
        <figure class="feed-card">
          ${image ? `<img src="${escapeHtml(image.src)}" alt="">` : ''}
          <figcaption>${escapeHtml(entry.caption)}</figcaption>
          <p class="standin">Local stand-in for an R2 URL · 4:5</p>
        </figure>`);
      continue;
    }
    const cards = slice
      .map(
        (image) => `          <figure class="carousel-card">
            <img src="${escapeHtml(image.src)}" alt="">
            <p class="standin">Local stand-in for an R2 URL</p>
          </figure>`,
      )
      .join('\n');
    blocks.push(`        <div class="strip">
${cards}
        </div>
        <p class="note">${escapeHtml(entry.caption)}</p>`);
  }
  return `      <section>
        <h3>Instagram carousel</h3>
${blocks.join('\n')}
      </section>`;
}

function renderFrames(
  entry: PreviewEntry,
  title: string,
  frameClass: string,
  note: string,
): string {
  const frames = entry.images
    .map(
      (image) => `          <figure>
            <div class="${frameClass}"><img src="${escapeHtml(image.src)}" alt=""></div>
            <p class="standin">Local stand-in for an R2 URL · 9:16</p>
          </figure>`,
    )
    .join('\n');
  return `      <section>
        <h3>${escapeHtml(title)}</h3>
        <div class="row">
${frames}
        </div>
        <p class="note">${escapeHtml(note)} ${escapeHtml(entry.caption)}</p>
      </section>`;
}

function renderTikTok(entry: PreviewEntry): string {
  const cover = entry.images[0];
  return `      <section>
        <h3>TikTok</h3>
        <div class="row">
          <figure>
            <div class="tiktok-frame">
              ${cover ? `<img src="${escapeHtml(cover.src)}" alt="">` : ''}
              <div class="overlay">${escapeHtml(entry.caption)}</div>
            </div>
            <p class="standin">Local stand-in for an R2 URL · 9:16 · ${entry.images.length} photo(s) · SELF_ONLY unless configured otherwise</p>
          </figure>
        </div>
      </section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
