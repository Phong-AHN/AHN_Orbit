import { describe, expect, it } from 'vitest';
import { TenantIsolationError } from '@orbit/core';
import { resolveJobTenant } from './tenant.js';

const ORG_A = '018f0000-0000-7000-8000-00000000000a';
const ORG_B = '018f0000-0000-7000-8000-00000000000b';

const context = {
  queue: 'publish',
  jobId: 'job-1',
  subjectType: 'postVariant',
  subjectId: '018f0000-0000-7000-8000-000000000099',
};

describe('resolveJobTenant', () => {
  it('returns the subject row tenant when the payload agrees', () => {
    expect(resolveJobTenant(ORG_A, { organizationId: ORG_A }, context)).toBe(ORG_A);
  });

  it('refuses when the payload names a different tenant than the subject', () => {
    // The whole point: a job that claims org B while its subject belongs to
    // org A must not be handed a client scoped to either. Both readings cannot
    // be right, and guessing which is the hazard.
    expect(() => resolveJobTenant(ORG_B, { organizationId: ORG_A }, context)).toThrow(
      TenantIsolationError,
    );
  });

  it('refuses when the subject does not exist', () => {
    // Falling back to the claimed value is precisely the trust being denied.
    expect(() => resolveJobTenant(ORG_A, null, context)).toThrow(TenantIsolationError);
  });

  it('never returns the claimed value in preference to the subject', () => {
    const resolved = resolveJobTenant(ORG_A, { organizationId: ORG_A }, context);
    // Same value here, but it came from the row — the mismatch case above is
    // what proves the row is the authority.
    expect(resolved).toBe(ORG_A);
    expect(() => resolveJobTenant(ORG_A, { organizationId: ORG_B }, context)).toThrow();
  });
});
