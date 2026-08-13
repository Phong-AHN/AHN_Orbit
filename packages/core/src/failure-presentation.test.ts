import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors.js';
import { isRetryOffered, presentFailure } from './failure-presentation.js';

describe('presentFailure', () => {
  it('explains every code in the taxonomy', () => {
    // SRS §37 requires every error class render a useful human message. If a
    // code is added without an explanation, this fails rather than shipping a
    // shrug to a user.
    for (const code of ERROR_CODES) {
      const presentation = presentFailure(code);

      expect(presentation.summary.length).toBeGreaterThan(10);
      expect(presentation.action).toBeTruthy();
    }
  });

  it('never leaks an error code into the summary', () => {
    // The reader is an account manager, not an engineer.
    for (const code of ERROR_CODES) {
      expect(presentFailure(code).summary).not.toContain(code);
      expect(presentFailure(code).summary).not.toMatch(/[A-Z]{4,}_[A-Z]{4,}/);
    }
  });

  it('points an expired connection at reconnecting', () => {
    const presentation = presentFailure('PROVIDER_AUTHENTICATION_ERROR');
    expect(presentation.action).toBe('RECONNECT_ACCOUNT');
    expect(presentation.retryable).toBe(false);
  });

  it('points rejected content at editing, not retrying', () => {
    // Retrying unchanged content the platform already refused is pointless.
    expect(presentFailure('PROVIDER_VALIDATION_ERROR')).toMatchObject({
      action: 'EDIT_CONTENT',
      retryable: false,
    });
    expect(presentFailure('PROVIDER_MEDIA_ERROR').action).toBe('FIX_MEDIA');
  });

  it('treats a rate limit as something to wait out', () => {
    expect(presentFailure('PROVIDER_RATE_LIMIT')).toMatchObject({
      action: 'WAIT',
      retryable: true,
    });
  });

  it('describes a timeout as unknown rather than failed, and sends it to review', () => {
    // The distinction the whole design rests on: it is not a failure, it is an
    // unknown, and only a person can settle it.
    const presentation = presentFailure('PUBLISHING_TIMEOUT');

    expect(presentation.action).toBe('REVIEW');
    expect(presentation.retryable).toBe(false);
    expect(presentation.summary).toContain('never confirmed');
    expect(presentation.summary).toContain('twice');
  });

  it('explains the human-resolution markers as outcomes, not failures', () => {
    expect(presentFailure('RESOLVED_BY_HUMAN').summary).toContain('confirmed');
    expect(presentFailure('RETRY_AFTER_REVIEW').retryable).toBe(true);
    expect(presentFailure('ABANDONED_BY_HUMAN').action).toBe('REVIEW');
  });

  it('handles an absent code', () => {
    expect(presentFailure(null).action).toBe('WAIT');
    expect(presentFailure(undefined).summary).toContain('not been attempted');
  });

  it('falls back safely for a code it has never seen', () => {
    const presentation = presentFailure('SOMETHING_NEW');

    expect(presentation.action).toBe('CONTACT_SUPPORT');
    expect(presentation.retryable).toBe(false);
    expect(presentation.summary).not.toContain('SOMETHING_NEW');
  });
});

describe('isRetryOffered', () => {
  it('offers a retry for transient failures', () => {
    expect(isRetryOffered('PROVIDER_UNAVAILABLE')).toBe(true);
    expect(isRetryOffered('INTERNAL_ERROR')).toBe(true);
  });

  it('does not offer a retry for anything a retry cannot fix', () => {
    expect(isRetryOffered('PROVIDER_AUTHENTICATION_ERROR')).toBe(false);
    expect(isRetryOffered('PROVIDER_VALIDATION_ERROR')).toBe(false);
  });

  it('does not offer a retry for an unresolved publish', () => {
    // Offering "try again" here is offering to double-post.
    expect(isRetryOffered('PUBLISHING_TIMEOUT')).toBe(false);
  });
});
