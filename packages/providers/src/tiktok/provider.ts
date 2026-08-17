import { clock, type Platform } from '@orbit/core';
import { preflightRefusal, toAppError } from '../errors.js';
import { validateDraft, type ValidationResult, type VariantDraft } from '../validation.js';
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
import { TikTokClient, type TikTokClientOptions } from './client.js';
import { tiktokPublishFailure } from './errors.js';
import {
  TIKTOK_ANALYTICS_SCOPES,
  TIKTOK_CHUNK,
  TIKTOK_DEFAULT_SCOPES,
  TIKTOK_PUBLISH_SCOPES,
  TIKTOK_UPLOAD_SCOPES,
  TIKTOK_VIDEO_METRICS,
  tiktokCapabilities,
  tiktokUserFieldsFor,
  type TikTokPostMode,
  type TikTokPrivacyLevel,
  type TikTokPublishStatus,
} from './capabilities.js';

/**
 * TikTok adapter.
 *
 * Everything TikTok-specific lives in this directory. The core knows only
 * `SocialProvider` and `PlatformCapabilities`.
 *
 * ## What makes this platform different
 *
 * **A publish is not an event, it is a process.** `video/init` returns a
 * `publish_id`; the post exists when `status/fetch` says `PUBLISH_COMPLETE`,
 * which is seconds to minutes later. That is why `publish` records the
 * `publish_id` through `recordProviderRef` *before* it can matter, and why a
 * publish still processing when our budget runs out throws a timeout rather
 * than a failure — the engine then reconciles by asking about that exact
 * `publish_id`, which is a stronger answer than Instagram's container check
 * because it is scoped to this attempt and nothing else.
 *
 * **Bytes go up in chunks, not by URL.** `PULL_FROM_URL` would need TikTok to
 * fetch client media from a verified public domain; Orbit's media is private
 * and reached through short-lived signed URLs. `FILE_UPLOAD` keeps it that way
 * — the worker streams the bytes itself and nothing about a client's video is
 * ever publicly addressable.
 *
 * **The creator owns the privacy decision.** `privacy_level` is mandatory, must
 * be one of the options `creator_info/query` returns for that account at that
 * moment, and TikTok treats ignoring it as a Terms of Service violation rather
 * than a bad request. So the adapter refuses to guess: no default, no fallback.
 *
 * ## Credential shape
 *
 *   authorization code
 *        ↓ POST /v2/oauth/token/  (grant_type=authorization_code)
 *   access_token  — 24 hours
 *   refresh_token — 365 days, **and may be replaced on every refresh**
 *
 * Unlike a Facebook Page token, this one certainly expires, so health here is
 * expiry-driven rather than probe-driven, and the refresh path must store the
 * returned refresh token even when it looks unchanged.
 */

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

/**
 * How long `publish` waits for TikTok to finish before handing over to
 * reconciliation.
 *
 * Deliberately shorter than the engine's 60s call budget: exhausting *our*
 * budget must produce a clean timeout the engine can reconcile, not an abort
 * from underneath that loses the `publish_id` context.
 */
const PUBLISH_POLL_BUDGET_MS = 40_000;
const PUBLISH_POLL_INTERVAL_MS = 3_000;

/** Refresh once the access token is within this of expiring. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;

export interface TikTokProviderOptions extends TikTokClientOptions {
  /**
   * How the worker reads media bytes for chunked upload.
   *
   * Injected rather than imported: `@orbit/providers` must not depend on
   * storage, and the tests need a stream they control. The adapter asks for a
   * byte range so a 4 GB video never has to exist in memory at once.
   */
  readMediaRange?:
    | ((input: {
        media: PublishMedia;
        firstByte: number;
        lastByte: number;
        signal?: AbortSignal | undefined;
      }) => Promise<Uint8Array>)
    | undefined;
  /**
   * How long to wait for TikTok to finish, and how often to ask.
   *
   * Overridable for one reason: a test of the "still processing when the budget
   * runs out" path would otherwise take forty seconds, and a path that slow to
   * test is a path that ends up untested. Production leaves both at default.
   */
  pollBudgetMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

/** Fields TikTok requires on a direct post, resolved from the creator. */
export interface TikTokPostSettings {
  postMode: TikTokPostMode;
  privacyLevel?: TikTokPrivacyLevel | undefined;
  disableComment?: boolean | undefined;
  disableDuet?: boolean | undefined;
  disableStitch?: boolean | undefined;
}

