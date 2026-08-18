import { clock, matchesPublishedText, type Platform } from '@orbit/core';
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
import { ThreadsClient, type ThreadsClientOptions } from './client.js';
import {
  THREADS_AUTHORIZE_URL,
  THREADS_DEFAULT_SCOPES,
  THREADS_POST_METRICS,
  THREADS_PUBLISH_SCOPES,
  threadsCapabilities,
} from './capabilities.js';

/**
 * Threads adapter.
 *
 * Meta's, and yet not one of the Meta adapters: its own host, its own
 * authorization window, its own app credentials. Meta's guide is explicit that
 * a Threads app issues **two** id/secret pairs and that the Threads one is what
 * these endpoints want — using the other produces an authentication failure
 * that reads like a bad token.
 *
 * ## What is different from Instagram, which it superficially resembles
 *
 * **The container needs time.** Meta asks for roughly 30 seconds between
 * creating a container and publishing it. Instagram's image containers are
 * usable at once and only Reels need waiting; here it applies to every post,
 * including text. Publishing therefore polls `status` and treats running out of
 * budget as a *timeout* the engine reconciles, never a failure — the container
 * id is recorded first, so the question stays answerable (**D-027**).
 *
 * **Text is a first-class post.** `media_type: TEXT` needs no media at all,
 * where Instagram cannot publish without an image. Threads is the only platform
 * here that publishes both text alone and media alone.
 *
 * **500 characters.** The shortest limit of any platform in the product, by a
 * factor of four against Instagram.
 *
 * ## Credential shape
 *
 *   authorization code
 *        ↓ POST /oauth/access_token
 *   short-lived token — 1 hour
 *        ↓ GET /access_token?grant_type=th_exchange_token
 *   long-lived token — 60 days, refreshable while it is still alive
 *
 * The refresh is the trap: `th_refresh_token` requires a token that has **not
 * yet expired**. A connection left untouched past sixty days cannot be
 * refreshed at all and has to be reconnected by a human, so the refresh sweep
 * matters more here than on a platform with a year-long window.
 */

/** Refresh once the token is within this of expiring. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long publishing waits for a container, and how often it asks. */
const CONTAINER_POLL_BUDGET_MS = 45_000;
const CONTAINER_POLL_INTERVAL_MS = 5_000;

export interface ThreadsProviderOptions extends ThreadsClientOptions {
  /**
   * Overridable so the "still processing" path is testable at all — forty-five
   * seconds of real waiting is a path that ends up untested.
   */
  pollBudgetMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

interface TokenResponse {
  access_token?: string;
  user_id?: string | number;
  token_type?: string;
  expires_in?: number;
}

interface ProfileResponse {
  id?: string;
  username?: string;
  name?: string;
  threads_profile_picture_url?: string;
}

interface ContainerResponse {
  id?: string;
}

interface StatusResponse {
  status?: string;
  error_message?: string;
}

interface PostResponse {
  id?: string;
  permalink?: string;
  timestamp?: string;
  text?: string;
}

interface PostsListResponse {
  data?: PostResponse[];
}

interface InsightsResponse {
  data?: Array<{
    name?: string;
    values?: Array<{ value?: number }>;
    total_value?: { value?: number };
  }>;
}

export class ThreadsProvider implements SocialProvider {
  readonly platform: Platform = 'THREADS';

