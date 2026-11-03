import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when this module is the process entrypoint (node, tsx, or a built file). */
export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(metaUrl) === path.resolve(entry);
}
