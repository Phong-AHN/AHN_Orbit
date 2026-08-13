import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@orbit/core';

/**
 * @orbit/core defines the domain enums; schema.prisma mirrors them as Postgres
 * enums. Mirroring is only safe if it cannot rot, so this test parses the
 * schema and fails the build the moment the two disagree.
 */

const schemaPath = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const schema = readFileSync(schemaPath, 'utf8');

function prismaEnum(name: string): string[] {
  const match = schema.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
  if (!match?.[1]) throw new Error(`enum ${name} not found in schema.prisma`);
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

const PAIRS: ReadonlyArray<[string, readonly string[]]> = [
  ['OrganizationRole', core.ORGANIZATION_ROLES],
  ['WorkspaceRole', core.WORKSPACE_ROLES],
  ['MembershipStatus', core.MEMBERSHIP_STATUSES],
  ['WorkspaceStatus', core.WORKSPACE_STATUSES],
  ['Platform', core.PLATFORMS],
  ['SocialAccountStatus', core.SOCIAL_ACCOUNT_STATUSES],
  ['PostStatus', core.POST_STATUSES],
  ['VariantStatus', core.VARIANT_STATUSES],
  ['PostSource', core.POST_SOURCES],
  ['ApprovalStage', core.APPROVAL_STAGES],
  ['ApprovalState', core.APPROVAL_STATES],
  ['ProductionStage', core.PRODUCTION_STAGES],
  ['ProductionTaskState', core.PRODUCTION_TASK_STATES],
  ['CommentVisibility', core.COMMENT_VISIBILITIES],
  ['MediaKind', core.MEDIA_KINDS],
  ['MediaStatus', core.MEDIA_STATUSES],
  ['PublishingJobState', core.PUBLISHING_JOB_STATES],
  ['PublishingAttemptState', core.PUBLISHING_ATTEMPT_STATES],
  ['NotificationChannel', core.NOTIFICATION_CHANNELS],
  ['ActorType', core.ACTOR_TYPES],
  ['SubscriptionStatus', core.SUBSCRIPTION_STATUSES],
  ['ContentIdeaState', core.CONTENT_IDEA_STATES],
];

describe('enum parity between @orbit/core and schema.prisma', () => {
  it.each(PAIRS)('%s matches, member for member and in order', (name, coreValues) => {
    expect(prismaEnum(name)).toEqual([...coreValues]);
  });

  it('covers every enum declared in the schema', () => {
    const declared = [...schema.matchAll(/enum\s+(\w+)\s*\{/g)].map((m) => m[1]);
    const paired = PAIRS.map(([name]) => name);
    expect([...declared].sort()).toEqual([...paired].sort());
  });
});

describe('tenant discriminator coverage', () => {
  /**
   * Every model must either carry organizationId or be on the exemption list
   * with a stated reason. A new model therefore cannot quietly land outside the
   * isolation boundary (SRS §4).
   */
  const EXEMPT: Record<string, string> = {
    User: 'a user may hold memberships in several organizations, so the row belongs to no single tenant',
    Organization: 'is the tenant root; scoped by its own id',
    WebhookEvent:
      'arrives before a tenant is known; the tenant is resolved through our account mapping',
  };

  it('every model is either tenant-scoped or explicitly exempt', () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    expect(models.length).toBeGreaterThan(20);

    const unscoped = models
      .filter(([, , body]) => !/^\s*organizationId\s/m.test(body ?? ''))
      .map(([, name]) => name!)
      .filter((name) => !(name in EXEMPT));

    expect(unscoped).toEqual([]);
  });

  it('RLS is declared for every tenant-scoped model', () => {
    const rlsPath = fileURLToPath(
      new URL(
        '../prisma/migrations/20260811000200_constraints_and_rls/migration.sql',
        import.meta.url,
      ),
    );
    const rls = readFileSync(rlsPath, 'utf8');

    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    const tenantModels = models
      .filter(([, , body]) => /^\s*organizationId\s/m.test(body ?? ''))
      .map(([, name]) => name!);

    const missing = tenantModels.filter((m) => !rls.includes(`'${m}'`));
    expect(missing).toEqual([]);
  });
});
