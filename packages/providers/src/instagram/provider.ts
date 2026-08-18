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
  PublishResult,
  RawWebhookRequest,
  ReconcileContext,
  ReconcileResult,
  RefreshOutcome,
  SocialProvider,
} from '../types.js';
import { GraphClient, type GraphClientOptions } from '../facebook/client.js';
import { reauthorizationReason } from '../facebook/errors.js';
import {
  INSTAGRAM_ACCOUNT_METRICS,
  INSTAGRAM_DEFAULT_SCOPES,
  INSTAGRAM_LOGIN_SCOPES,
  INSTAGRAM_PUBLISH_SCOPES,
  instagramCapabilities,
} from './capabilities.js';

/**
 * Instagram professional-account adapter.
 *
 * Shares the Meta app, the OAuth dialog and the Graph client with Facebook —
 * this is "API setup with Facebook Login", so there is no second app id, no
 * second secret, and no second consent screen. What differs is the scopes
 * asked for, how accounts are discovered, and how a post is published.
 *
 * Discovery is the first surprise: an Instagram professional account is not
 * found on its own. It hangs off a Facebook Page, and the credential we store
 * is that **Page's** token. So a brand connects Instagram by authorizing the
 * Page it is linked to, and an account with no linked Page cannot be connected
 * at all — which the connect flow reports rather than silently returning
 * nothing.
 *
 * Publishing is the second: it takes two calls, and that shapes the failure
 * model. See `publish`.
 */

/**
 * The Facebook-Login surface's options, plus the second app if it exists.
 *
 * The base fields are the Facebook app's — aliased from `GraphClientOptions` so
 * the two adapters cannot drift. `login` is Business Login for Instagram, which
 * Meta requires to live in its own app; absent, that surface is not offered.
 */
export interface InstagramProviderOptions extends GraphClientOptions {
  login?:
    | {
        appId: string;
        appSecret: string;
      }
    | undefined;
  /**
   * How long to wait for a Reel container, and how often to ask.
   *
   * Overridable for one reason: a test of the "still transcoding when the
   * budget runs out" path would otherwise take forty seconds, and a path that
   * slow to test is a path that ends up untested.
   */
  reelPollBudgetMs?: number | undefined;
  reelPollIntervalMs?: number | undefined;
}

/**
 * How long publishing waits for a Reel container to finish transcoding.
 *
 * Shorter than the engine's own call budget, so exhausting it produces a clean
 * timeout the engine can reconcile rather than an abort from underneath that
 * loses the container id. Meta suggests polling for up to five minutes; holding
 * a worker slot that long is the wrong trade when the recorded id makes the
 * question answerable afterwards.
 */
const REEL_POLL_BUDGET_MS = 40_000;
const REEL_POLL_INTERVAL_MS = 3_000;

/** Business Login for Instagram speaks to its own hosts, not to Graph. */
const INSTAGRAM_LOGIN_DIALOG = 'https://www.instagram.com/oauth/authorize';
const INSTAGRAM_LOGIN_TOKEN = 'https://api.instagram.com/oauth/access_token';
const INSTAGRAM_LOGIN_GRAPH = 'https://graph.instagram.com';

interface PagesWithInstagram {
  data?: Array<{
    id: string;
    name: string;
    access_token?: string;
    instagram_business_account?: {
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
    };
  }>;
}

interface DebugTokenResponse {
  data?: {
    is_valid?: boolean;
    scopes?: string[];
    expires_at?: number;
    error?: { subcode?: number };
  };
}

export class InstagramProvider implements SocialProvider {
  readonly platform: Platform = 'INSTAGRAM';

