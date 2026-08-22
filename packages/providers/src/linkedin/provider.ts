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
import { LinkedInClient, type LinkedInClientOptions } from './client.js';
import {
  LINKEDIN_AUTHORIZE_URL,
  LINKEDIN_PUBLISHING_ROLES,
  LINKEDIN_PUBLISH_SCOPES,
  LINKEDIN_TOKEN_URL,
  linkedinCapabilities,
} from './capabilities.js';

/**
 * LinkedIn adapter.
 *
 * ## What an agency actually connects
 *
 * A **company page**, not a person. Publishing to a page needs
 * `w_organization_social` *and* the authorising member to hold a publishing
 * role on that page, so discovery walks `organizationAcls` rather than reading
 * a profile: the question is not "who signed in" but "which pages may this
 * person post to".
 *
 * A member who administers no page authorises perfectly and has nothing to
 * connect. The connect flow says so rather than showing an empty list, because
 * an empty list reads as a bug.
 *
 * ## Three things unlike everything else here
 *
 * **The post id comes back in a header.** `x-restli-id` on a 201 with an empty
 * body. Every other platform answers in JSON.
 *
 * **A post can be deleted.** LinkedIn is the only platform in the product that
 * allows it, and deletions are idempotent — deleting an already-deleted post
 * still answers 204.
 *
 * **The API version expires.** Every call carries `LinkedIn-Version: YYYYMM`,
 * and LinkedIn sunsets a version roughly a year after release. An unattended
 * integration stops working on a date that is already published, which makes
 * bumping it a scheduled operational task rather than a nicety.
 */

/** Refresh once the token is within this of expiring. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LinkedInProviderOptions extends LinkedInClientOptions {
  /**
   * How the worker reads an image's bytes.
   *
   * Injected for the same reason TikTok's is: `@orbit/providers` must not
   * depend on storage. LinkedIn will not fetch from a URL — an image is
   * registered, then its bytes are pushed — so unlike Meta there is no way to
   * hand over a signed link and let the platform pull.
   */
  readMedia?: ((media: PublishMedia) => Promise<Uint8Array>) | undefined;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

interface OrganizationAclResponse {
  elements?: Array<{ organization?: string; role?: string; state?: string }>;
}

interface OrganizationResponse {
  results?: Record<string, { localizedName?: string; vanityName?: string; id?: number }>;
}

interface PostResponse {
  id?: string;
  commentary?: string;
  createdAt?: number;
  lifecycleState?: string;
}

interface PostsPage {
  elements?: PostResponse[];
}

export class LinkedInProvider implements SocialProvider {
  readonly platform: Platform = 'LINKEDIN';

