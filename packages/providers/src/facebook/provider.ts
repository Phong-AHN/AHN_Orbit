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
import { safeEquals } from '../credential-cipher.js';
import { createHmac } from 'node:crypto';
import { GraphClient, type GraphClientOptions } from './client.js';
import {
  FACEBOOK_DEFAULT_SCOPES,
  FACEBOOK_PUBLISH_SCOPES,
  facebookPageCapabilities,
} from './capabilities.js';
import { reauthorizationReason } from './errors.js';

/**
 * Facebook Pages adapter.
 *
 * Everything Meta-specific in the system lives in this directory. The core
 * knows only `SocialProvider` and `PlatformCapabilities`.
 *
 * Credential shape, which drives the whole connection flow:
 *
 *   short-lived user token (~1–2h)
 *        ↓ server-side exchange with the app secret
 *   long-lived user token (~60 days)
 *        ↓ GET /me/accounts
 *   Page access token — generally does not expire, but IS invalidated by a
 *   password change, permission revocation, or loss of Page access.
 *
 * Because a Page token dies without expiring, health is **probe-driven** rather
 * than expiry-driven (docs/SOCIAL_PROVIDERS.md §4).
 */

export interface FacebookProviderOptions extends GraphClientOptions {
  /** Verify token for the webhook subscription handshake. */
  webhookVerifyToken?: string | undefined;
}

interface DebugTokenResponse {
  data?: {
    is_valid?: boolean;
    app_id?: string;
    expires_at?: number;
    data_access_expires_at?: number;
    scopes?: string[];
    granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    error?: { code?: number; subcode?: number; message?: string };
  };
}

interface AccountsResponse {
  data?: Array<{
    id: string;
    name: string;
    username?: string;
    access_token?: string;
    tasks?: string[];
    picture?: { data?: { url?: string } };
  }>;
  paging?: { next?: string };
}

/** Tasks Meta grants on a Page. CREATE_CONTENT is what publishing needs. */
const REQUIRED_PAGE_TASK = 'CREATE_CONTENT';

export class FacebookProvider implements SocialProvider {
  readonly platform: Platform = 'FACEBOOK';

  private readonly client: GraphClient;
  private readonly capabilityCache: PlatformCapabilities;

  constructor(private readonly options: FacebookProviderOptions) {
    this.client = new GraphClient(options);
    // Built once: the composer calls capabilities() on every keystroke.
    this.capabilityCache = facebookPageCapabilities(options.apiVersion);
  }

  capabilities(): PlatformCapabilities {
    return this.capabilityCache;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(this.capabilityCache, draft);
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = [...new Set([...FACEBOOK_DEFAULT_SCOPES, ...(input.extraScopes ?? [])])];

    // The dialog lives on www.facebook.com, not the graph host.
    const url = new URL(`https://www.facebook.com/${this.options.apiVersion}/dialog/oauth`);
    url.searchParams.set('client_id', this.options.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('response_type', 'code');
    // Force the account picker so connecting a second Page is possible without
    // signing out of Facebook first.
    url.searchParams.set('auth_type', 'rerequest');

    return { url: url.toString(), scopes };
  }

  /**
   * Exchange the callback code for a long-lived user token, then discover Pages.
   *
   * Runs server-side only — the app secret is required and must never reach a
   * browser (SRS §6).
   */
  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    const shortLived = await this.client.request<{
      access_token: string;
      expires_in?: number;
      token_type?: string;
    }>({
      path: '/oauth/access_token',
      params: {
        client_id: this.options.appId,
        client_secret: this.options.appSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
      },
    });

    const longLived = await this.exchangeForLongLived(shortLived.access_token);
    const accounts = await this.discoverPages(longLived.accessToken);

    return { userCredential: longLived, accounts };
  }

  /** Short-lived → long-lived (~60 days). */
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

    const scopes = await this.grantedScopes(response.access_token);

