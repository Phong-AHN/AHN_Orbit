/**
 * Secret redaction (SRS §33: "never log secrets or tokens").
 *
 * Enforced by code rather than by discipline: everything logged passes through
 * here, so forgetting to strip a token is not a thing a developer can do.
 *
 * Matching is by key *name*, recursively, because the shapes that carry secrets
 * are the ones nobody anticipated — a provider error payload, a webhook body, a
 * request header bag.
 */

export const REDACTED = '[redacted]';

/**
 * A key is redacted when its name contains any of these, case-insensitively.
 * Substring matching is intentional: it catches `accessToken`,
 * `refresh_token_ciphertext`, `x-hub-signature`, and whatever the next provider
 * invents, without a new entry each time.
 */
const SENSITIVE_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'auth_header',
  'cookie',
  'session',
  'credential',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'signature',
  'ciphertext',
  'encryptionkey',
  'client_secret',
  'clientsecret',
  'set-cookie',
] as const;

/** Keys that merely *look* sensitive but are safe and useful in a log line. */
const ALLOWLIST = new Set([
  'tokenversion',
  'keyversion',
  'hastoken',
  'tokenexpiresat',
  'sessionid',
  'correlationid',
  'signaturevalid',
  'tokencount',
  'inputtokens',
  'outputtokens',
]);

export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, '');
  if (ALLOWLIST.has(normalised)) return false;
  return SENSITIVE_KEY_PARTS.some((part) => normalised.includes(part.replace(/[-_]/g, '')));
}

const MAX_DEPTH = 8;

/**
 * Deep-redact a value. Returns a new structure; the input is never mutated.
 * Cycles are tolerated — a log call must not be able to hang the process.
 */
export function redact<T>(value: T): T {
  return redactInner(value, 0, new WeakSet()) as T;
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(redactInner({ ...value }, depth + 1, seen) as Record<string, unknown>),
    };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength}b]`;

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactInner(item, depth + 1, seen);
  }
  return out;
}

/**
 * Strip secrets from a URL: query parameters with sensitive names, and any
 * userinfo in the authority. OAuth callbacks and presigned S3 URLs both carry
 * credentials in the query string.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key) || key === 'code' || key === 'state' || key.startsWith('X-Amz-')) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}
