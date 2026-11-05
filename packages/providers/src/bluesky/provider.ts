import { randomInt } from 'node:crypto';
import { clock, matchesPublishedText, type Platform } from '@orbit/core';
import { preflightRefusal, toAppError } from '../errors.js';
import {
  composePublishedText,
  validateDraft,
  type ValidationResult,
  type VariantDraft,
} from '../validation.js';
import type { PlatformCapabilities } from '../capabilities.js';
import type {
  AccountHealth,
  AuthorizationUrlInput,
  CallbackInput,
  ConnectedAccounts,
  DateRange,
  DecryptedCredential,
  ExternalPostRef,
  ExternalPostStatus,
  IssuedCredential,
  MetricSet,
  ProviderEvent,
  PublishContext,
  PublishMedia,
  PublishResult,
  RawWebhookRequest,
  ReconcileContext,
  ReconcileResult,
  RefreshOutcome,
  SocialProvider,
} from '../types.js';
import { BlueskyHttp, type FetchLike } from './client.js';
import {
  deriveEs256Key,
  keyFromPrivateJwk,
  s256,
  type Es256Key,
  type PrivateEcJwk,
} from './crypto.js';
import { authorizationServerFor, resolveIdentity } from './identity.js';
import { detectFacets } from './richtext.js';
import {
  BLUESKY_ACCOUNT_METRICS,
  BLUESKY_API_VERSION,
  BLUESKY_APPVIEW,
  BLUESKY_AUTHORIZATION_SERVER,
  BLUESKY_PLC_DIRECTORY,
  BLUESKY_POST_METRICS,
  BLUESKY_SCOPES,
  blueskyCapabilities,
} from './capabilities.js';

/**
 * Bluesky adapter (atproto).
 *
 * ## Connecting
 *
 * OAuth through bsky.social, the authorization server for every account
 * Bluesky hosts: a pushed authorization request, then the consent screen,
 * then a token exchange — each POST authenticated as Social Square with a
 * signed assertion (`private_key_jwt`) and carrying a DPoP proof. The account
 * the token names is then checked independently (`identity.ts`) before it is
 * trusted. Accounts on a self-hosted PDS with their own authorization server
 * are not offered yet.
 *
 * ## The session key
 *
 * Tokens are bound to a DPoP key: every later request must be signed with it,
 * refreshes included. The key is derived from the flow's PKCE verifier and the
 * client key, so the start of the flow and the callback produce the same one
 * with nothing stored in between; after the exchange it is kept with the
 * tokens, sealed like them.
 *
 * ## The stored credential
 *
 * `accessToken` holds a small JSON session — the token, the DPoP key, the
 * PDS and the issuer — because every call needs all four and the credential
 * row has one opaque field. Only this adapter reads it.
 */

/** Refresh once the access token has less than this left. atproto's last ≤ 30 minutes. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const POST_COLLECTION = 'app.bsky.feed.post';

export interface BlueskyProviderOptions {
  /** The client metadata URL — which is the client id. */
  clientId: string;
  /** Social Square's ES256 private key, published (public half) at jwks_uri. */
  privateKeyJwk: PrivateEcJwk;
  authorizationServer?: string | undefined;
  appView?: string | undefined;
  plcDirectory?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  /** How the worker reads an image's bytes; Bluesky takes uploads, not URLs. */
  readMedia?: ((media: PublishMedia) => Promise<Uint8Array>) | undefined;
}

interface Session {
  v: 1;
  token: string;
  dpop: PrivateEcJwk;
  pds: string;
  issuer: string;
  did: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  sub?: string;
}

interface Profile {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

interface PostView {
  uri?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
}

interface RecordView {
  uri?: string;
  value?: { text?: string; createdAt?: string };
}

export class BlueskyProvider implements SocialProvider {
  readonly platform: Platform = 'BLUESKY';

  private readonly http: BlueskyHttp;
  private readonly clientKey: Es256Key;
  private readonly capabilityCache: PlatformCapabilities;
  private readonly issuer: string;
  private readonly appView: string;
  private readonly plc: string;

