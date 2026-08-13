import type { BadgeTone } from '@orbit/ui';
import type { SocialAccountStatus } from '@orbit/core';

/**
 * How connection health reads on screen (SRS §14, T1.7).
 *
 * Total records, so adding a status to the enum is a type error here until
 * someone decides how to show it — the same discipline as the post status and
 * publishing state maps.
 */

export const ACCOUNT_STATUS_TONE: Record<SocialAccountStatus, BadgeTone> = {
  ACTIVE: 'success',
  // Danger rather than warning: unlike a parked publish, this one is definite —
  // nothing on this account will publish until a person acts.
  NEEDS_RECONNECT: 'danger',
  DISABLED: 'neutral',
  REVOKED: 'neutral',
};

export const ACCOUNT_STATUS_LABEL: Record<SocialAccountStatus, string> = {
  ACTIVE: 'Connected',
  NEEDS_RECONNECT: 'Needs reconnecting',
  DISABLED: 'Not connected',
  REVOKED: 'Disconnected',
};

/** What the status means for publishing, in the reader's terms. */
export const ACCOUNT_STATUS_HINT: Record<SocialAccountStatus, string | null> = {
  ACTIVE: null,
  NEEDS_RECONNECT: 'Scheduled posts for this account are waiting and will not go out.',
  DISABLED: 'This account was never finished connecting.',
  REVOKED: 'Connect it again to publish to it.',
};

/** Only a live connection can be reconnected; a revoked one starts over. */
export function canReconnect(status: SocialAccountStatus): boolean {
  return status === 'ACTIVE' || status === 'NEEDS_RECONNECT';
}
