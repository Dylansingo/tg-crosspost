export interface OutboundRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpRuntime {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  /** Total attempts, including the first call. */
  maxAttempts: number;
  pollTimeoutMs: number;
  pollInitialDelayMs: number;
  pollMaxDelayMs: number;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

const RETRY_BASE_MS = 200;
const RETRY_CAP_MS = 8_000;

/**
 * Delay before a retry. `attempt` is 0 for the first retry.
 * Full jitter lands between 50% and 100% of the exponential delay.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  const ratio = 0.5 + 0.5 * clamp01(random());
  return Math.round(exponential * ratio);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/access_token=[^&\s]+/gi, 'access_token=<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, method: string, url: string, body: string) {
    super(`${method} ${redactSecrets(url)} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function createHttpRuntime(overrides: Partial<HttpRuntime> = {}): HttpRuntime {
  return {
    fetch: overrides.fetch ?? globalThis.fetch,
    sleep: overrides.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? (() => Date.now()),
    random: overrides.random ?? Math.random,
    maxAttempts: overrides.maxAttempts ?? 4,
    pollTimeoutMs: overrides.pollTimeoutMs ?? 60_000,
    pollInitialDelayMs: overrides.pollInitialDelayMs ?? 500,
    pollMaxDelayMs: overrides.pollMaxDelayMs ?? 8_000,
  };
}

/**
 * Send one request. Retries 429, 5xx, and network failures with exponential
 * backoff and jitter. Other 4xx responses fail on the first attempt.
 */
export async function send(request: OutboundRequest, http: HttpRuntime): Promise<HttpResult> {
  let attempt = 0;
  while (true) {
    try {
      const response = await http.fetch(request.url, {
        method: request.method,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await response.text();
      if (shouldRetryStatus(response.status) && attempt + 1 < http.maxAttempts) {
        await http.sleep(retryDelayMs(attempt, http.random));
        attempt += 1;
        continue;
      }
      const body = parseBody(text);
      if (response.status >= 400) {
        throw new HttpError(response.status, request.method, request.url, text);
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (attempt + 1 >= http.maxAttempts) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${request.method} ${redactSecrets(request.url)} failed: ${redactSecrets(detail)}`,
          { cause: error },
        );
      }
      await http.sleep(retryDelayMs(attempt, http.random));
      attempt += 1;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
