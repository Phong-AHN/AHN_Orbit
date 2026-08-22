import { normalizeUnknownError, toAppError, type ProviderErrorKind } from '../errors.js';
import { LINKEDIN_API_HOST } from './capabilities.js';

/**
 * Thin LinkedIn REST client.
 *
 * Three things differ from every other client here, and each is a trap:
 *
 *   • **Two mandatory headers on every call** — `LinkedIn-Version: YYYYMM` and
 *     `X-Restli-Protocol-Version: 2.0.0`. Omitting either yields a 400 that
 *     names neither.
 *   • **Some responses put the answer in a header.** Creating a post returns
 *     201 with an empty body and the new URN in `x-restli-id`. Reading the body
 *     for it finds nothing and looks like a platform fault.
 *   • **Errors are flat JSON**, `{ message, status, serviceErrorCode }`, with
 *     the machine-readable part in a `code` field that is not always present —
 *     so the HTTP status carries most of the meaning.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LinkedInClientOptions {
  clientId: string;
  clientSecret: string;
  /** `YYYYMM`. Pinned, because LinkedIn sunsets a version about a year on. */
  apiVersion: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface LinkedInRequest {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  accessToken?: string | undefined;
  params?: Record<string, string | number | undefined> | undefined;
  json?: Record<string, unknown> | undefined;
  /** `X-RestLi-Method`, which LinkedIn requires on batch, finder and delete calls. */
  restliMethod?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface LinkedInResponse<T> {
  body: T;
  /** The new entity's URN, for calls that answer in a header rather than a body. */
  createdId?: string | undefined;
  status: number;
}

interface LinkedInErrorBody {
  message?: string;
  status?: number;
  code?: string;
  serviceErrorCode?: number;
}

/**
 * HTTP status to taxonomy, from LinkedIn's own documented error table.
 *
 * 409 is the interesting one: LinkedIn calls it a write conflict and says to
 * retry, so it is UNAVAILABLE rather than a validation failure — treating it as
 * permanent would throw away a post over a momentary collision.
 */
function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 409 || status >= 500) return 'UNAVAILABLE';
  if (status === 404 || status === 422 || status === 400) return 'VALIDATION';
  return 'UNAVAILABLE';
}

export class LinkedInClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: LinkedInClientOptions) {
    this.baseUrl = options.baseUrl ?? LINKEDIN_API_HOST;
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

  async request<T>(request: LinkedInRequest): Promise<LinkedInResponse<T>> {
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      // Both are mandatory on every versioned call. Omitting either produces a
      // 400 that names neither of them.
      'linkedin-version': this.options.apiVersion,
      'x-restli-protocol-version': '2.0.0',
    };

    if (request.accessToken) headers.authorization = `Bearer ${request.accessToken}`;
    if (request.restliMethod) headers['x-restli-method'] = request.restliMethod;

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
    const parsed = text ? (safeJson(text) as T & LinkedInErrorBody) : ({} as T);

    if (!response.ok) {
      const failure = parsed as LinkedInErrorBody;

      throw toAppError('LINKEDIN', {
        kind: kindForStatus(response.status),
        message: failure.message ?? `LinkedIn returned HTTP ${response.status}`,
        ...(failure.code ? { providerCode: failure.code } : {}),
        httpStatus: response.status,
        meta: {
          ...(failure.serviceErrorCode !== undefined
            ? { serviceErrorCode: failure.serviceErrorCode }
            : {}),
        },
      });
    }

    return {
      body: parsed,
      // Creating a post answers 201 with an empty body; the URN is here.
      ...(response.headers.get('x-restli-id')
        ? { createdId: response.headers.get('x-restli-id') as string }
        : {}),
      status: response.status,
    };
  }

  /**
   * Exchange or refresh a token.
   *
   * Form-encoded and unauthenticated, on `www.linkedin.com` rather than the API
   * host — so it does not go through `request()`, which would attach the
   * version headers this endpoint does not want.
   */
  async token(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const form = new URLSearchParams(fields);

    const response = await this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      throw toAppError('LINKEDIN', {
        kind: kindForStatus(response.status),
        message: `LinkedIn OAuth refused: ${String(parsed['error'] ?? response.status)}${
          parsed['error_description'] ? ` — ${String(parsed['error_description'])}` : ''
        }`,
        ...(parsed['error'] ? { providerCode: String(parsed['error']) } : {}),
        httpStatus: response.status,
      });
    }

    return parsed;
  }

  /**
   * Send an image's bytes to the upload URL `initializeUpload` issued.
   *
   * A different host, no version headers, and the body is bytes. LinkedIn
   * accepts either PUT or POST here; PUT is used because the upload is
   * idempotent against that one-shot URL.
   */
  async upload(input: {
    uploadUrl: string;
    body: Uint8Array;
    accessToken: string;
    mimeType: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const response = await this.send(input.uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': input.mimeType,
      },
      body: input.body,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (response.ok) return;

    const text = await response.text().catch(() => '');

    throw toAppError('LINKEDIN', {
      // A refused upload is about the file, not the moment.
      kind: response.status >= 500 ? 'UNAVAILABLE' : 'MEDIA',
      message: `LinkedIn refused the image upload (HTTP ${response.status}): ${text.slice(0, 200)}`,
      httpStatus: response.status,
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
      throw normalizeUnknownError('LINKEDIN', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: 'LinkedIn returned a non-JSON response' };
  }
}