  constructor(private readonly options: BlueskyProviderOptions) {
    this.http = new BlueskyHttp(options);
    this.clientKey = keyFromPrivateJwk(options.privateKeyJwk);
    this.capabilityCache = blueskyCapabilities(BLUESKY_API_VERSION);
    this.issuer = (options.authorizationServer ?? BLUESKY_AUTHORIZATION_SERVER).replace(/\/$/, '');
    this.appView = options.appView ?? BLUESKY_APPVIEW;
    this.plc = options.plcDirectory ?? BLUESKY_PLC_DIRECTORY;
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * Push the authorization request, then send the person to consent.
   *
   * The request — state, PKCE challenge, scope, redirect — goes to the server
   * first, authenticated; the URL carries only its handle (`request_uri`).
   */
  async getAuthorizationUrl(
    input: AuthorizationUrlInput,
  ): Promise<{ url: string; scopes: readonly string[] }> {
    const verifier = requireVerifier(input.codeVerifier);
    const scopes = [...new Set([...BLUESKY_SCOPES, ...(input.extraScopes ?? [])])];
    const metadata = await this.http.authorizationServer(this.issuer);

    const pushed = await this.http.oauth({
      endpoint: metadata.pushed_authorization_request_endpoint,
      issuer: metadata.issuer,
      clientId: this.options.clientId,
      clientKey: this.clientKey,
      dpopKey: this.flowKey(verifier),
      fields: {
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: scopes.join(' '),
        state: input.state,
        code_challenge: s256(verifier),
        code_challenge_method: 'S256',
      },
    });

    const requestUri = pushed['request_uri'];
    if (typeof requestUri !== 'string') {
      throw toAppError('BLUESKY', {
        kind: 'UNAVAILABLE',
        message: 'Bluesky accepted the authorization request but returned no request_uri',
      });
    }

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('request_uri', requestUri);
    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const verifier = requireVerifier(input.codeVerifier);
    const metadata = await this.http.authorizationServer(this.issuer);
    const dpopKey = this.flowKey(verifier);

    const token = (await this.http.oauth({
      endpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      clientId: this.options.clientId,
      clientKey: this.clientKey,
      dpopKey,
      fields: {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: verifier,
      },
    })) as TokenResponse;

    if (!token.access_token || !token.sub || token.token_type?.toLowerCase() !== 'dpop') {
      throw toAppError('BLUESKY', {
        kind: 'AUTHENTICATION',
        message: 'Bluesky returned no DPoP-bound token for an account',
      });
    }

    // The account the token names must be one this server actually speaks for.
    const identity = await resolveIdentity(this.http, token.sub, this.plc);
    const serverForAccount = await authorizationServerFor(this.http, identity.pds);
    if (serverForAccount !== metadata.issuer) {
      throw toAppError('BLUESKY', {
        kind: 'AUTHENTICATION',
        message: `${token.sub} is served by ${serverForAccount}, not ${metadata.issuer}`,
        userMessage:
          'Bluesky could not confirm which account signed in. Please try connecting again.',
      });
    }

    const profile = await this.http
      .getJson<Profile>(
        `${this.appView}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(identity.did)}`,
      )
      .catch(() => ({}) as Profile);

    const credential = this.toIssued(token, {
      v: 1,
      token: token.access_token,
      dpop: dpopKey.privateJwk,
      pds: identity.pds,
      issuer: metadata.issuer,
      did: identity.did,
    });

    const handle = profile.handle ?? identity.handle;
    return {
      accounts: [
        {
          externalId: identity.did,
          displayName: profile.displayName || handle || identity.did,
          ...(handle ? { handle } : {}),
          ...(profile.avatar ? { avatarUrl: profile.avatar } : {}),
          credential,
        },
      ],
    };
  }

  /**
   * Renew the access token with the same DPoP key and client key.
   * **The refresh token is replaced every time**; the caller stores the new
   * one under a lock (D-111).
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    const remaining = credential.expiresAt
      ? credential.expiresAt.getTime() - clock.nowMs()
      : Infinity;
    if (remaining > REFRESH_WINDOW_MS) return { status: 'STILL_VALID' };

    if (!credential.refreshToken) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason: 'No Bluesky refresh token is stored for this account. Reconnect it.',
      };
    }

    const session = readSession(credential);
    const metadata = await this.http.authorizationServer(session.issuer);

    try {
      const token = (await this.http.oauth({
        endpoint: metadata.token_endpoint,
        issuer: metadata.issuer,
        clientId: this.options.clientId,
        clientKey: this.clientKey,
        dpopKey: keyFromPrivateJwk(session.dpop),
        fields: { grant_type: 'refresh_token', refresh_token: credential.refreshToken },
      })) as TokenResponse;

      if (!token.access_token || (token.sub && token.sub !== session.did)) {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'Bluesky renewed the connection for a different account. Reconnect it.',
        };
      }

      return {
        status: 'REFRESHED',
        credential: this.toIssued(token, { ...session, token: token.access_token }),
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'Bluesky rejected the refresh token. The account needs to be reconnected.',
        };
      }
      throw error;
    }
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async probeHealth(
    credential: DecryptedCredential,
    account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();
    const granted = credential.scopes;
    const missing = BLUESKY_SCOPES.filter((scope) => !granted.includes(scope));

    try {
      const session = readSession(credential);
      const me = await this.http.xrpc<{ did?: string }>({
        pds: session.pds,
        method: 'GET',
        nsid: 'com.atproto.server.getSession',
        accessToken: session.token,
        dpopKey: keyFromPrivateJwk(session.dpop),
      });

      if (me.did && me.did !== account.externalId) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message:
            'This connection now signs in as a different Bluesky account. Reconnect the right one.',
          checkedAt,
        };
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'Bluesky no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // An outage or a rate limit says nothing about the account.
      throw error;
    }

    if (missing.length > 0) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        message: `This connection is missing ${missing.join(', ')}, so it cannot publish.`,
        checkedAt,
      };
    }

    return { status: 'ACTIVE', grantedScopes: granted, missingScopes: [], checkedAt };
  }

  /** Best effort: disconnecting locally must succeed whatever Bluesky says. */
  async revoke(credential: DecryptedCredential): Promise<void> {
    try {
      const session = readSession(credential);
      const metadata = await this.http.authorizationServer(session.issuer);
      if (!metadata.revocation_endpoint || !credential.refreshToken) return;
      await this.http.oauth({
        endpoint: metadata.revocation_endpoint,
        issuer: metadata.issuer,
        clientId: this.options.clientId,
        clientKey: this.clientKey,
        dpopKey: keyFromPrivateJwk(session.dpop),
        fields: { token: credential.refreshToken },
      });
    } catch {
      return;
    }
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const validation = this.validate({
      ...ctx.draft,
      media: ctx.media.map((item) => ({
        id: item.id,
        kind: item.kind,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        frameRate: item.frameRate,
        peakFrameRate: item.peakFrameRate,
        altText: item.altText,
      })),
    });
    if (!validation.valid) throw toAppError('BLUESKY', preflightRefusal('BLUESKY', validation));

    const session = readSession(ctx.credential);
    const dpopKey = keyFromPrivateJwk(session.dpop);
    // The same composition the validator counted.
    const text = composePublishedText(ctx.draft);
    const facets = detectFacets(text);

    // Images first, the post second: an uploaded blob with no post is
    // invisible and collected by the PDS, a post without its images is not.
    const images = [];
    for (const media of ctx.media) {
      images.push({
        image: await this.uploadImage(ctx, session, dpopKey, media),
        alt: media.altText ?? '',
        ...(media.width && media.height
          ? { aspectRatio: { width: media.width, height: media.height } }
          : {}),
      });
    }

    /**
     * The record key is chosen here and recorded **before** the write. A
     * retry reuses it, and reconciliation asks for exactly that record — the
     * strongest answer "did it go out?" can have short of an idempotency key.
     */
    const resumed =
      typeof ctx.previousRef?.['rkey'] === 'string' &&
      ctx.previousRef['contentHash'] === ctx.contentHash
        ? (ctx.previousRef['rkey'] as string)
        : undefined;
    const rkey = resumed ?? newTid();
    await ctx.recordProviderRef?.({ rkey, contentHash: ctx.contentHash, did: session.did });

    const record = {
      $type: POST_COLLECTION,
      text,
      createdAt: clock.now().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      ...(images.length > 0 ? { embed: { $type: 'app.bsky.embed.images', images } } : {}),
    };

    let uri: string;
    try {
      const created = await this.http.xrpc<{ uri?: string; cid?: string }>({
        pds: session.pds,
        method: 'POST',
        nsid: 'com.atproto.repo.createRecord',
        accessToken: session.token,
        dpopKey,
        json: { repo: session.did, collection: POST_COLLECTION, rkey, record },
        signal: ctx.signal,
      });
      if (!created.uri) {
        throw toAppError('BLUESKY', {
          kind: 'UNAVAILABLE',
          message: 'Bluesky accepted the post but returned no uri',
        });
      }
      uri = created.uri;
    } catch (error) {
      // A retry whose first attempt did land is refused for the key it reused.
      // The record existing is the answer the retry was after.
      if (resumed && (await this.recordExists(session, rkey))) {
        uri = `at://${session.did}/${POST_COLLECTION}/${rkey}`;
      } else {
        throw error;
      }
    }

    return {
      externalPostId: uri,
      permalink: permalinkFor(session.did, rkey),
      publishedAt: clock.now(),
      providerMeta: { apiVersion: BLUESKY_API_VERSION, imageCount: images.length },
    };
  }

  private async uploadImage(
    ctx: PublishContext,
    session: Session,
    dpopKey: Es256Key,
    media: PublishMedia,
  ): Promise<unknown> {
    const read = this.options.readMedia;
    if (!read) {
      throw toAppError('BLUESKY', {
        kind: 'UNAVAILABLE',
        message:
          'Bluesky is configured without a media reader, so no image can be uploaded. Wire readMedia when constructing the provider.',
      });
    }

    const uploaded = await this.http.xrpc<{ blob?: unknown }>({
      pds: session.pds,
      method: 'POST',
      nsid: 'com.atproto.repo.uploadBlob',
      accessToken: session.token,
      dpopKey,
      body: await read(media),
      contentType: media.mimeType,
      signal: ctx.signal,
    });

    if (!uploaded.blob) {
      throw toAppError('BLUESKY', {
        kind: 'UNAVAILABLE',
        message: 'Bluesky stored the image but returned no blob reference',
      });
    }
    return uploaded.blob;
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the post go out? By record key when the attempt recorded one — an
   * exact answer — and otherwise by text among the account's recent posts.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    let session: Session;
    try {
      session = readSession(ctx.credential);
    } catch {
      return { outcome: 'INCONCLUSIVE', reason: 'The stored Bluesky session could not be read.' };
    }

    const rkey = ctx.providerRef?.['rkey'];
    if (typeof rkey === 'string') {
      try {
        const found = await this.getRecord(session, rkey);
        if (!found) return { outcome: 'NOT_FOUND' };
        return {
          outcome: 'FOUND',
          externalPostId: `at://${session.did}/${POST_COLLECTION}/${rkey}`,
          permalink: permalinkFor(session.did, rkey),
          publishedAt: found.value?.createdAt ? new Date(found.value.createdAt) : clock.now(),
        };
      } catch {
        return {
          outcome: 'INCONCLUSIVE',
          reason: 'Bluesky could not be reached to confirm whether this post went out.',
        };
      }
    }

    let recent;
    try {
      recent = await this.http.getJson<{ records?: RecordView[] }>(
        `${session.pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(session.did)}&collection=${POST_COLLECTION}&limit=25`,
      );
    } catch {
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'Bluesky could not be reached to confirm whether this post went out.',
      };
    }

    const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;
    const match = (recent.records ?? []).find((record) => {
      const at = record.value?.createdAt ? new Date(record.value.createdAt).getTime() : NaN;
      if (!record.uri || !(at >= lower && at <= upper)) return false;
      return matchesPublishedText(ctx.body, record.value?.text ?? '');
    });

    if (!match?.uri) return { outcome: 'NOT_FOUND' };
    const matchedKey = match.uri.split('/').pop() ?? '';
    return {
      outcome: 'FOUND',
      externalPostId: match.uri,
      permalink: permalinkFor(session.did, matchedKey),
      publishedAt: match.value?.createdAt ? new Date(match.value.createdAt) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    const session = readSession(credential);
    const rkey = rkeyOf(ref.externalPostId);
    const found = await this.getRecord(session, rkey);
    if (!found) return { exists: false };

    return {
      exists: true,
      permalink: permalinkFor(session.did, rkey),
      ...(found.value?.createdAt ? { publishedAt: new Date(found.value.createdAt) } : {}),
      createdByThisApp: true,
    };
  }

  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    const session = readSession(credential);
    await this.http.xrpc({
      pds: session.pds,
      method: 'POST',
      nsid: 'com.atproto.repo.deleteRecord',
      accessToken: session.token,
      dpopKey: keyFromPrivateJwk(session.dpop),
      json: { repo: session.did, collection: POST_COLLECTION, rkey: rkeyOf(ref.externalPostId) },
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /**
   * Counts from the public AppView: free, unauthenticated, and the same
   * numbers anybody sees under the post. Bluesky reports no impressions.
   */
  async fetchPostAnalytics(
    ref: ExternalPostRef,
    _credential: DecryptedCredential,
    _range: DateRange,
  ): Promise<MetricSet> {
    const response = await this.http.getJson<{ posts?: PostView[] }>(
      `${this.appView}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(ref.externalPostId)}`,
    );

    const post = response.posts?.[0];
    if (!post) {
      throw toAppError('BLUESKY', {
        kind: 'VALIDATION',
        message: `Bluesky no longer serves ${ref.externalPostId}`,
        userMessage: 'This post is no longer on Bluesky, so its numbers cannot be read.',
      });
    }

    return metricSet(
      {
        bsky_likes: post.likeCount,
        bsky_reposts: post.repostCount,
        bsky_replies: post.replyCount,
        bsky_quotes: post.quoteCount,
        bsky_bookmarks: post.bookmarkCount,
      },
      BLUESKY_POST_METRICS,
    );
  }

  async fetchAccountAnalytics(
    account: { externalId: string },
    _credential: DecryptedCredential,
    _range: DateRange,
  ): Promise<MetricSet> {
    const profile = await this.http.getJson<Profile>(
      `${this.appView}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(account.externalId)}`,
    );

    return metricSet(
      {
        bsky_followers: profile.followersCount,
        bsky_following: profile.followsCount,
        bsky_posts: profile.postsCount,
      },
      BLUESKY_ACCOUNT_METRICS,
    );
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(request: RawWebhookRequest): ProviderEvent[] {
    void request;
    return [];
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The flow's DPoP key: the same at the start and at the callback. */
  private flowKey(verifier: string): Es256Key {
    return deriveEs256Key(
      Buffer.from(this.options.privateKeyJwk.d, 'base64url'),
      `bluesky-dpop:${verifier}`,
    );
  }

  private toIssued(token: TokenResponse, session: Session): IssuedCredential {
    return {
      accessToken: JSON.stringify(session),
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: new Date(clock.nowMs() + token.expires_in * 1000) } : {}),
      scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : [...BLUESKY_SCOPES],
    };
  }

  private async getRecord(session: Session, rkey: string): Promise<RecordView | null> {
    try {
      return await this.http.getJson<RecordView>(
        `${session.pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(session.did)}&collection=${POST_COLLECTION}&rkey=${encodeURIComponent(rkey)}`,
      );
    } catch (error) {
      // `RecordNotFound` is a 400 with that error name: an answer, not a fault.
      if (
        (error as { context?: Record<string, unknown> }).context?.['xrpcError'] === 'RecordNotFound'
      ) {
        return null;
      }
      throw error;
    }
  }

  private async recordExists(session: Session, rkey: string): Promise<boolean> {
    return (await this.getRecord(session, rkey).catch(() => null)) !== null;
  }
}

function readSession(credential: DecryptedCredential): Session {
  try {
    const session = JSON.parse(credential.accessToken) as Partial<Session>;
    if (
      session.v === 1 &&
      session.token &&
      session.dpop &&
      session.pds &&
      session.did &&
      session.issuer
    ) {
      return session as Session;
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw toAppError('BLUESKY', {
    kind: 'AUTHENTICATION',
    message: 'The stored Bluesky session is unreadable',
    userMessage: 'This Bluesky connection needs to be reconnected.',
  });
}

function requireVerifier(verifier: string | undefined): string {
  if (!verifier || verifier.length < 43 || verifier.length > 128) {
    throw toAppError('BLUESKY', {
      kind: 'VALIDATION',
      message: 'Bluesky requires a PKCE code verifier of 43 to 128 characters',
      userMessage: 'That connection link is no longer valid. Please start again.',
      meta: { calledPlatform: false },
    });
  }
  return verifier;
}

function metricSet(
  values: Record<string, number | undefined>,
  names: readonly string[],
): MetricSet {
  const metrics: Record<string, number> = {};
  const availability: MetricSet['availability'] = {};
  for (const name of names) {
    const value = values[name];
    if (typeof value === 'number') {
      metrics[name] = value;
      availability[name] = 'AVAILABLE';
    } else {
      // Missing is missing, never zero (SRS §18).
      availability[name] = 'UNSUPPORTED';
    }
  }
  return { metrics, availability, capturedAt: clock.now(), apiVersion: BLUESKY_API_VERSION };
}

function rkeyOf(atUri: string): string {
  return atUri.split('/').pop() ?? atUri;
}

function permalinkFor(did: string, rkey: string): string {
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/**
 * A timestamp identifier, the record key posts use: 13 characters of
 * base32-sortable, encoding microseconds since the epoch and a random 10-bit
 * clock id, with the top bit zero.
 */
export function newTid(nowMs: number = clock.nowMs()): string {
  const micros = BigInt(nowMs) * 1000n + BigInt(randomInt(1000));
  let value = (micros << 10n) | BigInt(randomInt(1024));
  let out = '';
  for (let i = 0; i < 13; i += 1) {
    out = TID_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}
