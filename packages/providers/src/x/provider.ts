import { createHash } from 'node:crypto';
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
import { XClient, type XClientOptions, type XProblem } from './client.js';
import {
  X_ACCOUNT_METRICS,
  X_API_VERSION,
  X_AUTHORIZE_URL,
  X_POST_METRICS,
  X_PRIVATE_METRICS_WINDOW_MS,
  X_PUBLISH_SCOPES,
  xCapabilities,
} from './capabilities.js';

/**
 * X adapter.
 *
 * ## What an agency connects
 *
 * The account itself. One sign-in yields one account and one credential, the
 * same shape as TikTok and Pinterest — there is no page to go through.
 *
 * ## PKCE, without storing anything
 *
 * X requires PKCE even of a confidential client. The verifier is supplied by
 * the caller, who derives it from the flow's nonce with a server secret and can
 * derive it again at the callback; the URL carries only the S256 challenge.
 *
 * ## Media
 *
 * Uploaded in chunks through the v2 endpoints (`initialize`, `append`,
 * `finalize`), read from storage in ranges so a video is never in memory whole.
 * The media ids are recorded before the post is created, and a retry within
 * their lifetime reuses them — re-uploading would restart a transcode that may
 * already be running, and a slow video could then never publish.
 */

/** Refresh once the access token has less than this left. X's last two hours. */
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
/** 4 MB: under X's recommended 5 MB segment, well under its 8 MB ceiling. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MEDIA_POLL_BUDGET_MS = 45_000;
const MEDIA_POLL_INTERVAL_MS = 2_000;
/** Do not reuse a recorded media id this close to its expiry. */
const MEDIA_REUSE_MARGIN_MS = 10 * 60 * 1000;

export interface XProviderOptions extends XClientOptions {
  /**
   * How the worker reads a byte range of a media object.
   *
   * Injected, like TikTok's: `@orbit/providers` must not depend on storage.
   * Only the worker wires it — the web app never moves media bytes.
   */
  readMediaRange?:
    | ((input: {
        media: PublishMedia;
        firstByte: number;
        lastByte: number;
        signal?: AbortSignal | undefined;
      }) => Promise<Uint8Array>)
    | undefined;
  pollBudgetMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

interface TokenResponse {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface UserResponse {
  data?: {
    id?: string;
    name?: string;
    username?: string;
    profile_image_url?: string;
    public_metrics?: Record<string, number>;
  };
  errors?: XProblem[];
}

interface PostData {
  id?: string;
  text?: string;
  created_at?: string;
  public_metrics?: Record<string, number>;
  non_public_metrics?: Record<string, number>;
  attachments?: { media_keys?: string[] };
}

interface PostResponse {
  data?: PostData;
  includes?: { media?: Array<{ type?: string; public_metrics?: Record<string, number> }> };
  errors?: XProblem[];
}

interface MediaResponse {
  data?: {
    id?: string;
    media_key?: string;
    expires_after_secs?: number;
    processing_info?: {
      state?: 'pending' | 'in_progress' | 'succeeded' | 'failed';
      check_after_secs?: number;
      error?: { message?: string; name?: string };
    };
  };
}

/** What a publish records before the post is created, so a retry can resume. */
interface MediaRef {
  contentHash: string;
  mediaIds: string[];
  /** The ones FINALIZE said are still processing; a still usually has none. */
  pendingIds: string[];
  /** Epoch ms; the earliest any of them expires. */
  expiresAt: number;
}

export class XProvider implements SocialProvider {
  readonly platform: Platform = 'X';

