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
import { PinterestClient, type PinterestClientOptions } from './client.js';
import {
  PINTEREST_AUTHORIZE_URL,
  PINTEREST_PIN_METRICS,
  PINTEREST_PUBLISH_SCOPES,
  pinterestCapabilities,
} from './capabilities.js';

/**
 * Pinterest adapter.
 *
 * ## Two things Orbit refuses to decide for a client
 *
 * **Which board.** A pin without a board is not a pin, and Pinterest offers no
 * default. Filing a client's content under whichever board happened to come
 * back first would be an editorial choice made by a machine, so a post with no
 * board is refused before anything is uploaded — the same reasoning as TikTok's
 * privacy level (**D-086**) and YouTube's made-for-kids declaration.
 *
 * **What the cover looks like.** A video pin requires a cover image, and
 * Pinterest will not take a frame from the video for you. Orbit does not
 * generate one either: the post carries a second, image attachment, and a
 * video with no cover is refused with a message saying to add one. Generating a
 * still would put an unreviewed image in front of a client's audience.
 *
 * ## The video path has three round trips before the pin exists
 *
 *   POST /v5/media          → media_id + a bucket URL and its policy fields
 *   POST {bucket}           → the bytes, to somebody else's host entirely
 *   GET  /v5/media/{id}     → until Pinterest finishes transcoding
 *   POST /v5/pins           → the pin
 *
 * `media_id` is recorded through `recordProviderRef` before the bytes move, and
 * a retry that finds one **resumes at the polling step**. Without that a slow
 * video could never publish: every attempt would re-register, re-upload and run
 * out of budget at the same place in the transcode.
 */

