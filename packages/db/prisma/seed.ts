/**
 * Development seed.
 *
 * Creates one agency with two client workspaces, a full cast of roles, and a
 * mock Facebook Page so the composer and calendar have something to work with
 * before Meta App Review completes.
 *
 * Refuses to run against production: seeded users have known identities, and a
 * known identity in a real tenant is a back door (SRS §42).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APP_ENV = process.env.APP_ENV ?? 'development';

/** Deterministic ids so re-seeding is idempotent and links stay stable. */
const ID = {
  org: '018f1111-0000-7000-8000-000000000001',
  users: {
    owner: '018f2222-0000-7000-8000-000000000001',
    manager: '018f2222-0000-7000-8000-000000000002',
    creator: '018f2222-0000-7000-8000-000000000003',
    approver: '018f2222-0000-7000-8000-000000000004',
    client: '018f2222-0000-7000-8000-000000000005',
    platformAdmin: '018f2222-0000-7000-8000-000000000006',
  },
  workspaces: {
    northwind: '018f3333-0000-7000-8000-000000000001',
    lumen: '018f3333-0000-7000-8000-000000000002',
  },
  brands: {
    northwind: '018f4444-0000-7000-8000-000000000001',
    lumen: '018f4444-0000-7000-8000-000000000002',
  },
  account: '018f5555-0000-7000-8000-000000000001',
} as const;

async function main() {
  if (APP_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  console.log(`Seeding (APP_ENV=${APP_ENV})…`);

  const org = await prisma.organization.upsert({
    where: { id: ID.org },
    update: {},
    create: {
      id: ID.org,
      name: 'AHN Group',
      slug: 'ahn-group',
      timezone: 'Europe/London',
      subscription: {
        create: {
          plan: 'agency',
          status: 'TRIALING',
          seats: 10,
          limits: {
            workspaces: 10,
            socialAccounts: 25,
            aiCreditsPerMonth: 5000,
            storageBytes: 50 * 1024 ** 3,
          },
        },
      },
    },
  });

  const people = [
    { id: ID.users.owner, email: 'owner@ahn.test', name: 'Ada Owner', role: 'OWNER' },
    {
      id: ID.users.manager,
      email: 'manager@ahn.test',
      name: 'Mel Manager',
      role: 'ACCOUNT_MANAGER',
    },
    {
      id: ID.users.creator,
      email: 'creator@ahn.test',
      name: 'Chris Creator',
      role: 'CONTENT_CREATOR',
    },
    { id: ID.users.approver, email: 'approver@ahn.test', name: 'Alex Approver', role: 'APPROVER' },
    { id: ID.users.client, email: 'client@northwind.test', name: 'Nina Northwind', role: 'CLIENT' },
  ] as const;

  for (const p of people) {
    await prisma.user.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        // Dev identities carry a `dev:` prefix so they can never collide with a
        // real Firebase uid.
        firebaseUid: `dev:${p.email}`,
        email: p.email,
        name: p.name,
        timezone: 'Europe/London',
      },
    });

    await prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: p.id } },
      update: { role: p.role },
      create: {
        organizationId: org.id,
        userId: p.id,
        role: p.role,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  }

  await prisma.user.upsert({
    where: { id: ID.users.platformAdmin },
    update: { isPlatformAdmin: true },
    create: {
      id: ID.users.platformAdmin,
      firebaseUid: 'dev:admin@orbit.test',
      email: 'admin@orbit.test',
      name: 'Platform Admin',
      isPlatformAdmin: true,
    },
  });

  const workspaces = [
    {
      id: ID.workspaces.northwind,
      name: 'Northwind Coffee',
      slug: 'northwind',
      timezone: 'Europe/London',
      brandId: ID.brands.northwind,
      brandName: 'Northwind Coffee',
      brandSlug: 'northwind-coffee',
    },
    {
      id: ID.workspaces.lumen,
      name: 'Lumen Studio',
      slug: 'lumen',
      // A second zone so timezone handling is exercised the moment you open the
      // calendar, rather than only in tests.
      timezone: 'America/New_York',
      brandId: ID.brands.lumen,
      brandName: 'Lumen Studio',
      brandSlug: 'lumen-studio',
    },
  ] as const;

  for (const w of workspaces) {
    await prisma.workspace.upsert({
      where: { id: w.id },
      update: {},
      create: {
        id: w.id,
        organizationId: org.id,
        name: w.name,
        slug: w.slug,
        timezone: w.timezone,
        clientCompanyName: w.name,
      },
    });

    await prisma.brand.upsert({
      where: { id: w.brandId },
      update: {},
      create: {
        id: w.brandId,
        organizationId: org.id,
        workspaceId: w.id,
        name: w.brandName,
        slug: w.brandSlug,
        voice: {
          create: {
            // organizationId is deliberately absent: the composite foreign key
            // (organizationId, brandId) → Brand(organizationId, id) means the
            // child inherits the tenant from its parent, so a nested create
            // cannot land in a different organization even by mistake.
            companyDescription: `${w.brandName} — seeded brand context for local development.`,
            tone: 'Warm, direct, never salesy',
            bannedTerms: ['synergy', 'disrupt'],
            ctas: ['Visit us today', 'Book a table'],
          },
        },
      },
    });

    for (const [userId, role] of [
      [ID.users.manager, 'MANAGER'],
      [ID.users.creator, 'CONTRIBUTOR'],
      [ID.users.approver, 'APPROVER'],
    ] as const) {
      await prisma.workspaceMembership.upsert({
        where: { workspaceId_userId: { workspaceId: w.id, userId } },
        update: { role },
        create: { organizationId: org.id, workspaceId: w.id, userId, role },
      });
    }
  }

  // The client sees exactly one workspace — the leakage tests depend on there
  // being a second one they must not reach.
  await prisma.workspaceMembership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: ID.workspaces.northwind,
        userId: ID.users.client,
      },
    },
    update: { role: 'CLIENT_APPROVER' },
    create: {
      organizationId: org.id,
      workspaceId: ID.workspaces.northwind,
      userId: ID.users.client,
      role: 'CLIENT_APPROVER',
    },
  });

  // A mock connected Page. `dev-mock:` marks it as non-real so the provider
  // registry refuses to publish it outside development (SRS §42).
  await prisma.socialAccount.upsert({
    where: { id: ID.account },
    update: {},
    create: {
      id: ID.account,
      organizationId: org.id,
      workspaceId: ID.workspaces.northwind,
      brandId: ID.brands.northwind,
      platform: 'FACEBOOK',
      externalId: 'dev-mock:100000000000001',
      displayName: 'Northwind Coffee (Mock Page)',
      handle: 'northwindcoffee',
      accountType: 'PAGE',
      status: 'ACTIVE',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
      connectedById: ID.users.manager,
    },
  });

  console.log(`Seeded organization "${org.name}"`);
  console.log('  Sign in as any of:');
  for (const p of people) console.log(`    ${p.email.padEnd(28)} ${p.role}`);
  console.log(`    admin@orbit.test             PLATFORM_ADMIN`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
