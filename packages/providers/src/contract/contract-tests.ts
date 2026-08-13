import { describe, expect, it } from 'vitest';
import { clock, isAppError, type AppError } from '@orbit/core';
import { platformCapabilitiesSchema } from '../capabilities.js';
import { validateDraft } from '../validation.js';
import type { VariantDraft } from '../validation.js';
import type { DecryptedCredential, SocialProvider } from '../types.js';

/**
 * The provider contract suite.
 *
 * Every adapter must call `runProviderContractTests` from its own test file.
 * The suite encodes the promises the publishing engine relies on, so a new
 * provider either honours them or fails CI — the engine never has to ask which
 * platform it is talking to.
 *
 * Usage (see docs/PROVIDER_GUIDE.md):
 *
 *   runProviderContractTests({
 *     name: 'Facebook',
 *     createProvider: () => new FacebookProvider(deps),
 *     validCredential: () => ({ ... }),
 *     sampleAccount: { externalId: '123' },
 *     validDraft: () => ({ body: 'Hello' }),
 *   });
 */

export interface ContractFixtures {
  /** Human name, used in the describe block. */
  name: string;
  createProvider: () => SocialProvider;
  /** A credential the adapter accepts. Fakes are fine; nothing is dialled. */
  validCredential: () => DecryptedCredential;
  sampleAccount: { externalId: string; accountType?: string | undefined };
  /** A draft that must pass validation for this platform. */
  validDraft: () => VariantDraft;
  /**
   * Set when the adapter reaches the network and the suite should skip the
   * live-call sections. Pure sections (capabilities, validation) always run.
   */
  offlineOnly?: boolean;
}

