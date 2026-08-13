import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderRateLimitError, PublishingTimeoutError } from '@orbit/core';
import { runProviderContractTests } from '../contract/contract-tests.js';
import { MockProvider } from './mock-provider.js';

/**
 * The mock runs the full contract suite, which is what makes the suite itself
 * trustworthy — a contract nothing exercises drifts into fiction.
 */

const shared = new MockProvider();

runProviderContractTests({
  name: 'Mock',
  createProvider: () => shared,
  validCredential: () => ({
    accessToken: 'mock-token-contract',
    scopes: ['mock_read', 'mock_publish'],
    keyVersion: 1,
  }),
  sampleAccount: { externalId: 'dev-mock:100000000000001', accountType: 'PAGE' },
  validDraft: () => ({ body: 'A perfectly ordinary post.' }),
});

// ── Fault injection, which is what the publishing engine will lean on ───────

describe('mock fault injection', () => {
  let provider: MockProvider;

  const credential = {
    accessToken: 'mock-token',
    scopes: ['mock_read', 'mock_publish'],
    keyVersion: 1,
  };
  const account = { externalId: 'dev-mock:100000000000001' };

  const publish = (contentHash = 'hash-1') =>
    provider.publish({
      credential,
      account,
      draft: { body: 'hello' },
      media: [],
      contentHash,
      correlationId: 'test',
    });

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('publishes cleanly by default', async () => {
    const result = await publish();
    expect(result.externalPostId).toMatch(/^mock-post-/);
    expect(provider.posts.size).toBe(1);
  });

  it('injects a rate limit carrying retryAfter', async () => {
    provider.fault = 'RATE_LIMIT';
    const error = await publish().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(60);
    expect(provider.posts.size).toBe(0);
  });

  it('fires a fault once, so the retry after it can succeed', async () => {
    provider.fault = 'UNAVAILABLE';
    await expect(publish()).rejects.toThrow();
    await expect(publish()).resolves.toBeTruthy();
  });

  it('models the dangerous case: timed out AFTER publishing', async () => {
    provider.fault = 'TIMEOUT_THEN_PUBLISHED';
    await expect(publish('ambiguous-hash')).rejects.toBeInstanceOf(PublishingTimeoutError);

    // The post exists even though the caller was told nothing. Only
    // reconciliation can discover this — which is the whole point of layer 4.
    expect(provider.posts.size).toBe(1);

    const reconciled = await provider.reconcile({
      credential,
      account,
      contentHash: 'ambiguous-hash',
      body: 'hello',
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'test',
    });

    expect(reconciled.outcome).toBe('FOUND');
  });

  it('models the other ambiguous case: timed out BEFORE publishing', async () => {
    provider.fault = 'TIMEOUT_NOT_PUBLISHED';
    await expect(publish('ambiguous-hash')).rejects.toBeInstanceOf(PublishingTimeoutError);
    expect(provider.posts.size).toBe(0);

    const reconciled = await provider.reconcile({
      credential,
      account,
      contentHash: 'ambiguous-hash',
      body: 'hello',
      attemptedAt: new Date(),
      windowMs: 600_000,
      correlationId: 'test',
    });

    // NOT_FOUND is what makes a retry safe; the two timeout cases must be
    // distinguishable or exactly-once publishing is impossible.
    expect(reconciled.outcome).toBe('NOT_FOUND');
  });

  it('counts provider calls, so tests can assert exactly one publish happened', async () => {
    await publish();
    await publish('hash-2');
    expect(provider.callCounts.publish).toBe(2);
  });

  it('reports NEEDS_RECONNECT when the credential is revoked', async () => {
    provider.fault = 'AUTH_EXPIRED';
    const health = await provider.probeHealth(credential, account);
    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.missingScopes).toContain('mock_publish');
  });

  it('reports a missing scope as needing reconnection', async () => {
    const health = await provider.probeHealth({ ...credential, scopes: ['mock_read'] }, account);
    expect(health.status).toBe('NEEDS_RECONNECT');
    expect(health.missingScopes).toEqual(['mock_publish']);
  });

  it('refuses a refresh that cannot succeed rather than looping', async () => {
    provider.fault = 'AUTH_EXPIRED';
    const outcome = await provider.refreshCredential({ ...credential, keyVersion: 1 });
    expect(outcome.status).toBe('REQUIRES_RECONNECT');
  });

  it('reports STILL_VALID for a credential nowhere near expiry', async () => {
    const outcome = await provider.refreshCredential({
      ...credential,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    expect(outcome.status).toBe('STILL_VALID');
  });

  it('discovers several accounts from one authorization', async () => {
    const connected = await provider.exchangeCode({ code: 'x', redirectUri: 'https://a.test/cb' });
    expect(connected.accounts.length).toBeGreaterThan(1);
  });

  it('verifies a webhook signature before parsing', () => {
    expect(
      provider.verifyWebhook({ headers: { 'x-mock-signature': 'valid' }, rawBody: '{}' }),
    ).toBe(true);
    expect(provider.verifyWebhook({ headers: {}, rawBody: '{}' })).toBe(false);
  });
});
