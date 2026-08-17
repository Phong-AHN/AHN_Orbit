import { normalizeUnknownError, toAppError } from '../errors.js';
import { isTikTokFailure, normalizeTikTokError, type TikTokErrorBody } from './errors.js';

/**
 * Thin TikTok Open API client.
 *
 * `fetch` is injected for the same reason the Graph client injects it: the
 * whole adapter — OAuth, discovery, chunked upload, status polling — has to be
 * testable with no network and no approved TikTok app.
 *
 * Three things differ from the Meta client and each is a trap:
 *
 *   • **Requests are JSON, not form-encoded** — except the OAuth token
 *     endpoint, which is `application/x-www-form-urlencoded`. Getting that
 *     backwards produces `invalid_param` with no hint which param.
 *   • **A 200 is not success.** Every response carries an `error` object, and
 *     `error.code === "ok"` is what success looks like. The body is read before
 *     the status, always.
 *   • **There is no version segment in the path.** `v2` is part of the path
 *     itself, so `apiVersion` here is a label carried onto analytics snapshots
 *     rather than something that shapes a URL.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TikTokClientOptions {
  clientKey: string;
  clientSecret: string;
  /** Recorded on analytics snapshots so a metric change is traceable. */
  apiVersion: string;
  fetchImpl?: FetchLike;
  /** Overridable so tests can assert URLs without a real host. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface TikTokRequest {
  path: string;
  method?: 'GET' | 'POST';
  accessToken?: string | undefined;
  /** JSON body. Mutually exclusive with `form`. */
  json?: Record<string, unknown> | undefined;
  /** Form body — the OAuth token endpoint only. */
  form?: Record<string, string | undefined> | undefined;
  params?: Record<string, string | number | undefined> | undefined;
  signal?: AbortSignal | undefined;
}

export class TikTokClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: TikTokClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://open.tiktokapis.com';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get apiVersion(): string {
    return this.options.apiVersion;
  }

  get clientKey(): string {
    return this.options.clientKey;
  }

  get clientSecret(): string {
    return this.options.clientSecret;
  }

  async request<T>(request: TikTokRequest): Promise<T> {
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (request.accessToken) {
      // Header, never a query string: tokens in URLs reach access logs,
      // proxies and error reports.
      headers.authorization = `Bearer ${request.accessToken}`;
    }

    let body: string | undefined;
    if (request.json) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json; charset=UTF-8';
    } else if (request.form) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) {
        if (value !== undefined) form.set(key, value);
      }
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const response = await this.send(url.toString(), {
      method: request.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as TikTokErrorBody & { data?: T }) : {};

    // Body before status. A 200 with `error.code: "spam_risk_too_many_posts"`
    // is a failure, and reading `response.ok` first would miss it entirely.
    if (isTikTokFailure(parsed, response.status)) {
      throw normalizeTikTokError(parsed, response.status, response.headers);
    }

    // Every TikTok payload is wrapped in `data`. Returning the envelope would
    // push that detail into every caller.
    return (parsed.data ?? {}) as T;
  }

  /**
   * Send one chunk of a file to the upload URL issued by the init call.
   *
   * Not `request()`: the host is different, the body is bytes, there is no
   * `Authorization` header — the upload token lives in the URL TikTok gave us —
   * and success is a bare 206 or 201 with no JSON at all.
   */
  async uploadChunk(input: {
    uploadUrl: string;
    body: Uint8Array;
    mimeType: string;
    firstByte: number;
    lastByte: number;
    totalBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const response = await this.send(input.uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': input.mimeType,
        'content-length': String(input.body.byteLength),
        'content-range': `bytes ${input.firstByte}-${input.lastByte}/${input.totalBytes}`,
      },
      body: input.body,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // 206 for every chunk but the last, 201 when the final chunk completes it.
    if (response.status === 206 || response.status === 201 || response.status === 200) return;

    const text = await response.text().catch(() => '');

    throw toAppError('TIKTOK', {
      // A rejected chunk is about the file, not the moment. Retrying the whole
      // publish would re-upload every byte to be refused identically.
      kind: response.status >= 500 ? 'UNAVAILABLE' : 'MEDIA',
      message: `Chunk upload failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
      httpStatus: response.status,
      meta: { firstByte: input.firstByte, lastByte: input.lastByte },
    });
  }

  /** Shared transport: one timeout, one abort path, one error taxonomy. */
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
      // An abort leaves the outcome genuinely unknown, so this must classify as
      // TIMEOUT and let the engine reconcile rather than retry (D-027).
      throw normalizeUnknownError('TIKTOK', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'internal_error', message: 'TikTok returned a non-JSON response' } };
  }
}
