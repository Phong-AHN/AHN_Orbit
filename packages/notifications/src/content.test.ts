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
    fromClient: false,
    by: 'Linh',
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
  'post.client_review_requested': {
    type: 'post.client_review_requested',
    postTitle: 'Spring launch',
  },
  'post.approved': {
    type: 'post.approved',
    postTitle: 'Spring launch',
    fromClient: true,
    by: 'Pat',
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

/**
 * What a client is allowed to be told.
 *
 * The agency speaks to its clients as one voice, and the enforcement is the
 * *shape of the event*: `post.client_review_requested` has one field, a post
 * title, so there is nothing for the copy to leak. These tests pin that down
 * from the outside, because the protection would be lost the moment somebody
 * added a convenient `requestedBy` to the type.
 */
describe('the client-facing notification', () => {
  const content = notificationContent({
    type: 'post.client_review_requested',
    postTitle: 'Spring launch',
  });

  it('asks the client for the thing they can actually do', () => {
    expect(content.title).toContain('Spring launch');
    expect(content.title).toMatch(/review/i);
    expect(content.body).toMatch(/approve|changes/i);
  });

  it('names no person and no role', () => {
    const text = `${content.title} ${content.body}`;

    for (const leak of ['Linh', 'Pat', 'Account Manager', 'Content Creator', 'Owner', 'Admin']) {
      expect(text).not.toContain(leak);
    }
  });

  /**
   * A client has no business knowing that a post was rejected internally twice
   * before it reached them, and the portal shows none of that anywhere else.
   */
  it('says nothing about the internal process', () => {
    const text = `${content.title} ${content.body}`.toLowerCase();

    for (const leak of ['internal', 'agency', 'round', 'reviewer', 'approver']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('a review decision reported to the agency', () => {
  it('distinguishes the client from a colleague', () => {
    const byClient = notificationContent({
      type: 'post.approved',
      postTitle: 'Spring launch',
      fromClient: true,
      by: 'Pat',
    });
    const internally = notificationContent({
      type: 'post.approved',
      postTitle: 'Spring launch',
      fromClient: false,
      by: 'Linh',
    });

    expect(byClient.body).toContain('Pat (client)');
    // The client's gate is the last one, so this is the fact that matters.
    expect(byClient.body).toMatch(/schedule/i);

    expect(internally.body).toContain('Linh');
    expect(internally.body).not.toContain('client');
  });

  /**
   * `decidedById` is `SetNull` when a user is deleted, and a decision recorded
   * on the client's behalf deliberately passes no name — naming the staff
   * member there would report a colleague *as* the client.
   */
  it('falls back to the side rather than printing nothing', () => {
    expect(
      notificationContent({ type: 'post.approved', postTitle: 'Spring launch', fromClient: true })
        .body,
    ).toContain('The client');

    expect(
      notificationContent({ type: 'post.approved', postTitle: 'Spring launch', fromClient: false })
        .body,
    ).toContain('A reviewer');
  });

  it('says who asked for changes, and quotes what they said', () => {
    const content = notificationContent({
      type: 'post.changes_requested',
      postTitle: 'Spring launch',
      fromClient: true,
      by: 'Pat',
      note: 'The opening line is too formal.',
    });

    expect(content.title).toContain('Pat (client)');
    expect(content.body).toContain('too formal');
  });
});
