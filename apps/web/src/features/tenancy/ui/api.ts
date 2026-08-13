'use client';

import { apiRequest } from '@/features/posts/ui/api';

/**
 * Browser-side calls for the onboarding chain.
 *
 * Organization → workspace → brand → connected account is the order in which
 * an agency has to set itself up, and until now every one of those routes was
 * reachable only by hand. They were built and tested in T1.4 and T1.5; what was
 * missing was any way into them from a browser, which is why the product had a
 * green test suite and no usable front door.
 */

const org = (orgSlug: string) => `/api/v1/orgs/${encodeURIComponent(orgSlug)}`;

const send = <T>(url: string, body: unknown) =>
  apiRequest<T>(url, { method: 'POST', body: JSON.stringify(body) });

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export function createOrganization(input: { name: string; timezone: string }) {
  return send<{ organization: OrganizationSummary }>('/api/v1/orgs', input);
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export function createWorkspace(
  orgSlug: string,
  input: { name: string; timezone: string; clientCompanyName?: string },
) {
  return send<{ workspace: WorkspaceSummary }>(`${org(orgSlug)}/workspaces`, input);
}

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
}

export function createBrand(
  orgSlug: string,
  workspaceId: string,
  input: { name: string; website?: string; primaryColor?: string },
) {
  return send<{ brand: BrandSummary }>(`${org(orgSlug)}/workspaces/${workspaceId}/brands`, input);
}

/**
 * Begin an OAuth connection. Returns where to send the browser — the state
 * cookie rides on this response, so the caller must navigate rather than
 * open a popup (same reasoning as `ReconnectButton`).
 */
export function startConnect(
  orgSlug: string,
  platform: string,
  input: { workspaceId: string; brandId: string; returnTo: string },
) {
  return send<{ authorizationUrl: string; scopes: string[] }>(
    `${org(orgSlug)}/social-accounts/oauth/${encodeURIComponent(platform.toLowerCase())}/start`,
    input,
  );
}

/**
 * Activate the subset of discovered accounts the user chose. Everything they
 * left unticked stays staged and is discarded with its credentials.
 */
export function confirmAccounts(
  orgSlug: string,
  input: {
    platform: string;
    workspaceId: string;
    brandId: string;
    socialAccountIds: string[];
  },
) {
  return send<{ connected: Array<{ id: string; displayName: string }> }>(
    `${org(orgSlug)}/social-accounts`,
    input,
  );
}
