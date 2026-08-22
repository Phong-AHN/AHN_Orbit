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
import { YouTubeClient, type YouTubeClientOptions } from './client.js';
import {
  YOUTUBE_AUTHORIZE_URL,
  YOUTUBE_PRIVACY,
  YOUTUBE_PUBLISH_SCOPES,
  YOUTUBE_VIDEO_METRICS,
  youtubeCapabilities,
  type YouTubePrivacy,
} from './capabilities.js';

/**
 * YouTube adapter.
 *
 * ## The declaration Orbit refuses to make on somebody's behalf
 *
 * YouTube requires every upload to state whether the video is **made for
 * children**. That is not a preference — it is an audience declaration under
 * COPPA, it changes what YouTube does with comments, personalised ads and
 * notifications, and getting it wrong has cost creators money.
 *
 * So this adapter has no default. A post with no declaration is refused before
 * anything is uploaded, with a message that says what to choose. Picking
 * `false` silently would be making a legal statement on a client's behalf that
 * nobody in the agency ever saw — the same reasoning that keeps TikTok's
 * privacy level un-defaulted (**D-086**).
 *
 * ## A Short is not a mode
 *
 * YouTube classifies an upload as a Short when it is vertical and short enough.
 * There is no flag, no separate endpoint, and nothing here pretends otherwise —
 * a "post as a Short" switch would be a control the platform does not have.
 *
 * ## Uploading is a two-request dance
 *
 *   POST /upload/youtube/v3/videos?uploadType=resumable  → a session URL
 *   PUT  {session URL}                                    → the bytes, the video
 *
 * The session URL is recorded through `recordProviderRef` before the bytes
 * move, because everything after the session opens is ambiguous on failure:
 * YouTube may have finished an upload whose response we lost.
 */

/** Refresh once the token is within this of expiring. */
const REFRESH_WINDOW_MS = 10 * 60 * 1000;

export interface YouTubeProviderOptions extends YouTubeClientOptions {
  /**
   * How the worker reads the video's bytes.
   *
   * Injected, like TikTok's: `@orbit/providers` must not depend on storage.
   * YouTube will not fetch from a URL, so there is no way to hand over a signed
   * link and let the platform pull.
   */
  readMedia?: ((media: PublishMedia) => Promise<Uint8Array>) | undefined;
}

/** Per-post settings that exist only here. */
export interface YouTubeSettings {
  privacyStatus?: YouTubePrivacy | undefined;
  /** The COPPA declaration. Deliberately has no default. */
  madeForKids?: boolean | undefined;
  categoryId?: string | undefined;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface ChannelListResponse {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
  }>;
}

interface VideoListResponse {
  items?: Array<{
    id?: string;
    snippet?: { publishedAt?: string; title?: string };
    status?: { uploadStatus?: string; privacyStatus?: string };
    statistics?: Record<string, string>;
  }>;
}

export class YouTubeProvider implements SocialProvider {
  readonly platform: Platform = 'YOUTUBE';

