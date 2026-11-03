import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Stager } from '../media/index.js';

/**
 * Offline stand-in for the Media Engineer. Writes the buffer under `directory`
 * and returns a file URL. Live publishing refuses that scheme.
 */
export function createLocalStager(directory = './out'): Stager {
  return {
    async stage(buf: Buffer, name: string): Promise<string> {
      const fileName = `${safeSegment(name)}.${imageExtension(buf)}`;
      const full = path.resolve(directory, fileName);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, buf);
      return pathToFileURL(full).href;
    },
  };
}

function imageExtension(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return 'bin';
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}