const MEDIA_POLL_BUDGET_MS = 45_000;
const MEDIA_POLL_INTERVAL_MS = 5_000;
/** Refresh once the token is within a day of expiring. Pinterest's last 30. */
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PinterestProviderOptions extends PinterestClientOptions {
  /**
   * How the worker reads a video's bytes.
   *
   * Injected, like TikTok's and LinkedIn's: `@orbit/providers` must not depend
   * on storage. Only video needs it — an image pin is created from a URL that
   * Pinterest fetches itself.
   */
  readMedia?: ((media: PublishMedia) => Promise<Uint8Array>) | undefined;
  pollBudgetMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

/** Per-post settings that exist only here. */
export interface PinterestSettings {
  /** Required. Deliberately has no default — see the note above. */
  boardId?: string | undefined;
  /** Optional section within the board. */
  boardSectionId?: string | undefined;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

interface UserAccountResponse {
  username?: string;
  id?: string;
  profile_image?: string;
  account_type?: string;
  business_name?: string;
}

interface MediaRegisterResponse {
  media_id?: string;
  media_type?: string;
  upload_url?: string;
  upload_parameters?: Record<string, string>;
}

interface MediaStatusResponse {
  media_id?: string;
  status?: string;
}

interface PinResponse {
  id?: string;
  created_at?: string;
  title?: string;
  link?: string;
  board_id?: string;
}

interface PinListResponse {
  items?: PinResponse[];
}

interface AnalyticsResponse {
  all?: { summary_metrics?: Record<string, number> };
  ALL?: { summary_metrics?: Record<string, number> };
}

export class PinterestProvider implements SocialProvider {
  readonly platform: Platform = 'PINTEREST';

  private readonly client: PinterestClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: PinterestProviderOptions) {
    this.client = new PinterestClient(options);
    this.capabilityCache = pinterestCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = [...new Set([...PINTEREST_PUBLISH_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(PINTEREST_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    // Pinterest joins scopes with commas, not the spaces every other platform
    // here uses. A space-joined list is accepted and then silently grants
    // nothing, which surfaces much later as a 403 on the first publish.
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('state', input.state);

    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const token = (await this.client.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    })) as TokenResponse;

    const credential = this.toIssuedCredential(token);
    const account = await this.fetchAccount(credential.accessToken);

    return { userCredential: credential, accounts: [{ ...account, credential }] };
  }

  /**
   * The one account behind this token.
   *
   * Unlike Meta, a Pinterest authorization grants exactly one account — there
   * is no list to choose from. The connect flow still shows a chooser with one
   * row rather than a special case, because the alternative is a second code
   * path for one platform.
   */
  private async fetchAccount(accessToken: string) {
    const response = await this.client.request<UserAccountResponse>({
      path: '/user_account',
      accessToken,
    });

    const account = response.body;
    const id = account.id ?? account.username;

    if (!id) {
      throw toAppError('PINTEREST', {
        kind: 'AUTHENTICATION',
        message: 'Pinterest returned an account with no identifier',
      });
    }

    return {
      externalId: id,
      displayName: account.business_name || account.username || id,
      ...(account.username ? { handle: account.username } : {}),
      ...(account.profile_image ? { avatarUrl: account.profile_image } : {}),
      accountType: 'PINTEREST_ACCOUNT',
    };
  }

  private toIssuedCredential(token: TokenResponse): IssuedCredential {
    if (!token.access_token) {
      throw toAppError('PINTEREST', {
        kind: 'AUTHENTICATION',
        message: 'Pinterest returned no access token',
      });
    }

    const now = clock.nowMs();

    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: new Date(now + token.expires_in * 1000) } : {}),
      /**
       * Verified: the access token lasts 30 days and the refresh token 60, and
       * a refresh inside that window issues both again — so an account that
       * publishes at all never needs reconnecting. Recorded honestly, because
       * an account idle for two months genuinely does need a human, and the
       * sweep should say so before the first publish fails.
       */
      ...(token.refresh_token_expires_in
        ? { refreshableUntil: new Date(now + token.refresh_token_expires_in * 1000) }
        : {}),
      scopes: token.scope
        ? token.scope.split(/[,\s]+/).filter(Boolean)
        : [...PINTEREST_PUBLISH_SCOPES],
    };
  }

  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    if (!credential.refreshToken) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason: 'No Pinterest refresh token is stored, so this connection cannot be renewed.',
      };
    }

    const now = clock.nowMs();

    if (credential.refreshableUntil && credential.refreshableUntil.getTime() <= now) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason:
          'The Pinterest refresh token expired after 60 days without use. The account needs to be reconnected.',
      };
    }

    if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
      return { status: 'STILL_VALID' };
    }

    try {
      const token = (await this.client.token({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      })) as TokenResponse;

      const issued = this.toIssuedCredential(token);

      return {
        status: 'REFRESHED',
        credential: {
          ...issued,
          /**
           * Pinterest only returns a new refresh token when the app is
           * configured to rotate them. Taking the response at face value would
           * drop the existing one on every ordinary refresh and turn a
           * self-sustaining connection into a 30-day one.
           */
          refreshToken: token.refresh_token ?? credential.refreshToken,
          ...(token.refresh_token_expires_in || !credential.refreshableUntil
            ? {}
            : { refreshableUntil: credential.refreshableUntil }),
        },
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'Pinterest rejected the refresh token. The account needs to be reconnected.',
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
    const missing = PINTEREST_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    try {
      await this.client.request<UserAccountResponse>({
        path: '/user_account',
        accessToken: credential.accessToken,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'Pinterest no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // A 429 or an outage is not a verdict on the account. Rethrown so the
      // sweep records it without demoting a working connection.
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

  /** Pinterest exposes no revoke endpoint; disconnecting deletes the token here. */
  async revoke(): Promise<void> {
    return;
  }

  // ── Boards ────────────────────────────────────────────────────────────────

  /**
   * The boards this account can pin to, for the picker.
   *
   * Not part of `SocialProvider` — it is Pinterest's alone, and promoting it to
   * the shared interface would put one platform's vocabulary into the contract
   * every platform implements. The route that needs it reaches for this
   * provider by name.
   */
  async listBoards(
    credential: DecryptedCredential,
  ): Promise<Array<{ id: string; name: string; privacy: string }>> {
    const response = await this.client.request<{
      items?: Array<{ id?: string; name?: string; privacy?: string }>;
    }>({
      path: '/boards',
      accessToken: credential.accessToken,
      params: { page_size: 100 },
    });

    return (response.body.items ?? [])
      .filter((board): board is { id: string; name?: string; privacy?: string } =>
        Boolean(board.id),
      )
      .map((board) => ({
        id: board.id,
        name: board.name ?? board.id,
        privacy: board.privacy ?? 'PUBLIC',
      }));
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
      throw toAppError('PINTEREST', preflightRefusal('PINTEREST', validation));
    }

    const settings = readSettings(ctx.draft);

    if (!settings.boardId) {
      throw toAppError('PINTEREST', {
        kind: 'VALIDATION',
        message: 'A Pinterest pin needs a board and Orbit will not choose one',
        userMessage: 'Choose which Pinterest board this pin belongs on before publishing.',
      });
    }

    const video = ctx.media.find((item) => item.kind === 'VIDEO');
    const image = ctx.media.find((item) => item.kind === 'IMAGE' || item.kind === 'GIF');

    if (!video && !image) {
      throw toAppError('PINTEREST', {
        kind: 'MEDIA',
        message: 'Pinterest has no text-only pin',
        userMessage: 'A Pinterest pin needs an image or a video.',
      });
    }

    const body = ctx.draft.body.trim();

    const mediaSource = video
      ? await this.prepareVideo(ctx, video, image)
      : {
          source_type: 'image_url',
          url: (image as PublishMedia).url,
        };

    if (!video) {
      // The video path already recorded `media_id`; the image path has nothing
      // to record until now, and `POST /v5/pins` is the ambiguous call.
      await ctx.recordProviderRef?.({ contentHash: ctx.contentHash, kind: 'image' });
    }

    const created = await this.client.request<PinResponse>({
      path: '/pins',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: {
        board_id: settings.boardId,
        ...(settings.boardSectionId ? { board_section_id: settings.boardSectionId } : {}),
        title: titleFrom(body),
        description: body,
        ...(ctx.draft.linkUrl ? { link: ctx.draft.linkUrl } : {}),
        ...(video?.altText || image?.altText
          ? { alt_text: (video?.altText ?? image?.altText ?? '').slice(0, 500) }
          : {}),
        media_source: mediaSource,
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const pinId = created.body.id;
    if (!pinId) {
      throw toAppError('PINTEREST', {
        kind: 'UNAVAILABLE',
        message: 'Pinterest accepted the pin but returned no id',
      });
    }

    return {
      externalPostId: pinId,
      permalink: `https://www.pinterest.com/pin/${pinId}/`,
      publishedAt: created.body.created_at ? new Date(created.body.created_at) : clock.now(),
      providerMeta: {
        boardId: settings.boardId,
        apiVersion: this.client.apiVersion,
        pinKind: video ? 'video' : 'image',
      },
    };
  }

  /**
   * Register, upload and wait for a video, then describe it as a media source.
   *
   * The cover is checked *first*, before a byte moves: uploading a video and
   * then discovering there is nothing to put on the front of it wastes minutes
   * of transcode and tells the person the same thing either way.
   */
  private async prepareVideo(
    ctx: PublishContext,
    video: PublishMedia,
    cover: PublishMedia | undefined,
  ): Promise<Record<string, unknown>> {
    if (!cover) {
      throw toAppError('PINTEREST', {
        kind: 'MEDIA',
        message: 'Pinterest requires a cover image for a video pin and Orbit will not invent one',
        userMessage:
          'Pinterest shows a cover image wherever the video is not playing. Add an image to this post to use as the cover.',
      });
    }

    const read = this.options.readMedia;
    if (!read) {
      throw toAppError('PINTEREST', {
        kind: 'UNAVAILABLE',
        message:
          'Pinterest is configured without a media reader, so no video can be uploaded. Wire readMedia when constructing the provider.',
      });
    }

    /**
     * Resume rather than restart.
     *
     * A retry that finds the media id it registered last time skips straight to
     * polling. Re-registering would upload the file again and restart a
     * transcode that was already running, so a video slower than one budget
     * could never publish — every attempt would stop at the same point.
     */
    const resumed =
      typeof ctx.previousRef?.['mediaId'] === 'string' &&
      ctx.previousRef['contentHash'] === ctx.contentHash
        ? (ctx.previousRef['mediaId'] as string)
        : undefined;

    let mediaId = resumed;

    if (!mediaId) {
      const registered = await this.client.request<MediaRegisterResponse>({
        path: '/media',
        method: 'POST',
        accessToken: ctx.credential.accessToken,
        json: { media_type: 'video' },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      const {
        media_id: id,
        upload_url: uploadUrl,
        upload_parameters: parameters,
      } = registered.body;

      if (!id || !uploadUrl) {
        throw toAppError('PINTEREST', {
          kind: 'UNAVAILABLE',
          message: 'Pinterest registered no upload destination for this video',
        });
      }

      // Before the bytes move: a retry must be able to find this again.
      await ctx.recordProviderRef?.({ mediaId: id, contentHash: ctx.contentHash, kind: 'video' });

      await this.client.uploadMedia({
        uploadUrl,
        parameters: parameters ?? {},
        body: await read(video),
        fileName: fileNameFor(video),
        mimeType: video.mimeType,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      mediaId = id;
    }

    await this.awaitMedia(ctx, mediaId);

    return {
      source_type: 'video_id',
      media_id: mediaId,
      /**
       * Pinterest fetches this URL itself, server-side, while the pin is being
       * created. Orbit's signed media URLs outlive a single request by a wide
       * margin, so the fetch lands — but this is the one place where a shortened
       * signing window would break publishing rather than a preview.
       */
      cover_image_url: cover.url,
    };
  }

  /**
   * Wait for Pinterest to finish transcoding.
   *
   * `failed` is terminal. Running out of budget is **not** ambiguous: no pin
   * has been created, so nothing went out and there is nothing to reconcile —
   * an `UNAVAILABLE` retries with backoff and the retry resumes this same media
   * id rather than starting the upload again.
   */
  private async awaitMedia(ctx: PublishContext, mediaId: string): Promise<void> {
    const budgetMs = this.options.pollBudgetMs ?? MEDIA_POLL_BUDGET_MS;
    const intervalMs = this.options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
    const deadline = clock.nowMs() + budgetMs;

    for (;;) {
      const status = await this.client.request<MediaStatusResponse>({
        path: `/media/${mediaId}`,
        accessToken: ctx.credential.accessToken,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      const state = status.body.status ?? 'unknown';

      if (state === 'succeeded') return;

      if (state === 'failed') {
        throw toAppError('PINTEREST', {
          kind: 'MEDIA',
          message: `Pinterest could not process the video (media ${mediaId})`,
          userMessage: 'Pinterest could not process this video. Try re-exporting it.',
          meta: { mediaId },
        });
      }

      if (clock.nowMs() >= deadline) {
        throw toAppError('PINTEREST', {
          kind: 'UNAVAILABLE',
          message: `Pinterest is still processing media ${mediaId}; no pin has been created`,
          userMessage: 'Pinterest is still processing this video. We will try again shortly.',
          retryAfterSeconds: 60,
          meta: { mediaId, lastStatus: state },
        });
      }

      await sleep(intervalMs, ctx.signal);
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the pin we lost track of get created?
   *
   * Pinterest offers nothing to ask about a *specific* attempt — the media id
   * says the video uploaded, not that a pin exists — so this lists the account's
   * recent pins and matches title within the attempt window. Weaker than a
   * handle, which is why the window is bounded and an unreachable API is
   * INCONCLUSIVE rather than NOT_FOUND: reporting "no pin" because the listing
   * failed would publish it a second time.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;
    const expected = titleFrom(ctx.body.trim());

    let listing;
    try {
      listing = await this.client.request<PinListResponse>({
        path: '/pins',
        accessToken: ctx.credential.accessToken,
        params: { page_size: 50 },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch {
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'Pinterest could not be reached to confirm whether this pin was created.',
      };
    }

    const match = (listing.body.items ?? []).find((pin) => {
      if (!pin.id || !pin.created_at) return false;
      const at = Date.parse(pin.created_at);
      if (Number.isNaN(at) || at < lower || at > upper) return false;
      return (pin.title ?? '') === expected;
    });

    if (!match?.id) return { outcome: 'NOT_FOUND' };

    return {
      outcome: 'FOUND',
      externalPostId: match.id,
      permalink: `https://www.pinterest.com/pin/${match.id}/`,
      publishedAt: match.created_at ? new Date(match.created_at) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const response = await this.client.request<PinResponse>({
        path: `/pins/${ref.externalPostId}`,
        accessToken: credential.accessToken,
      });

      if (!response.body.id) return { exists: false };

      return {
        exists: true,
        permalink: `https://www.pinterest.com/pin/${response.body.id}/`,
        ...(response.body.created_at ? { publishedAt: new Date(response.body.created_at) } : {}),
        createdByThisApp: true,
      };
    } catch {
      return { exists: false };
    }
  }

  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    await this.client.request<Record<string, never>>({
      path: `/pins/${ref.externalPostId}`,
      method: 'DELETE',
      accessToken: credential.accessToken,
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    const response = await this.client.request<AnalyticsResponse>({
      path: `/pins/${ref.externalPostId}/analytics`,
      accessToken: credential.accessToken,
      params: {
        start_date: isoDate(range.from),
        end_date: isoDate(range.to),
        metric_types: PINTEREST_PIN_METRICS.join(','),
      },
    });

    // Pinterest keys the split by `ALL` when no split was requested; the
    // lower-case form appears in some responses, so both are accepted rather
    // than reporting nothing because of a casing difference.
    const summary = response.body.ALL?.summary_metrics ?? response.body.all?.summary_metrics ?? {};

    const metrics: Record<string, number> = {};
    const availability: Record<string, 'AVAILABLE' | 'UNSUPPORTED'> = {};

    for (const name of PINTEREST_PIN_METRICS) {
      const value = summary[name];

      if (typeof value === 'number' && Number.isFinite(value)) {
        metrics[name] = value;
        availability[name] = 'AVAILABLE';
      } else {
        /**
         * The video metrics are simply absent on an image pin, and Pinterest
         * omits rather than zeroes them. Storing 0 would report a video nobody
         * watched for a pin that has no video at all (SRS §18).
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
    throw toAppError('PINTEREST', {
      kind: 'VALIDATION',
      message: 'Pinterest account analytics are not built',
      userMessage: 'Orbit does not collect account-level Pinterest figures yet.',
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

function readSettings(draft: VariantDraft): PinterestSettings {
  const raw = draft.providerOptions ?? {};

  return {
    ...(typeof raw['boardId'] === 'string' && raw['boardId'].length > 0
      ? { boardId: raw['boardId'] }
      : {}),
    ...(typeof raw['boardSectionId'] === 'string' && raw['boardSectionId'].length > 0
      ? { boardSectionId: raw['boardSectionId'] }
      : {}),
  };
}

/**
 * The pin title, from a body written for a feed: the first line, capped at
 * Pinterest's 100 characters. Same shape as YouTube's, and for the same reason.
 */
export function titleFrom(body: string): string {
  return (body.split('\n')[0] ?? '').trim().slice(0, 100);
}

/**
 * A file name for the multipart part. The bucket does not care what it is, but
 * an extension that matches the bytes keeps the stored object recognisable.
 */
function fileNameFor(media: PublishMedia): string {
  const extension = media.mimeType === 'video/quicktime' ? 'mov' : 'mp4';
  return `${media.id}.${extension}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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
