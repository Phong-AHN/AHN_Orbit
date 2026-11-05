import { clock } from '@orbit/core';
import { normalizeUnknownError, toAppError, type ProviderErrorKind } from '../errors.js';
import { X_API_HOST } from './capabilities.js';

/**
 * Thin X API v2 client.
 *
 * Three traps, each of which costs an account if it is missed:
 *
 *   • **403 is not one thing.** X answers a duplicate post, a video too long
 *     for this account, and an app that is not enrolled for the endpoint all
 *     with 403. Mapped blindly to PERMISSION, a duplicate tweet would demote
 *     a perfectly good account and send somebody to reconnect it — so the
 *     body is read before the status is trusted.
 *   • **Errors come in two shapes**: an RFC 7807 problem (`title`, `detail`,
 *     `type`) for a refused request, and `{ data, errors: [...] }` with a 200
 *     for a lookup that partly failed. The second is read by the caller.
 *   • **The token endpoint wants HTTP Basic**, built from the client id and
 *     secret, and refuses a confidential client that sends them in the body.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface XClientOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface XRequest {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  accessToken?: string | undefined;
  params?: Record<string, string | number | undefined> | undefined;
  json?: Record<string, unknown> | undefined;
  /** Multipart body, for media chunks. Mutually exclusive with `json`. */
  form?: FormData | undefined;
  signal?: AbortSignal | undefined;
}

/** An RFC 7807 problem, or one entry of a partial-failure `errors` array. */
export interface XProblem {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  reason?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

interface XErrorBody extends XProblem {
  errors?: XProblem[];
}

/**
 * A refusal of **this app**, not of the connection.
 *
 * `client-forbidden` is an app that is not enrolled for the endpoint (no
 * project, wrong access level); `usage-capped` and 402 are a billing account
 * out of credit. Reconnecting fixes none of them — the remedy is in the X
 * developer console, held by a different person.
 */
function clientStanding(status: number, body: XErrorBody): string | undefined {
  if (isBillingRefusal(status, body)) {
    return 'X refused the request on billing grounds: the X API credit balance is empty, a spending limit was reached, or the app is not attached to the pay-per-use package. An administrator needs to check Billing in console.x.com; reconnecting will not help.';
  }
  if (/client-forbidden/i.test(body.type ?? '') || body.reason === 'client-not-enrolled') {
    return 'X refused Social Square’s app access to this endpoint. An administrator needs to check that the app is in the Production environment of the pay-per-use package in console.x.com; reconnecting will not help.';
  }
  return undefined;
}

/**
 * X's two billing refusals.
 *
 * A 402 (`CreditsDepleted`) is an empty or negative balance; a 429 of type
 * `usage-capped` is a spending limit or usage cap. Neither clears by waiting,
 * so neither is a rate limit: retrying spends attempts and changes nothing
 * until somebody tops up, after which a person retries the post.
 */
function isBillingRefusal(status: number, body: XErrorBody): boolean {
  const marker = `${body.type ?? ''} ${body.title ?? ''}`;
  return status === 402 || /usage-capped|credits/i.test(marker);
}

function kindForStatus(status: number, body: XErrorBody): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (isBillingRefusal(status, body)) return 'PERMISSION';
  if (status === 403) {
    const detail = `${body.detail ?? ''} ${body.title ?? ''}`;
    // The post is the problem, not the account.
    if (/duplicate/i.test(detail)) return 'VALIDATION';
    if (/video|media|duration/i.test(detail)) return 'MEDIA';
    return 'PERMISSION';
  }
  if (status === 429) return 'RATE_LIMIT';
  if (status === 413 || status === 415) return 'MEDIA';
  if (status >= 500) return 'UNAVAILABLE';
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'VALIDATION';
  return 'UNAVAILABLE';
}

export class XClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: XClientOptions) {
    this.baseUrl = options.baseUrl ?? X_API_HOST;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get clientId(): string {
    return this.options.clientId;
  }

  async request<T>(request: XRequest): Promise<{ body: T; status: number }> {
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (request.accessToken) headers.authorization = `Bearer ${request.accessToken}`;

    let body: string | FormData | undefined;
    if (request.json) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json';
    } else if (request.form) {
      // No content-type: fetch writes the multipart boundary itself, and one
      // set by hand would lack it.
      body = request.form;
    }

    const response = await this.send(url.toString(), {
      method: request.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as T & XErrorBody) : ({} as T);

    if (!response.ok) throw this.toError(parsed as XErrorBody, response, request);

    return { body: parsed, status: response.status };
  }

  /**
   * The token endpoint: exchange, refresh and revoke.
   *
   * Form-encoded with HTTP Basic, which is how X authenticates a confidential
   * client. Sending the secret in the body instead is refused.
   */
  async oauth(path: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const basic = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');

    const response = await this.send(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });

    const text = await response.text();
    const parsed = text ? (safeJson(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = String(parsed['error'] ?? response.status);
      throw toAppError('X', {
        // A refresh token that has already been used, or revoked, is a
        // connection a person has to make again.
        kind:
          code === 'invalid_grant' || code === 'invalid_request' || response.status === 401
            ? 'AUTHENTICATION'
            : kindForStatus(response.status, parsed as XErrorBody),
        message: `X OAuth refused: ${code}${
          parsed['error_description'] ? ` — ${String(parsed['error_description'])}` : ''
        }`,
        providerCode: code,
        httpStatus: response.status,
      });
    }

    return parsed;
  }

  private toError(body: XErrorBody, response: Response, request: XRequest) {
    const standing = clientStanding(response.status, body);
    const kind = kindForStatus(response.status, body);
    const first = body.errors?.[0];
    const reason = body.detail ?? first?.detail ?? first?.message ?? body.title;

    // `x-rate-limit-reset` is an epoch second, not a delay.
    const reset = Number(response.headers.get('x-rate-limit-reset'));
    const retryAfter =
      response.status === 429 && Number.isFinite(reset) && reset > 0
        ? Math.max(1, Math.ceil(reset - clock.nowMs() / 1000))
        : undefined;

    return toAppError('X', {
      kind,
      message: reason ?? `X returned HTTP ${response.status}`,
      ...(body.type ? { providerCode: body.type } : {}),
      httpStatus: response.status,
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      ...(standing
        ? { userMessage: standing }
        : kind === 'VALIDATION' && /duplicate/i.test(body.detail ?? '')
          ? {
              userMessage:
                'X does not accept a post identical to one this account already published. Change the text and try again.',
            }
          : // X's own words, on a write: "the platform rejected this post" sends
            // somebody to edit a caption when the fault may be elsewhere.
            (kind === 'VALIDATION' || kind === 'MEDIA') && request.method === 'POST' && reason
            ? { userMessage: `X rejected this post: ${reason.slice(0, 200)}` }
            : {}),
      meta: {
        // Which step refused. A post with an image is half a dozen calls, and
        // without this they all read as "the platform rejected this post".
        xEndpoint: request.path,
        ...(body.title ? { xTitle: body.title } : {}),
        ...(reason ? { xDetail: reason.slice(0, 300) } : {}),
        // A rate limit or an empty credit balance is the app's standing, not a
        // broken connection: the account is left ACTIVE (D-085).
        ...(standing || response.status === 429 ? { clientStanding: true } : {}),
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
      throw normalizeUnknownError('X', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: 'X returned a non-JSON response' };
  }
}
