import { describe, expect, it } from 'vitest';
import { webhookSecretMatches } from '../src/ingest/secret.js';

describe('webhook secret', () => {
  it('matches equal secrets and rejects missing, empty, and different values', () => {
    expect(webhookSecretMatches('alpha', 'alpha')).toBe(true);
    expect(webhookSecretMatches('alpha', 'beta')).toBe(false);
    expect(webhookSecretMatches('a', 'aaaa')).toBe(false);
    expect(webhookSecretMatches(undefined, 'alpha')).toBe(false);
    expect(webhookSecretMatches('', 'alpha')).toBe(false);
  });
});
