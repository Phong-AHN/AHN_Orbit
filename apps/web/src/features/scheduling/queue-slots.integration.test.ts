import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import {
  createQueueSlot,
  deleteQueueSlot,
  listQueueSlots,
  setQueueSlotActive,
} from './queue-slots';

/**
 * Posting slots (SRS §7).
 *
 * `useNextQueueSlot` has resolved against these since T1.12 and nothing could
 * create one, so the cases worth proving are the ones that would make the queue
 * behave strangely rather than fail: two identical slots putting two posts at
 * the same minute, and a slot narrowed to an account belonging to a different
 * client.
 */

const ORG_A = '018f1500-0000-7000-8000-001500000001';
const ORG_B = '018f1600-0000-7000-8000-001600000001';
const WS_A1 = '018f1500-0000-7000-8000-001500000002';
const WS_A2 = '018f1500-0000-7000-8000-001500000003';
const WS_B = '018f1600-0000-7000-8000-001600000002';
const BRAND_A1 = '018f1500-0000-7000-8000-001500000004';
const BRAND_A2 = '018f1500-0000-7000-8000-001500000005';
const ACCOUNT_A1 = '018f1500-0000-7000-8000-001500000006';
const ACCOUNT_A2 = '018f1500-0000-7000-8000-001500000007';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;

async function seedOrg(org: string, workspaces: string[], slug: string, email: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });

  for (const [index, ws] of workspaces.entries()) {
    await platformDb.workspace.upsert({
      where: { id: ws },
      update: {},
      create: {
        id: ws,
        organizationId: org,
        name: `${slug}-${index}`,
        slug: `${slug}-${index}`,
        // A real zone, so the "slot inherits the client's zone" case is real.
        timezone: 'Asia/Ho_Chi_Minh',
      },
    });
  }

  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });

  const { ctx } = await resolveTenantContext(user, org, 'itest-slots');
  return ctx;
}

