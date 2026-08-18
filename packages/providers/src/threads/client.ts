import { normalizeUnknownError } from '../errors.js';
import { normalizeGraphError, type GraphErrorBody } from '../facebook/errors.js';
import { THREADS_API_HOST } from './capabilities.js';

/**
 * Thin Threads API client.
 *
 * Threads speaks the Graph dialect — a JSON body with an `error` object of the
 * same shape — so error normalization is reused from the Facebook adapter
 * rather than copied. What is *not* shared is the host, the app credentials or
 * the version segment, which is why this is its own client rather than a
 * `GraphClient` with a different `baseUrl`: making one class serve both would
 * put a Threads conditional inside the Facebook client, and the whole point of
 * the adapter layer is that no such conditional exists.
 *
 * Two shapes to keep straight:
 *
 *   • **OAuth calls carry no version segment** and live at the host root
 *     (`/oauth/access_token`, `/access_token`, `/refresh_access_token`).
 *   • **Everything else is versioned** (`/v1.0/{user-id}/threads`).
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ThreadsClientOptions {
  /** The **Threads** app id. A Threads app issues two pairs; this is not the other one. */
  appId: string;
  appSecret: string;
  apiVersion: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ThreadsRequest {
  path: string;
  method?: 'GET' | 'POST';
  accessToken?: string | undefined;
  params?: Record<string, string | number | boolean | undefined> | undefined;
  form?: Record<string, string | number | boolean | undefined> | undefined;
  /** True for `/oauth/*` and the token endpoints, which sit outside the version. */
  unversioned?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export class ThreadsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: ThreadsClientOptions) {
    this.baseUrl = options.baseUrl ?? THREADS_API_HOST;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get apiVersion(): string {
    return this.options.apiVersion;
  }

  get appId(): string {
    return this.options.appId;
  }

  get appSecret(): string {
    return this.options.appSecret;
  }

  async request<T>(request: ThreadsRequest): Promise<T> {
    const prefix = request.unversioned ? '' : `/${this.options.apiVersion}`;
    const url = new URL(`${this.baseUrl}${prefix}${request.path}`);

    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (request.accessToken) {
      // Header rather than query string: tokens in URLs reach access logs,
      // proxies and error reports.
      headers.authorization = `Bearer ${request.accessToken}`;
    }

    let body: string | undefined;
    if (request.form) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) {
        if (value !== undefined) form.set(key, String(value));
      }
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort leaves the outcome unknown, so this classifies as TIMEOUT and
      // the engine reconciles rather than retries (D-027).
      throw normalizeUnknownError('THREADS', error);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = text ? (safeJson(text) as GraphErrorBody & T) : ({} as T);

    if (!response.ok || (parsed as GraphErrorBody).error) {
      // Reused from the Facebook adapter: Threads returns the same error shape,
      // and a second copy of that mapping would drift.
      const failure = normalizeGraphError(
        parsed as GraphErrorBody,
        response.status,
        response.headers,
      );
      // The platform on the error has to be Threads, or a reader chases a
      // Facebook Page that was never involved.
      throw retagged(failure);
    }

    return parsed;
  }
}

/**
 * Re-label a Graph failure as Threads.
 *
 * The classification is right — same codes, same meanings — but the platform
 * tag would say FACEBOOK, and every downstream reader (the log, the attempt
 * row, the publishing page) would name the wrong platform. Rewriting the field
 * is cheaper than duplicating the code map to change one string.
 */
function retagged<E extends { context?: Record<string, unknown> }>(error: E): E {
  if (error.context && typeof error.context === 'object') {
    error.context['platform'] = 'THREADS';
  }
  return error;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'Threads returned a non-JSON response' } };
  }
}
