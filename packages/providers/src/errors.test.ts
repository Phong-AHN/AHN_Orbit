import { describe, expect, it } from 'vitest';
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  PublishingTimeoutError,
  ValidationError,
} from '@orbit/core';
import {
  ProviderErrorMap,
  classifyHttpStatus,
  normalizeUnknownError,
  parseRetryAfter,
  toAppError,
  tokenEndpointFailure,
} from './errors.js';

describe('classifyHttpStatus', () => {
  it.each([
    [401, 'AUTHENTICATION'],
    [403, 'PERMISSION'],
    [429, 'RATE_LIMIT'],
    [408, 'TIMEOUT'],
    [504, 'TIMEOUT'],
    [413, 'MEDIA'],
    [415, 'MEDIA'],
    [400, 'VALIDATION'],
    [422, 'VALIDATION'],
    [500, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
  ])('maps %i to %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });
});

describe('toAppError', () => {
  it('produces the taxonomy class for each kind', () => {
    expect(toAppError('FACEBOOK', { kind: 'AUTHENTICATION', message: 'x' })).toBeInstanceOf(
      ProviderAuthenticationError,
    );
    expect(toAppError('FACEBOOK', { kind: 'RATE_LIMIT', message: 'x' })).toBeInstanceOf(
      ProviderRateLimitError,
    );
    expect(toAppError('FACEBOOK', { kind: 'TIMEOUT', message: 'x' })).toBeInstanceOf(
      PublishingTimeoutError,
    );
  });

  it('marks authentication failures non-retryable — retrying a dead token burns quota', () => {
    expect(toAppError('FACEBOOK', { kind: 'AUTHENTICATION', message: 'x' }).retryable).toBe(false);
  });

  it('marks rate limits retryable and carries retryAfter', () => {
    const error = toAppError('FACEBOOK', {
      kind: 'RATE_LIMIT',
      message: 'x',
      retryAfterSeconds: 90,
    });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(90);
  });

  it('marks a timeout NON-retryable, because the outcome is unknown', () => {
    // The engine must reconcile before it may try again; a retryable timeout
    // is precisely how a double-post happens.
    expect(toAppError('FACEBOOK', { kind: 'TIMEOUT', message: 'x' }).retryable).toBe(false);
  });

  it('marks unavailability retryable', () => {
    expect(toAppError('FACEBOOK', { kind: 'UNAVAILABLE', message: 'x' }).retryable).toBe(true);
  });

  it('keeps the platform and provider code in context, not in the user message', () => {
    const error = toAppError('FACEBOOK', {
      kind: 'VALIDATION',
      message: 'Graph error 100: bad field',
      providerCode: 100,
      httpStatus: 400,
    });

    expect(error.context.platform).toBe('FACEBOOK');
    expect(error.context.providerCode).toBe(100);
    expect(error.userMessage).not.toContain('Graph error');
  });
});

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    expect(parseRetryAfter('Wed, 12 Aug 2026 10:01:00 GMT', now)).toBe(60);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-08-12T10:00:00Z');
    expect(parseRetryAfter('Wed, 12 Aug 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for a missing or unparseable header', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('normalizeUnknownError', () => {
  it('classifies an abort as TIMEOUT so the engine reconciles', () => {
    const error = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(normalizeUnknownError('FACEBOOK', error)).toBeInstanceOf(PublishingTimeoutError);
  });

  it.each(['socket hang up', 'ETIMEDOUT connecting', 'ECONNRESET'])(
    'treats %s as a timeout, not a plain failure',
    (message) => {
      expect(normalizeUnknownError('FACEBOOK', new Error(message))).toBeInstanceOf(
        PublishingTimeoutError,
      );
    },
  );

  it('classifies anything else as unavailable', () => {
    expect(normalizeUnknownError('FACEBOOK', new Error('weird'))).toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('passes an existing application error through untouched', () => {
    const original = new ValidationError('already normalized');
    expect(normalizeUnknownError('FACEBOOK', original)).toBe(original);
  });

  it('never leaks the original message to the user', () => {
    const error = normalizeUnknownError('FACEBOOK', new Error('token=abc123 leaked in message'));
    expect(error.userMessage).not.toContain('abc123');
  });
});

describe('ProviderErrorMap', () => {
  const map = new ProviderErrorMap({
    '190': 'AUTHENTICATION',
    '4': 'RATE_LIMIT',
    '200': 'PERMISSION',
    '100': 'VALIDATION',
  });

  it('classifies a known code', () => {
    expect(map.classify(190)).toBe('AUTHENTICATION');
    expect(map.classify('4')).toBe('RATE_LIMIT');
  });

  it('classifies a subcode by its parent', () => {
    expect(map.classify('190.463')).toBe('AUTHENTICATION');
  });

  it('falls back to the HTTP status for an unknown code', () => {
    expect(map.classify(99999, 429)).toBe('RATE_LIMIT');
  });

  it('falls back to UNAVAILABLE with no code and no status', () => {
    expect(map.classify(undefined)).toBe('UNAVAILABLE');
  });
});

/**
 * A token endpoint's refusal, read by the standard (RFC 6749 §5.2) for every
 * platform (D-114). Reading these wrongly is what told every account on a
 * platform to reconnect when only our own app credentials were at fault.
 */
describe('tokenEndpointFailure', () => {
  const fallback = classifyHttpStatus;

  /** Google says a refresh token is dead with a 400, not a 401. */
  it('reads invalid_grant as a dead connection, whatever the status', () => {
    const error = tokenEndpointFailure('YOUTUBE', { status: 400, code: 'invalid_grant', fallback });
    expect(error.code).toBe('PROVIDER_AUTHENTICATION_ERROR');
    expect(error.context['clientStanding']).toBeUndefined();
  });

  it.each([
    ['invalid_client', 401],
    ['invalid_client', 400],
    ['unauthorized_client', 400],
    ['unsupported_grant_type', 400],
  ])('reads %s (HTTP %i) as about our app, never the account', (code, status) => {
    const error = tokenEndpointFailure('X', { status, code, fallback });

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.context['clientStanding']).toBe(true);
    expect(error.userMessage).toMatch(/administrator/);
    expect(error.userMessage).toMatch(/reconnecting the account will not help/);
  });

  /** The standard's own meaning of a 401 at the token endpoint. */
  it('reads a 401 with no code as a refusal of our client', () => {
    const error = tokenEndpointFailure('PINTEREST', { status: 401, fallback });
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.context['clientStanding']).toBe(true);
  });

  /** X answers a spent refresh token with `invalid_request`. */
  it("honours a platform's own word for a dead refresh token", () => {
    const error = tokenEndpointFailure('X', {
      status: 400,
      code: 'invalid_request',
      grantCodes: ['invalid_request'],
      fallback,
    });
    expect(error.code).toBe('PROVIDER_AUTHENTICATION_ERROR');
  });

  it('leaves everything else to the platform reading of the status', () => {
    expect(tokenEndpointFailure('LINKEDIN', { status: 503, fallback }).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(tokenEndpointFailure('LINKEDIN', { status: 429, fallback }).code).toBe(
      'PROVIDER_RATE_LIMIT',
    );
    expect(
      tokenEndpointFailure('LINKEDIN', { status: 503, fallback }).context['clientStanding'],
    ).toBeUndefined();
  });

  it('keeps the platform code and description for whoever reads the log', () => {
    const error = tokenEndpointFailure('YOUTUBE', {
      status: 400,
      code: 'invalid_grant',
      description: 'Token has been expired or revoked.',
      fallback,
    });
    expect(error.message).toBe(
      'Google OAuth refused: invalid_grant — Token has been expired or revoked.',
    );
    expect(error.context['providerCode']).toBe('invalid_grant');
  });
});
