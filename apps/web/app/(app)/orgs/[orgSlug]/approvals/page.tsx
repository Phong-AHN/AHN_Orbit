import type { Metadata } from 'next';
import Link from 'next/link';
import { APPROVAL_STAGES, type ApprovalStage } from '@orbit/core';
import { Badge, Card, CardBody, Empty, PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listApprovalQueue } from '@/features/approvals/service';
import { STATUS_LABEL, STATUS_TONE } from '@/features/posts/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Approvals' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function isStage(value: unknown): value is ApprovalStage {
  return typeof value === 'string' && (APPROVAL_STAGES as readonly string[]).includes(value);
}

/**
 * The approval queue.
 *
 * Server-rendered: the service already narrows to the workspaces this principal
 * can reach, and narrows a Client further to posts whose status has reached
 * them — so what arrives here is what they are allowed to see, with no
 * client-side filtering standing between.
 */
export default async function ApprovalsPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'post:read')) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-6 py-10">
        <PermissionDenied action="see the approval queue" />
      </main>
    );
  }

  const stage = isStage(query.stage) ? query.stage : undefined;
  const approvals = await listApprovalQueue(ctx, { ...(stage ? { stage } : {}) });

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Approvals"
        description="Everything waiting on a decision."
      />

      <nav className="mt-6 flex gap-1.5" aria-label="Filter by stage">
        <StageLink orgSlug={orgSlug} label="All" active={stage === undefined} />
        {APPROVAL_STAGES.map((value) => (
          <StageLink
            key={value}
            orgSlug={orgSlug}
            stage={value}
            label={value === 'CLIENT' ? 'With client' : 'Internal'}
            active={stage === value}
          />
        ))}
      </nav>

      {approvals.length === 0 ? (
        <Empty
          className="mt-6"
          title="Nothing waiting"
          description="When something is submitted for review, it will show up here."
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {approvals.map((approval) => (
            <li key={approval.id}>
              <Card className="transition-colors hover:border-line-strong">
                <CardBody>
                  <Link
                    href={`/orgs/${orgSlug}/posts/${approval.post.id}`}
                    className="block focus:outline-none"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                        {approval.post.title ??
                          approval.post.body.trim().slice(0, 60) ??
                          'Untitled post'}
                      </h2>
                      <Badge tone={STATUS_TONE[approval.post.status]}>
                        {STATUS_LABEL[approval.post.status]}
                      </Badge>
                    </div>

                    <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted">
                      {approval.post.body.trim().slice(0, 160)}
                    </p>

                    <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                      <span>
                        {approval.stage === 'CLIENT' ? 'Client review' : 'Internal review'}
                      </span>
                      <span>round {approval.round}</span>
                      <time dateTime={approval.requestedAt.toISOString()}>
                        requested {approval.requestedAt.toISOString().slice(0, 10)}
                      </time>
                    </p>
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function StageLink({
  orgSlug,
  stage,
  label,
  active,
}: {
  orgSlug: string;
  stage?: ApprovalStage;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={stage ? `/orgs/${orgSlug}/approvals?stage=${stage}` : `/orgs/${orgSlug}/approvals`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-full px-3 py-1.5 text-sm transition-colors',
        active ? 'bg-accent text-accent-ink' : 'bg-surface-sunken text-ink-muted hover:text-ink',
      )}
    >
      {label}
    </Link>
  );
}
