import { describe, expect, it } from 'vitest';
import { classifyIdentityProbeError } from './firebase-provider.js';

/**
 * Sorting a sign-in failure into the right category.
 *
 * This is the only part of the health probe worth testing, and it is worth
 * testing because getting it wrong is silent and expensive: a rejected service
 * account filed as `UNREACHABLE` tells an operator that Google is down, and
 * they go and look at a status page instead of at their own key.
 *
 * Every shape below is one Firebase Admin actually produces. The SDK reports
 * the same problem three different ways — a `code`, a nested `errorInfo.code`,
 * or a bare message — which is the reason the classifier reads all three.
 */

describe('a credential Google refused', () => {
  it('recognises a revoked or wrong-project service account', () => {
    expect(classifyIdentityProbeError({ code: 'app/invalid-credential' })).toBe(
      'CREDENTIAL_REJECTED',
    );
  });

  /** The shape the SDK uses when it wraps a Google OAuth failure. */
  it('reads a nested errorInfo code', () => {
    expect(classifyIdentityProbeError({ errorInfo: { code: 'auth/invalid-credential' } })).toBe(
      'CREDENTIAL_REJECTED',
    );
  });

  /** A deleted service account arrives as a raw OAuth error with no code. */
  it('recognises invalid_grant from the message alone', () => {
    expect(
      classifyIdentityProbeError({
        message: 'Credential implementation provided to initializeApp() failed: invalid_grant',
      }),
    ).toBe('CREDENTIAL_REJECTED');
  });

  /**
   * The classic `.env` mistake: a private key pasted without its line breaks,
   * or with a trailing comma from the service-account JSON. OpenSSL complains
   * about the PEM, which has nothing to do with the network.
   */
  it('recognises a malformed private key', () => {
    expect(
      classifyIdentityProbeError({ message: 'error:0909006C:PEM routines:get_name:no start line' }),
    ).toBe('CREDENTIAL_REJECTED');
  });

  /**
   * **Clock drift is filed here on purpose.** A machine far enough out of sync
   * signs a JWT that Google reads as already expired and answers
   * `invalid_grant`. It is not a bad key and not an outage — but it *is* Google
   * refusing the credential, which is the half of the system an operator should
   * be looking at.
   */
  it('files a signed-JWT rejection as a credential problem, not an outage', () => {
    expect(
      classifyIdentityProbeError({ message: 'Invalid JWT: Token must be a short-lived token' }),
    ).toBe('CREDENTIAL_REJECTED');
  });
});

describe('everything else is an outage', () => {
  it('treats a DNS failure as unreachable', () => {
    expect(classifyIdentityProbeError({ code: 'ENOTFOUND' })).toBe('UNREACHABLE');
  });

  it('treats a timeout as unreachable', () => {
    expect(classifyIdentityProbeError({ code: 'ETIMEDOUT', message: 'socket hang up' })).toBe(
      'UNREACHABLE',
    );
  });

  /** No code, no recognisable message: say the honest thing rather than guess. */
  it('falls back to unreachable for an error it cannot read', () => {
    expect(classifyIdentityProbeError(new Error('something went wrong'))).toBe('UNREACHABLE');
    expect(classifyIdentityProbeError(undefined)).toBe('UNREACHABLE');
    expect(classifyIdentityProbeError(null)).toBe('UNREACHABLE');
    expect(classifyIdentityProbeError('a bare string')).toBe('UNREACHABLE');
  });
});

describe('what the categories never contain', () => {
  /**
   * This route answers without a session, so a category must not become a way
   * to read configuration. The classifier returns one of three fixed strings
   * and can never echo the provider's message back.
   */
  it('cannot leak a project id, an email or a key through its return value', () => {
    const hostile = {
      code: 'app/invalid-credential',
      message:
        'service account orbit-admin@my-secret-project.iam.gserviceaccount.com ' +
        'key AIzaSyExample rejected for project my-secret-project',
    };

    const reason = classifyIdentityProbeError(hostile);

    expect(reason).toBe('CREDENTIAL_REJECTED');
    expect(['NOT_CONFIGURED', 'CREDENTIAL_REJECTED', 'UNREACHABLE']).toContain(reason);
  });
});