  private readonly client: GraphClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: InstagramProviderOptions) {
    this.client = new GraphClient(options);
    this.capabilityCache = instagramCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /** Whether the username-login surface is configured at all. */
  get supportsInstagramLogin(): boolean {
    return Boolean(this.options.login);
  }

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    if (input.accountType === 'INSTAGRAM_LOGIN') return this.instagramLoginAuthorizationUrl(input);

    const scopes = [...new Set([...INSTAGRAM_DEFAULT_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(`https://www.facebook.com/${this.options.apiVersion}/dialog/oauth`);
    url.searchParams.set('client_id', this.options.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('auth_type', 'rerequest');

    return { url: url.toString(), scopes };
  }

  /**
   * Business Login for Instagram.
   *
   * A different dialog on a different host, and `scope` is space-delimited here
   * where Graph uses commas — the kind of detail that produces "Invalid Scope"
   * rather than anything that names the real problem.
   */
  private instagramLoginAuthorizationUrl(input: AuthorizationUrlInput): {
    url: string;
    scopes: readonly string[];
  } {
    const login = this.requireLoginApp();
    const scopes = [...new Set([...INSTAGRAM_LOGIN_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(INSTAGRAM_LOGIN_DIALOG);
    url.searchParams.set('client_id', login.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('response_type', 'code');

    return { url: url.toString(), scopes };
  }

  private requireLoginApp(): { appId: string; appSecret: string } {
    const login = this.options.login;
    if (!login) {
      throw toAppError('INSTAGRAM', {
        kind: 'VALIDATION',
        message:
          'Business Login for Instagram is not configured. It needs its own Meta app — set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.',
      });
    }
    return login;
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    if (input.accountType === 'INSTAGRAM_LOGIN') return this.exchangeInstagramLoginCode(input);

    const shortLived = await this.client.request<{ access_token: string }>({
      path: '/oauth/access_token',
      params: {
        client_id: this.options.appId,
        client_secret: this.options.appSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
      },
    });

    const longLived = await this.exchangeForLongLived(shortLived.access_token);
    const accounts = await this.discoverAccounts(longLived.accessToken);

    return { userCredential: longLived, accounts };
  }

  /**
   * Business Login for Instagram: code → short-lived → long-lived, then the
   * account is *itself* the account. There is no Page to walk through and no
   * list to choose from, so exactly one account comes back.
   *
   * Three things differ from Graph and each is its own trap: the token exchange
   * is a form POST rather than a query string, the long-lived exchange is a GET
   * on a different path, and the user id arrives as `user_id` on the token
   * response rather than needing a `/me` call.
   */
  private async exchangeInstagramLoginCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const login = this.requireLoginApp();

    const form = new URLSearchParams({
      client_id: login.appId,
      client_secret: login.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      code: input.code,
    });

    const shortLived = await this.instagramLoginFetch<{
      access_token: string;
      user_id: number | string;
    }>(INSTAGRAM_LOGIN_TOKEN, { method: 'POST', body: form });

    const longLived = await this.instagramLoginFetch<{
      access_token: string;
      expires_in?: number;
    }>(
      `${INSTAGRAM_LOGIN_GRAPH}/access_token?${new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: login.appSecret,
        access_token: shortLived.access_token,
      }).toString()}`,
    );

    const profile = await this.instagramLoginFetch<{
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
    }>(
      `${INSTAGRAM_LOGIN_GRAPH}/me?${new URLSearchParams({
        fields: 'id,username,name,profile_picture_url',
        access_token: longLived.access_token,
      }).toString()}`,
    );

    const credential: IssuedCredential = {
      accessToken: longLived.access_token,
      ...(longLived.expires_in
        ? { expiresAt: new Date(clock.nowMs() + longLived.expires_in * 1000) }
        : {}),
      scopes: INSTAGRAM_LOGIN_SCOPES,
    };

    return {
      userCredential: credential,
      accounts: [
        {
          externalId: profile.id || String(shortLived.user_id),
          displayName: profile.name ?? profile.username ?? 'Instagram account',
          ...(profile.username ? { handle: profile.username } : {}),
          ...(profile.profile_picture_url ? { avatarUrl: profile.profile_picture_url } : {}),
          accountType: 'INSTAGRAM_LOGIN',
          credential,
        },
      ],
    };
  }

  /**
   * These hosts are not Graph, so `GraphClient` — with its app-secret proof,
   * its error map and its base URL — does not apply. Errors are normalised
   * through the same `toAppError` so the rest of the system sees one shape.
   */
  private async instagramLoginFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (body as { error_message?: string; error?: { message?: string } } | null)?.error_message ??
        (body as { error?: { message?: string } } | null)?.error?.message ??
        `Instagram login request failed (${response.status})`;

      throw toAppError('INSTAGRAM', {
        kind: response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'VALIDATION',
        message,
      });
    }

    return body as T;
  }

  private async exchangeForLongLived(shortLivedToken: string): Promise<IssuedCredential> {
    const response = await this.client.request<{ access_token: string; expires_in?: number }>({
      path: '/oauth/access_token',
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.options.appId,
        client_secret: this.options.appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });

    return {
      accessToken: response.access_token,
      ...(response.expires_in
        ? { expiresAt: new Date(clock.nowMs() + response.expires_in * 1000) }
        : {}),
      scopes: await this.grantedScopes(response.access_token),
    };
  }

  /**
   * Instagram accounts reachable through the Pages this user administers.
   *
   * `instagram_business_account` is absent on a Page with nothing linked, so
   * those Pages are dropped — connecting them would create an account that can
   * never publish. The stored `externalId` is the **Instagram** id, while the
   * token is the **Page's**; every publishing call needs that pairing.
   */
  private async discoverAccounts(userAccessToken: string) {
    const response = await this.client.request<PagesWithInstagram>({
      path: '/me/accounts',
      params: {
        fields:
          'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}',
        limit: 100,
      },
      accessToken: userAccessToken,
    });

    return (response.data ?? [])
      .filter((page) => Boolean(page.access_token) && Boolean(page.instagram_business_account))
      .map((page) => {
        const instagram = page.instagram_business_account as NonNullable<
          NonNullable<PagesWithInstagram['data']>[number]['instagram_business_account']
        >;

        return {
          externalId: instagram.id,
          displayName: instagram.name ?? instagram.username ?? page.name,
          ...(instagram.username ? { handle: instagram.username } : {}),
          ...(instagram.profile_picture_url ? { avatarUrl: instagram.profile_picture_url } : {}),
          accountType: 'INSTAGRAM_BUSINESS',
          credential: {
            accessToken: page.access_token as string,
            scopes: INSTAGRAM_PUBLISH_SCOPES,
          } satisfies IssuedCredential,
        };
      });
  }

  private async grantedScopes(accessToken: string): Promise<readonly string[]> {
    const debug = await this.client.request<DebugTokenResponse>({
      path: '/debug_token',
      params: { input_token: accessToken, access_token: this.client.appAccessToken },
    });

    return debug.data?.scopes ?? [];
  }

  /**
   * Which surface a stored credential belongs to.
   *
   * Read from the scopes, because that is what the row actually carries — the
   * two surfaces ask for disjoint sets and `probeHealth` receives no account
   * type. Getting this wrong is not a small error: an Instagram-app token
   * checked against the *Facebook* app's `debug_token` comes back invalid, and
   * the account is demoted to NEEDS_RECONNECT for no reason. It did.
   */
  private isLoginSurface(credential: DecryptedCredential): boolean {
    return credential.scopes.includes('instagram_business_basic');
  }

  /** Page tokens do not refresh; only a person reauthorizing can fix a dead one. */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    if (this.isLoginSurface(credential)) {
      // No debug endpoint here. Reading the account is the check.
      try {
        await this.instagramLoginFetch(
          `${INSTAGRAM_LOGIN_GRAPH}/me?${new URLSearchParams({
            fields: 'id',
            access_token: credential.accessToken,
          }).toString()}`,
        );
        return { status: 'STILL_VALID' };
      } catch {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'The connection to this Instagram account is no longer valid.',
        };
      }
    }

    try {
      const debug = await this.client.request<DebugTokenResponse>({
        path: '/debug_token',
        params: { input_token: credential.accessToken, access_token: this.client.appAccessToken },
      });

      if (!debug.data?.is_valid) {
        return {
          status: 'REQUIRES_RECONNECT',
          reason:
            reauthorizationReason(debug.data?.error?.subcode) ??
            'The connection to this Instagram account is no longer valid.',
        };
      }

      return { status: 'STILL_VALID' };
    } catch {
      // A failed debug call is not proof the credential is dead.
      return { status: 'STILL_VALID' };
    }
  }

  async probeHealth(
    credential: DecryptedCredential,
    account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();

    if (this.isLoginSurface(credential)) {
      try {
        // Reading the account with the token proves both at once: the token
        // works, and the account it names is still reachable.
        await this.instagramLoginFetch(
          `${INSTAGRAM_LOGIN_GRAPH}/${account.externalId}?${new URLSearchParams({
            fields: 'id',
            access_token: credential.accessToken,
          }).toString()}`,
        );

        return {
          status: 'ACTIVE',
          grantedScopes: credential.scopes,
          missingScopes: [],
          checkedAt,
        };
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
          return {
            status: 'NEEDS_RECONNECT',
            grantedScopes: [],
            missingScopes: [...INSTAGRAM_LOGIN_SCOPES],
            message: 'This Instagram account needs to be reconnected before it can publish.',
            checkedAt,
          };
        }

        // A transient outage is not a broken connection.
        throw error;
      }
    }

    try {
      const debug = await this.client.request<DebugTokenResponse>({
        path: '/debug_token',
        params: { input_token: credential.accessToken, access_token: this.client.appAccessToken },
      });

      const data = debug.data;

      if (!data?.is_valid) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: [],
          missingScopes: [...INSTAGRAM_PUBLISH_SCOPES],
          message:
            reauthorizationReason(data?.error?.subcode) ??
            'This Instagram account needs to be reconnected before it can publish.',
          checkedAt,
        };
      }

      const granted = data.scopes ?? [];
      const missing = INSTAGRAM_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

      if (missing.length > 0) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'A permission this account needs was removed. Reconnect to restore it.',
          checkedAt,
        };
      }

      // The Instagram account can be unlinked from the Page while the token
      // stays perfectly valid, so reading the account itself is the only check
      // that proves publishing would work.
      await this.client.request<{ id: string }>({
        path: `/${account.externalId}`,
        params: { fields: 'id' },
        accessToken: credential.accessToken,
      });

      return { status: 'ACTIVE', grantedScopes: granted, missingScopes: [], checkedAt };
    } catch (error) {
      const code = (error as { code?: string }).code;

      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: [],
          missingScopes: [...INSTAGRAM_PUBLISH_SCOPES],
          message: 'This Instagram account needs to be reconnected before it can publish.',
          checkedAt,
        };
      }

      // A transient outage is not a broken connection.
      throw error;
    }
  }

  async revoke(credential: DecryptedCredential, account: { externalId: string }): Promise<void> {
    void credential;
    void account;
    // Deliberately a no-op. The grant belongs to the Facebook Page, and
    // revoking it would disconnect the Page too — including a Facebook account
    // in the same brand that the user did not ask to disconnect. Removing the
    // row locally is the whole of what "disconnect Instagram" should mean.
  }

  /**
   * One call, routed to the host that issued the token.
   *
   * Everything after the connection — publishing, reconciling, reading a post
   * back, insights — is identical in *shape* on both surfaces and different in
   * *host*. `graph.facebook.com` will not accept a token minted by the
   * Instagram app, and the error it returns is an authentication failure, which
   * the publish path reads as "this credential is dead" and demotes the account.
   *
   * So a username-login account was disconnected by its own successful publish
   * attempt, every time. Routing by credential is the fix, and it belongs here
   * rather than at each call site precisely because there are eight of them.
   */
  private async call<T>(
    credential: DecryptedCredential,
    request: {
      path: string;
      method?: 'GET' | 'POST';
      params?: Record<string, string | number | boolean | undefined>;
      form?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal | undefined;
    },
  ): Promise<T> {
    if (!this.isLoginSurface(credential)) {
      return this.client.request<T>({
        path: request.path,
        ...(request.method ? { method: request.method } : {}),
        ...(request.params ? { params: request.params } : {}),
        ...(request.form ? { form: request.form } : {}),
        accessToken: credential.accessToken,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    }

    const url = new URL(`${INSTAGRAM_LOGIN_GRAPH}${request.path}`);
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // graph.instagram.com takes the token as a parameter; there is no bearer
    // header and no app-secret proof.
    if (request.form) {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) {
        if (value !== undefined) body.set(key, String(value));
      }
      body.set('access_token', credential.accessToken);

      return this.instagramLoginFetch<T>(url.toString(), {
        method: 'POST',
        body,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    }

    url.searchParams.set('access_token', credential.accessToken);
    return this.instagramLoginFetch<T>(url.toString(), {
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /**
   * Publish, in the two calls Instagram requires.
   *
   *   POST /{ig-user-id}/media          → a container id
   *   POST /{ig-user-id}/media_publish  → the published media id
   *
   * The gap between them is the whole risk. A container is inert — creating one
   * and never publishing costs nothing and leaves nothing visible. But a
   * `media_publish` that times out is genuinely ambiguous: the post may be live.
   * Retrying it would duplicate, so the error is left to propagate as a
   * publishing timeout, which the worker parks in NEEDS_REVIEW rather than
   * retrying (**D-027**), and `reconcile` is what resolves it.
   *
   * Carousels build one container per image first, then a parent that names
   * them. A partial failure there is safe for the same reason: unpublished
   * children are invisible and expire on their own.
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
      throw toAppError('INSTAGRAM', preflightRefusal('INSTAGRAM', validation));
    }

    const images = ctx.media.filter((item) => item.kind === 'IMAGE');
    const videos = ctx.media.filter((item) => item.kind === 'VIDEO');

    if (images.length + videos.length !== ctx.media.length) {
      throw toAppError('INSTAGRAM', {
        kind: 'MEDIA',
        message: 'Only images and video are supported for Instagram publishing',
      });
    }

    if (videos.length > 0 && (videos.length > 1 || images.length > 0)) {
      throw toAppError('INSTAGRAM', {
        kind: 'MEDIA',
        message: 'A Reel is one video and nothing else',
        userMessage: 'An Instagram Reel takes one video on its own - no photos alongside it.',
      });
    }

    // Validation guarantees this, but publishing is where an empty post would
    // become a confusing platform error rather than our own message.
    if (ctx.media.length === 0) {
      throw toAppError('INSTAGRAM', {
        kind: 'MEDIA',
        message: 'Instagram cannot publish a post without media',
      });
    }

    const caption = composeCaption(ctx.draft);
    const igUserId = ctx.account.externalId;

    const containerId =
      videos.length === 1
        ? await this.createReelContainer(ctx, igUserId, videos[0]!, caption)
        : images.length === 1
          ? await this.createImageContainer(ctx, igUserId, images[0]!, caption)
          : await this.createCarouselContainer(ctx, igUserId, images, caption);

    // Before the ambiguous call, not after. If `media_publish` times out, this
    // id is the only thing that can answer whether the post went out — and an
    // id written after the call would not exist in exactly that case.
    await ctx.recordProviderRef?.({ containerId });

    /**
     * A Reel container is not ready when it is created.
     *
     * An image container is usable immediately; a video one has to be
     * transcoded, and `media_publish` on an `IN_PROGRESS` container fails.
     * Meta's own guidance is to poll roughly once a minute for up to five --
     * far longer than a worker slot should be held, so the wait is bounded and
     * running out is a *timeout*, not a failure. The container id is already
     * recorded, so reconciliation asks Meta what became of it (D-027).
     */
    if (videos.length === 1) {
      await this.awaitContainerReady(ctx, containerId);
    }

    const published = await this.call<{ id: string }>(ctx.credential, {
      path: `/${igUserId}/media_publish`,
      method: 'POST',
      form: { creation_id: containerId },
      signal: ctx.signal,
    });

    return {
      externalPostId: published.id,
      permalink: await this.permalinkFor(published.id, ctx.credential),
      publishedAt: clock.now(),
      providerMeta: {
        accountId: igUserId,
        apiVersion: this.client.apiVersion,
        containerId,
      },
    };
  }

  /**
   * A Reel container.
   *
   * `video_url` only: Instagram fetches the file itself and offers no byte
   * upload for Reels, so the signed URL the publish subject built is what it
   * gets. Unlike TikTok there is no domain to verify -- Meta simply fetches it.
   *
   * `share_to_feed` is true so a Reel also appears on the profile grid, which
   * is what an agency posting for a client almost always means by "post a
   * Reel". Turning that into a per-post choice is a product decision, and until
   * somebody asks for it a sensible default beats a control nobody understands.
   */
  private async createReelContainer(
    ctx: PublishContext,
    igUserId: string,
    video: PublishContext['media'][number],
    caption: string,
  ): Promise<string> {
    const container = await this.call<{ id: string }>(ctx.credential, {
      path: `/${igUserId}/media`,
      method: 'POST',
      form: {
        media_type: 'REELS',
        video_url: video.url,
        caption,
        share_to_feed: 'true',
      },
      signal: ctx.signal,
    });

    return container.id;
  }

  /**
   * Wait for Instagram to finish transcoding, within a budget.
   *
   * `ERROR` and `EXPIRED` are terminal and reported as media problems -- that is
   * Instagram rejecting the file, and an identical retry fails identically.
   * Running out of budget is neither: the container may still finish, so it
   * raises a timeout the engine reconciles rather than retries.
   */
  private async awaitContainerReady(ctx: PublishContext, containerId: string): Promise<void> {
    const budgetMs = this.options.reelPollBudgetMs ?? REEL_POLL_BUDGET_MS;
    const intervalMs = this.options.reelPollIntervalMs ?? REEL_POLL_INTERVAL_MS;
    const deadline = clock.nowMs() + budgetMs;

    for (;;) {
      const container = await this.call<{ status_code?: string; status?: string }>(ctx.credential, {
        path: `/${containerId}`,
        params: { fields: 'status_code,status' },
        signal: ctx.signal,
      });

      const status = container.status_code;
      if (status === 'FINISHED') return;

      if (status === 'ERROR' || status === 'EXPIRED') {
        throw toAppError('INSTAGRAM', {
          kind: 'MEDIA',
          message: `Instagram could not process the video: ${container.status ?? status}`,
          userMessage:
            'Instagram would not accept this video. It has to be MP4 or MOV with the moov atom at the front of the file, which re-exporting with fast start produces.',
          meta: { containerId, statusCode: status ?? 'unknown' },
        });
      }

      if (clock.nowMs() >= deadline) {
        throw toAppError('INSTAGRAM', {
          kind: 'TIMEOUT',
          message: `Instagram is still processing container ${containerId}; the outcome is unknown`,
          userMessage: 'Instagram is still processing this video. We will confirm what happened.',
          meta: { containerId, lastStatus: status ?? 'unknown' },
        });
      }

      await sleep(intervalMs, ctx.signal);
    }
  }

  private async createImageContainer(
    ctx: PublishContext,
    igUserId: string,
    image: PublishContext['media'][number],
    caption: string,
  ): Promise<string> {
    const container = await this.call<{ id: string }>(ctx.credential, {
      path: `/${igUserId}/media`,
      method: 'POST',
      form: {
        image_url: image.url,
        caption,
        ...(image.altText ? { alt_text: image.altText } : {}),
      },
      signal: ctx.signal,
    });

    return container.id;
  }

  private async createCarouselContainer(
    ctx: PublishContext,
    igUserId: string,
    images: readonly PublishContext['media'][number][],
    caption: string,
  ): Promise<string> {
    const children: string[] = [];

    for (const image of images) {
      const child = await this.call<{ id: string }>(ctx.credential, {
        path: `/${igUserId}/media`,
        method: 'POST',
        form: {
          image_url: image.url,
          is_carousel_item: true,
          ...(image.altText ? { alt_text: image.altText } : {}),
        },
        signal: ctx.signal,
      });
      children.push(child.id);
    }

    const parent = await this.call<{ id: string }>(ctx.credential, {
      path: `/${igUserId}/media`,
      method: 'POST',
      form: { media_type: 'CAROUSEL', children: children.join(','), caption },
      signal: ctx.signal,
    });

    return parent.id;
  }

  /** Best effort: a published post without a permalink is still published. */
  private async permalinkFor(
    mediaId: string,
    credential: DecryptedCredential,
  ): Promise<string | undefined> {
    try {
      const media = await this.call<{ permalink?: string }>(credential, {
        path: `/${mediaId}`,
        params: { fields: 'permalink' },
      });
      return media.permalink;
    } catch {
      return undefined;
    }
  }

  /**
   * Did the post we are unsure about actually go out?
   *
   * This is what stands between an ambiguous `media_publish` and a duplicate
   * reaching a client's followers, and it asks in two ways.
   *
   * **First, the container.** If `publish` got as far as recording a container
   * id, `GET /{ig-container-id}?fields=status_code` answers the question
   * directly: `PUBLISHED` means the media object went out, `ERROR` and
   * `EXPIRED` mean it did not, and the in-flight states mean it is too early to
   * say. That is an answer from the platform about *this* attempt, which no
   * amount of reading the account's timeline can give you.
   *
   * **Then, the caption.** Matching recent media on the caption is the
   * fallback, used when no container id was recorded — a variant published
   * before this existed, or an attempt that died before the container call
   * returned. It is a fallback rather than the method because two posts sharing
   * a caption make it wrong, and wrong in the direction that double-posts.
   *
   * `PUBLISHED` without a locatable media id is deliberately INCONCLUSIVE, not
   * NOT_FOUND: we know it published and cannot name what published, and only
   * NOT_FOUND licenses a retry.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const containerId = ctx.providerRef?.['containerId'];

    if (typeof containerId === 'string' && containerId.length > 0) {
      const byContainer = await this.reconcileByContainer(ctx, containerId);
      if (byContainer) return byContainer;
    }

    const found = await this.findRecentMedia(ctx);

    // `undefined` means we could not look. NOT_FOUND here would licence a retry
    // that might duplicate; INCONCLUSIVE parks it for a human instead.
    return (
      found ?? {
        outcome: 'INCONCLUSIVE',
        reason: 'Could not read the Instagram account to confirm whether the post went out.',
      }
    );
  }

  /**
   * Look for the post on the account's timeline, matched by caption.
   *
   * `undefined` is reserved for "could not read the account" and is distinct
   * from `NOT_FOUND`, which means the timeline was read and the post is not on
   * it. Only the latter may ever lead to a retry.
   */
  private async findRecentMedia(ctx: ReconcileContext): Promise<ReconcileResult | undefined> {
    try {
      const response = await this.call<{
        data?: Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>;
      }>(ctx.credential, {
        path: `/${ctx.account.externalId}/media`,
        params: { fields: 'id,caption,timestamp,permalink', limit: 25 },
        signal: ctx.signal,
      });

      const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
      const upper = ctx.attemptedAt.getTime() + ctx.windowMs;

      // `/media` takes no time filter, so the window is applied here rather
      // than trusting position in the list.
      const match = (response.data ?? []).find((media) => {
        if (!matchesPublishedText(media.caption ?? '', ctx.body)) return false;
        if (!media.timestamp) return true;
        const at = new Date(media.timestamp).getTime();
        return at >= lower && at <= upper;
      });

      if (match) {
        return {
          outcome: 'FOUND',
          externalPostId: match.id,
          ...(match.permalink ? { permalink: match.permalink } : {}),
          publishedAt: match.timestamp ? new Date(match.timestamp) : clock.now(),
        };
      }

      return { outcome: 'NOT_FOUND' };
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the container what happened to it.
   *
   * Returns `undefined` — rather than INCONCLUSIVE — when the container cannot
   * settle the question, so the caller falls through to the caption match
   * instead of parking something the timeline could still resolve.
   */
  private async reconcileByContainer(
    ctx: ReconcileContext,
    containerId: string,
  ): Promise<ReconcileResult | undefined> {
    let status: string | undefined;

    try {
      const container = await this.call<{ status_code?: string }>(ctx.credential, {
        path: `/${containerId}`,
        params: { fields: 'status_code' },
        signal: ctx.signal,
      });
      status = container.status_code;
    } catch {
      // The container is gone, or unreadable. Says nothing either way, so let
      // the caption match have its turn.
      return undefined;
    }

    // Not published, and the platform is certain. This is the one branch that
    // may licence a retry, which is why it takes an explicit status rather than
    // an absence of one.
    if (status === 'ERROR' || status === 'EXPIRED') return { outcome: 'NOT_FOUND' };

    // Still moving. Retrying now could publish the very container that is
    // mid-flight, so this parks rather than guessing either way.
    if (status === 'IN_PROGRESS' || status === 'FINISHED') {
      return {
        outcome: 'INCONCLUSIVE',
        reason: `Instagram still reports the media container as ${status.toLowerCase()}; publishing it again could double-post.`,
      };
    }

    if (status !== 'PUBLISHED') return undefined;

    // It published. Find what it published — the status alone carries no media
    // id, so the timeline still has to name it.
    const found = await this.findRecentMedia(ctx);
    if (found?.outcome === 'FOUND') return found;

    // We know it went out and cannot name it. NOT_FOUND would be a licence to
    // retry something the platform has just told us succeeded.
    return {
      outcome: 'INCONCLUSIVE',
      reason:
        'Instagram confirms the media container was published, but the post could not be located to record its id.',
    };
  }

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const media = await this.call<{
        id: string;
        permalink?: string;
        timestamp?: string;
      }>(credential, {
        path: `/${ref.externalPostId}`,
        params: { fields: 'id,permalink,timestamp' },
      });

      return {
        exists: true,
        ...(media.permalink ? { permalink: media.permalink } : {}),
        ...(media.timestamp ? { publishedAt: new Date(media.timestamp) } : {}),
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_VALIDATION_ERROR') {
        return { exists: false };
      }
      throw error;
    }
  }

  /**
   * There is no delete.
   *
   * The Instagram Graph API exposes no way to remove a published media object;
   * it is a manual action in the app. Saying so is better than a request that
   * fails with something indistinguishable from an outage — and the capability
   * descriptor already declares `lifecycle.delete: false`, so nothing in the
   * product should be calling this.
   */
  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    void ref;
    void credential;

    throw toAppError('INSTAGRAM', {
      kind: 'VALIDATION',
      message:
        'Instagram does not allow deleting a published post through the API. Remove it in the Instagram app.',
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    // Media insights are lifetime totals; there is no window to narrow.
    void range;

    return this.fetchInsights(
      `/${ref.externalPostId}/insights`,
      this.capabilityCache.analytics.metrics,
      credential,
    );
  }

  /**
   * Account-level insights.
   *
   * A different metric list from media, and a different call shape: these need
   * `metric_type=total_value`, and one of them is spelled `saves` where media
   * spells the same idea `saved`. The list and the reasoning for what is left
   * out live in `INSTAGRAM_ACCOUNT_METRICS`.
   */
  async fetchAccountAnalytics(
    account: { externalId: string },
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    return this.fetchInsights(
      `/${account.externalId}/insights`,
      INSTAGRAM_ACCOUNT_METRICS,
      credential,
      range,
      { totalValue: true },
    );
  }

  /**
   * Mirrors the Facebook adapter, and for the same reason: a withdrawn metric
   * is an *error* from Graph rather than an empty result, so requesting one
   * fails the whole call. Deprecated metrics are reported, never asked for.
   */
  private async fetchInsights(
    path: string,
    metricNames: readonly string[],
    credential: DecryptedCredential,
    range?: DateRange,
    options: { totalValue?: boolean } = {},
  ): Promise<MetricSet> {
    const availability: MetricSet['availability'] = {};

    for (const metric of this.capabilityCache.analytics.deprecatedMetrics) {
      availability[metric] = 'DEPRECATED';
    }

    const response = await this.call<{
      data?: Array<{
        name: string;
        values?: Array<{ value: unknown }>;
        total_value?: { value?: unknown };
      }>;
    }>(credential, {
      path,
      params: {
        metric: metricNames.join(','),
        ...(options.totalValue ? { metric_type: 'total_value' } : {}),
        ...(range
          ? {
              period: 'day',
              since: Math.floor(range.from.getTime() / 1000),
              until: Math.floor(range.to.getTime() / 1000),
            }
          : {}),
      },
    });

    const metrics: Record<string, number> = {};
    for (const entry of response.data ?? []) {
      // Two response shapes, chosen by `metric_type`: `total_value` carries one
      // number for the window, `values` carries a series. Reading the wrong one
      // yields undefined, which would be recorded as ERROR — a metric that
      // arrived fine, reported as broken.
      const value = options.totalValue ? entry.total_value?.value : entry.values?.at(-1)?.value;

      if (typeof value === 'number') {
        metrics[entry.name] = value;
        availability[entry.name] = 'AVAILABLE';
      } else {
        availability[entry.name] = 'ERROR';
      }
    }

    for (const metric of metricNames) {
      if (availability[metric] === undefined) availability[metric] = 'UNSUPPORTED';
    }

    return {
      metrics,
      availability,
      capturedAt: clock.now(),
      apiVersion: this.client.apiVersion,
    };
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Not subscribed.
   *
   * Instagram webhooks need their own subscription and a published app. The
   * capability descriptor says `webhooks.supported: false`, so nothing routes
   * here; returning an empty list is the honest answer if anything does.
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(request: RawWebhookRequest): ProviderEvent[] {
    void request;
    return [];
  }
}

/**
 * Caption text, assembled the same way the Facebook message is.
 *
 * Hashtags go in the caption because Instagram's first comment is out of reach
 * without `instagram_manage_comments` — which is why the capability descriptor
 * refuses `firstComment` rather than quietly dropping it.
 */
function composeCaption(draft: VariantDraft): string {
  const hashtags = draft.hashtags ?? [];
  const parts = [draft.body.trim()];

  if (hashtags.length > 0) {
    parts.push(hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' '));
  }

  return parts.filter((part) => part.length > 0).join('\n\n');
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