export interface TikTokCreatorInfo {
  creatorUsername: string;
  creatorNickname: string;
  creatorAvatarUrl?: string | undefined;
  privacyLevelOptions: readonly TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

interface CreatorInfoResponse {
  creator_username?: string;
  creator_nickname?: string;
  creator_avatar_url?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface UserInfoResponse {
  user?: {
    open_id?: string;
    union_id?: string;
    avatar_url?: string;
    display_name?: string;
    username?: string;
  };
}

interface InitResponse {
  publish_id?: string;
  upload_url?: string;
}

interface StatusResponse {
  status?: string;
  fail_reason?: string;
  publicaly_available_post_id?: string[];
  publicly_available_post_id?: string[];
  uploaded_bytes?: number;
}

interface VideoQueryResponse {
  videos?: Array<{
    id?: string;
    create_time?: number;
    share_url?: string;
    view_count?: number;
    like_count?: number;
    comment_count?: number;
    share_count?: number;
  }>;
}

export class TikTokProvider implements SocialProvider {
  readonly platform: Platform = 'TIKTOK';

  private readonly client: TikTokClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: TikTokProviderOptions) {
    this.client = new TikTokClient(options);
    this.capabilityCache = tiktokCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * The web authorization flow. No PKCE.
   *
   * PKCE exists for public clients that cannot hold a secret. Orbit's callback
   * is server-side and the client secret never leaves it, so the confidential
   * model applies and `state` — signed, single-use, session-bound — carries the
   * forgery protection. Adding PKCE here would be cargo cult.
   *
   * `scope` is comma-delimited on this dialog. Space-delimited is Instagram's
   * Business Login, and mixing them up produces an unhelpful "invalid scope".
   */
  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const base = input.accountType === 'UPLOAD_ONLY' ? TIKTOK_UPLOAD_SCOPES : TIKTOK_PUBLISH_SCOPES;
    const scopes = [
      ...new Set([...base, ...TIKTOK_ANALYTICS_SCOPES, ...(input.extraScopes ?? [])]),
    ];

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_key', this.options.clientKey);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');

    return { url: url.toString(), scopes };
  }

