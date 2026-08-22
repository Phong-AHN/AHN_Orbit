import { normalizeUnknownError, toAppError, type ProviderErrorKind } from '../errors.js';
import { YOUTUBE_UPLOAD_HOST } from './capabilities.js';

/**
 * Thin YouTube Data API client.
 *
 * Google's error shape is `{ error: { code, message, errors: [{ reason }] } }`,
 * and **`reason` carries the meaning the status does not**: a 403 is
 * `quotaExceeded` (the whole project, until midnight Pacific), `forbidden` (a
 * missing scope) or `uploadLimitExceeded` (this one channel, today) — three
 * different remedies behind one status code, and only one of them is anybody's
 * fault.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface YouTubeClientOptions {
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Overridable so tests can point the token endpoint somewhere local. */
  tokenUrl?: string;
  timeoutMs?: number;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Google's `reason` to our taxonomy.
 *
 * `quotaExceeded` and `uploadLimitExceeded` are both rate limits with very
 * different windows — the first resets at midnight Pacific for the whole
 * project, the second is per channel — but both mean "not now, and not because
 * of this video", which is what the engine needs to decide.
 */
const REASONS: Record<string, ProviderErrorKind> = {
  quotaExceeded: 'RATE_LIMIT',
  dailyLimitExceeded: 'RATE_LIMIT',
  rateLimitExceeded: 'RATE_LIMIT',
  uploadLimitExceeded: 'RATE_LIMIT',
  userRateLimitExceeded: 'RATE_LIMIT',
  authError: 'AUTHENTICATION',
  invalidCredentials: 'AUTHENTICATION',
  forbidden: 'PERMISSION',
  insufficientPermissions: 'PERMISSION',
  youtubeSignupRequired: 'PERMISSION',
  invalidVideoMetadata: 'VALIDATION',
  invalidTitle: 'VALIDATION',
  invalidDescription: 'VALIDATION',
  invalidFilename: 'MEDIA',
  mediaBodyRequired: 'MEDIA',
  failedPrecondition: 'VALIDATION',
  backendError: 'UNAVAILABLE',
  internalError: 'UNAVAILABLE',
};

/** What a person can do about it, in their words rather than Google's. */
const REASON_MESSAGE: Record<string, string> = {
  quotaExceeded:
    'This deployment has used its YouTube API quota for the day. It resets at midnight Pacific time, and an administrator can request more.',
  dailyLimitExceeded:
    'This deployment has used its YouTube API quota for the day. It resets at midnight Pacific time.',
  uploadLimitExceeded:
    'This channel has reached its upload limit for today. YouTube lifts it automatically.',
  youtubeSignupRequired:
    'That Google account has no YouTube channel. Create one on YouTube first, then reconnect.',
};

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 404 || status === 400) return 'VALIDATION';
  return 'UNAVAILABLE';
}

export class YouTubeClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: YouTubeClientOptions) {
    this.baseUrl = options.baseUrl ?? YOUTUBE_UPLOAD_HOST;
    this.tokenUrl = options.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get apiVersion(): string {
    return this.options.apiVersion;
  }

  get clientId(): string {
    return this.options.clientId;
  }

  get clientSecret(): string {
    return this.options.clientSecret;
  }

  async request<T>(input: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT';
    accessToken?: string | undefined;
    params?: Record<string, string | number | boolean | undefined> | undefined;
    json?: Record<string, unknown> | undefined;
    headers?: Record<string, string> | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ body: T; location?: string | undefined; status: number }> {
    const url = new URL(`${this.baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (input.accessToken) headers.authorization = `Bearer ${input.accessToken}`;

    let body: string | undefined;
    if (input.json) {
      body = JSON.stringify(input.json);
      headers['content-type'] = 'application/json';
    }

    const response = await this.send(url.toString(), {
      method: input.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as T & GoogleErrorBody) : ({} as T);

    if (!response.ok) throw this.toError(parsed as GoogleErrorBody, response.status);

    return {
      body: parsed,
      // A resumable session answers 200 with the session URL in `Location` and
      // nothing useful in the body.
      ...(response.headers.get('location')
        ? { location: response.headers.get('location') as string }
        : {}),
      status: response.status,
    };
  }

  /** Send the whole file to a resumable session URL. */
  async uploadTo(input: {
    sessionUrl: string;
    body: Uint8Array;
    mimeType: string;
    signal?: AbortSignal | undefined;
  }): Promise<Record<string, unknown>> {
    const response = await this.send(input.sessionUrl, {
      method: 'PUT',
      headers: {
        'content-type': input.mimeType,
        'content-length': String(input.body.byteLength),
      },
      body: input.body,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as GoogleErrorBody & Record<string, unknown>) : {};

    if (!response.ok) throw this.toError(parsed, response.status);

    return parsed;
  }

  /** Token exchange and refresh. Form-encoded, and on a different host. */
  async token(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.send(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const description = parsed['error_description'];

      throw toAppError('YOUTUBE', {
        kind: kindForStatus(response.status),
        message: `Google OAuth refused: ${String(parsed['error'] ?? response.status)}${
          description ? ` — ${String(description)}` : ''
        }`,
        ...(parsed['error'] ? { providerCode: String(parsed['error']) } : {}),
        httpStatus: response.status,
      });
    }

    return parsed;
  }

  private toError(body: GoogleErrorBody, status: number) {
    const reason = body.error?.errors?.[0]?.reason;
    const kind = (reason ? REASONS[reason] : undefined) ?? kindForStatus(status);
    const explained = reason ? REASON_MESSAGE[reason] : undefined;

    return toAppError('YOUTUBE', {
      kind,
      message: body.error?.message ?? `YouTube returned HTTP ${status}`,
      ...(reason ? { providerCode: reason } : {}),
      httpStatus: status,
      // The daily quota resets at midnight Pacific. An hour is a sensible
      // interval to look again, not a claim about when it lifts.
      ...(kind === 'RATE_LIMIT' ? { retryAfterSeconds: 3600 } : {}),
      ...(explained ? { userMessage: explained } : {}),
      meta: {
        ...(reason ? { reason } : {}),
        /**
         * `quotaExceeded` is about the **project** and every channel on it, not
         * about this connection. Marked so the engine records the failure and
         * leaves the account alone — demoting it would tell an account manager
         * to reconnect a channel that is working perfectly (D-085).
         */
        ...(reason === 'quotaExceeded' || reason === 'dailyLimitExceeded'
          ? { clientStanding: true }
          : {}),
      },
    });
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const caller = init.signal;
    if (caller) {
      if (caller.aborted) controller.abort();
      else caller.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      // An abort leaves the outcome unknown: TIMEOUT, so the engine reconciles
      // rather than retries (D-027).
      throw normalizeUnknownError('YOUTUBE', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'YouTube returned a non-JSON response' } };
  }
}
