import { normalizeUnknownError } from '../errors.js';
import { normalizeGraphError, type GraphErrorBody } from './errors.js';

/**
 * Thin Graph API client.
 *
 * `fetch` is injected, which is what lets the entire adapter — OAuth, page
 * discovery, health probing, publishing, reconciliation — be tested against
 * recorded Meta responses with no network and no App Review.
 *
 * Two rules hold here:
 *   • the app secret never appears in a URL that could be logged;
 *   • every failure leaves as a taxonomy error, never a raw Graph shape.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  appId: string;
  appSecret: string;
  apiVersion: string;
  fetchImpl?: FetchLike;
  /** Overridable so tests can assert the URL without hitting a real host. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GraphRequest {
  path: string;
  /** Query parameters. `access_token` is passed as a header where possible. */
  params?: Record<string, string | number | boolean | undefined>;
  method?: 'GET' | 'POST' | 'DELETE';
  accessToken?: string;
  /** Form body for POST. */
  form?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal | undefined;
}

export class GraphClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: GraphClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://graph.facebook.com';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get apiVersion(): string {
    return this.options.apiVersion;
  }

  /** App-level token for endpoints that authenticate as the app itself. */
  get appAccessToken(): string {
    return `${this.options.appId}|${this.options.appSecret}`;
  }

  async request<T>(request: GraphRequest): Promise<T> {
    const url = new URL(`${this.baseUrl}/${this.options.apiVersion}${request.path}`);

    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (request.accessToken) {
      // Header rather than query string: access tokens in URLs end up in
      // access logs, proxies and error reports.
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
    if (request.signal) {
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort here means the outcome is unknown — normalizeUnknownError
      // classifies it as TIMEOUT so the engine reconciles rather than retries.
      throw normalizeUnknownError('FACEBOOK', error);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = text ? (safeJson(text) as GraphErrorBody & T) : ({} as T);

    if (!response.ok || (parsed as GraphErrorBody).error) {
      throw normalizeGraphError(parsed as GraphErrorBody, response.status, response.headers);
    }

    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'Graph returned a non-JSON response' } };
  }
}