  private readonly client: XClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: XProviderOptions) {
    this.client = new XClient(options);
    this.capabilityCache = xCapabilities(X_API_VERSION);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const verifier = requireVerifier(input.codeVerifier);
    const scopes = [...new Set([...X_PUBLISH_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(X_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    // Space-delimited, as LinkedIn and Google do.
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', s256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const token = (await this.client.oauth('/2/oauth2/token', {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: requireVerifier(input.codeVerifier),
    })) as TokenResponse;

    const credential = toIssuedCredential(token);

    const me = await this.client.request<UserResponse>({
      path: '/2/users/me',
      accessToken: credential.accessToken,
      params: { 'user.fields': 'name,username,profile_image_url' },
    });

    const user = me.body.data;
    if (!user?.id) {
      throw toAppError('X', {
        kind: 'UNAVAILABLE',
        message: 'X issued a token but returned no account for it',
      });
    }

    return {
      accounts: [
        {
          externalId: user.id,
          displayName: user.name ?? user.username ?? user.id,
          ...(user.username ? { handle: user.username } : {}),
          ...(user.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
          credential,
        },
      ],
    };
  }

  /**
   * Renew the access token. **The refresh token is replaced every time**, so
   * the caller must store what comes back before anything refreshes again —
   * using the old one a second time is refused and ends the connection.
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    const now = clock.nowMs();
    const remaining = credential.expiresAt ? credential.expiresAt.getTime() - now : Infinity;

    if (remaining > REFRESH_WINDOW_MS) return { status: 'STILL_VALID' };

    if (!credential.refreshToken) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason:
          'No X refresh token is stored for this account, so the connection cannot be renewed. Reconnect it.',
      };
    }

    try {
      const token = (await this.client.oauth('/2/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      })) as TokenResponse;

      return { status: 'REFRESHED', credential: toIssuedCredential(token) };
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'X rejected the refresh token. The account needs to be reconnected.',
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
    const missing = X_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    try {
      const me = await this.client.request<UserResponse>({
        path: '/2/users/me',
        accessToken: credential.accessToken,
      });

      // The token works but belongs to somebody else: the account was
      // reconnected with a different sign-in.
      if (me.body.data?.id && me.body.data.id !== account.externalId) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message:
            'This connection now signs in as a different X account. Reconnect the right one.',
          checkedAt,
        };
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'X no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // A rate limit, an empty credit balance or an outage is not a verdict
      // on the account. Rethrown so the sweep records it and leaves it ACTIVE.
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

  /** Best effort: disconnecting locally must succeed whatever X says. */
  async revoke(credential: DecryptedCredential): Promise<void> {
    for (const token of [credential.refreshToken, credential.accessToken]) {
      if (!token) continue;
      await this.client.oauth('/2/oauth2/revoke', { token }).catch(() => undefined);
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

    if (!validation.valid) {
      throw toAppError('X', preflightRefusal('X', validation));
    }

    // The same composition the validator counted, so the composer's count and
    // X's verdict cannot disagree.
    const text = composePublishedText(ctx.draft);

    /**
     * Media first, post second: an uploaded file with no post is invisible and
     * expires on its own, while a post created first and then failed on media
     * would be public and wrong.
     */
    const prepared = ctx.media.length > 0 ? await this.prepareMedia(ctx) : undefined;
    const mediaIds = prepared?.mediaIds ?? [];

    // Before the call whose outcome can be lost: reconciliation matches on the
    // text actually sent — hashtags and link included — not on the body alone,
    // which a short post shares with too little of what X published.
    await ctx.recordProviderRef?.({
      ...(prepared ?? { contentHash: ctx.contentHash }),
      publishedText: withoutLinks(text),
    });

    const created = await this.client.request<{ data?: { id?: string; text?: string } }>({
      path: '/2/tweets',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: {
        ...(text ? { text } : {}),
        ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}),
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const id = created.body.data?.id;
    if (!id) {
      throw toAppError('X', {
        kind: 'UNAVAILABLE',
        message: 'X accepted the post but returned no id',
      });
    }

    return {
      externalPostId: id,
      permalink: permalinkFor(id),
      publishedAt: clock.now(),
      providerMeta: { apiVersion: X_API_VERSION, mediaCount: mediaIds.length },
    };
  }

  /**
   * Upload every attachment, or reuse the ones an earlier attempt uploaded.
   *
   * The ids are recorded before anything waits on processing: a video still
   * transcoding when the budget runs out is retried, and the retry has to find
   * the same ids to wait on rather than send the file again.
   */
  private async prepareMedia(ctx: PublishContext): Promise<MediaRef> {
    const previous = readMediaRef(ctx.previousRef);
    const reusable =
      previous &&
      previous.contentHash === ctx.contentHash &&
      previous.mediaIds.length === ctx.media.length &&
      previous.expiresAt - clock.nowMs() > MEDIA_REUSE_MARGIN_MS;

    let ref: MediaRef;

    if (reusable) {
      ref = previous;
    } else {
      const uploaded: Array<{ id: string; expiresAt: number; processing: boolean }> = [];
      for (const media of ctx.media) uploaded.push(await this.upload(ctx, media));

      ref = {
        contentHash: ctx.contentHash,
        mediaIds: uploaded.map((item) => item.id),
        pendingIds: uploaded.filter((item) => item.processing).map((item) => item.id),
        expiresAt: Math.min(...uploaded.map((item) => item.expiresAt)),
      };
      await ctx.recordProviderRef?.({ ...ref });
    }

    for (const id of ref.pendingIds) await this.awaitProcessing(ctx, id);
    return { ...ref, pendingIds: [] };
  }

  private async upload(
    ctx: PublishContext,
    media: PublishMedia,
  ): Promise<{ id: string; expiresAt: number; processing: boolean }> {
    const read = this.options.readMediaRange;
    if (!read) {
      throw toAppError('X', {
        kind: 'UNAVAILABLE',
        message:
          'X is configured without a media reader, so no file can be uploaded. Wire readMediaRange when constructing the provider.',
      });
    }

    const signal = ctx.signal ? { signal: ctx.signal } : {};

    const initialized = await this.client.request<MediaResponse>({
      path: '/2/media/upload/initialize',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: {
        media_type: media.mimeType,
        total_bytes: media.sizeBytes,
        media_category: categoryFor(media),
      },
      ...signal,
    });

    const id = initialized.body.data?.id;
    if (!id) {
      throw toAppError('X', {
        kind: 'UNAVAILABLE',
        message: 'X did not return a media id for the upload',
      });
    }

    for (let offset = 0, segment = 0; offset < media.sizeBytes; offset += CHUNK_BYTES, segment++) {
      const bytes = await read({
        media,
        firstByte: offset,
        lastByte: Math.min(offset + CHUNK_BYTES, media.sizeBytes) - 1,
        ...signal,
      });

      // Copied into a fresh buffer: a view onto a larger pooled buffer would
      // otherwise upload the whole pool.
      const chunk = new Uint8Array(bytes.byteLength);
      chunk.set(bytes);

      const form = new FormData();
      form.append('segment_index', String(segment));
      form.append('media', new Blob([chunk.buffer], { type: media.mimeType }), 'chunk');

      await this.client.request({
        path: `/2/media/upload/${id}/append`,
        method: 'POST',
        accessToken: ctx.credential.accessToken,
        form,
        ...signal,
      });
    }

    const finalized = await this.client.request<MediaResponse>({
      path: `/2/media/upload/${id}/finalize`,
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      ...signal,
    });

    // Alt text is for stills and GIFs. Sent after finalize, while the post does
    // not yet exist, so a failure here costs nothing anybody can see.
    if (media.altText && media.kind !== 'VIDEO') {
      await this.client.request({
        path: '/2/media/metadata',
        method: 'POST',
        accessToken: ctx.credential.accessToken,
        json: { id, metadata: { alt_text: { text: media.altText.slice(0, 1_000) } } },
        ...signal,
      });
    }

    const lifetime =
      finalized.body.data?.expires_after_secs ?? initialized.body.data?.expires_after_secs ?? 0;

    return {
      id,
      expiresAt: clock.nowMs() + lifetime * 1000,
      // Verified: "If `processing_info` is returned, proceed to Step 4 to wait
      // for processing. If not, the media is ready to use."
      processing: Boolean(finalized.body.data?.processing_info),
    };
  }

  /**
   * Wait until X has processed an upload.
   *
   * Only for media FINALIZE said is processing — STATUS is not a question to
   * ask about anything else. Running out of budget is **not** ambiguous: no post exists yet, so the failure is UNAVAILABLE
   * and the retry resumes these same ids.
   */
  private async awaitProcessing(ctx: PublishContext, mediaId: string): Promise<void> {
    const budgetMs = this.options.pollBudgetMs ?? MEDIA_POLL_BUDGET_MS;
    const floorMs = this.options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
    const deadline = clock.nowMs() + budgetMs;

    for (;;) {
      const status = await this.client.request<MediaResponse>({
        path: '/2/media/upload',
        accessToken: ctx.credential.accessToken,
        params: { command: 'STATUS', media_id: mediaId },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      const processing = status.body.data?.processing_info;
      if (!processing || processing.state === 'succeeded') return;

      if (processing.state === 'failed') {
        throw toAppError('X', {
          kind: 'MEDIA',
          message: `X could not process media ${mediaId}: ${processing.error?.message ?? 'no reason given'}`,
          userMessage: 'X could not process this file. Try re-exporting it.',
          meta: { mediaId },
        });
      }

      if (clock.nowMs() >= deadline) {
        throw toAppError('X', {
          kind: 'UNAVAILABLE',
          message: `X is still processing media ${mediaId}; no post has been created`,
          userMessage: 'X is still processing this video. We will try again shortly.',
          retryAfterSeconds: 60,
          meta: { mediaId, lastState: processing.state ?? 'unknown' },
        });
      }

      const wait = Math.max(floorMs, (processing.check_after_secs ?? 0) * 1000);
      await sleep(Math.min(wait, Math.max(0, deadline - clock.nowMs())), ctx.signal);
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the post we lost track of go out?
   *
   * X offers no idempotency key, so this lists the account's posts inside the
   * attempt window and matches on text. Links are stripped from both sides
   * first: X rewrites every URL to t.co and appends one for attached media, so
   * the published text never equals what was sent.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const from = new Date(ctx.attemptedAt.getTime() - ctx.windowMs);

    let recent;
    try {
      recent = await this.client.request<{ data?: PostData[] }>({
        path: `/2/users/${encodeURIComponent(ctx.account.externalId)}/tweets`,
        accessToken: ctx.credential.accessToken,
        params: {
          max_results: 10,
          start_time: from.toISOString(),
          'tweet.fields': 'created_at,text',
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch {
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'X could not be reached to confirm whether this post went out.',
      };
    }

    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;
    const recorded = ctx.providerRef?.['publishedText'];
    const expected = typeof recorded === 'string' ? recorded : withoutLinks(ctx.body);

    const match = (recent.body.data ?? []).find((post) => {
      if (!post.id || !post.created_at) return false;
      if (new Date(post.created_at).getTime() > upper) return false;
      return matchesPublishedText(withoutLinks(post.text ?? ''), expected);
    });

    if (!match?.id) return { outcome: 'NOT_FOUND' };

    return {
      outcome: 'FOUND',
      externalPostId: match.id,
      permalink: permalinkFor(match.id),
      publishedAt: match.created_at ? new Date(match.created_at) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    const post = await this.client.request<PostResponse>({
      path: `/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
      accessToken: credential.accessToken,
      params: { 'tweet.fields': 'created_at' },
    });

    // A deleted post is a 200 with `errors` and no `data`.
    if (!post.body.data?.id) return { exists: false };

    return {
      exists: true,
      permalink: permalinkFor(post.body.data.id),
      ...(post.body.data.created_at ? { publishedAt: new Date(post.body.data.created_at) } : {}),
      createdByThisApp: true,
    };
  }

  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    await this.client.request({
      path: `/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
      method: 'DELETE',
      accessToken: credential.accessToken,
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /**
   * One post's numbers, in one request.
   *
   * Public metrics always; the owner-only ones (link clicks, profile clicks,
   * engagements) only inside X's 30-day window, because asking for them on an
   * older post is an error rather than an empty answer. Video views come from
   * the attached media, so it is expanded in the same call.
   */
  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    const privateWindowOpen = clock.nowMs() - range.from.getTime() < X_PRIVATE_METRICS_WINDOW_MS;

    const response = await this.client.request<PostResponse>({
      path: `/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
      accessToken: credential.accessToken,
      params: {
        'tweet.fields': privateWindowOpen
          ? 'created_at,public_metrics,non_public_metrics'
          : 'created_at,public_metrics',
        expansions: 'attachments.media_keys',
        'media.fields': 'type,public_metrics',
      },
    });

    const post = response.body.data;
    if (!post?.id) {
      throw toAppError('X', {
        kind: 'VALIDATION',
        message: `X no longer serves post ${ref.externalPostId}`,
        userMessage: 'This post is no longer on X, so its numbers cannot be read.',
      });
    }

    const metrics: Record<string, number> = {};
    const availability: MetricSet['availability'] = {};
    const record = (name: string, value: unknown) => {
      if (typeof value === 'number') {
        metrics[name] = value;
        availability[name] = 'AVAILABLE';
      }
    };

    record('x_impressions', post.public_metrics?.['impression_count']);
    record('x_likes', post.public_metrics?.['like_count']);
    record('x_replies', post.public_metrics?.['reply_count']);
    record('x_reposts', post.public_metrics?.['retweet_count']);
    record('x_quotes', post.public_metrics?.['quote_count']);
    record('x_bookmarks', post.public_metrics?.['bookmark_count']);
    record('x_link_clicks', post.non_public_metrics?.['url_link_clicks']);
    record('x_profile_clicks', post.non_public_metrics?.['user_profile_clicks']);
    record('x_engagements', post.non_public_metrics?.['engagements']);

    const videos = (response.body.includes?.media ?? []).filter(
      (media) => media.type === 'video' && typeof media.public_metrics?.['view_count'] === 'number',
    );
    if (videos.length > 0) {
      record(
        'x_video_views',
        videos.reduce((sum, media) => sum + (media.public_metrics?.['view_count'] ?? 0), 0),
      );
    }

    // Anything X did not serve is missing, never zero (SRS §18).
    for (const name of X_POST_METRICS) availability[name] ??= 'UNSUPPORTED';

    return { metrics, availability, capturedAt: clock.now(), apiVersion: X_API_VERSION };
  }

  async fetchAccountAnalytics(
    account: { externalId: string },
    credential: DecryptedCredential,
    _range: DateRange,
  ): Promise<MetricSet> {
    const response = await this.client.request<UserResponse>({
      path: `/2/users/${encodeURIComponent(account.externalId)}`,
      accessToken: credential.accessToken,
      params: { 'user.fields': 'public_metrics' },
    });

    const counts = response.body.data?.public_metrics ?? {};
    const source: Record<(typeof X_ACCOUNT_METRICS)[number], string> = {
      x_followers: 'followers_count',
      x_following: 'following_count',
      x_posts: 'tweet_count',
      x_listed: 'listed_count',
    };

    const metrics: Record<string, number> = {};
    const availability: MetricSet['availability'] = {};
    for (const name of X_ACCOUNT_METRICS) {
      const value = counts[source[name]];
      if (typeof value === 'number') {
        metrics[name] = value;
        availability[name] = 'AVAILABLE';
      } else {
        availability[name] = 'UNSUPPORTED';
      }
    }

    return { metrics, availability, capturedAt: clock.now(), apiVersion: X_API_VERSION };
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(request: RawWebhookRequest): ProviderEvent[] {
    void request;
    return [];
  }
}

function requireVerifier(verifier: string | undefined): string {
  // RFC 7636: 43 to 128 characters.
  if (!verifier || verifier.length < 43 || verifier.length > 128) {
    throw toAppError('X', {
      kind: 'VALIDATION',
      message: 'X requires a PKCE code verifier of 43 to 128 characters',
      userMessage: 'That connection link is no longer valid. Please start again.',
      meta: { calledPlatform: false },
    });
  }
  return verifier;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function toIssuedCredential(token: TokenResponse): IssuedCredential {
  if (!token.access_token) {
    throw toAppError('X', { kind: 'AUTHENTICATION', message: 'X returned no access token' });
  }

  return {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.expires_in ? { expiresAt: new Date(clock.nowMs() + token.expires_in * 1000) } : {}),
    scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : [...X_PUBLISH_SCOPES],
  };
}

/** `/i/web/status/` resolves without knowing the handle, which can change. */
function permalinkFor(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

function categoryFor(media: PublishMedia): string {
  if (media.kind === 'VIDEO') return 'tweet_video';
  if (media.kind === 'GIF') return 'tweet_gif';
  return 'tweet_image';
}

function readMediaRef(ref: Record<string, unknown> | undefined): MediaRef | undefined {
  if (!ref) return undefined;
  const { contentHash, mediaIds, pendingIds, expiresAt } = ref;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');

  // A ref with no `pendingIds` predates them and cannot say what is still
  // processing, so it is not reused: uploading again is always safe.
  if (
    typeof contentHash !== 'string' ||
    !strings(mediaIds) ||
    !strings(pendingIds) ||
    typeof expiresAt !== 'number'
  ) {
    return undefined;
  }
  return { contentHash, mediaIds, pendingIds, expiresAt };
}

function withoutLinks(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '').trim();
}

function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
