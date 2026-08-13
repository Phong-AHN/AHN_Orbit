import { describe, expect, it } from 'vitest';
import { notificationContent } from './content.js';
import { NOTIFICATION_TYPES, isNotificationType, type NotificationEvent } from './types.js';

/**
 * The copy people actually read (T1.15).
 *
 * Worth unit tests because a notification is written once and read by someone
 * who has no other context — a title that does not name the thing, or a body
 * that does not say what to do, is a notification that produces a support
 * question rather than an action.
 */

const SAMPLES: Record<(typeof NOTIFICATION_TYPES)[number], NotificationEvent> = {
  'social_account.needs_reconnect': {
    type: 'social_account.needs_reconnect',
    accountName: 'Acme Bakery',
    reason: 'The token was revoked.',
  },
  'social_account.reconnected': {
    type: 'social_account.reconnected',
    accountName: 'Acme Bakery',
  },
  'post.approval_requested': {
    type: 'post.approval_requested',
    postTitle: 'Spring launch',
    stage: 'INTERNAL',
  },
  'post.changes_requested': {
    type: 'post.changes_requested',
    postTitle: 'Spring launch',
    note: 'Please soften the opening line.',
  },
  'publishing.failed': {
    type: 'publishing.failed',
    postTitle: 'Spring launch',
    accountName: 'Acme Bakery',
    summary: 'The platform rejected the content.',
  },
  'publishing.needs_review': {
    type: 'publishing.needs_review',
    postTitle: 'Spring launch',
    accountName: 'Acme Bakery',
  },
};

describe('every notification type', () => {
  it('has copy, and it names the thing it is about', () => {
    for (const type of NOTIFICATION_TYPES) {
      const content = notificationContent(SAMPLES[type]);

      expect(content.title.length, type).toBeGreaterThan(0);
      expect(content.body.length, type).toBeGreaterThan(0);
      // Nothing leaks a placeholder into a person's inbox.
      expect(content.title, type).not.toContain('undefined');
      expect(content.body, type).not.toContain('undefined');
      expect(content.body, type).not.toContain('[object');
    }
  });

  it('is recognised by the type guard, and nothing else is', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(isNotificationType(type)).toBe(true);
    }
    expect(isNotificationType('post.deleted')).toBe(false);
    expect(isNotificationType('')).toBe(false);
  });
});

describe('account health', () => {
  it('carries the provider’s reason and says what it costs', () => {
    const content = notificationContent(SAMPLES['social_account.needs_reconnect']);

    expect(content.title).toContain('Acme Bakery');
    expect(content.body).toContain('The token was revoked.');
    expect(content.body).toContain('will not publish');
  });

  it('still says something useful when the provider gave no reason', () => {
    const content = notificationContent({
      type: 'social_account.needs_reconnect',
      accountName: 'Acme Bakery',
    });

    expect(content.body).toContain('no longer valid');
  });
});

describe('approvals', () => {
  it('distinguishes the internal gate from the client’s', () => {
    const internal = notificationContent({
      type: 'post.approval_requested',
      postTitle: 'Spring launch',
      stage: 'INTERNAL',
    });
    const client = notificationContent({
      type: 'post.approval_requested',
      postTitle: 'Spring launch',
      stage: 'CLIENT',
    });

    expect(internal.title).toContain('needs your review');
    expect(client.title).toContain('with the client');
    expect(internal.body).not.toBe(client.body);
  });

  it('quotes a review note, and copes without one', () => {
    const withNote = notificationContent(SAMPLES['post.changes_requested']);
    expect(withNote.body).toContain('soften the opening line');

    const without = notificationContent({
      type: 'post.changes_requested',
      postTitle: 'Spring launch',
    });
    expect(without.body).toContain('what needs changing');
  });

  it('truncates a long note without cutting mid-word', () => {
    const note = 'word '.repeat(80).trim();
    const content = notificationContent({
      type: 'post.changes_requested',
      postTitle: 'Spring launch',
      note,
    });

    expect(content.body).toContain('…');
    expect(content.body.length).toBeLessThan(note.length);
    // The ellipsis follows a whole word, not a fragment.
    expect(content.body).not.toMatch(/wor…/);
  });
});

describe('publishing', () => {
  it('reuses the publishing log’s wording for a failure', () => {
    const content = notificationContent(SAMPLES['publishing.failed']);

    expect(content.title).toContain('did not publish');
    expect(content.body).toContain('The platform rejected the content.');
  });

  it('does not claim a parked publish failed', () => {
    // The whole point of parking is that we do not know (decision D-027).
    // Saying "failed" here would be the system asserting something it refused
    // to assert everywhere else.
    const content = notificationContent(SAMPLES['publishing.needs_review']);

    expect(content.title).toContain('Check whether');
    expect(content.body).toContain('could not confirm');
    expect(content.body.toLowerCase()).not.toContain('failed');
  });
});