  /**
   * Exchange the callback code, then read back who authorized.
   *
   * One authorization yields exactly **one** account. There is no Page to walk
   * through and no list to choose from, which makes this the simplest discovery
   * of any adapter here — but the connect flow still returns an array, because
   * the flow is shared and a one-element list is not a special case worth
   * inventing a second path for.
   */
  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const token = await this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });

    const issued = this.toIssuedCredential(token);
    const profile = await this.fetchUserInfo(issued.accessToken, issued.scopes);

    // `open_id` is the account's identity for every later call, and it comes
    // from the token response rather than needing a lookup.
    const externalId = token.open_id ?? profile.open_id;
    if (!externalId) {
      throw toAppError('TIKTOK', {
        kind: 'AUTHENTICATION',
        message: 'TikTok returned no open_id, so the account cannot be identified',
      });
    }

    return {
      accounts: [
        {
          externalId,
          displayName: profile.display_name ?? profile.username ?? 'TikTok account',
          ...(profile.username ? { handle: profile.username } : {}),
          ...(profile.avatar_url ? { avatarUrl: profile.avatar_url } : {}),
          accountType: 'TIKTOK_USER',
          credential: issued,
        },
      ],
    };
  }

  /**
   * Refresh, and **always store what comes back**.
   *
   * TikTok says outright that the returned refresh token may differ from the
   * one sent and that the new one must be used. Keeping the old one is a bug
   * whose symptom arrives up to a year later, when the account silently stops
   * refreshing and nobody remembers why.
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    if (!credential.refreshToken) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason: 'No refresh token is stored for this account.',
      };
    }

    const now = clock.nowMs();

    if (credential.refreshableUntil && credential.refreshableUntil.getTime() <= now) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason: 'The refresh token expired, which happens 365 days after it was issued.',
      };
    }

    if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
      return { status: 'STILL_VALID' };
    }

    try {
      const token = await this.token({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      });

      return { status: 'REFRESHED', credential: this.toIssuedCredential(token) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'TikTok rejected the refresh token. The account needs to be reconnected.',
        };
      }
      throw error;
    }
  }

  private async token(fields: Record<string, string>): Promise<TokenResponse> {
    // Form-encoded, unlike every other TikTok endpoint. The client secret is in
    // the body rather than the URL for the usual reason.
    return this.client.request<TokenResponse>({
      path: '/v2/oauth/token/',
      method: 'POST',
      // Top-level fields, flat error strings — not the `data` envelope the
      // rest of the API uses.
      oauth: true,
      form: {
        client_key: this.client.clientKey,
        client_secret: this.client.clientSecret,
        ...fields,
      },
    });
  }

  private toIssuedCredential(token: TokenResponse): IssuedCredential {
    if (!token.access_token) {
      throw toAppError('TIKTOK', {
        kind: 'AUTHENTICATION',
        message: 'TikTok returned no access token',
      });
    }

    const now = clock.nowMs();

    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: new Date(now + token.expires_in * 1000) } : {}),
      ...(token.refresh_expires_in
        ? { refreshableUntil: new Date(now + token.refresh_expires_in * 1000) }
        : {}),
      // TikTok returns the scopes actually granted, which may be fewer than
      // those asked for — a user can decline individually.
      scopes: token.scope
        ? token.scope.split(',').map((s) => s.trim())
        : [...TIKTOK_DEFAULT_SCOPES],
    };
  }

  /**
   * Read back who authorized, asking only for fields the grant covers.
   *
   * **The field list follows the granted scopes, not our wish list.** Asking
   * for one field the user did not grant fails the entire request with
   * `scope_not_authorized` — TikTok does not return the rest and omit that one.
   * A fixed list therefore turns a partial grant into a connection that cannot
   * complete, which is exactly how the first live attempt failed: `username`
   * reads like basic profile data but sits behind `user.info.profile`.
   *
   * The upshot is that enabling `user.info.profile` on the TikTok app makes the
   * @handle appear on its own, with no change here.
   */
  private async fetchUserInfo(
    accessToken: string,
    grantedScopes: readonly string[],
    signal?: AbortSignal | undefined,
  ): Promise<NonNullable<UserInfoResponse['user']>> {
    const response = await this.client.request<UserInfoResponse>({
      path: '/v2/user/info/',
      accessToken,
      params: { fields: tiktokUserFieldsFor(grantedScopes) },
      ...(signal ? { signal } : {}),
    });

    return response.user ?? {};
  }

  // ── Health ────────────────────────────────────────────────────────────────

  /**
   * Expiry-driven, then probed.
   *
   * The expiry is authoritative in a way a Page token's is not — TikTok access
   * tokens genuinely last 24 hours — so a stored expiry in the past is a
   * verdict on its own and needs no call. Beyond that the cheapest real probe
   * is `/v2/user/info/`, which costs nothing and fails loudly on a dead token.
   */
  async probeHealth(
    credential: DecryptedCredential,
    _account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();
    const granted = credential.scopes;
    const missing = TIKTOK_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    if (credential.expiresAt && credential.expiresAt.getTime() <= clock.nowMs()) {
      // An expired access token with a live refresh token is not a broken
      // connection — the refresh sweep will fix it without anyone's help — but
      // `AccountHealth` has no "needs a refresh" state, and inventing one would
      // change the shared status enum for one platform. NEEDS_RECONNECT with a
      // message that says which case it is stays honest either way.
      const refreshable =
        Boolean(credential.refreshToken) &&
        (!credential.refreshableUntil || credential.refreshableUntil.getTime() > clock.nowMs());

      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        message: refreshable
          ? 'The TikTok access token has expired and will be refreshed automatically.'
          : 'The TikTok connection has expired and needs to be reconnected.',
        checkedAt,
      };
    }

    try {
      await this.fetchUserInfo(credential.accessToken, credential.scopes);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'TikTok no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // A transient failure is not a verdict on the account. Saying "unhealthy"
      // because TikTok had a bad minute would have somebody reconnect a
      // perfectly good connection.
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

  /**
   * Hand the authorization back.
   *
   * Disconnecting an account in Orbit must also tell TikTok, or the grant sits
   * on the creator's account looking active for a year. A revoke that fails is
   * *not* propagated: the local disconnect is the user's instruction and must
   * happen regardless — leaving an account connected because TikTok had a bad
   * minute would be the wrong way round.
   */
  async revoke(credential: DecryptedCredential, _account: { externalId: string }): Promise<void> {
    await this.client
      .request({
        path: '/v2/oauth/revoke/',
        method: 'POST',
        oauth: true,
        form: {
          client_key: this.client.clientKey,
          client_secret: this.client.clientSecret,
          token: credential.accessToken,
        },
      })
      .catch(() => undefined);
  }

  // ── Creator info ──────────────────────────────────────────────────────────

  /**
   * The creator's current posting options.
   *
   * Required before a direct post, and not merely as a formality: TikTok's
   * product guidance requires that these options are *shown* and the creator's
   * choice honoured. It is also the only place the per-account video duration
   * ceiling appears, which is why the capability descriptor has no
   * `maxDurationMs` — a fixed number there would be wrong for most accounts.
   *
   * Called by the composer as well as by publishing, so the person choosing
   * sees the same options the post will be sent with.
   */
  async fetchCreatorInfo(
    credential: DecryptedCredential,
    signal?: AbortSignal | undefined,
  ): Promise<TikTokCreatorInfo> {
    const info = await this.client.request<CreatorInfoResponse>({
      path: '/v2/post/publish/creator_info/query/',
      method: 'POST',
      accessToken: credential.accessToken,
      ...(signal ? { signal } : {}),
    });

    return {
      creatorUsername: info.creator_username ?? '',
      creatorNickname: info.creator_nickname ?? '',
      ...(info.creator_avatar_url ? { creatorAvatarUrl: info.creator_avatar_url } : {}),
      privacyLevelOptions: (info.privacy_level_options ?? []) as TikTokPrivacyLevel[],
      commentDisabled: info.comment_disabled ?? false,
      duetDisabled: info.duet_disabled ?? false,
      stitchDisabled: info.stitch_disabled ?? false,
      // 0 means "TikTok did not say", which the duration check reads as "no
      // per-account ceiling to enforce" rather than "zero seconds allowed".
      maxVideoPostDurationSec: info.max_video_post_duration_sec ?? 0,
    };
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /**
   * Publish, in the three or four calls TikTok requires.
   *
   *   POST creator_info/query   → the creator's current options (direct post)
   *   POST video|content/init   → publish_id, and an upload_url for FILE_UPLOAD
   *   PUT  upload_url × n       → the bytes, in order
   *   POST status/fetch (poll)  → PUBLISH_COMPLETE, or still working
   *
   * The `publish_id` is recorded before the first byte moves. Everything after
   * `init` is ambiguous if it fails — TikTok may still finish a publish whose
   * upload we lost track of — and that id is the only thing that can answer the
   * question afterwards.
   */
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
        altText: item.altText,
      })),
    });

    if (!validation.valid) {
      throw toAppError('TIKTOK', preflightRefusal('TIKTOK', validation));
    }

    const settings = readSettings(ctx.draft);
    const videos = ctx.media.filter((item) => item.kind === 'VIDEO');
    const images = ctx.media.filter((item) => item.kind === 'IMAGE');

    if (videos.length > 0 && images.length > 0) {
      throw toAppError('TIKTOK', {
        kind: 'MEDIA',
        message: 'A TikTok post is a video or a photo set, never both',
        userMessage: 'A TikTok post can hold a video or photos, but not both at once.',
      });
    }

    if (videos.length > 1) {
      throw toAppError('TIKTOK', {
        kind: 'MEDIA',
        message: 'TikTok publishes one video per post',
        userMessage: 'TikTok takes one video per post.',
      });
    }

    const caption = composeCaption(ctx.draft);

    // Direct posts must carry the creator's own choice. Asking here — not only
    // in the composer — is what makes a stale choice fail loudly rather than
    // post under a privacy level the creator did not pick.
    const creator =
      settings.postMode === 'DIRECT_POST'
        ? await this.fetchCreatorInfo(ctx.credential, ctx.signal)
        : undefined;

    if (creator) assertSettingsMatchCreator(settings, creator, videos[0]);

    // Attached to whatever the init call throws. TikTok's refusals name a
    // category — `unaudited_client_can_only_post_to_private_accounts` — without
    // saying which visibility was actually asked for, and that is the one fact
    // needed to tell "they picked public" from "even private is refused".
    const init = await this.initWithContext(ctx, videos, images, caption, settings);

    if (!init.publishId) {
      throw toAppError('TIKTOK', {
        kind: 'UNAVAILABLE',
        message: 'TikTok accepted the request but returned no publish_id',
      });
    }

    // Before a single byte moves. An id written afterwards would not exist in
    // exactly the case it is needed for.
    await ctx.recordProviderRef?.({ publishId: init.publishId, postMode: settings.postMode });

    if (init.uploadUrl && videos.length === 1) {
      await this.uploadInChunks(videos[0]!, init.uploadUrl, ctx.signal);
    }

    const settled = await this.pollUntilSettled(
      ctx.credential,
      init.publishId,
      settings.postMode,
      ctx.signal,
    );

    return {
      externalPostId: settled.externalPostId,
      ...(settled.permalink ? { permalink: settled.permalink } : {}),
      publishedAt: clock.now(),
      providerMeta: {
        publishId: init.publishId,
        postMode: settings.postMode,
        apiVersion: this.client.apiVersion,
        ...(settings.privacyLevel ? { privacyLevel: settings.privacyLevel } : {}),
        // True when the post is in the creator's inbox rather than on their
        // profile. The publishing page reads this to say which happened.
        awaitingCreator: settled.awaitingCreator,
      },
    };
  }

  private async initWithContext(
    ctx: PublishContext,
    videos: readonly PublishMedia[],
    images: readonly PublishMedia[],
    caption: string,
    settings: TikTokPostSettings,
  ): Promise<{ publishId?: string | undefined; uploadUrl?: string | undefined }> {
    try {
      return videos.length === 1
        ? await this.initVideo(ctx, videos[0]!, caption, settings)
        : await this.initPhotos(ctx, images, caption, settings);
    } catch (error) {
      const context = (error as { context?: Record<string, unknown> }).context;
      if (context) {
        context['requestedPrivacyLevel'] = settings.privacyLevel ?? 'unset';
        context['requestedPostMode'] = settings.postMode;
      }
      throw error;
    }
  }

  private async initVideo(
    ctx: PublishContext,
    video: PublishMedia,
    caption: string,
    settings: TikTokPostSettings,
  ): Promise<{ publishId?: string | undefined; uploadUrl?: string | undefined }> {
    const chunk = planChunks(video.sizeBytes);

    const path =
      settings.postMode === 'DIRECT_POST'
        ? '/v2/post/publish/video/init/'
        : '/v2/post/publish/inbox/video/init/';

    const response = await this.client.request<InitResponse>({
      path,
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: {
        // Upload mode takes no post_info at all — the creator writes the
        // caption themselves in TikTok's editor, and sending one would be
        // silently dropped rather than rejected.
        ...(settings.postMode === 'DIRECT_POST'
          ? {
              post_info: {
                title: caption,
                privacy_level: settings.privacyLevel,
                disable_comment: settings.disableComment ?? false,
                disable_duet: settings.disableDuet ?? false,
                disable_stitch: settings.disableStitch ?? false,
              },
            }
          : {}),
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: video.sizeBytes,
          chunk_size: chunk.chunkSize,
          total_chunk_count: chunk.totalChunks,
        },
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return { publishId: response.publish_id, uploadUrl: response.upload_url };
  }

  /**
   * Photo posts, which take a different endpoint and a different shape.
   *
   * `content/init` requires `media_type` and `post_mode` in the body, where the
   * video endpoint infers both from the path — and it accepts image URLs only.
   * There is no FILE_UPLOAD for photos, so this path does need TikTok to fetch
   * from our signed URLs, and a client whose domain is unverified will see
   * `url_ownership_unverified` say so precisely.
   */
  private async initPhotos(
    ctx: PublishContext,
    images: readonly PublishMedia[],
    caption: string,
    settings: TikTokPostSettings,
  ): Promise<{ publishId?: string | undefined; uploadUrl?: string | undefined }> {
    const response = await this.client.request<InitResponse>({
      path: '/v2/post/publish/content/init/',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: {
        media_type: 'PHOTO',
        post_mode: settings.postMode,
        post_info: {
          title: caption.slice(0, 90),
          description: caption,
          privacy_level: settings.privacyLevel,
          disable_comment: settings.disableComment ?? false,
          auto_add_music: true,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: images.map((image) => image.url),
        },
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return { publishId: response.publish_id, uploadUrl: response.upload_url };
  }

  /**
   * Send the file, sequentially, one chunk at a time.
   *
   * Sequential because TikTok requires it, and one chunk in memory at a time
   * because a 4 GB video must never be resident — `readMediaRange` asks for a
   * range rather than a whole file for exactly that reason.
   */
  private async uploadInChunks(
    video: PublishMedia,
    uploadUrl: string,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const read = this.options.readMediaRange;
    if (!read) {
      throw toAppError('TIKTOK', {
        kind: 'UNAVAILABLE',
        message:
          'TikTok is configured without a media reader, so bytes cannot be uploaded. Wire readMediaRange when constructing the provider.',
      });
    }

    const plan = planChunks(video.sizeBytes);

    for (let index = 0; index < plan.totalChunks; index += 1) {
      const firstByte = index * plan.chunkSize;
      // The final chunk absorbs the trailing bytes rather than becoming a
      // short one, which TikTok would refuse for being under 5 MB.
      const lastByte =
        index === plan.totalChunks - 1
          ? video.sizeBytes - 1
          : Math.min(firstByte + plan.chunkSize - 1, video.sizeBytes - 1);

      const body = await read({ media: video, firstByte, lastByte, ...(signal ? { signal } : {}) });

      await this.client.uploadChunk({
        uploadUrl,
        body,
        mimeType: video.mimeType,
        firstByte,
        lastByte,
        totalBytes: video.sizeBytes,
        ...(signal ? { signal } : {}),
      });
    }
  }

  /**
   * Wait for TikTok to finish, within a budget.
   *
   * Running out of budget is **not** a failure and must never be reported as
   * one: the publish is still in flight and may well succeed. It throws a
   * timeout, which the engine treats as an ambiguous outcome and resolves
   * through `reconcile` rather than by retrying (D-027). Retrying here would
   * publish the same video twice.
   */
  private async pollUntilSettled(
    credential: DecryptedCredential,
    publishId: string,
    postMode: TikTokPostMode,
    signal?: AbortSignal | undefined,
  ): Promise<{
    externalPostId: string;
    permalink?: string | undefined;
    awaitingCreator: boolean;
  }> {
    const budgetMs = this.options.pollBudgetMs ?? PUBLISH_POLL_BUDGET_MS;
    const intervalMs = this.options.pollIntervalMs ?? PUBLISH_POLL_INTERVAL_MS;
    const deadline = clock.nowMs() + budgetMs;

    for (;;) {
      const status = await this.fetchStatus(credential, publishId, signal);
      const settled = settlementFor(status, publishId, postMode);

      if (settled) return settled;

      if (clock.nowMs() >= deadline) {
        throw toAppError('TIKTOK', {
          kind: 'TIMEOUT',
          message: `TikTok is still processing publish ${publishId} after ${budgetMs}ms; the outcome is unknown`,
          userMessage: 'TikTok is still processing this post. We will confirm what happened.',
          meta: { publishId, lastStatus: status.status ?? 'unknown' },
        });
      }

      await sleep(intervalMs, signal);
    }
  }

  private async fetchStatus(
    credential: DecryptedCredential,
    publishId: string,
    signal?: AbortSignal | undefined,
  ): Promise<StatusResponse> {
    return this.client.request<StatusResponse>({
      path: '/v2/post/publish/status/fetch/',
      method: 'POST',
      accessToken: credential.accessToken,
      json: { publish_id: publishId },
      ...(signal ? { signal } : {}),
    });
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the publish we lost track of actually go out?
   *
   * TikTok answers this better than any other platform Orbit talks to. A
   * `publish_id` is scoped to one attempt, so `status/fetch` is a direct
   * question about *this* publish rather than a search of a listing for
   * something that resembles what we sent. There is no matching heuristic here
   * and no window to widen — either the id is known or it is not.
   *
   * Without a recorded id there is nothing honest to say, so this returns
   * INCONCLUSIVE and the engine parks the variant for a human. Guessing from a
   * video listing would risk calling somebody else's upload ours.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const publishId = ctx.providerRef?.['publishId'];
    const postMode = (ctx.providerRef?.['postMode'] as TikTokPostMode) ?? 'DIRECT_POST';

    if (typeof publishId !== 'string' || publishId.length === 0) {
      return {
        outcome: 'INCONCLUSIVE',
        reason:
          'No TikTok publish id was recorded for this attempt, so TikTok cannot be asked what happened to it.',
      };
    }

    let status: StatusResponse;
    try {
      status = await this.fetchStatus(ctx.credential, publishId, ctx.signal);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // A publish id TikTok no longer knows means the attempt never landed.
      if (code === 'PROVIDER_VALIDATION_ERROR') return { outcome: 'NOT_FOUND' };
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'TikTok could not be reached to confirm what happened to this post.',
      };
    }

    // Checked *before* `settlementFor`, which throws on FAILED because that is
    // the right shape during a publish. Here it is an answer, not an error:
    // TikTok is telling us nothing went out, which is exactly what reconcile
    // exists to find out. Letting the throw escape would turn a clean
    // "never landed" into an exception the engine reads as a new failure.
    if (status.status === 'FAILED') return { outcome: 'NOT_FOUND' };

    const settled = settlementFor(status, publishId, postMode);
    if (settled) {
      return {
        outcome: 'FOUND',
        externalPostId: settled.externalPostId,
        ...(settled.permalink ? { permalink: settled.permalink } : {}),
        publishedAt: clock.now(),
      };
    }

    // Still moving. Publishing again could post the same video twice, so this
    // parks rather than guesses.
    return {
      outcome: 'INCONCLUSIVE',
      reason: `TikTok still reports this publish as ${(status.status ?? 'in progress').toLowerCase()}; posting again could duplicate it.`,
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    const response = await this.client.request<VideoQueryResponse>({
      path: '/v2/video/query/',
      method: 'POST',
      accessToken: credential.accessToken,
      params: { fields: 'id,create_time,share_url' },
      json: { filters: { video_ids: [ref.externalPostId] } },
    });

    const video = response.videos?.[0];
    if (!video?.id) return { exists: false };

    return {
      exists: true,
      ...(video.share_url ? { permalink: video.share_url } : {}),
      ...(video.create_time ? { publishedAt: new Date(video.create_time * 1000) } : {}),
      createdByThisApp: true,
    };
  }

  /**
   * TikTok exposes no delete, and the descriptor says so
   * (`lifecycle.delete: false`), so nothing in the product should call this.
   * Saying why beats a request that fails like an outage.
   */
  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    void ref;
    void credential;

    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'TikTok does not allow deleting a post through the API',
      userMessage: 'TikTok posts have to be removed in the TikTok app.',
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /**
   * Per-video counters from the Display API.
   *
   * These are lifetime totals, not a series: TikTok reports what a video has
   * accumulated, with no way to ask for a date range. The range is accepted to
   * satisfy the interface and deliberately ignored — slicing a lifetime total
   * into daily buckets would invent data.
   */
  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    void range;

    const response = await this.client.request<VideoQueryResponse>({
      path: '/v2/video/query/',
      method: 'POST',
      accessToken: credential.accessToken,
      params: { fields: 'id,view_count,like_count,comment_count,share_count' },
      json: { filters: { video_ids: [ref.externalPostId] } },
    });

    const video = response.videos?.[0];
    const metrics: Record<string, number> = {};
    const availability: Record<string, 'AVAILABLE' | 'UNSUPPORTED'> = {};

    for (const name of TIKTOK_VIDEO_METRICS) {
      const value = video?.[name as keyof typeof video];
      if (typeof value === 'number') {
        metrics[name] = value;
        availability[name] = 'AVAILABLE';
      } else {
        // Absent is not zero. A video TikTok has not counted yet must read as
        // unavailable, or a fresh post looks like a failed one (SRS §18).
        availability[name] = 'UNSUPPORTED';
      }
    }

    return {
      metrics,
      availability,
      capturedAt: clock.now(),
      apiVersion: this.client.apiVersion,
    };
  }

  /**
   * TikTok's Display API has no account-level insights — no reach, no profile
   * views, no follower series. Summing videos would produce something that
   * looks like an account metric and is not one, so this refuses instead
   * (SRS §18, and `analytics.account: false` says the same in data).
   */
  async fetchAccountAnalytics(): Promise<MetricSet> {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'TikTok exposes no account-level analytics on the Display API',
      userMessage: 'TikTok does not publish account-level figures through its API.',
    });
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read TikTok's per-post settings off the draft.
 *
 * They ride in `providerOptions` rather than becoming first-class fields on
 * `VariantDraft`, because `privacy_level` and `disable_duet` mean nothing to
 * any other platform and the contract exists to keep platform vocabulary out
 * of the core.
 */
function readSettings(draft: VariantDraft): TikTokPostSettings {
  const raw = draft.providerOptions ?? {};

  const postMode = raw['postMode'] === 'MEDIA_UPLOAD' ? 'MEDIA_UPLOAD' : 'DIRECT_POST';

  return {
    postMode,
    ...(typeof raw['privacyLevel'] === 'string'
      ? { privacyLevel: raw['privacyLevel'] as TikTokPrivacyLevel }
      : {}),
    ...(typeof raw['disableComment'] === 'boolean'
      ? { disableComment: raw['disableComment'] }
      : {}),
    ...(typeof raw['disableDuet'] === 'boolean' ? { disableDuet: raw['disableDuet'] } : {}),
    ...(typeof raw['disableStitch'] === 'boolean' ? { disableStitch: raw['disableStitch'] } : {}),
  };
}

/**
 * Refuse a direct post whose settings do not match what the creator allows.
 *
 * Every check here maps to a TikTok rule that is about the creator's rights
 * rather than about data shape, which is why they are refused by name instead
 * of being sent and rejected: `privacy_level_option_mismatch` is flagged by
 * TikTok as a product-guidance violation, not a bad request.
 */
function assertSettingsMatchCreator(
  settings: TikTokPostSettings,
  creator: TikTokCreatorInfo,
  video: PublishMedia | undefined,
): void {
  if (!settings.privacyLevel) {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'A TikTok direct post requires a privacy level chosen by the creator',
      userMessage: 'Choose who can see this TikTok post before publishing it.',
    });
  }

  if (!creator.privacyLevelOptions.includes(settings.privacyLevel)) {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: `privacy_level ${settings.privacyLevel} is not among this creator's options (${creator.privacyLevelOptions.join(', ')})`,
      userMessage:
        'This account no longer offers the visibility chosen for this post. Pick one of its current options.',
    });
  }

  if (settings.disableComment === false && creator.commentDisabled) {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'The creator has comments turned off; the post cannot enable them',
      userMessage: 'This account has comments turned off on TikTok.',
    });
  }

  if (settings.disableDuet === false && creator.duetDisabled) {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'The creator has duet turned off; the post cannot enable it',
      userMessage: 'This account has duet turned off on TikTok.',
    });
  }

  if (settings.disableStitch === false && creator.stitchDisabled) {
    throw toAppError('TIKTOK', {
      kind: 'VALIDATION',
      message: 'The creator has stitch turned off; the post cannot enable it',
      userMessage: 'This account has stitch turned off on TikTok.',
    });
  }

  // The per-account ceiling, which is the only place this number exists.
  const durationMs = video?.durationMs;
  if (durationMs && creator.maxVideoPostDurationSec > 0) {
    const maxMs = creator.maxVideoPostDurationSec * 1000;
    if (durationMs > maxMs) {
      throw toAppError('TIKTOK', {
        kind: 'MEDIA',
        message: `Video is ${Math.round(durationMs / 1000)}s; this account allows ${creator.maxVideoPostDurationSec}s`,
        userMessage: `This account can post videos up to ${creator.maxVideoPostDurationSec} seconds.`,
      });
    }
  }
}