  private readonly client: ThreadsClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: ThreadsProviderOptions) {
    this.client = new ThreadsClient(options);
    this.capabilityCache = threadsCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * The authorization window lives on `threads.net`, not on the API host and
   * not on `facebook.com`. Scopes are comma-delimited here.
   */
  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = [...new Set([...THREADS_PUBLISH_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(THREADS_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.client.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);

    return { url: url.toString(), scopes };
  }

  /**
   * Exchange the code, then immediately trade up to a long-lived token.
   *
   * The short-lived one lasts an hour, which is shorter than the gap between
   * connecting an account and the first scheduled post. Storing it would give a
   * connection that works during setup and is dead by morning, so the exchange
   * happens here rather than being left to the refresh sweep.
   */
  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const shortLived = await this.client.request<TokenResponse>({
      path: '/oauth/access_token',
      method: 'POST',
      unversioned: true,
      form: {
        client_id: this.client.appId,
        client_secret: this.client.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
        code: input.code,
      },
    });

    if (!shortLived.access_token) {
      throw toAppError('THREADS', {
        kind: 'AUTHENTICATION',
        message: 'Threads returned no access token',
      });
    }

    const credential = await this.exchangeForLongLived(shortLived.access_token);
    const profile = await this.fetchProfile(credential.accessToken);

    const externalId = profile.id ?? (shortLived.user_id ? String(shortLived.user_id) : undefined);
    if (!externalId) {
      throw toAppError('THREADS', {
        kind: 'AUTHENTICATION',
        message: 'Threads returned no user id, so the account cannot be identified',
      });
    }

    // One authorization, one account — there is no Page to walk through.
    return {
      accounts: [
        {
          externalId,
          displayName: profile.name ?? profile.username ?? 'Threads account',
          ...(profile.username ? { handle: profile.username } : {}),
          ...(profile.threads_profile_picture_url
            ? { avatarUrl: profile.threads_profile_picture_url }
            : {}),
          accountType: 'THREADS_USER',
          credential,
        },
      ],
    };
  }

  private async exchangeForLongLived(shortLivedToken: string): Promise<IssuedCredential> {
    const long = await this.client.request<TokenResponse>({
      path: '/access_token',
      unversioned: true,
      params: {
        grant_type: 'th_exchange_token',
        client_secret: this.client.appSecret,
        access_token: shortLivedToken,
      },
    });

    return this.toIssuedCredential(long);
  }

  private toIssuedCredential(token: TokenResponse): IssuedCredential {
    if (!token.access_token) {
      throw toAppError('THREADS', {
        kind: 'AUTHENTICATION',
        message: 'Threads returned no access token',
      });
    }

    const expiresAt = token.expires_in
      ? new Date(clock.nowMs() + token.expires_in * 1000)
      : undefined;

    return {
      accessToken: token.access_token,
      ...(expiresAt ? { expiresAt } : {}),
      /**
       * The same instant, deliberately.
       *
       * Threads has no separate refresh token: the long-lived token refreshes
       * *itself*, and only while it is still alive. So the last moment a
       * refresh can succeed is the moment the token expires — there is no grace
       * period, and pretending otherwise would let the sweep skip an account
       * until it was past saving.
       */
      ...(expiresAt ? { refreshableUntil: expiresAt } : {}),
      scopes: [...THREADS_PUBLISH_SCOPES],
    };
  }

  /**
   * Refresh, which on Threads means asking the token to renew itself.
   *
   * There is no refresh token. `th_refresh_token` takes the long-lived token
   * and returns another, and it only works while the current one is **still
   * valid** — an expired connection cannot be refreshed at all. That is why the
   * window here is a week rather than an hour: missing it costs a reconnection.
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    const now = clock.nowMs();

    if (credential.expiresAt && credential.expiresAt.getTime() <= now) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason:
          'The Threads token expired. Threads tokens can only be refreshed while still valid, so this account has to be reconnected.',
      };
    }

    if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
      return { status: 'STILL_VALID' };
    }

    try {
      const refreshed = await this.client.request<TokenResponse>({
        path: '/refresh_access_token',
        unversioned: true,
        params: { grant_type: 'th_refresh_token', access_token: credential.accessToken },
      });

      return { status: 'REFRESHED', credential: this.toIssuedCredential(refreshed) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'Threads rejected the token. The account needs to be reconnected.',
        };
      }
      throw error;
    }
  }

  private async fetchProfile(accessToken: string): Promise<ProfileResponse> {
    return this.client.request<ProfileResponse>({
      path: '/me',
      accessToken,
      params: { fields: 'id,username,name,threads_profile_picture_url' },
    });
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async probeHealth(
    credential: DecryptedCredential,
    _account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();
    const granted = credential.scopes;
    const missing = THREADS_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    if (credential.expiresAt && credential.expiresAt.getTime() <= clock.nowMs()) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        // Stated plainly because it is unusual: on most platforms an expired
        // token is a refresh away. Here it is not.
        message:
          'The Threads connection expired. Threads cannot refresh an expired token, so it has to be reconnected.',
        checkedAt,
      };
    }

    try {
      await this.fetchProfile(credential.accessToken);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'Threads no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      // A transient failure is not a verdict on the account.
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
   * Threads offers no revoke endpoint.
   *
   * Disconnecting locally is still correct and still deletes the stored token;
   * this simply has nothing to tell the platform. Saying so beats a call that
   * 404s and gets logged as a failure every time somebody disconnects.
   */
  async revoke(): Promise<void> {
    return;
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /**
   * Publish, in the two calls Threads requires plus the wait between them.
   *
   *   POST /{user-id}/threads          → a container id
   *   (wait for status FINISHED)
   *   POST /{user-id}/threads_publish  → the post
   *
   * A carousel builds one container per item first, then a parent naming them —
   * the same shape as Instagram, and safe for the same reason: an unpublished
   * child is invisible and expires on its own.
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
        frameRate: item.frameRate,
        peakFrameRate: item.peakFrameRate,
        altText: item.altText,
      })),
    });

    if (!validation.valid) {
      throw toAppError('THREADS', preflightRefusal('THREADS', validation));
    }

    const text = composeText(ctx.draft);
    const userId = ctx.account.externalId;

    const containerId =
      ctx.media.length === 0
        ? await this.createTextContainer(ctx, userId, text)
        : ctx.media.length === 1
          ? await this.createSingleContainer(ctx, userId, ctx.media[0]!, text)
          : await this.createCarouselContainer(ctx, userId, ctx.media, text);

    // Before the wait and before the publish. If either is interrupted, this id
    // is the only thing that can answer whether the post went out.
    await ctx.recordProviderRef?.({ containerId });

    await this.awaitContainer(ctx, containerId);

    const published = await this.client.request<ContainerResponse>({
      path: `/${userId}/threads_publish`,
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      form: { creation_id: containerId },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!published.id) {
      throw toAppError('THREADS', {
        kind: 'UNAVAILABLE',
        message: 'Threads accepted the publish but returned no post id',
        meta: { containerId },
      });
    }

    return {
      externalPostId: published.id,
      ...(await this.permalinkFor(published.id, ctx.credential)),
      publishedAt: clock.now(),
      providerMeta: {
        accountId: userId,
        apiVersion: this.client.apiVersion,
        containerId,
      },
    };
  }

  private async createTextContainer(
    ctx: PublishContext,
    userId: string,
    text: string,
  ): Promise<string> {
    return this.container(ctx, userId, {
      media_type: 'TEXT',
      text,
      ...(ctx.draft.linkUrl ? { link_attachment: ctx.draft.linkUrl } : {}),
    });
  }

  private async createSingleContainer(
    ctx: PublishContext,
    userId: string,
    item: PublishMedia,
    text: string,
  ): Promise<string> {
    return this.container(ctx, userId, {
      media_type: item.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE',
      ...(item.kind === 'VIDEO' ? { video_url: item.url } : { image_url: item.url }),
      text,
    });
  }

  /**
   * A carousel: children first, then a parent that names them.
   *
   * `is_carousel_item` marks a child so Threads does not treat it as a post in
   * its own right. A partial failure here is safe — unpublished children are
   * invisible and expire — which is why they are not cleaned up on error.
   */
  private async createCarouselContainer(
    ctx: PublishContext,
    userId: string,
    media: readonly PublishMedia[],
    text: string,
  ): Promise<string> {
    const children: string[] = [];

    for (const item of media) {
      children.push(
        await this.container(ctx, userId, {
          media_type: item.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE',
          ...(item.kind === 'VIDEO' ? { video_url: item.url } : { image_url: item.url }),
          is_carousel_item: true,
        }),
      );
    }

    return this.container(ctx, userId, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      text,
    });
  }

  private async container(
    ctx: PublishContext,
    userId: string,
    form: Record<string, string | number | boolean | undefined>,
  ): Promise<string> {
    const created = await this.client.request<ContainerResponse>({
      path: `/${userId}/threads`,
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      form,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!created.id) {
      throw toAppError('THREADS', {
        kind: 'UNAVAILABLE',
        message: 'Threads accepted the container request but returned no id',
      });
    }

    return created.id;
  }

  /**
   * Wait for the container, within a budget.
   *
   * Meta asks for roughly 30 seconds before publishing, and unlike Instagram
   * this applies to **every** post type, text included. `ERROR` and `EXPIRED`
   * are terminal and reported as media problems with whatever reason Threads
   * gave; running out of budget is neither, and raises a timeout the engine
   * reconciles rather than retries — retrying would publish twice.
   */
  private async awaitContainer(ctx: PublishContext, containerId: string): Promise<void> {
    const budgetMs = this.options.pollBudgetMs ?? CONTAINER_POLL_BUDGET_MS;
    const intervalMs = this.options.pollIntervalMs ?? CONTAINER_POLL_INTERVAL_MS;
    const deadline = clock.nowMs() + budgetMs;

    for (;;) {
      const container = await this.client.request<StatusResponse>({
        path: `/${containerId}`,
        accessToken: ctx.credential.accessToken,
        params: { fields: 'status,error_message' },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (container.status === 'FINISHED' || container.status === 'PUBLISHED') return;

      if (container.status === 'ERROR' || container.status === 'EXPIRED') {
        throw toAppError('THREADS', {
          kind: 'MEDIA',
          message: `Threads could not prepare the post: ${container.error_message ?? container.status}`,
          userMessage: 'Threads would not accept this post.',
          meta: {
            containerId,
            ...(container.error_message ? { reason: container.error_message } : {}),
          },
        });
      }

      if (clock.nowMs() >= deadline) {
        throw toAppError('THREADS', {
          kind: 'TIMEOUT',
          message: `Threads is still preparing container ${containerId}; the outcome is unknown`,
          userMessage: 'Threads is still preparing this post. We will confirm what happened.',
          meta: { containerId, lastStatus: container.status ?? 'unknown' },
        });
      }

      await sleep(intervalMs, ctx.signal);
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the post we lost track of go out?
   *
   * The container id answers directly — `status: PUBLISHED` is the platform
   * saying so about *this* attempt — which beats searching a timeline. Without
   * a recorded id there is a fallback to matching recent posts by their text,
   * and it is deliberately the second choice: text matching can claim somebody
   * else's post, so it only runs when nothing better exists.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const containerId = ctx.providerRef?.['containerId'];

    if (typeof containerId === 'string' && containerId.length > 0) {
      const byContainer = await this.reconcileByContainer(ctx, containerId);
      if (byContainer) return byContainer;
    }

    return this.reconcileByTimeline(ctx);
  }

  private async reconcileByContainer(
    ctx: ReconcileContext,
    containerId: string,
  ): Promise<ReconcileResult | undefined> {
    let container: StatusResponse;
    try {
      container = await this.client.request<StatusResponse>({
        path: `/${containerId}`,
        accessToken: ctx.credential.accessToken,
        params: { fields: 'status,error_message' },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch {
      // Gone or unreadable: says nothing either way, so fall through.
      return undefined;
    }

    if (container.status === 'ERROR' || container.status === 'EXPIRED') {
      return { outcome: 'NOT_FOUND' };
    }

    if (container.status === 'IN_PROGRESS' || container.status === 'FINISHED') {
      return {
        outcome: 'INCONCLUSIVE',
        reason: `Threads still reports this container as ${container.status.toLowerCase()}; publishing again could double-post.`,
      };
    }

    // PUBLISHED, but the container is not the post. The id has to be found.
    return undefined;
  }

  private async reconcileByTimeline(ctx: ReconcileContext): Promise<ReconcileResult> {
    const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;

    const recent = await this.client.request<PostsListResponse>({
      path: `/${ctx.account.externalId}/threads`,
      accessToken: ctx.credential.accessToken,
      params: { fields: 'id,permalink,timestamp,text', limit: 25 },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const match = (recent.data ?? []).find((post) => {
      if (!post.timestamp || !post.id) return false;
      const at = Date.parse(post.timestamp);
      if (Number.isNaN(at) || at < lower || at > upper) return false;
      return matchesPublishedText(ctx.body, post.text ?? '');
    });

    if (!match?.id) return { outcome: 'NOT_FOUND' };

    return {
      outcome: 'FOUND',
      externalPostId: match.id,
      ...(match.permalink ? { permalink: match.permalink } : {}),
      publishedAt: match.timestamp ? new Date(match.timestamp) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const post = await this.client.request<PostResponse>({
        path: `/${ref.externalPostId}`,
        accessToken: credential.accessToken,
        params: { fields: 'id,permalink,timestamp' },
      });

      if (!post.id) return { exists: false };

      return {
        exists: true,
        ...(post.permalink ? { permalink: post.permalink } : {}),
        ...(post.timestamp ? { publishedAt: new Date(post.timestamp) } : {}),
        createdByThisApp: true,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Threads exposes no delete, and `lifecycle.delete: false` says so, which
   * means nothing in the product should reach this. Explaining beats a request
   * that fails like an outage.
   */
  async deletePost(): Promise<void> {
    throw toAppError('THREADS', {
      kind: 'VALIDATION',
      message: 'Threads does not allow deleting a post through the API',
      userMessage: 'Threads posts have to be removed in the Threads app.',
    });
  }

  private async permalinkFor(
    postId: string,
    credential: DecryptedCredential,
  ): Promise<{ permalink?: string }> {
    try {
      const post = await this.client.request<PostResponse>({
        path: `/${postId}`,
        accessToken: credential.accessToken,
        params: { fields: 'permalink' },
      });
      return post.permalink ? { permalink: post.permalink } : {};
    } catch {
      // A missing permalink is cosmetic. Failing the publish over it would
      // throw away a post that is already live.
      return {};
    }
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    void range;

    const response = await this.client.request<InsightsResponse>({
      path: `/${ref.externalPostId}/insights`,
      accessToken: credential.accessToken,
      params: { metric: THREADS_POST_METRICS.join(',') },
    });

    return this.toMetricSet(response);
  }

  async fetchAccountAnalytics(
    account: { externalId: string },
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    const response = await this.client.request<InsightsResponse>({
      path: `/${account.externalId}/threads_insights`,
      accessToken: credential.accessToken,
      params: {
        metric: 'views,likes,replies,followers_count',
        since: Math.floor(range.from.getTime() / 1000),
        until: Math.floor(range.to.getTime() / 1000),
      },
    });

    return this.toMetricSet(response);
  }

  /**
   * Fold an insights response into metrics and availability.
   *
   * A metric Threads did not return is marked UNSUPPORTED rather than stored as
   * zero. A fresh post with no views yet would otherwise chart identically to
   * one nobody saw, which is the fabrication SRS §18 forbids.
   */
  private toMetricSet(response: InsightsResponse): MetricSet {
    const metrics: Record<string, number> = {};
    const availability: Record<string, 'AVAILABLE' | 'UNSUPPORTED'> = {};

    for (const entry of response.data ?? []) {
      if (!entry.name) continue;
      const value = entry.total_value?.value ?? entry.values?.[0]?.value;
      if (typeof value === 'number') {
        metrics[entry.name] = value;
        availability[entry.name] = 'AVAILABLE';
      } else {
        availability[entry.name] = 'UNSUPPORTED';
      }
    }

    for (const name of THREADS_POST_METRICS) {
      if (!(name in availability)) availability[name] = 'UNSUPPORTED';
    }

    return {
      metrics,
      availability,
      capturedAt: clock.now(),
      apiVersion: this.client.apiVersion,
    };
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

/** Hashtags go in the text on Threads, as they do on TikTok. */
function composeText(draft: VariantDraft): string {
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

/** Unused import guard: `THREADS_DEFAULT_SCOPES` documents the baseline. */
void THREADS_DEFAULT_SCOPES;
