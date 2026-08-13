import { describe, expect, it } from 'vitest';
import {
  HEALTH_PROBE_INTERVAL_MS,
  accountStatusForErrorCode,
  classifyHealthChange,
  isProbeDue,
} from './account-health.js';
import { ERROR_CODES } from './errors.js';

/**
 * The pure half of account health (T1.7).
 *
 * These are the decisions shared by the hourly sweep, the publish engine and the
 * web endpoint. Pinning them here is what lets those three places stay in step
 * without three copies of the reasoning.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('isProbeDue', () => {
  it('probes an account that has never been checked', () => {
    // The strongest reason to ask: nothing at all is known about it.
    expect(isProbeDue(null, NOW)).toBe(true);
    expect(isProbeDue(undefined, NOW)).toBe(true);
  });

  it('does not re-probe an account checked recently', () => {
    expect(isProbeDue(ago(5 * 60_000), NOW)).toBe(false);
  });

  it('probes once the interval has elapsed', () => {
    expect(isProbeDue(ago(HEALTH_PROBE_INTERVAL_MS), NOW)).toBe(true);
    expect(isProbeDue(ago(HEALTH_PROBE_INTERVAL_MS + 1), NOW)).toBe(true);
  });

  it('treats the boundary as due rather than not due', () => {
    // Sweeps run on a schedule that will land a millisecond either side of the
    // hour. Excluding the boundary would skip an account for a whole cycle.
    expect(isProbeDue(ago(HEALTH_PROBE_INTERVAL_MS - 1), NOW)).toBe(false);
    expect(isProbeDue(ago(HEALTH_PROBE_INTERVAL_MS), NOW)).toBe(true);
  });

  it('honours an explicit interval, including zero for "check now"', () => {
    expect(isProbeDue(ago(1_000), NOW, 60_000)).toBe(false);
    expect(isProbeDue(ago(1_000), NOW, 0)).toBe(true);
    // Even a check from this very instant is due when the caller asked for one.
    expect(isProbeDue(NOW, NOW, 0)).toBe(true);
  });
});

describe('accountStatusForErrorCode', () => {
  it('demotes on the two codes that mean the credential is no longer good', () => {
    expect(accountStatusForErrorCode('PROVIDER_AUTHENTICATION_ERROR')).toBe('NEEDS_RECONNECT');
    expect(accountStatusForErrorCode('PROVIDER_PERMISSION_ERROR')).toBe('NEEDS_RECONNECT');
  });

  it('leaves the account alone for failures that are about the post', () => {
    // This is the half that matters most. Demoting an account because one
    // caption was too long would pause publishing for every other post on it.
    expect(accountStatusForErrorCode('PROVIDER_VALIDATION_ERROR')).toBeNull();
    expect(accountStatusForErrorCode('PROVIDER_MEDIA_ERROR')).toBeNull();
    expect(accountStatusForErrorCode('PROVIDER_RATE_LIMIT')).toBeNull();
    expect(accountStatusForErrorCode('PROVIDER_UNAVAILABLE')).toBeNull();
    expect(accountStatusForErrorCode('PUBLISHING_TIMEOUT')).toBeNull();
  });

  it('answers for every error code without throwing', () => {
    // A new code must not be able to reach this function undecided.
    for (const code of ERROR_CODES) {
      const result = accountStatusForErrorCode(code);
      expect(result === null || result === 'NEEDS_RECONNECT').toBe(true);
    }
  });
});

describe('classifyHealthChange', () => {
  it('reports a healthy account staying healthy as no change at all', () => {
    // The hourly sweep hits this case for almost every account, almost always.
    expect(classifyHealthChange('ACTIVE', 'ACTIVE')).toEqual({
      changed: false,
      degraded: false,
      recovered: false,
    });
  });

  it('reports the moment an account breaks', () => {
    expect(classifyHealthChange('ACTIVE', 'NEEDS_RECONNECT')).toEqual({
      changed: true,
      degraded: true,
      recovered: false,
    });
  });

  it('does not re-report an account that is still broken', () => {
    // Without this, an account left broken over a weekend would generate a
    // notification every hour — and people would learn to ignore them.
    expect(classifyHealthChange('NEEDS_RECONNECT', 'NEEDS_RECONNECT')).toEqual({
      changed: false,
      degraded: false,
      recovered: false,
    });
  });

  it('reports recovery', () => {
    expect(classifyHealthChange('NEEDS_RECONNECT', 'ACTIVE')).toEqual({
      changed: true,
      degraded: false,
      recovered: true,
    });
  });

  it('does not treat a deliberate disconnection as a breakage', () => {
    // REVOKED and DISABLED are states a person put the account into. Announcing
    // them would be reporting the user's own action back as a problem.
    expect(classifyHealthChange('ACTIVE', 'REVOKED').degraded).toBe(false);
    expect(classifyHealthChange('ACTIVE', 'DISABLED').degraded).toBe(false);
    // Still a change, so it is still audited.
    expect(classifyHealthChange('ACTIVE', 'REVOKED').changed).toBe(true);
  });

  it('does not count a first connection as a recovery', () => {
    expect(classifyHealthChange('DISABLED', 'ACTIVE').recovered).toBe(false);
  });
});

// Notification copy moved to `@orbit/notifications` in T1.15; its tests moved
// with it (`packages/notifications/src/content.test.ts`).