  private readonly client: LinkedInClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: LinkedInProviderOptions) {
    this.client = new LinkedInClient(options);
    this.capabilityCache = linkedinCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = [...new Set([...LINKEDIN_PUBLISH_SCOPES, ...(input.extraScopes ?? [])])];

    const url = new URL(LINKEDIN_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    // Space-delimited here. Meta uses commas, Instagram Login uses spaces —
    // three platforms, three conventions, and the wrong one yields a dialog
    // error that names no scope.
    url.searchParams.set('scope', scopes.join(' '));

    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const token = (await this.client.token(LINKEDIN_TOKEN_URL, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
    })) as TokenResponse;

    const credential = this.toIssuedCredential(token);
    const accounts = await this.discoverPages(credential.accessToken);

    return { userCredential: credential, accounts };
  }

  /**
   * Company pages this member may publish to.
   *
   * `organizationAcls` answers the question that matters — which pages, in
   * which role — where a profile lookup would answer who signed in. Roles are
   * filtered to the three LinkedIn documents as permitting publishing, and only
   * APPROVED grants count: a pending invitation is not access.
   */
  private async discoverPages(accessToken: string) {
    const acls = await this.client.request<OrganizationAclResponse>({
      path: '/rest/organizationAcls',
      accessToken,
      params: { q: 'roleAssignee', state: 'APPROVED', count: 100 },
      restliMethod: 'FINDER',
    });

    const publishable = (acls.body.elements ?? []).filter(
      (element) =>
        element.organization &&
        element.role &&
        (LINKEDIN_PUBLISHING_ROLES as readonly string[]).includes(element.role),
    );

    if (publishable.length === 0) return [];

    // One batch call rather than one per page: an agency member may administer
    // dozens, and LinkedIn's rate limits are the tightest in the product.
    const ids = publishable
      .map((element) => element.organization as string)
      .map((urn) => encodeURIComponent(urn));

    const details = await this.client.request<OrganizationResponse>({
      path: `/rest/organizations?ids=List(${ids.join(',')})`,
      accessToken,
      restliMethod: 'BATCH_GET',
    });

    return publishable.map((element) => {
      const urn = element.organization as string;
      const detail = details.body.results?.[urn];

      return {
        externalId: urn,
        displayName: detail?.localizedName ?? urn,
        ...(detail?.vanityName ? { handle: detail.vanityName } : {}),
        accountType: 'ORGANIZATION',
        // LinkedIn issues one member token that covers every page they
        // administer; there is no per-page credential the way Meta issues a
        // per-Page token. The same credential is attached to each.
        credential: {
          accessToken,
          scopes: [...LINKEDIN_PUBLISH_SCOPES],
        } satisfies IssuedCredential,
      };
    });
  }

  private toIssuedCredential(token: TokenResponse): IssuedCredential {
    if (!token.access_token) {
      throw toAppError('LINKEDIN', {
        kind: 'AUTHENTICATION',
        message: 'LinkedIn returned no access token',
      });
    }

    const now = clock.nowMs();

    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: new Date(now + token.expires_in * 1000) } : {}),
      /**
       * Refresh tokens are **not issued to every app**.
       *
       * LinkedIn grants them only to approved partners; without one, a 60-day
       * token simply expires and the account has to be reconnected. So
       * `refreshableUntil` is only set when a refresh token actually exists —
       * claiming a refresh window we cannot use would have the sweep skip an
       * account it should have been warning about.
       */
      ...(token.refresh_token && token.refresh_token_expires_in
        ? { refreshableUntil: new Date(now + token.refresh_token_expires_in * 1000) }
        : {}),
      scopes: token.scope
        ? token.scope.split(/[\s,]+/).filter(Boolean)
        : [...LINKEDIN_PUBLISH_SCOPES],
    };
  }

  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    const now = clock.nowMs();

    if (!credential.refreshToken) {
      // Not a fault: most apps never get one. Said plainly so nobody goes
      // looking for a broken refresh that was never available.
      if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
        return { status: 'STILL_VALID' };
      }
      return {
        status: 'REQUIRES_RECONNECT',
        reason:
          'This LinkedIn app does not have refresh tokens, so the connection has to be renewed by signing in again.',
      };
    }

    if (credential.refreshableUntil && credential.refreshableUntil.getTime() <= now) {
      return {
        status: 'REQUIRES_RECONNECT',
        reason: 'The LinkedIn refresh token expired. The account has to be reconnected.',
      };
    }

    if (credential.expiresAt && credential.expiresAt.getTime() - now > REFRESH_WINDOW_MS) {
      return { status: 'STILL_VALID' };
    }

    try {
      const token = (await this.client.token(LINKEDIN_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      })) as TokenResponse;

      return { status: 'REFRESHED', credential: this.toIssuedCredential(token) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR' || code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'LinkedIn rejected the refresh token. The account needs to be reconnected.',
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
    const missing = LINKEDIN_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

    if (credential.expiresAt && credential.expiresAt.getTime() <= clock.nowMs()) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: granted,
        missingScopes: missing,
        message: 'The LinkedIn connection expired and needs to be reconnected.',
        checkedAt,
      };
    }

    try {
      // Reading the page back proves both that the token lives *and* that this
      // member still holds a role on it — the second is what actually changes,
      // when somebody is removed as an admin.
      await this.client.request({
        path: `/rest/organizations/${encodeURIComponent(account.externalId)}`,
        accessToken: credential.accessToken,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROVIDER_AUTHENTICATION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'LinkedIn no longer accepts this connection. It needs to be reconnected.',
          checkedAt,
        };
      }
      if (code === 'PROVIDER_PERMISSION_ERROR') {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          // Precisely worded: the token is fine, the *role* is gone, and
          // "reconnect" only helps if somebody restores the role first.
          message:
            'This LinkedIn account no longer has permission to post to that page. Check the page admins, then reconnect.',
          checkedAt,
        };
      }
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

  /** LinkedIn offers no revoke endpoint; disconnecting locally is the whole act. */
  async revoke(): Promise<void> {
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
      throw toAppError('LINKEDIN', preflightRefusal('LINKEDIN', validation));
    }

    const author = ctx.account.externalId;
    const commentary = composeCommentary(ctx.draft);

    /**
     * The image is registered and pushed **before** the post is created, and
     * that ordering is what keeps a failure clean: an image uploaded with no
     * post attached is an orphaned asset nobody sees, while a post created
     * first and then failed on media would be visible and wrong.
     */
    const image = ctx.media[0] ? await this.uploadImage(ctx, author, ctx.media[0]) : undefined;

    const body: Record<string, unknown> = {
      author,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(image
        ? {
            content: {
              media: {
                id: image,
                ...(ctx.media[0]?.altText ? { altText: ctx.media[0].altText } : {}),
              },
            },
          }
        : ctx.draft.linkUrl
          ? {
              /**
               * LinkedIn does **not** scrape the URL — the docs say so, because
               * scraping "introduces unpredictability in how a post will
               * appear". Title and description have to be supplied, and the
               * body's first line is the best title available without asking
               * for one.
               */
              content: {
                article: {
                  source: ctx.draft.linkUrl,
                  title: firstLine(commentary) || ctx.draft.linkUrl,
                },
              },
            }
          : {}),
    };

    const created = await this.client.request<Record<string, never>>({
      path: '/rest/posts',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      json: body,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    // 201 with an empty body: the URN is in a header. Reading the body for it
    // finds nothing and looks like a platform fault.
    const urn = created.createdId;
    if (!urn) {
      throw toAppError('LINKEDIN', {
        kind: 'UNAVAILABLE',
        message: 'LinkedIn accepted the post but returned no id in x-restli-id',
      });
    }

    return {
      externalPostId: urn,
      permalink: `https://www.linkedin.com/feed/update/${urn}/`,
      publishedAt: clock.now(),
      providerMeta: {
        author,
        apiVersion: this.client.apiVersion,
        ...(image ? { imageUrn: image } : {}),
      },
    };
  }

  /**
   * Register an image, then push its bytes.
   *
   * LinkedIn will not fetch from a URL: unlike Meta there is no `image_url`
   * anywhere, so the worker reads the object and uploads it. `readMedia` is
   * injected for that, and its absence is a configuration error rather than a
   * media one — the web app registers this provider without it, because the web
   * app never moves bytes.
   */
  private async uploadImage(
    ctx: PublishContext,
    owner: string,
    media: PublishMedia,
  ): Promise<string> {
    const read = this.options.readMedia;
    if (!read) {
      throw toAppError('LINKEDIN', {
        kind: 'UNAVAILABLE',
        message:
          'LinkedIn is configured without a media reader, so images cannot be uploaded. Wire readMedia when constructing the provider.',
      });
    }

    const initialized = await this.client.request<{
      value?: { uploadUrl?: string; image?: string };
    }>({
      path: '/rest/images',
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      params: { action: 'initializeUpload' },
      json: { initializeUploadRequest: { owner } },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const uploadUrl = initialized.body.value?.uploadUrl;
    const imageUrn = initialized.body.value?.image;

    if (!uploadUrl || !imageUrn) {
      throw toAppError('LINKEDIN', {
        kind: 'UNAVAILABLE',
        message: 'LinkedIn did not return an upload URL for the image',
      });
    }

    await this.client.upload({
      uploadUrl,
      body: await read(media),
      accessToken: ctx.credential.accessToken,
      mimeType: media.mimeType,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return imageUrn;
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Did the post we lost track of go out?
   *
   * There is no container id to ask about — a LinkedIn post either exists or
   * does not — so this searches the page's recent posts and matches on text
   * within the attempt window. Weaker than TikTok's `publish_id`, and said so:
   * a page posting the same words twice in ten minutes could confuse it, which
   * is why the window is bounded and the match is on the whole body.
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const lower = ctx.attemptedAt.getTime() - ctx.windowMs;
    const upper = ctx.attemptedAt.getTime() + ctx.windowMs;

    let recent;
    try {
      recent = await this.client.request<PostsPage>({
        path: '/rest/posts',
        accessToken: ctx.credential.accessToken,
        params: {
          author: ctx.account.externalId,
          q: 'author',
          count: 25,
          sortBy: 'CREATED',
        },
        restliMethod: 'FINDER',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch {
      return {
        outcome: 'INCONCLUSIVE',
        reason: 'LinkedIn could not be reached to confirm whether this post went out.',
      };
    }

    const match = (recent.body.elements ?? []).find((post) => {
      if (!post.id || post.createdAt === undefined) return false;
      if (post.createdAt < lower || post.createdAt > upper) return false;
      return matchesPublishedText(ctx.body, post.commentary ?? '');
    });

    if (!match?.id) return { outcome: 'NOT_FOUND' };

    return {
      outcome: 'FOUND',
      externalPostId: match.id,
      permalink: `https://www.linkedin.com/feed/update/${match.id}/`,
      publishedAt: match.createdAt ? new Date(match.createdAt) : clock.now(),
    };
  }

  // ── Post lifecycle ────────────────────────────────────────────────────────

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const post = await this.client.request<PostResponse>({
        path: `/rest/posts/${encodeURIComponent(ref.externalPostId)}`,
        accessToken: credential.accessToken,
      });

      if (!post.body.id) return { exists: false };

      return {
        exists: true,
        permalink: `https://www.linkedin.com/feed/update/${post.body.id}/`,
        ...(post.body.createdAt ? { publishedAt: new Date(post.body.createdAt) } : {}),
        createdByThisApp: true,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Delete a published post — the only platform here that permits it.
   *
   * LinkedIn documents deletion as **idempotent**: deleting an already-deleted
   * post still answers 204. So a retry after a lost response is safe, which is
   * the opposite of the situation every publish path in this product has to
   * defend against.
   */
  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    await this.client.request({
      path: `/rest/posts/${encodeURIComponent(ref.externalPostId)}`,
      method: 'DELETE',
      accessToken: credential.accessToken,
      restliMethod: 'DELETE',
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  /**
   * Not built, and the descriptor says so (`analytics.post: false`), which
   * means the ingestion sweep skips LinkedIn rather than calling this. Throwing
   * is the honest shape for a method that exists only to satisfy the interface.
   */
  async fetchPostAnalytics(
    _ref: ExternalPostRef,
    _credential: DecryptedCredential,
    _range: DateRange,
  ): Promise<MetricSet> {
    throw toAppError('LINKEDIN', {
      kind: 'VALIDATION',
      message: 'LinkedIn analytics are not implemented',
      userMessage: 'Orbit does not collect LinkedIn analytics yet.',
    });
  }

  async fetchAccountAnalytics(): Promise<MetricSet> {
    throw toAppError('LINKEDIN', {
      kind: 'VALIDATION',
      message: 'LinkedIn analytics are not implemented',
      userMessage: 'Orbit does not collect LinkedIn analytics yet.',
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

/** Hashtags go inline; LinkedIn renders a plain `#tag` as one. */
function composeCommentary(draft: VariantDraft): string {
  const tags = (draft.hashtags ?? [])
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .join(' ');

  return [draft.body?.trim(), tags].filter((part) => part && part.length > 0).join('\n\n');
}

/** The article title, when nobody supplied one. Bounded so it stays a title. */
function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 200);
}
