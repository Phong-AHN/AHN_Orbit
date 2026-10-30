import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OAuthError, hashSecret, isAcceptableRedirectUri, parseScopes, pkceMatches } from './oauth';

describe('agent OAuth', () => {
  it('grants the narrowest scope when none is asked for, and refuses unknown ones', () => {
    expect(parseScopes(undefined)).toEqual(['read']);
    expect(parseScopes('  ')).toEqual(['read']);
    expect(parseScopes('engagement read')).toEqual(['read', 'engagement']);
    expect(() => parseScopes('read admin')).toThrow(OAuthError);
  });

  it('accepts https and loopback http redirect URIs only', () => {
    expect(isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAcceptableRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost:6274/oauth/callback')).toBe(true);
    expect(isAcceptableRedirectUri('http://evil.example/callback')).toBe(false);
    expect(isAcceptableRedirectUri('https://claude.ai/cb#fragment')).toBe(false);
    expect(isAcceptableRedirectUri('https://user:pass@claude.ai/cb')).toBe(false);
    expect(isAcceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAcceptableRedirectUri('not a url')).toBe(false);
  });

  it('verifies PKCE S256 and nothing weaker', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    // "plain" — the verifier itself as the challenge — is not accepted.
    expect(pkceMatches(verifier, verifier)).toBe(false);
    expect(pkceMatches('short', createHash('sha256').update('short').digest('base64url'))).toBe(
      false,
    );
  });

  it('stores tokens only as a one-way hash', () => {
    const token = 'ssat_example';
    expect(hashSecret(token)).not.toContain(token);
    expect(hashSecret(token)).toBe(hashSecret(token));
  });
});