  private readonly client: YouTubeClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: YouTubeProviderOptions) {
    this.client = new YouTubeClient(options);
    this.capabilityCache = youtubeCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * Google's dialog, with the two parameters that decide whether this
   * integration survives the night.
   *
   * `access_type=offline` is what asks for a refresh token at all, and
   * `prompt=consent` is what makes Google issue a *new* one — without it, a
   * second authorisation of an already-approved account returns an access token
   * and no refresh token, and the connection dies in an hour with nothing in
   * the logs to explain why.
   */
  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = [...new Set([...YOUTUBE_PUBLISH_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(YOUTUBE_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    // Google's tokens are short; without this the connection would need a
    // human within the hour.
    url.searchParams.set('include_granted_scopes', 'true');

    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const token = (await this.client.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
    })) as TokenResponse;

    const credential = this.toIssuedCredential(token);
    const channels = await this.discoverChannels(credential.accessToken);

    return { userCredential: credential, accounts: channels };
  }

  /**
   * The channels this Google account owns.
   *
   * A Google account is not a YouTube channel: plenty have none, and the API
   * says so with `youtubeSignupRequired` rather than an empty list. Returning
   * nothing here is a real state the connect flow explains, not a fault.
   */
  private async discoverChannels(accessToken: string) {
    const response = await this.client.request<ChannelListResponse>({
      path: '/youtube/v3/channels',
      accessToken,
      params: { part: 'snippet', mine: true, maxResults: 50 },
    });

    return (response.body.items ?? [])
      .filter((item) => item.id)
      .map((item) => ({
        externalId: item.id as string,
        displayName: item.snippet?.title ?? (item.id as string),
        ...(item.snippet?.customUrl ? { handle: item.snippet.customUrl } : {}),
        ...(item.snippet?.thumbnails?.default?.url
          ? { avatarUrl: item.snippet.thumbnails.default.url }
          : {}),
        accountType: 'CHANNEL',
        credential: {
          accessToken,
          scopes: [...YOUTUBE_PUBLISH_SCOPES],
        } satisfies IssuedCredential,
      }));
  }

  private toIssuedCredential(token: TokenResponse): IssuedCredential {
    if (!token.access_token) {
      throw toAppError('YOUTUBE', {
        kind: 'AUTHENTICATION',
        message: 'Google returned no access token',
      });
    }

    const now = clock.nowMs();

    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: new Date(now + token.expires_in * 1000) } : {}),
      /**
       * A Google refresh token does not expire on a schedule — it is revoked,
       * or it goes unused for six months, or the account changes its password.
       * There is no date to record, so none is: an invented one would have the
       * sweep give up on a connection that still works.
       */
      scopes: token.scope ? token.scope.split(' ').filter(Boolean) : [...YOUTUBE_PUBLISH_SCOPES],
    };
  }

  /**
   * Refresh, which here happens roughly hourly.
   *
   * Google's access tokens last an hour, so this is the busiest refresh path in
   * the product by a wide margin — every other platform measures its window in
   * weeks. The window is ten minutes rather than the usual days for exactly
   * that reason.
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    if (!credential.refreshToken) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason:
          'No Google refresh token is stored for this channel, so it cannot be renewed automatically.',
      };
    }

    const now = clock.nowMs();
    if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
      return { status: 'STILL_VALID' };
    }

    try {
      const token = (await this.client.token({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      })) as TokenResponse;

      return {
        status: 'REFRESHED',
        credential: {
          ...this.toIssuedCredential(token),
          /**
           * Google does **not** return the refresh token on a refresh. Taking
           * the response at face value would drop it and turn an hourly renewal
           * into a one-time one, so the existing token is carried forward.
           */
          refreshToken: token.refresh_token ?? credential.refreshToken,
        },
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'Google rejected the refresh token. The channel needs to be reconnected.',
        };
      }
      throw error;
    }
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async probeHealth(
    credential: DecryptedCredential,
    _account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();
    const granted = credential.scopes;
    const missing = YOUTUBE_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    /**
     * An expired access token is **not** a verdict here.
     *
     * Google's tokens last an hour, so an expired one is the normal state
     * between refreshes. Reporting NEEDS_RECONNECT on it would mark every
     * healthy channel broken several times a day — the opposite of what health
     * is for. Only a missing refresh token makes expiry terminal.
     */
    if (
      credential.expiresAt &&
      credential.expiresAt.getTime() <= clock.nowMs() &&
      !credential.refreshToken
    ) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        message: 'The YouTube connection expired and has no refresh token. Reconnect the channel.',
        checkedAt,
      };
    }

    try {
      await this.client.request<ChannelListResponse>({
        path: '/youtube/v3/channels',
        accessToken: credential.accessToken,
        params: { part: 'id', mine: true },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'YouTube no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // A quota failure is about the project, not the channel. Rethrown so the
      // sweep records it without demoting a working connection.
      throw error;
    }

    if (missing.length > 0) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        message: `This connection is missing ${missing.join(', ')}, so it cannot upload.`,
        checkedAt,
      };
    }

    return { status: 'ACTIVE', grantedScopes: granted, missingScopes: [], checkedAt };
  }

  /** Google has a revoke endpoint, but it kills the whole grant. See below. */
  async revoke(): Promise<void> {
    /**
     * Deliberately does nothing.
     *
     * `https://oauth2.googleapis.com/revoke` invalidates the credential for
     * **every channel** on that Google account, and Orbit connects channels
     * individually. Disconnecting one client's channel must not silently break
     * another client's. Local disconnection deletes the stored token, which is
     * the part that matters.
     */
    return;
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
      throw toAppError('YOUTUBE', preflightRefusal('YOUTUBE', validation));
    }

    const video = ctx.media[0];
    if (!video || video.kind !== 'VIDEO') {
      throw toAppError('YOUTUBE', {
        kind: 'MEDIA',
        message: 'YouTube publishes a video and nothing else',
        userMessage: 'A YouTube post needs a video.',
      });
    }

    const settings = readSettings(ctx.draft);

    /**
     * The declaration, refused rather than defaulted.
     *
     * This is a statement about a client's audience with regulatory weight.
     * Choosing for them — either way — would put words in their mouth that
     * nobody in the agency ever saw.
     */
    if (settings.madeForKids === undefined) {
      throw toAppError('YOUTUBE', {
        kind: 'VALIDATION',
        message: 'YouTube requires a made-for-kids declaration and Orbit will not assume one',
        userMessage:
          'YouTube needs to know whether this video is made for children. Choose that on the post before publishing.',
      });
    }

    const read = this.options.readMedia;
    if (!read) {
      throw toAppError('YOUTUBE', {
        kind: 'UNAVAILABLE',
        message:
          'YouTube is configured without a media reader, so nothing can be uploaded. Wire readMedia when constructing the provider.',
      });
    }

    const body = ctx.draft.body.trim();

    const session = await this.client.request<Record<string, never>>({
      path: '/upload/youtube/v3/videos',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      params: { uploadType: 'resumable', part: 'snippet,status' },
      headers: {
        // Google sizes the session from these; a mismatch fails the PUT rather
        // than the POST, which is much harder to read.
        'x-upload-content-type': video.mimeType,
        'x-upload-content-length': String(video.sizeBytes),
      },
      json: {
        snippet: {
          // The title is the first line and the description is the whole body.
          // A caption written for a feed has no title, and using all of it
          // would overflow the 100-character ceiling every time.
          title: titleFrom(body) || 'Untitled',
          description: body,
          ...(ctx.draft.hashtags && ctx.draft.hashtags.length > 0
            ? { tags: ctx.draft.hashtags.map((tag) => tag.replace(/^#/, '')) }
            : {}),
          ...(settings.categoryId ? { categoryId: settings.categoryId } : {}),
        },
        status: {
          privacyStatus: settings.privacyStatus ?? 'private',
          selfDeclaredMadeForKids: settings.madeForKids,
        },
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const sessionUrl = session.location;
    if (!sessionUrl) {
      throw toAppError('YOUTUBE', {
        kind: 'UNAVAILABLE',
        message: 'YouTube opened no resumable session (no Location header)',
      });
    }

    // Before the bytes move: everything after this point is ambiguous on
    // failure, and the session is the only handle that exists.
    await ctx.recordProviderRef?.({ sessionUrl, contentHash: ctx.contentHash });

    const uploaded = await this.client.uploadTo({
      sessionUrl,
      body: await read(video),
      mimeType: video.mimeType,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const videoId = typeof uploaded['id'] === 'string' ? uploaded['id'] : undefined;
    if (!videoId) {
      throw toAppError('YOUTUBE', {
        kind: 'UNAVAILABLE',
        message: 'YouTube accepted the upload but returned no video id',
      });
    }

    return {
      externalPostId: videoId,
      permalink: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: clock.now(),
      providerMeta: {
        channelId: ctx.account.externalId,
        apiVersion: this.client.apiVersion,
        privacyStatus: settings.privacyStatus ?? 'private',
        madeForKids: settings.madeForKids,
      },
    };
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the upload we lost track of become a video?
   *
   * YouTube offers no way to ask a session what became of it, so this searches
   * the channel's own uploads within the attempt window and matches on title.
   * Weaker than a handle, and said so — which is why the window is bounded and
   * an inconclusive answer parks rather than guesses.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;
    const expected = titleFrom(ctx.body.trim());

    let search;
    try {
      search = await this.client.request<VideoListResponse>({
        path: '/youtube/v3/search',
        accessToken: ctx.credential.accessToken,
        params: {
          part: 'snippet',
          forMine: true,
          type: 'video',
          order: 'date',
          maxResults: 25,
        },
      });
    } catch {
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'YouTube could not be reached to confirm whether this upload landed.',
      };
    }

    const match = (search.body.items ?? []).find((item) => {
      const publishedAt = item.snippet?.publishedAt;
      if (!item.id || !publishedAt) return false;
      const at = Date.parse(publishedAt);
      if (Number.isNaN(at) || at < lower || at > upper) return false;
      return (item.snippet?.title ?? '') === expected;
    });

    if (!match?.id) return { outcome: 'NOT_FOUND' };

    return {
      outcome: 'FOUND',
      externalPostId: match.id,
      permalink: `https://www.youtube.com/watch?v=${match.id}`,
      publishedAt: match.snippet?.publishedAt ? new Date(match.snippet.publishedAt) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const response = await this.client.request<VideoListResponse>({
        path: '/youtube/v3/videos',
        accessToken: credential.accessToken,
        params: { part: 'snippet,status', id: ref.externalPostId },
      });

      const video = response.body.items?.[0];
      if (!video?.id) return { exists: false };

      return {
        exists: true,
        permalink: `https://www.youtube.com/watch?v=${video.id}`,
        ...(video.snippet?.publishedAt ? { publishedAt: new Date(video.snippet.publishedAt) } : {}),
        createdByThisApp: true,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Deleting needs the broad `.../auth/youtube` scope, which Orbit does not ask
   * for — see the descriptor. `lifecycle.delete` is false, so nothing in the
   * product should reach this; explaining beats a 403 that reads like an outage.
   */
  async deletePost(): Promise<void> {
    throw toAppError('YOUTUBE', {
      kind: 'VALIDATION',
      message: 'Orbit does not hold the scope required to delete a YouTube video',
      userMessage: 'Videos have to be removed in YouTube Studio.',
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    // The Data API serves lifetime counters with no date range. Slicing them
    // into buckets would invent data, so the range is accepted and ignored.
    void range;

    const response = await this.client.request<VideoListResponse>({
      path: '/youtube/v3/videos',
      accessToken: credential.accessToken,
      params: { part: 'statistics', id: ref.externalPostId },
    });

    const statistics = response.body.items?.[0]?.statistics ?? {};
    const metrics: Record<string, number> = {};
    const availability: Record<string, 'AVAILABLE' | 'UNSUPPORTED'> = {};

    for (const name of YOUTUBE_VIDEO_METRICS) {
      const raw = statistics[name];
      const value = raw === undefined ? Number.NaN : Number(raw);

      if (Number.isFinite(value)) {
        metrics[name] = value;
        availability[name] = 'AVAILABLE';
      } else {
        /**
         * A channel can **hide** its like count, and YouTube then omits the
         * field entirely. Storing zero would report a video nobody liked, which
         * is a different and false claim (SRS §18).
         */
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

  async fetchAccountAnalytics(): Promise<MetricSet> {
    throw toAppError('YOUTUBE', {
      kind: 'VALIDATION',
      message: 'Channel analytics need the YouTube Analytics API, which is not built',
      userMessage: 'Orbit does not collect channel-level YouTube figures yet.',
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

function readSettings(draft: VariantDraft): YouTubeSettings {
  const raw = draft.providerOptions ?? {};

  const privacy = raw['privacyStatus'];
  const madeForKids = raw['madeForKids'];

  return {
    ...(typeof privacy === 'string' && (YOUTUBE_PRIVACY as readonly string[]).includes(privacy)
      ? { privacyStatus: privacy as YouTubePrivacy }
      : {}),
    ...(typeof madeForKids === 'boolean' ? { madeForKids } : {}),
    ...(typeof raw['categoryId'] === 'string' ? { categoryId: raw['categoryId'] } : {}),
  };
}

/**
 * The title, from a body written for a feed.
 *
 * The first line, capped at YouTube's 100 characters. A caption has no title
 * and using the whole thing would overflow every time — this is the closest
 * honest thing to one, and the composer counts against the same limit so what
 * somebody writes is what they see.
 */
export function titleFrom(body: string): string {
  return (body.split('\n')[0] ?? '').trim().slice(0, 100);
}
