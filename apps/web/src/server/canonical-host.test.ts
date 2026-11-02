import { describe, expect, it } from 'vitest';
import { canonicalRedirect } from './canonical-host';

const APP_URL = 'https://www.anhoi.co';

const redirect = (href: string, overrides: Partial<Parameters<typeof canonicalRedirect>[0]> = {}) =>
  canonicalRedirect({
    url: new URL(href),
    method: 'GET',
    appUrl: APP_URL,
    vercelEnv: 'production',
    ...overrides,
  });

describe('canonicalRedirect', () => {
  /** The cookies an OAuth callback needs only exist on the host that set them. */
  it('moves a page on another host to the canonical one, keeping path and query', () => {
    expect(redirect('https://ahn-orbit-web.vercel.app/orgs/acme/settings/accounts?x=1')).toBe(
      'https://www.anhoi.co/orgs/acme/settings/accounts?x=1',
    );
  });

  it('leaves the canonical host alone', () => {
    expect(redirect('https://www.anhoi.co/orgs/acme')).toBeNull();
  });

  /** A webhook or MCP client would be broken by a redirect, not steered. */
  it('never moves API routes or discovery documents', () => {
    expect(redirect('https://ahn-orbit-web.vercel.app/api/v1/webhooks/meta')).toBeNull();
    expect(
      redirect('https://ahn-orbit-web.vercel.app/.well-known/oauth-authorization-server'),
    ).toBeNull();
  });

  it('does nothing outside production, or for a non-GET request', () => {
    expect(redirect('https://ahn-orbit-git-x.vercel.app/', { vercelEnv: 'preview' })).toBeNull();
    expect(redirect('https://ahn-orbit-web.vercel.app/orgs', { method: 'POST' })).toBeNull();
  });

  it('does nothing when APP_URL is missing or malformed', () => {
    expect(redirect('https://ahn-orbit-web.vercel.app/', { appUrl: undefined })).toBeNull();
    expect(redirect('https://ahn-orbit-web.vercel.app/', { appUrl: 'not a url' })).toBeNull();
  });
});
