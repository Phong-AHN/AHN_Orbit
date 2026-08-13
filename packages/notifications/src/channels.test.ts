import { describe, expect, it } from 'vitest';
import { EMAIL_DELIVERY_ENABLED, channelsFor } from './channels.js';
import { NOTIFICATION_TYPES } from './types.js';
import { RECIPIENT_RULES } from './recipients.js';

/**
 * The delivery seam (T1.15, decision D-034).
 *
 * These tests pin the *scope decision* — in-app only, no mail — so that turning
 * email on is a deliberate change with a failing test to update, not something
 * that happens by accident to a live tenant's client addresses.
 */

describe('channel selection', () => {
  it('delivers in-app and nothing else', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(channelsFor(type), type).toEqual(['IN_APP']);
    }
  });

  it('ignores email preferences, because email is not wired', () => {
    // A preference that silently did nothing would be worse than none at all;
    // `EMAIL_DELIVERY_ENABLED` is what the UI checks before offering toggles.
    expect(channelsFor('publishing.failed', { email: { 'publishing.failed': true } })).toEqual([
      'IN_APP',
    ]);
    expect(EMAIL_DELIVERY_ENABLED).toBe(false);
  });

  it('never returns an empty channel list', () => {
    // There is no opting out of the in-app record: it is the durable evidence
    // someone was told, and the bell is the only place it appears.
    for (const type of NOTIFICATION_TYPES) {
      expect(channelsFor(type).length, type).toBeGreaterThan(0);
    }
  });
});

describe('fan-out rules', () => {
  it('decides who hears about every type', () => {
    // A total record, so a new type cannot ship without someone choosing an
    // audience. This asserts the record is genuinely populated rather than
    // satisfied by a cast.
    for (const type of NOTIFICATION_TYPES) {
      expect(RECIPIENT_RULES[type], type).toBeDefined();
      expect(RECIPIENT_RULES[type].interestedIn, type).toBeTruthy();
    }
  });

  it('requires post visibility for every post-scoped type', () => {
    // The T1.15 DoD: no notification about a post you cannot see.
    const postScoped = NOTIFICATION_TYPES.filter(
      (type) => type.startsWith('post.') || type.startsWith('publishing.'),
    );

    expect(postScoped.length).toBeGreaterThan(0);

    for (const type of postScoped) {
      expect(RECIPIENT_RULES[type].visibilityRequires, type).toBe('post:read');
    }
  });
});