/**
 * Decide what a status response means, or `undefined` if it means "still
 * working".
 *
 * The two modes settle differently and conflating them would be a lie in one
 * direction or the other: `PUBLISH_COMPLETE` is a live post, while
 * `SEND_TO_USER_INBOX` means a notification arrived and **nothing is public**.
 * Upload mode is finished at that point as far as Orbit is concerned — there is
 * nothing further to wait for, and the creator may never act — so it settles,
 * flagged, rather than pretending to be a published post.
 */
function settlementFor(
  status: StatusResponse,
  publishId: string,
  postMode: TikTokPostMode,
):
  { externalPostId: string; permalink?: string | undefined; awaitingCreator: boolean } | undefined {
  const state = status.status as TikTokPublishStatus | undefined;

  if (state === 'FAILED') {
    // Each `fail_reason` is a different kind of problem with a different
    // remedy — and one of them, `internal`, is retryable. Collapsing them into
    // one media error threw away a post because TikTok had a bad minute.
    throw toAppError('TIKTOK', tiktokPublishFailure(status.fail_reason, publishId));
  }

  if (state === 'PUBLISH_COMPLETE') {
    // TikTok has shipped this field under two spellings; both are read so a
    // corrected typo on their side does not become a lost post id here.
    const postId =
      status.publicly_available_post_id?.[0] ?? status.publicaly_available_post_id?.[0];

    return {
      // Falling back to the publish id keeps the post traceable when TikTok
      // returns none — which happens for private posts, where there is no
      // publicly available id by definition.
      externalPostId: postId ?? publishId,
      ...(postId ? { permalink: `https://www.tiktok.com/video/${postId}` } : {}),
      awaitingCreator: false,
    };
  }

  if (state === 'SEND_TO_USER_INBOX' && postMode === 'MEDIA_UPLOAD') {
    return { externalPostId: publishId, awaitingCreator: true };
  }

  return undefined;
}