    return {
      accessToken: response.access_token,
      ...(response.expires_in
        ? { expiresAt: new Date(clock.nowMs() + response.expires_in * 1000) }
        : {}),
      scopes,
    };
  }

  /**
   * Pages the authorizing user administers.
   *
   * Each carries its own access token, derived from the long-lived user token
   * and therefore generally non-expiring. Pages without CREATE_CONTENT are
   * returned but flagged, so the UI can explain why one cannot be selected
   * rather than silently omitting it.
   */
  private async discoverPages(userAccessToken: string) {
    const response = await this.client.request<AccountsResponse>({
      path: '/me/accounts',
      params: { fields: 'id,name,username,access_token,tasks,picture{url}', limit: 100 },
      accessToken: userAccessToken,
    });

    const pages = response.data ?? [];

    return pages
      .filter((page) => Boolean(page.access_token))
      .map((page) => {
        const tasks = page.tasks ?? [];
        return {
          externalId: page.id,
          displayName: page.name,
          ...(page.username ? { handle: page.username } : {}),
          ...(page.picture?.data?.url ? { avatarUrl: page.picture.data.url } : {}),
          accountType: 'PAGE',
          credential: {
            accessToken: page.access_token as string,
            // Page tokens do not carry an expiry; health probing covers them.
            scopes: tasks.includes(REQUIRED_PAGE_TASK)
              ? FACEBOOK_PUBLISH_SCOPES
              : (tasks as readonly string[]),
          } satisfies IssuedCredential,
        };
      });
  }

  /** Scopes actually granted, read from the token itself rather than assumed. */
  private async grantedScopes(accessToken: string): Promise<readonly string[]> {
    const debug = await this.client.request<DebugTokenResponse>({
      path: '/debug_token',
      params: { input_token: accessToken, access_token: this.client.appAccessToken },
    });

    return debug.data?.scopes ?? [];
  }

  /**
   * Page tokens are not refreshable in the usual sense.
   *
   * If the token still works, there is nothing to do; if it does not, only a
   * human reauthorizing can fix it. Returning REQUIRES_RECONNECT rather than
   * attempting a refresh loop is the honest answer.
   */
  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    try {
      const debug = await this.client.request<DebugTokenResponse>({
        path: '/debug_token',
        params: {
          input_token: credential.accessToken,
          access_token: this.client.appAccessToken,
        },
      });

      const data = debug.data;
      if (!data?.is_valid) {
        return {
          status: 'REQUIRES_RECONNECT',
          reason:
            reauthorizationReason(data?.error?.subcode) ??
            'The connection to this Page is no longer valid.',
        };
      }

      // expires_at of 0 means "does not expire", which is the normal case for
      // a Page token derived from a long-lived user token.
      const expiresAt =
        data.expires_at && data.expires_at > 0 ? new Date(data.expires_at * 1000) : undefined;

      if (expiresAt && expiresAt.getTime() - clock.nowMs() < 7 * 24 * 3600_000) {
        return {
          status: 'REQUIRES_RECONNECT',
          reason: 'This connection expires soon and must be renewed by signing in to Facebook.',
        };
      }

      return { status: 'STILL_VALID' };
    } catch {
      // A failed debug call is not proof the credential is dead; say so rather
      // than triggering a needless reconnect prompt.
      return { status: 'STILL_VALID' };
    }
  }

  async probeHealth(
    credential: DecryptedCredential,
    account: { externalId: string },
  ): Promise<AccountHealth> {
    const checkedAt = clock.now();

    try {
      const debug = await this.client.request<DebugTokenResponse>({
        path: '/debug_token',
        params: {
          input_token: credential.accessToken,
          access_token: this.client.appAccessToken,
        },
      });

      const data = debug.data;

      if (!data?.is_valid) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: [],
          missingScopes: [...FACEBOOK_PUBLISH_SCOPES],
          message:
            reauthorizationReason(data?.error?.subcode) ??
            'This Page needs to be reconnected before it can publish.',
          checkedAt,
        };
      }

      const granted = data.scopes ?? [];
      const missing = FACEBOOK_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));

      if (missing.length > 0) {
        return {
          status: 'NEEDS_RECONNECT',
          grantedScopes: granted,
          missingScopes: missing,
          message: 'A permission this Page needs was removed. Reconnect to restore it.',
          checkedAt,
        };
      }

      // The token is valid, but Page access can be withdrawn independently —
      // so confirm the Page itself is still reachable with it.
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
          missingScopes: [...FACEBOOK_PUBLISH_SCOPES],
          message: 'This Page needs to be reconnected before it can publish.',
          checkedAt,
        };
      }

      // A transient outage is not a broken connection. Leave the account alone
      // rather than sending a reconnect prompt for a five-minute blip.
      throw error;
    }
  }

  async revoke(credential: DecryptedCredential, account: { externalId: string }): Promise<void> {
    // Best effort: if Meta has already invalidated the grant, this 400s, and
    // disconnecting locally must still succeed.
    try {
      await this.client.request({
        path: `/${account.externalId}/permissions`,
        method: 'DELETE',
        accessToken: credential.accessToken,
      });
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  async publish(ctx: PublishContext): Promise<PublishResult> {
    // Validate against the media actually being sent, not just the draft's own
    // list — the worker resolves media separately, and validating the draft
    // alone would let an unsupported kind through to the API.
    const validation = this.validate({
      ...ctx.draft,
      media: ctx.media.map((m) => ({
        id: m.id,
        kind: m.kind,
        mimeType: m.mimeType,
        sizeBytes: m.sizeBytes,
        width: m.width,
        height: m.height,
        durationMs: m.durationMs,
        altText: m.altText,
      })),
    });

    if (!validation.valid) {
      throw toAppError('FACEBOOK', preflightRefusal('FACEBOOK', validation));
    }

    const images = ctx.media.filter((m) => m.kind === 'IMAGE');
    if (ctx.media.length !== images.length) {
      throw toAppError('FACEBOOK', {
        kind: 'MEDIA',
        message: 'Only images are supported for Page publishing at present',
      });
    }

    const message = composeMessage(ctx.draft);

    // No media: a plain feed post, optionally with a link.
    if (images.length === 0) {
      const created = await this.client.request<{ id: string }>({
        path: `/${ctx.account.externalId}/feed`,
        method: 'POST',
        accessToken: ctx.credential.accessToken,
        form: { message, ...(ctx.draft.linkUrl ? { link: ctx.draft.linkUrl } : {}) },
        signal: ctx.signal,
      });

      return this.published(created.id, ctx);
    }

    // Single image: one call to /photos.
    if (images.length === 1) {
      const photo = images[0]!;
      const created = await this.client.request<{ id: string; post_id?: string }>({
        path: `/${ctx.account.externalId}/photos`,
        method: 'POST',
        accessToken: ctx.credential.accessToken,
        form: {
          url: photo.url,
          message,
          ...(photo.altText ? { alt_text_custom: photo.altText } : {}),
        },
        signal: ctx.signal,
      });

      // /photos returns the photo id; post_id is the feed story.
      return this.published(created.post_id ?? created.id, ctx);
    }

    // Multi-photo: upload each unpublished, then attach to one feed post.
    // Partial failure is possible, so the uploaded ids are surfaced in the
    // error context for cleanup rather than being silently orphaned.
    const uploaded: string[] = [];
    try {
      for (const photo of images) {
        const result = await this.client.request<{ id: string }>({
          path: `/${ctx.account.externalId}/photos`,
          method: 'POST',
          accessToken: ctx.credential.accessToken,
          form: {
            url: photo.url,
            published: false,
            ...(photo.altText ? { alt_text_custom: photo.altText } : {}),
          },
          signal: ctx.signal,
        });
        uploaded.push(result.id);
      }
    } catch (error) {
      if (uploaded.length > 0) {
        (error as { context?: Record<string, unknown> }).context = {
          ...(error as { context?: Record<string, unknown> }).context,
          orphanedPhotoIds: uploaded,
        };
      }
      throw error;
    }

    const form: Record<string, string> = { message };
    uploaded.forEach((id, index) => {
      form[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
    });

    const created = await this.client.request<{ id: string }>({
      path: `/${ctx.account.externalId}/feed`,
      method: 'POST',
      accessToken: ctx.credential.accessToken,
      form,
      signal: ctx.signal,
    });

    return this.published(created.id, ctx);
  }

  private published(externalPostId: string, ctx: PublishContext): PublishResult {
    return {
      externalPostId,
      permalink: `https://www.facebook.com/${externalPostId}`,
      publishedAt: clock.now(),
      providerMeta: { accountId: ctx.account.externalId, apiVersion: this.client.apiVersion },
    };
  }

  /**
   * Did the post we are unsure about actually go out?
   *
   * Graph accepts no idempotency key, so after an ambiguous timeout this read
   * is the only thing standing between a retry and a duplicate post reaching a
   * client's audience (docs/ARCHITECTURE.md §5.2 layer 4).
   */
  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    const since = Math.floor((ctx.attemptedAt.getTime() - ctx.windowMs) / 1000);
    const until = Math.floor((ctx.attemptedAt.getTime() + ctx.windowMs) / 1000);

    try {
      const response = await this.client.request<{
        data?: Array<{
          id: string;
          message?: string;
          created_time?: string;
          permalink_url?: string;
        }>;
      }>({
        path: `/${ctx.account.externalId}/posts`,
        params: { fields: 'id,message,created_time,permalink_url', since, until, limit: 50 },
        accessToken: ctx.credential.accessToken,
        signal: ctx.signal,
      });

      const posts = response.data ?? [];
      const match = posts.find((post) => matchesPublishedText(post.message ?? '', ctx.body));

      if (match) {
        return {
          outcome: 'FOUND',
          externalPostId: match.id,
          ...(match.permalink_url ? { permalink: match.permalink_url } : {}),
          publishedAt: match.created_time ? new Date(match.created_time) : clock.now(),
        };
      }

      // An empty page of results is only meaningful if we could actually read
      // the timeline. We could, so absence is real.
      return { outcome: 'NOT_FOUND' };
    } catch (error) {
      // We could not look. Saying NOT_FOUND here would licence a retry that
      // might duplicate — INCONCLUSIVE parks it for a human instead.
      return {
        outcome: 'INCONCLUSIVE',
        reason: `Could not read the Page timeline to confirm: ${
          (error as { code?: string }).code ?? 'unknown error'
        }`,
      };
    }
  }

  async getPostStatus(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<ExternalPostStatus> {
    try {
      const post = await this.client.request<{
        id: string;
        created_time?: string;
        permalink_url?: string;
        is_eligible_for_promotion?: boolean;
      }>({
        path: `/${ref.externalPostId}`,
        params: { fields: 'id,created_time,permalink_url' },
        accessToken: credential.accessToken,
      });

      return {
        exists: true,
        ...(post.permalink_url ? { permalink: post.permalink_url } : {}),
        ...(post.created_time ? { publishedAt: new Date(post.created_time) } : {}),
        // Graph does not report authorship directly; editability is decided by
        // whether the attempt succeeds, and the composer explains the rule.
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'PROVIDER_VALIDATION_ERROR') {
        return { exists: false };
      }
      throw error;
    }
  }

  async deletePost(ref: ExternalPostRef, credential: DecryptedCredential): Promise<void> {
    await this.client.request({
      path: `/${ref.externalPostId}`,
      method: 'DELETE',
      accessToken: credential.accessToken,
    });
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async fetchPostAnalytics(
    ref: ExternalPostRef,
    credential: DecryptedCredential,
  ): Promise<MetricSet> {
    const metrics = this.capabilityCache.analytics.metrics.filter((m) => m.startsWith('post_'));
    return this.fetchInsights(`/${ref.externalPostId}/insights`, metrics, credential);
  }

  async fetchAccountAnalytics(
    account: { externalId: string },
    credential: DecryptedCredential,
    range: DateRange,
  ): Promise<MetricSet> {
    const metrics = this.capabilityCache.analytics.metrics.filter((m) => m.startsWith('page_'));
    return this.fetchInsights(`/${account.externalId}/insights`, metrics, credential, range);
  }

  private async fetchInsights(
    path: string,
    metricNames: readonly string[],
    credential: DecryptedCredential,
    range?: DateRange,
  ): Promise<MetricSet> {
    const availability: MetricSet['availability'] = {};

    // Requesting a withdrawn metric is an ERROR, not an empty result, so the
    // whole call would fail. They are reported, never requested.
    for (const metric of this.capabilityCache.analytics.deprecatedMetrics) {
      availability[metric] = 'DEPRECATED';
    }

    const response = await this.client.request<{
      data?: Array<{ name: string; values?: Array<{ value: unknown }> }>;
    }>({
      path,
      params: {
        metric: metricNames.join(','),
        ...(range
          ? {
              since: Math.floor(range.from.getTime() / 1000),
              until: Math.floor(range.to.getTime() / 1000),
            }
          : {}),
      },
      accessToken: credential.accessToken,
    });

    const metrics: Record<string, number> = {};
    for (const entry of response.data ?? []) {
      const value = entry.values?.at(-1)?.value;
      if (typeof value === 'number') {
        metrics[entry.name] = value;
        availability[entry.name] = 'AVAILABLE';
      } else {
        availability[entry.name] = 'ERROR';
      }
    }

    // A metric we asked for that came back at all is unsupported here.
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

  /** X-Hub-Signature-256 over the raw body, keyed by the app secret. */
  verifyWebhook(request: RawWebhookRequest): boolean {
    const header = request.headers['x-hub-signature-256'];
    if (!header?.startsWith('sha256=')) return false;

    const expected = createHmac('sha256', this.options.appSecret)
      .update(request.rawBody, 'utf8')
      .digest('hex');

    return safeEquals(header.slice('sha256='.length), expected);
  }

  parseWebhook(request: RawWebhookRequest): ProviderEvent[] {
    const body = JSON.parse(request.rawBody) as {
      entry?: Array<{
        id?: string;
        time?: number;
        changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
      }>;
    };

    return (body.entry ?? []).flatMap((entry) =>
      (entry.changes ?? []).map((change, index) => ({
        externalEventId: `${entry.id ?? 'unknown'}:${entry.time ?? 0}:${index}`,
        type: `facebook.${change.field ?? 'unknown'}`,
        ...(entry.id ? { accountExternalId: entry.id } : {}),
        occurredAt: entry.time ? new Date(entry.time * 1000) : clock.now(),
        payload: change.value ?? {},
      })),
    );
  }
}

/** Hashtags append to the body; Facebook has no separate field for them. */
function composeMessage(draft: VariantDraft): string {
  const tags = (draft.hashtags ?? []).map((t) => (t.startsWith('#') ? t : `#${t}`));
  return tags.length > 0 ? `${draft.body}\n\n${tags.join(' ')}`.trim() : draft.body;
}
