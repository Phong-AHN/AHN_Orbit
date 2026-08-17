import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import type { Email, Mailer } from '@orbit/notifications';
import { drainEmailOutbox } from './outbox.js';

/**
 * Draining the email outbox (SRS §18).
 *
 * The property that matters most is the one that is easy to lose: **the in-app
 * record must survive any mail problem**. A notification is stored the moment
 * it is written; email is a second delivery of something already safe. Every
 * failure path here is asserted against that.
 *
 * The mailer is a stub rather than a mock library — it records what it was
 * asked to send and can be told to fail, which is all these need.
 */

const ORG = '018f1200-0000-7000-8000-001200000001';
const USER = '018f1200-0000-7000-8000-001200000002';
const NOW = new Date('2026-06-15T12:00:00.000Z');

let restoreClock: (() => void) | undefined;

class StubMailer implements Mailer {
  readonly name = 'stub';
  readonly sent: Email[] = [];
  failFor: string | null = null;

  async send(email: Email): Promise<void> {
    if (this.failFor && email.to === this.failFor) {
      throw new Error('mail provider is down');
    }
    this.sent.push(email);
  }
}

let mailer: StubMailer;

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 'Outbox Agency', slug: 'outbox-agency', timezone: 'UTC' },
  });

  await platformDb.user.upsert({
    where: { id: USER },
    update: {},
    create: {
      id: USER,
      firebaseUid: 'outbox-test-user-1',
      email: 'someone@outbox.test',
      name: 'Someone',
    },
  });

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: USER } },
    update: {},
    create: { organizationId: ORG, userId: USER, role: 'OWNER', status: 'ACTIVE' },
  });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.user.deleteMany({ where: { id: USER } });
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  mailer = new StubMailer();
  await platformDb.notification.deleteMany({ where: { organizationId: ORG } });
});

async function seed(overrides: Record<string, unknown> = {}) {
  return platformDb.notification.create({
    data: {
      organizationId: ORG,
      userId: USER,
      type: 'publishing.failed',
      title: 'A post did not go out',
      body: 'Facebook refused it. Open the publishing log to see why.',
      channel: 'EMAIL',
      resourceType: 'Post',
      resourceId: '018f1200-0000-7000-8000-0012000000ff',
      createdAt: NOW,
      ...overrides,
    },
  });
}

describe('draining', () => {
  it('sends a pending row and stamps it', async () => {
    const notification = await seed();

    const result = await drainEmailOutbox(mailer);

    expect(result.sent).toBe(1);
    expect(mailer.sent[0]?.to).toBe('someone@outbox.test');
    expect(mailer.sent[0]?.subject).toBe('A post did not go out');

    const after = await platformDb.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(after.emailedAt).not.toBeNull();
  });

  it('deep-links to the thing that needs attention', async () => {
    await seed();

    await drainEmailOutbox(mailer);

    // Not the dashboard: an alert that makes somebody hunt is one they stop
    // opening.
    expect(mailer.sent[0]?.text).toContain('/orgs/outbox-agency/posts/');
  });

  it('never sends an IN_APP row', async () => {
    await seed({ channel: 'IN_APP' });

    const result = await drainEmailOutbox(mailer);

    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('does not send the same row twice', async () => {
    await seed();

    await drainEmailOutbox(mailer);
    await drainEmailOutbox(mailer);

    expect(mailer.sent).toHaveLength(1);
  });
});

describe('when mail fails', () => {
  /**
   * The property the whole design rests on. A mail outage must cost a *second*
   * delivery, never the record itself.
   */
  it('keeps the in-app notification and leaves the row retryable', async () => {
    mailer.failFor = 'someone@outbox.test';
    const notification = await seed();

    const result = await drainEmailOutbox(mailer);

    expect(result.failed).toBe(1);

    const after = await platformDb.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });

    // Still there, still readable in the product, and not stamped — so the next
    // pass tries again.
    expect(after.title).toBe('A post did not go out');
    expect(after.emailedAt).toBeNull();
  });

  it('sends the rest of the batch when one address fails', async () => {
    await platformDb.user.upsert({
      where: { id: '018f1200-0000-7000-8000-001200000003' },
      update: {},
      create: {
        id: '018f1200-0000-7000-8000-001200000003',
        firebaseUid: 'outbox-test-user-2',
        email: 'other@outbox.test',
        name: 'Other',
      },
    });

    mailer.failFor = 'someone@outbox.test';
    await seed();
    await seed({ userId: '018f1200-0000-7000-8000-001200000003' });

    const result = await drainEmailOutbox(mailer);

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(mailer.sent[0]?.to).toBe('other@outbox.test');

    await platformDb.notification.deleteMany({ where: { organizationId: ORG } });
    await platformDb.user.deleteMany({ where: { id: '018f1200-0000-7000-8000-001200000003' } });
  });

  it('succeeds on a later pass once mail recovers', async () => {
    mailer.failFor = 'someone@outbox.test';
    await seed();
    await drainEmailOutbox(mailer);

    mailer.failFor = null;
    const second = await drainEmailOutbox(mailer);

    expect(second.sent).toBe(1);
  });
});

describe('stale messages', () => {
  /**
   * An alert about a publish that failed yesterday helps nobody today, and a
   * row retried forever is a row that never stops costing.
   */
  it('abandons anything older than a day without sending it', async () => {
    const old = await seed({ createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1_000) });

    const result = await drainEmailOutbox(mailer);

    expect(result.abandoned).toBe(1);
    expect(mailer.sent).toHaveLength(0);

    // Stamped, so it stops being picked up — and the in-app record survives.
    const after = await platformDb.notification.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.emailedAt).not.toBeNull();
    expect(after.title).toBe('A post did not go out');
  });

  it('still sends one that is inside the window', async () => {
    await seed({ createdAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1_000) });

    expect((await drainEmailOutbox(mailer)).sent).toBe(1);
  });
});