/**
 * Split a file into chunks TikTok will accept.
 *
 * The rules are unusual enough to be worth stating: chunks must be 5–64 MB,
 * `total_chunk_count` is the size divided by the chunk size **rounded down**,
 * and the final chunk swallows the remainder rather than being a short one. A
 * file under 5 MB cannot be chunked at all and goes as a single piece.
 */
export function planChunks(sizeBytes: number): { chunkSize: number; totalChunks: number } {
  // Anything up to the 64 MB chunk ceiling goes as one piece — a file under
  // 5 MB *must*, and one between 5 and 64 MB legally may. Reporting a
  // `chunk_size` larger than the file is the bug this replaces: TikTok would
  // have been told 64 MB chunks for a 50 MB video, and its own arithmetic
  // (size ÷ chunk_size, rounded down) makes that zero chunks.
  if (sizeBytes <= TIKTOK_CHUNK.maxBytes) {
    return { chunkSize: sizeBytes, totalChunks: 1 };
  }

  const chunkSize = TIKTOK_CHUNK.maxBytes;

  // Rounded down, per TikTok's rule, which is what leaves the remainder to the
  // final chunk. That chunk is therefore between one and two chunk-sizes —
  // at most 128 MB, which is exactly the ceiling TikTok documents for it.
  const totalChunks = Math.floor(sizeBytes / chunkSize);

  return { chunkSize, totalChunks };
}

/** Hashtags belong in the caption on TikTok, which is where creators put them. */
function composeCaption(draft: VariantDraft): string {
  const tags = (draft.hashtags ?? [])
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .join(' ');

  return [draft.body?.trim(), tags].filter((part) => part && part.length > 0).join('\n\n');
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
