import { normalizeUnknownError, toAppError, type ProviderErrorKind } from '../errors.js';
import { PINTEREST_API_HOST } from './capabilities.js';

/**
 * Thin Pinterest v5 client.
 *
 * Three things about Pinterest that are easy to get wrong:
 *
 *   • **The token endpoint uses HTTP Basic**, not a `client_secret` form
 *     field. Sending the secret in the body returns 401 with no hint that the
 *     header was what it wanted.
 *   • **The media upload does not go to Pinterest.** `POST /v5/media` hands
 *     back an S3 URL and a bag of form fields that must be sent *before* the
 *     file part and *without* an Authorization header — attaching the bearer
 *     token makes S3 refuse the whole request.
 *   • **Errors are `{ code, message }`** where `code` is a Pinterest-specific
 *     integer, not an HTTP status. The status carries most of the meaning; the
 *     code is recorded for support rather than branched on.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PinterestClientOptions {
  clientId: string;
  clientSecret: string;
  /** The v5 in the path. Recorded on every analytics snapshot. */
  apiVersion: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface PinterestRequest {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  accessToken?: string | undefined;
  params?: Record<string, string | number | boolean | undefined> | undefined;
  json?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
}

interface PinterestErrorBody {
  code?: number;
  message?: string;
  message_detail?: string;
}

/**
 * HTTP status to taxonomy.
 *
 * 401 is authentication and 403 is permission, and Pinterest keeps them apart
 * properly: a 403 here really does mean a missing scope or a business-account
 * requirement, which is a different conversation from "reconnect".
 */
function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UNAVAILABLE';
  if (status === 400 || status === 404 || status === 422) return 'VALIDATION';
  return 'UNAVAILABLE';
}

export class PinterestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: PinterestClientOptions) {
    this.baseUrl = options.baseUrl ?? PINTEREST_API_HOST;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
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

  async request<T>(request: PinterestRequest): Promise<{ body: T; status: number }> {
    const url = new URL(`${this.baseUrl}/v5${request.path}`);
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (request.accessToken) headers.authorization = `Bearer ${request.accessToken}`;

    let body: string | undefined;
    if (request.json) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json';
    }

    const response = await this.send(url.toString(), {
      method: request.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as T & PinterestErrorBody) : ({} as T);

    if (!response.ok) throw this.toError(parsed as PinterestErrorBody, response);

    return { body: parsed, status: response.status };
  }

  /**
   * OAuth token exchange and refresh.
   *
   * Basic auth, form body, and on the same host as everything else — Pinterest
   * puts `/v5/oauth/token` inside the versioned API rather than on a separate
   * identity host the way Google and Meta do.
   */
  async token(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await this.send(`${this.baseUrl}/v5/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      throw toAppError('PINTEREST', {
        kind: kindForStatus(response.status),
        message: `Pinterest OAuth refused: ${String(
          parsed['message'] ?? parsed['error'] ?? response.status,
        )}`,
        httpStatus: response.status,
      });
    }

    return parsed;
  }

  /**
   * Push the file to the storage bucket Pinterest nominated.
   *
   * `upload_parameters` must be written **before** the file part — the bucket
   * streams the request and applies the policy fields as it reads them, so a
   * file that arrives first is rejected before its policy is known. And no
   * bearer token: this host is not Pinterest, and an Authorization header it
   * did not expect makes it refuse the upload outright.
   */
  async uploadMedia(input: {
    uploadUrl: string;
    parameters: Record<string, string>;
    body: Uint8Array;
    fileName: string;
    mimeType: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(input.parameters)) form.append(key, value);
    // Copied into a fresh buffer: a Uint8Array that is a *view* onto a larger
    // pooled buffer would otherwise upload the whole pool.
    const bytes = new Uint8Array(input.body.byteLength);
    bytes.set(input.body);
    form.append('file', new Blob([bytes.buffer], { type: input.mimeType }), input.fileName);

    const response = await this.send(input.uploadUrl, {
      method: 'POST',
      body: form,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!response.ok) {
      // The bucket answers in XML, so there is nothing structured to read. The
      // status is the whole message.
      throw toAppError('PINTEREST', {
        kind: response.status >= 500 ? 'UNAVAILABLE' : 'MEDIA',
        message: `The storage bucket Pinterest nominated refused the upload (HTTP ${response.status})`,
        httpStatus: response.status,
        userMessage: 'Pinterest would not accept this file. Try uploading it again.',
      });
    }
  }

  private toError(body: PinterestErrorBody, response: Response) {
    const retryAfter = Number(response.headers.get('retry-after'));

    return toAppError('PINTEREST', {
      kind: kindForStatus(response.status),
      message: body.message ?? `Pinterest returned HTTP ${response.status}`,
      ...(body.code !== undefined ? { providerCode: body.code } : {}),
      httpStatus: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      meta: {
        ...(body.code !== undefined ? { pinterestCode: body.code } : {}),
        /**
         * A 429 is the account's own daily allowance, not a broken connection.
         * Marked so the engine records the failure and leaves the account
         * ACTIVE — demoting it would send somebody to reconnect an account
         * that is working (D-085).
         */
        ...(response.status === 429 ? { clientStanding: true } : {}),
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
      throw normalizeUnknownError('PINTEREST', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: 'Pinterest returned a non-JSON response' };
  }
}