async function seedAccount(org: string, ws: string, brand: string, account: string, name: string) {
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name, slug: name },
  });

  await platformDb.socialAccount.upsert({
    where: { id: account },
    update: {},
    create: {
      id: account,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `ext-${name}`,
      displayName: name,
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
}

beforeAll(async () => {
  ctxA = await seedOrg(ORG_A, [WS_A1, WS_A2], 'slot-a', 'owner@slot-a.test');
  ctxB = await seedOrg(ORG_B, [WS_B], 'slot-b', 'owner@slot-b.test');

  await seedAccount(ORG_A, WS_A1, BRAND_A1, ACCOUNT_A1, 'page-one');
  await seedAccount(ORG_A, WS_A2, BRAND_A2, ACCOUNT_A2, 'page-two');
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.queueSlot.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

const slot = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: WS_A1,
  dayOfWeek: 2,
  localTime: '09:00',
  ...overrides,
});

describe('creating', () => {
  it('inherits the client own timezone when none is given', async () => {
    const created = await createQueueSlot(ctxA, slot(), fingerprint);

    expect(created.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(created.isActive).toBe(true);
  });

  it('accepts a different zone, for a client posting into another market', async () => {
    const created = await createQueueSlot(
      ctxA,
      slot({ timezone: 'Australia/Sydney' }),
      fingerprint,
    );

    expect(created.timezone).toBe('Australia/Sydney');
  });

  it('refuses a zone the runtime does not know', async () => {
    await expect(
      createQueueSlot(ctxA, slot({ timezone: 'Mars/Olympus' }), fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['9:00', '25:00', '09:60', 'morning', ''])('refuses %s as a time', async (bad) => {
    await expect(
      createQueueSlot(ctxA, slot({ localTime: bad }), fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([-1, 7, 1.5])('refuses %s as a day', async (bad) => {
    await expect(
      createQueueSlot(ctxA, slot({ dayOfWeek: bad }), fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  /**
   * Two identical slots would put two posts at the same minute, which reads as
   * a scheduling bug rather than a duplicated row.
   */
  it('refuses an identical slot', async () => {
    await createQueueSlot(ctxA, slot(), fingerprint);

    await expect(createQueueSlot(ctxA, slot(), fingerprint)).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows the same time narrowed to a specific account', async () => {
    await createQueueSlot(ctxA, slot(), fingerprint);

    await expect(
      createQueueSlot(ctxA, slot({ socialAccountId: ACCOUNT_A1 }), fingerprint),
    ).resolves.toBeDefined();
  });

  it('refuses a workspace from another tenant, by exact id', async () => {
    await expect(
      createQueueSlot(ctxA, slot({ workspaceId: WS_B }), fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * A slot narrowed to another client's account would silently never fire —
   * the worst kind of failure, because it looks configured.
   */
  it('refuses an account belonging to a different client', async () => {
    await expect(
      createQueueSlot(ctxA, slot({ socialAccountId: ACCOUNT_A2 }), fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('writes an audit row', async () => {
    await createQueueSlot(ctxA, slot(), fingerprint);

    expect(
      await platformDb.auditLog.findFirst({
        where: { organizationId: ORG_A, action: 'queue_slot.created' },
      }),
    ).not.toBeNull();
  });
});

describe('pausing', () => {
  it('remembers the appointment rather than removing it', async () => {
    const created = await createQueueSlot(ctxA, slot(), fingerprint);

    const paused = await setQueueSlotActive(ctxA, created.id, false, fingerprint);
    expect(paused.isActive).toBe(false);

    // Still there, still listed — a seasonal pause is reversible.
    expect(await listQueueSlots(ctxA, WS_A1)).toHaveLength(1);

    const resumed = await setQueueSlotActive(ctxA, created.id, true, fingerprint);
    expect(resumed.isActive).toBe(true);
  });

  it('does not touch another tenant slot, by exact id', async () => {
    const theirs = await createQueueSlot(ctxB, { ...slot(), workspaceId: WS_B }, fingerprint);

    await expect(setQueueSlotActive(ctxA, theirs.id, false, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('removing', () => {
  it('removes the slot', async () => {
    const created = await createQueueSlot(ctxA, slot(), fingerprint);

    await deleteQueueSlot(ctxA, created.id, fingerprint);

    expect(await listQueueSlots(ctxA, WS_A1)).toHaveLength(0);
  });

  /**
   * A queued post is given a real `scheduledFor` the moment it is queued — the
   * slot is where that time came from, not where it lives. Removing one must
   * never move something already promised to a client.
   */
  it('leaves an already scheduled post exactly where it was', async () => {
    const created = await createQueueSlot(ctxA, slot(), fingerprint);

    const post = await platformDb.post.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_A1,
        brandId: BRAND_A1,
        body: 'Queued earlier',
        status: 'SCHEDULED',
        scheduledFor: new Date('2026-07-14T02:00:00.000Z'),
      },
    });

    await deleteQueueSlot(ctxA, created.id, fingerprint);

    const after = await platformDb.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.scheduledFor?.toISOString()).toBe('2026-07-14T02:00:00.000Z');
    expect(after.status).toBe('SCHEDULED');

    await platformDb.post.deleteMany({ where: { id: post.id } });
  });

  it('does not remove another tenant slot, by exact id', async () => {
    const theirs = await createQueueSlot(ctxB, { ...slot(), workspaceId: WS_B }, fingerprint);

    await expect(deleteQueueSlot(ctxA, theirs.id, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await platformDb.queueSlot.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe('listing', () => {
  it('returns the week in reading order', async () => {
    await createQueueSlot(ctxA, slot({ dayOfWeek: 5, localTime: '17:00' }), fingerprint);
    await createQueueSlot(ctxA, slot({ dayOfWeek: 1, localTime: '14:00' }), fingerprint);
    await createQueueSlot(ctxA, slot({ dayOfWeek: 1, localTime: '09:00' }), fingerprint);

    const slots = await listQueueSlots(ctxA, WS_A1);

    expect(slots.map((s) => `${s.dayOfWeek} ${s.localTime}`)).toEqual([
      '1 09:00',
      '1 14:00',
      '5 17:00',
    ]);
  });

  it('never lists another tenant slots', async () => {
    await createQueueSlot(ctxB, { ...slot(), workspaceId: WS_B }, fingerprint);

    expect(await listQueueSlots(ctxA, WS_B)).toHaveLength(0);
  });
});
