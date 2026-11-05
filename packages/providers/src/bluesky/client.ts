import { clock } from '@orbit/core';
import { normalizeUnknownError, toAppError, type ProviderErrorKind } from '../errors.js';
import { clientAssertion, dpopProof, type Es256Key } from './crypto.js';

/**
 * HTTP for atproto: plain requests, DPoP requests, and the OAuth endpoints.
 *
 * ## DPoP nonces
 *
 * atproto servers require a server-issued nonce in every DPoP proof, and the
 * only way to learn one is to be refused: a 400 (authorization server) or 401
 * (resource server) saying `use_dpop_nonce`, with the nonce in a `DPoP-Nonce`
 * header. Every response may also carry a fresh one. So nonces are cached per
 * origin, sent with every proof, and a refusal for want of one is retried
 * exactly once with the nonce it supplied.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  revocation_endpoint?: string;
}

interface XrpcError {
  error?: string;
  message?: string;
  error_description?: string;
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 413) return 'MEDIA';
  if (status >= 500) return 'UNAVAILABLE';
  if (status === 400 || status === 404 || status === 409) return 'VALIDATION';
  return 'UNAVAILABLE';
}

export class BlueskyHttp {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** Latest DPoP nonce per origin. Per process; a stale one costs one retry. */
  private readonly nonces = new Map<string, string>();
  private readonly metadata = new Map<string, AuthorizationServerMetadata>();

  constructor(options: { fetchImpl?: FetchLike | undefined; timeoutMs?: number | undefined }) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** A JSON GET with no authentication: discovery, DID documents, the AppView. */
  async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await this.send(url, { method: 'GET', ...(signal ? { signal } : {}) });
    return this.read<T>(response);
  }

  async authorizationServer(issuer: string): Promise<AuthorizationServerMetadata> {
    const cached = this.metadata.get(issuer);
    if (cached) return cached;

    const metadata = await this.getJson<AuthorizationServerMetadata>(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    // The issuer the server names must be the one that was asked for, or the
    // document is somebody else's.
    if (metadata.issuer !== issuer) {
      throw toAppError('BLUESKY', {
        kind: 'AUTHENTICATION',
        message: `Authorization server metadata names ${metadata.issuer}, not ${issuer}`,
      });
    }
    this.metadata.set(issuer, metadata);
    return metadata;
  }

  /**
   * POST a form to an OAuth endpoint, authenticated as the client and with a
   * DPoP proof from the session key.
   */
  async oauth(input: {
    endpoint: string;
    issuer: string;
    clientId: string;
    clientKey: Es256Key;
    dpopKey: Es256Key;
    fields: Record<string, string>;
  }): Promise<Record<string, unknown>> {
    const response = await this.dpop(input.endpoint, 'POST', input.dpopKey, () => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // A fresh assertion per attempt: its `jti` must be unique.
      body: new URLSearchParams({
        ...input.fields,
        client_id: input.clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion({
          key: input.clientKey,
          clientId: input.clientId,
          audience: input.issuer,
          nowMs: clock.nowMs(),
        }),
      }).toString(),
    }));

    const text = await response.text();
    const body = text ? (safeJson(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = String(body['error'] ?? response.status);
      throw toAppError('BLUESKY', {
        // A refresh token already used, or revoked, is a connection to make again.
        kind:
          code === 'invalid_grant' || response.status === 401
            ? 'AUTHENTICATION'
            : kindForStatus(response.status),
        message: `Bluesky OAuth refused: ${code}${
          body['error_description'] ? ` — ${String(body['error_description'])}` : ''
        }`,
        providerCode: code,
        httpStatus: response.status,
      });
    }
    return body;
  }

  /** An XRPC call to the account's PDS, as the account. */
  async xrpc<T>(input: {
    pds: string;
    method: 'GET' | 'POST';
    nsid: string;
    accessToken: string;
    dpopKey: Es256Key;
    params?: Record<string, string> | undefined;
    json?: Record<string, unknown> | undefined;
    body?: Uint8Array | undefined;
    contentType?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<T> {
    const url = new URL(`${input.pds}/xrpc/${input.nsid}`);
    for (const [key, value] of Object.entries(input.params ?? {})) url.searchParams.set(key, value);

    const response = await this.dpop(
      url.toString(),
      input.method,
      input.dpopKey,
      () => {
        if (input.json) {
          return {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input.json),
          };
        }
        if (input.body) {
          // Copied into a fresh buffer: a view onto a larger pooled buffer
          // would otherwise upload the whole pool.
          const bytes = new Uint8Array(input.body.byteLength);
          bytes.set(input.body);
          return {
            headers: { 'content-type': input.contentType ?? 'application/octet-stream' },
            body: new Blob([bytes.buffer]),
          };
        }
        return {};
      },
      input.accessToken,
      input.signal,
    );

    return this.read<T>(response);
  }

  /**
   * Send with a DPoP proof, retrying once when the server asks for a nonce.
   *
   * `build` produces the body afresh for each attempt, because a body stream
   * is spent by the first send and a client assertion must not be reused.
   */
  private async dpop(
    url: string,
    method: string,
    key: Es256Key,
    build: () => { headers?: Record<string, string>; body?: RequestInit['body'] },
    accessToken?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const origin = new URL(url).origin;

    for (let attempt = 0; ; attempt += 1) {
      const { headers, body } = build();
      const proof = dpopProof({
        key,
        method,
        url,
        nowMs: clock.nowMs(),
        nonce: this.nonces.get(origin),
        accessToken,
      });

      const response = await this.send(url, {
        method,
        headers: {
          ...headers,
          DPoP: proof,
          ...(accessToken ? { authorization: `DPoP ${accessToken}` } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        ...(signal ? { signal } : {}),
      });

      const fresh = response.headers.get('dpop-nonce');
      if (fresh) this.nonces.set(origin, fresh);

      if (attempt === 0 && fresh && (await asksForNonce(response))) continue;
      return response;
    }
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = text ? safeJson(text) : {};

    if (!response.ok) {
      const failure = body as XrpcError;
      const reset = Number(response.headers.get('ratelimit-reset'));
      throw toAppError('BLUESKY', {
        kind: kindForStatus(response.status),
        message:
          failure.message ??
          failure.error_description ??
          `Bluesky returned HTTP ${response.status}`,
        ...(failure.error ? { providerCode: failure.error } : {}),
        httpStatus: response.status,
        ...(response.status === 429 && Number.isFinite(reset) && reset > 0
          ? { retryAfterSeconds: Math.max(1, Math.ceil(reset - clock.nowMs() / 1000)) }
          : {}),
        meta: {
          ...(failure.error ? { xrpcError: failure.error } : {}),
          // A rate limit is the PDS's budget, not a broken connection (D-085).
          ...(response.status === 429 ? { clientStanding: true } : {}),
        },
      });
    }
    return body as T;
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
      throw normalizeUnknownError('BLUESKY', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The authorization server says so in its body; the PDS in a header. */
async function asksForNonce(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) return false;
  if (/use_dpop_nonce/i.test(response.headers.get('www-authenticate') ?? '')) return true;
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { error?: string };
  return body.error === 'use_dpop_nonce';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: 'Bluesky returned a non-JSON response' };
  }
}
