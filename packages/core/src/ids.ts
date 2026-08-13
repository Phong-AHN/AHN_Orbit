import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUIDv7 — time-ordered, so it indexes like a sequence without leaking row
 * counts the way a serial primary key does (docs/DATABASE.md §3).
 *
 * Layout (RFC 9562): 48-bit big-endian Unix milliseconds, 4-bit version, 12
 * bits of randomness, 2-bit variant, 62 bits of randomness.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Milliseconds encoded in a UUIDv7, or undefined if it is not a v7. */
export function uuidv7Timestamp(id: string): number | undefined {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || hex[12] !== '7') return undefined;
  return Number.parseInt(hex.slice(0, 12), 16);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Correlation id threaded through browser → API → queue → worker → provider so
 * one publish can be traced end to end in a single log query (SRS §33).
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/** URL-safe opaque token, used for invitations and OAuth state nonces. */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
