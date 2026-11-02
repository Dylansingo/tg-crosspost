import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare the webhook header with the configured secret.
 * Both sides are hashed so timingSafeEqual always sees equal lengths.
 */
export function webhookSecretMatches(provided: string | undefined, expected: string): boolean {
  const providedHash = createHash('sha256')
    .update(typeof provided === 'string' ? provided : '', 'utf8')
    .digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  const equal = timingSafeEqual(providedHash, expectedHash);
  return typeof provided === 'string' && provided.length > 0 && equal;
}
