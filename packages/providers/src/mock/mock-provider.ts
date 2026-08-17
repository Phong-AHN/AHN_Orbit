import { clock, newOpaqueToken } from '@orbit/core';
import { defineCapabilities, type PlatformCapabilities } from '../capabilities.js';
import { toAppError } from '../errors.js';
import { validateDraft, type ValidationResult, type VariantDraft } from '../validation.js';
import type {
  AccountHealth,
  AuthorizationUrlInput,
  CallbackInput,
  ConnectedAccounts,
  DecryptedCredential,
  ExternalPostRef,
  ExternalPostStatus,
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

/**
 * In-memory provider for development and tests.
 *
 * Two jobs:
 *   1. let the composer, calendar and publishing engine be exercised end to end
 *      before Meta App Review completes;
 *   2. serve as the **reference implementation** — it is the shortest complete
 *      example of what a real adapter must do (see docs/PROVIDER_GUIDE.md).
 *
 * Registered with `developmentOnly: true`, so the registry refuses it in
 * production (SRS §42: never fake social API responses in production code).
 *
 * Faults can be injected so the publishing engine's retry, reconciliation and
 * reconnect paths are testable without a real platform misbehaving on cue.
 */

export type MockFault =
  | 'NONE'
  | 'RATE_LIMIT'
  | 'AUTH_EXPIRED'
  | 'TIMEOUT_THEN_PUBLISHED'
  | 'TIMEOUT_NOT_PUBLISHED'
  | 'UNAVAILABLE'
  | 'VALIDATION'
  /** A refusal about the *app* rather than the connection. See below. */
  | 'CLIENT_STANDING';

interface MockPost {
  externalPostId: string;
  accountExternalId: string;
  body: string;
  contentHash: string;
  publishedAt: Date;
  createdByThisApp: boolean;
}

const MOCK_CAPABILITIES = defineCapabilities({
  platform: 'FACEBOOK',
  accountType: null,
  apiVersion: 'mock-1',
  verifiedOn: '2026-08-12',
  text: { supported: true, maxLength: 2000, allowsEmptyWithMedia: true },
  link: { supported: true, maxCount: 5 },
  media: {
    image: {
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: 8 * 1024 * 1024,
      minWidth: 200,
      minHeight: 200,
      minAspectRatio: 0.5,
      maxAspectRatio: 2,
    },
    video: {
      mimeTypes: ['video/mp4'],
      maxBytes: 100 * 1024 * 1024,
      minDurationMs: 1000,
      maxDurationMs: 120_000,
    },
    gif: null,
    maxAttachments: 4,
    allowsMixedKinds: false,
    carousel: true,
    altText: true,
    required: false,
  },
  hashtags: { supported: true, maxCount: 30 },
  mentions: { supported: true },
  firstComment: { supported: true, maxLength: 500 },
  scheduling: { providerSide: true, minLeadMs: 600_000, maxLeadMs: 30 * 24 * 3600_000 },
  lifecycle: { edit: true, editOwnPostsOnly: true, delete: true, readStatus: true },
  publishing: {
    idempotencyKey: false,
    reconcilable: true,
    rateLimit: { maxPosts: 30, windowMs: 24 * 3600_000 },
  },
  analytics: {
    post: true,
    account: true,
    metrics: ['views', 'likes', 'comments', 'shares'],
    deprecatedMetrics: ['impressions'],
  },
  webhooks: { supported: true },
});

export class MockProvider implements SocialProvider {
  readonly platform = 'FACEBOOK' as const;

  /** Published posts, keyed by external id. Inspectable from tests. */
  readonly posts = new Map<string, MockPost>();

  /** Next fault to inject. Reset to NONE after it fires once. */
  fault: MockFault = 'NONE';

  /** Counts calls, so tests can assert "exactly one provider call happened". */
  readonly callCounts = { publish: 0, reconcile: 0, refresh: 0, health: 0, delete: 0 };

  reset(): void {
    this.posts.clear();
    this.fault = 'NONE';
    for (const key of Object.keys(this.callCounts) as (keyof typeof this.callCounts)[]) {
      this.callCounts[key] = 0;
    }
  }

  capabilities(): PlatformCapabilities {
    return MOCK_CAPABILITIES;
  }

  validate(draft: VariantDraft): ValidationResult {
    return validateDraft(MOCK_CAPABILITIES, draft);
  }

  getAuthorizationUrl(input: AuthorizationUrlInput): { url: string; scopes: readonly string[] } {
    const scopes = ['mock_read', 'mock_publish', ...(input.extraScopes ?? [])];
    const url = new URL('https://mock.invalid/oauth/authorize');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', scopes.join(','));
    return { url: url.toString(), scopes };
  }

  async exchangeCode(input: CallbackInput): Promise<ConnectedAccounts> {
    if (!input.code) {
      throw toAppError(this.platform, {
        kind: 'VALIDATION',
        message: 'Missing authorization code',
      });
    }

    const credential = {
      accessToken: `mock-token-${newOpaqueToken(8)}`,
      expiresAt: new Date(clock.nowMs() + 60 * 24 * 3600_000),
      scopes: ['mock_read', 'mock_publish'] as const,
    };

    return {
      userCredential: credential,
      accounts: [
        {
          externalId: 'dev-mock:100000000000001',
          displayName: 'Mock Page One',
          handle: 'mockpageone',
          accountType: 'PAGE',
          credential,
        },
        {
          externalId: 'dev-mock:100000000000002',
          displayName: 'Mock Page Two',
          handle: 'mockpagetwo',
          accountType: 'PAGE',
          credential,
        },
      ],
    };
  }

  async refreshCredential(credential: DecryptedCredential): Promise<RefreshOutcome> {
    this.callCounts.refresh++;

    if (this.consumeFault('AUTH_EXPIRED')) {
      return { status: 'REQUIRES_RECONNECT', reason: 'Mock credential was revoked' };
    }

    const expiresAt = credential.expiresAt;
    if (expiresAt && expiresAt.getTime() - clock.nowMs() > 7 * 24 * 3600_000) {
      return { status: 'STILL_VALID' };
    }

    return {
      status: 'REFRESHED',
      credential: {
        accessToken: `mock-token-${newOpaqueToken(8)}`,
        expiresAt: new Date(clock.nowMs() + 60 * 24 * 3600_000),
        scopes: credential.scopes,
      },
    };
  }

  async probeHealth(credential: DecryptedCredential): Promise<AccountHealth> {
    this.callCounts.health++;

    if (this.consumeFault('AUTH_EXPIRED')) {
      return {
        status: 'NEEDS_RECONNECT',
        grantedScopes: [],
        missingScopes: ['mock_publish'],
        message: 'The mock account needs to be reconnected.',
        checkedAt: clock.now(),
      };
    }

    const granted = credential.scopes;
    const missing = ['mock_publish'].filter((s) => !granted.includes(s));

    return {
      status: missing.length > 0 ? 'NEEDS_RECONNECT' : 'ACTIVE',
      grantedScopes: granted,
      missingScopes: missing,
      ...(missing.length > 0 ? { message: 'A required permission is missing.' } : {}),
      checkedAt: clock.now(),
    };
  }

  async revoke(): Promise<void> {
    // Nothing to do; a real provider would call its revocation endpoint.
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    this.callCounts.publish++;

    if (this.consumeFault('RATE_LIMIT')) {
      throw toAppError(this.platform, {
        kind: 'RATE_LIMIT',
        message: 'Mock rate limit reached',
        retryAfterSeconds: 60,
      });
    }
    if (this.consumeFault('AUTH_EXPIRED')) {
      throw toAppError(this.platform, { kind: 'AUTHENTICATION', message: 'Mock token expired' });
    }
    if (this.consumeFault('UNAVAILABLE')) {
      throw toAppError(this.platform, { kind: 'UNAVAILABLE', message: 'Mock platform is down' });
    }
    /**
     * A permission refusal that says nothing about this connection.
     *
     * Stands in for TikTok's `unaudited_client_can_only_post_to_private_accounts`
     * — a 403 about the API client's standing, identical for every account on
     * the platform. The engine must record the failure and leave the account
     * ACTIVE; demoting it would send somebody through an OAuth round trip for a
     * problem that lives in a developer portal.
     */
    if (this.consumeFault('CLIENT_STANDING')) {
      throw toAppError(this.platform, {
        kind: 'PERMISSION',
        message: 'Mock client is not audited',
        meta: { clientStanding: true },
      });
    }

    if (this.consumeFault('VALIDATION')) {
      throw toAppError(this.platform, { kind: 'VALIDATION', message: 'Mock rejected the content' });
    }

    // The dangerous case: the post lands, but the caller never learns of it.
    // Reconciliation is the only way to discover this, which is exactly what
    // this fault exists to exercise.
    if (this.consumeFault('TIMEOUT_THEN_PUBLISHED')) {
      this.record(ctx);
      throw toAppError(this.platform, {
        kind: 'TIMEOUT',
        message: 'Mock timed out after publishing',
      });
    }
    if (this.consumeFault('TIMEOUT_NOT_PUBLISHED')) {
      throw toAppError(this.platform, {
        kind: 'TIMEOUT',
        message: 'Mock timed out before publishing',
      });
    }

    const post = this.record(ctx);
    return {
      externalPostId: post.externalPostId,
      permalink: `https://mock.invalid/${post.accountExternalId}/${post.externalPostId}`,
      publishedAt: post.publishedAt,
      providerMeta: { mock: true },
    };
  }

  async reconcile(ctx: ReconcileContext): Promise<ReconcileResult> {
    this.callCounts.reconcile++;

    const since = ctx.attemptedAt.getTime() - ctx.windowMs;
    const until = ctx.attemptedAt.getTime() + ctx.windowMs;

    const match = [...this.posts.values()].find(
      (p) =>
        p.accountExternalId === ctx.account.externalId &&
        p.contentHash === ctx.contentHash &&
        p.publishedAt.getTime() >= since &&
        p.publishedAt.getTime() <= until,
    );

    if (match) {
      return {
        outcome: 'FOUND',
        externalPostId: match.externalPostId,
        permalink: `https://mock.invalid/${match.accountExternalId}/${match.externalPostId}`,
        publishedAt: match.publishedAt,
      };
    }

    return { outcome: 'NOT_FOUND' };
  }

  async getPostStatus(ref: ExternalPostRef): Promise<ExternalPostStatus> {
    const post = this.posts.get(ref.externalPostId);
    if (!post) return { exists: false };

    return {
      exists: true,
      permalink: `https://mock.invalid/${post.accountExternalId}/${post.externalPostId}`,
      publishedAt: post.publishedAt,
      createdByThisApp: post.createdByThisApp,
    };
  }

  async deletePost(ref: ExternalPostRef): Promise<void> {
    this.callCounts.delete++;
    if (!this.posts.delete(ref.externalPostId)) {
      throw toAppError(this.platform, { kind: 'VALIDATION', message: 'No such mock post' });
    }
  }

  async fetchPostAnalytics(ref: ExternalPostRef): Promise<MetricSet> {
    const post = this.posts.get(ref.externalPostId);
    // Deterministic from the id, so assertions are stable across runs.
    const seed = post ? post.externalPostId.length : 0;

    return {
      metrics: { views: seed * 100, likes: seed * 7, comments: seed, shares: Math.floor(seed / 2) },
      availability: {
        views: 'AVAILABLE',
        likes: 'AVAILABLE',
        comments: 'AVAILABLE',
        shares: 'AVAILABLE',
        // Reported as withdrawn rather than zero — the behaviour SRS §18 wants.
        impressions: 'DEPRECATED',
      },
      capturedAt: clock.now(),
      apiVersion: MOCK_CAPABILITIES.apiVersion,
    };
  }

  async fetchAccountAnalytics(): Promise<MetricSet> {
    return {
      metrics: { views: 1000, followers: 250 },
      availability: { views: 'AVAILABLE', followers: 'AVAILABLE', impressions: 'DEPRECATED' },
      capturedAt: clock.now(),
      apiVersion: MOCK_CAPABILITIES.apiVersion,
    };
  }

  verifyWebhook(request: RawWebhookRequest): boolean {
    return request.headers['x-mock-signature'] === 'valid';
  }

  parseWebhook(request: RawWebhookRequest): ProviderEvent[] {
    const parsed = JSON.parse(request.rawBody) as {
      id?: string;
      type?: string;
      accountId?: string;
    };

    return [
      {
        externalEventId: parsed.id ?? 'mock-event',
        type: parsed.type ?? 'mock.event',
        accountExternalId: parsed.accountId,
        occurredAt: clock.now(),
        payload: parsed as Record<string, unknown>,
      },
    ];
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private record(ctx: PublishContext): MockPost {
    const post: MockPost = {
      externalPostId: `mock-post-${newOpaqueToken(6)}`,
      accountExternalId: ctx.account.externalId,
      body: ctx.draft.body,
      contentHash: ctx.contentHash,
      publishedAt: clock.now(),
      createdByThisApp: true,
    };
    this.posts.set(post.externalPostId, post);
    return post;
  }

  /** Faults fire once, so a retry after an injected failure can succeed. */
  private consumeFault(kind: MockFault): boolean {
    if (this.fault !== kind) return false;
    this.fault = 'NONE';
    return true;
  }
}

export const mockProvider = new MockProvider();