export function runProviderContractTests(fixtures: ContractFixtures): void {
  describe(`${fixtures.name} — provider contract`, () => {
    // ── Capabilities ──────────────────────────────────────────────────────

    describe('capabilities', () => {
      it('returns a descriptor that satisfies the schema', () => {
        const provider = fixtures.createProvider();
        const parsed = platformCapabilitiesSchema.safeParse(provider.capabilities(null));
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      });

      it('declares the same platform as the provider', () => {
        const provider = fixtures.createProvider();
        expect(provider.capabilities(null).platform).toBe(provider.platform);
      });

      it('is cheap enough to call on every keystroke', () => {
        const provider = fixtures.createProvider();
        const started = performance.now();
        for (let i = 0; i < 1000; i++) provider.capabilities(null);
        // The composer validates as the user types; a descriptor that hits the
        // network or rebuilds an object graph each time would be unusable.
        expect(performance.now() - started).toBeLessThan(100);
      });

      it('records the API version and verification date it was checked against', () => {
        const capabilities = fixtures.createProvider().capabilities(null);
        expect(capabilities.apiVersion).toBeTruthy();
        expect(capabilities.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('never lists a metric as both available and deprecated', () => {
        const { analytics } = fixtures.createProvider().capabilities(null);
        const overlap = analytics.metrics.filter((m) => analytics.deprecatedMetrics.includes(m));
        expect(overlap).toEqual([]);
      });

      it('declares reconcilability whenever it lacks an idempotency key', () => {
        const { publishing } = fixtures.createProvider().capabilities(null);
        // Without one or the other, exactly-once publishing is impossible and
        // the engine has no safe way to retry an ambiguous outcome.
        expect(publishing.idempotencyKey || publishing.reconcilable).toBe(true);
      });
    });

    // ── Validation ────────────────────────────────────────────────────────

    describe('validation', () => {
      it('accepts a valid draft', () => {
        const provider = fixtures.createProvider();
        const result = provider.validate(fixtures.validDraft());
        expect(result.valid, JSON.stringify(result.issues)).toBe(true);
      });

      it('is pure — the same draft always yields the same verdict', () => {
        const provider = fixtures.createProvider();
        const draft = fixtures.validDraft();
        expect(provider.validate(draft)).toEqual(provider.validate(draft));
      });

      it('agrees with the shared engine, so client and server cannot diverge', () => {
        const provider = fixtures.createProvider();
        const draft = fixtures.validDraft();
        const viaProvider = provider.validate(draft);
        const viaEngine = validateDraft(provider.capabilities(null), draft);
        expect(viaProvider.valid).toBe(viaEngine.valid);
      });

      it('rejects an entirely empty post', () => {
        const provider = fixtures.createProvider();
        const result = provider.validate({ body: '' });
        expect(result.valid).toBe(false);
      });

      it('rejects a body beyond the declared limit', () => {
        const provider = fixtures.createProvider();
        const capabilities = provider.capabilities(null);
        if (!capabilities.text.supported) return;

        const result = provider.validate({
          ...fixtures.validDraft(),
          body: 'a'.repeat(capabilities.text.maxLength + 1),
        });

        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === 'TEXT_TOO_LONG')).toBe(true);
      });

      it('rejects more attachments than declared', () => {
        const provider = fixtures.createProvider();
        const capabilities = provider.capabilities(null);
        const max = capabilities.media.maxAttachments;
        if (max === 0) return;

        const media = Array.from({ length: max + 1 }, (_, i) => ({
          id: `m${i}`,
          kind: 'IMAGE' as const,
          mimeType: capabilities.media.image?.mimeTypes[0] ?? 'image/jpeg',
          sizeBytes: 1024,
          width: 1000,
          height: 1000,
        }));

        const result = provider.validate({ ...fixtures.validDraft(), media });
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === 'TOO_MANY_ATTACHMENTS')).toBe(true);
      });

      it('reports every problem at once rather than only the first', () => {
        const provider = fixtures.createProvider();
        const capabilities = provider.capabilities(null);
        if (!capabilities.text.supported || capabilities.media.maxAttachments === 0) return;

        const result = provider.validate({
          body: 'a'.repeat(capabilities.text.maxLength + 1),
          media: Array.from({ length: capabilities.media.maxAttachments + 1 }, (_, i) => ({
            id: `m${i}`,
            kind: 'IMAGE' as const,
            mimeType: 'application/octet-stream',
            sizeBytes: 1024,
          })),
        });

        expect(result.issues.filter((i) => i.severity === 'ERROR').length).toBeGreaterThan(1);
      });

      it('gives every issue a stable code and a displayable message', () => {
        const provider = fixtures.createProvider();
        const result = provider.validate({ body: '' });

        for (const issue of result.issues) {
          expect(issue.code).toMatch(/^[A-Z0-9_]+$/);
          expect(issue.message.length).toBeGreaterThan(0);
          expect(issue.field.length).toBeGreaterThan(0);
        }
      });
    });

    // ── OAuth surface ─────────────────────────────────────────────────────

    describe('authorization', () => {
      it('builds a URL carrying the state it was given', () => {
        const provider = fixtures.createProvider();
        const { url, scopes } = provider.getAuthorizationUrl({
          redirectUri: 'https://app.test/callback',
          state: 'signed-state-value',
        });

        expect(url).toMatch(/^https:\/\//);
        expect(url).toContain('signed-state-value');
        expect(scopes.length).toBeGreaterThan(0);
      });

      it('never puts a client secret in the authorization URL', () => {
        const provider = fixtures.createProvider();
        const { url } = provider.getAuthorizationUrl({
          redirectUri: 'https://app.test/callback',
          state: 's',
        });

        expect(url.toLowerCase()).not.toContain('client_secret');
        expect(url.toLowerCase()).not.toContain('secret=');
      });
    });

    if (fixtures.offlineOnly) return;

    // ── Live-ish surface (against the adapter's own test double) ──────────

    describe('publishing', () => {
      it('returns an external id and a publish time', async () => {
        const provider = fixtures.createProvider();
        const result = await provider.publish({
          credential: fixtures.validCredential(),
          account: fixtures.sampleAccount,
          draft: fixtures.validDraft(),
          media: [],
          contentHash: 'contract-hash-1',
          correlationId: 'contract-test',
        });

        expect(result.externalPostId).toBeTruthy();
        expect(result.publishedAt).toBeInstanceOf(Date);
      });

      it('never returns credential material in providerMeta', async () => {
        const provider = fixtures.createProvider();
        const credential = fixtures.validCredential();
        const result = await provider.publish({
          credential,
          account: fixtures.sampleAccount,
          draft: fixtures.validDraft(),
          media: [],
          contentHash: 'contract-hash-2',
          correlationId: 'contract-test',
        });

        const serialised = JSON.stringify(result);
        expect(serialised).not.toContain(credential.accessToken);
      });
    });

    describe('reconciliation', () => {
      it('finds a post it published, matched on content hash', async () => {
        const provider = fixtures.createProvider();
        const contentHash = 'contract-reconcile-hash';
        const draft = fixtures.validDraft();

        await provider.publish({
          credential: fixtures.validCredential(),
          account: fixtures.sampleAccount,
          draft,
          media: [],
          contentHash,
          correlationId: 'contract-test',
        });

        const result = await provider.reconcile({
          credential: fixtures.validCredential(),
          account: fixtures.sampleAccount,
          contentHash,
          body: draft.body,
          attemptedAt: clock.now(),
          windowMs: 600_000,
          correlationId: 'contract-test',
        });

        expect(result.outcome).toBe('FOUND');
      });

      it('reports NOT_FOUND for content that was never published', async () => {
        const provider = fixtures.createProvider();
        const result = await provider.reconcile({
          credential: fixtures.validCredential(),
          account: fixtures.sampleAccount,
          contentHash: 'never-published-hash',
          body: 'never published',
          attemptedAt: clock.now(),
          windowMs: 600_000,
          correlationId: 'contract-test',
        });

        // NOT_FOUND must be distinguishable from INCONCLUSIVE: the first lets
        // the engine retry, the second must never be treated as permission to.
        expect(result.outcome).toBe('NOT_FOUND');
      });
    });

    describe('error normalization', () => {
      it('throws taxonomy errors, never raw provider shapes', async () => {
        const provider = fixtures.createProvider();

        // A draft the platform itself rejects, or a missing post — whichever
        // the adapter can produce without a network.
        const thrown = await provider
          .deletePost(
            {
              externalPostId: 'definitely-not-a-real-post',
              accountExternalId: fixtures.sampleAccount.externalId,
            },
            fixtures.validCredential(),
          )
          .then(() => undefined)
          .catch((e: unknown) => e);

        if (thrown === undefined) return; // adapter tolerates unknown ids

        expect(isAppError(thrown)).toBe(true);
        const error = thrown as AppError;
        expect(error.code.startsWith('PROVIDER_') || error.code === 'PUBLISHING_TIMEOUT').toBe(
          true,
        );
        expect(typeof error.retryable).toBe('boolean');
        expect(error.userMessage.length).toBeGreaterThan(0);
      });
    });

    describe('health', () => {
      it('reports a status, granted scopes and a check time', async () => {
        const provider = fixtures.createProvider();
        const health = await provider.probeHealth(
          fixtures.validCredential(),
          fixtures.sampleAccount,
        );

        expect(['ACTIVE', 'NEEDS_RECONNECT', 'DISABLED', 'REVOKED']).toContain(health.status);
        expect(Array.isArray(health.grantedScopes)).toBe(true);
        expect(health.checkedAt).toBeInstanceOf(Date);
      });
    });

    describe('analytics', () => {
      it('returns an availability entry for every metric it returns', async () => {
        const provider = fixtures.createProvider();
        const capabilities = provider.capabilities(null);
        if (!capabilities.analytics.account) return;

        const set = await provider.fetchAccountAnalytics(
          fixtures.sampleAccount,
          fixtures.validCredential(),
          { from: new Date(clock.nowMs() - 7 * 86_400_000), to: clock.now() },
        );

        for (const metric of Object.keys(set.metrics)) {
          expect(set.availability[metric], `${metric} has no availability entry`).toBeDefined();
        }
        expect(set.apiVersion).toBeTruthy();
      });

      it('marks withdrawn metrics DEPRECATED rather than reporting zero', async () => {
        const provider = fixtures.createProvider();
        const capabilities = provider.capabilities(null);
        if (
          !capabilities.analytics.account ||
          capabilities.analytics.deprecatedMetrics.length === 0
        ) {
          return;
        }

        const set = await provider.fetchAccountAnalytics(
          fixtures.sampleAccount,
          fixtures.validCredential(),
          { from: new Date(clock.nowMs() - 7 * 86_400_000), to: clock.now() },
        );

        for (const metric of capabilities.analytics.deprecatedMetrics) {
          if (set.availability[metric] !== undefined) {
            expect(set.availability[metric]).toBe('DEPRECATED');
            expect(set.metrics[metric]).toBeUndefined();
          }
        }
      });
    });
  });
}
