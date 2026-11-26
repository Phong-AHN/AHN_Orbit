import { serverEnv } from '@orbit/config';

/**
 * Where a notification points, outside the product (SRS §18; D-129).
 *
 * Deep-links to the thing that needs attention rather than the dashboard —
 * an alert that lands somebody on a home page and makes them hunt is an alert
 * they stop opening. Shared by email and Slack so the two never disagree about
 * where "this post" lives.
 */
export function linkFor(notification: {
  type: string;
  resourceType: string | null;
  resourceId: string | null;
  organization: { slug: string };
}): string {
  const base = `${serverEnv().APP_URL.replace(/\/$/, '')}/orgs/${notification.organization.slug}`;

  if (notification.resourceType === 'Post' && notification.resourceId) {
    return `${base}/posts/${notification.resourceId}`;
  }

  if (notification.type.startsWith('social_account.')) return `${base}/settings/accounts`;
  if (notification.type.startsWith('publishing.')) return `${base}/publishing`;

  return `${base}/dashboard`;
}
