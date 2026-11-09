import type { Metadata } from 'next';
import { Badge, Card, CardBody, Empty, PageHeader, Section } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { listPlanRequests, type AdminPlanRequest } from '@/features/admin/plans';
import { PLAN_LIMIT_KEYS, LIMIT_LABELS, formatLimit } from '@/features/billing/ui/format';
import { PlanRequestActions } from '@/features/admin/ui/plan-request-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Plan requests' };

const when = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const STATUS_TONE = {
  PENDING: 'info',
  APPROVED: 'success',
  DECLINED: 'warning',
  WITHDRAWN: 'neutral',
} as const;

/**
 * Organizations asking to change plan (D-116).
 *
 * Plans change by hand for now: arrange payment with the customer first, then
 * approve here, which applies the plan they asked for with its limits from the
 * catalogue. Times are UTC, because an administrator has no organization
 * timezone to show them in.
 */
export default async function AdminPlansPage() {
  await requirePlatformAdmin();

  const { pending, recent } = await listPlanRequests();

  return (
    <main id="main" className="space-y-8 px-4 py-10 sm:px-6">
      <PageHeader
        title="Plan requests"
        description="Arrange payment with the customer first, then approve to switch their plan."
      />

      <Section title={`${pending.length} waiting`}>
        {pending.length === 0 ? (
          <Empty title="Nothing waiting" description="New requests appear here, oldest first." />
        ) : (
          <ul className="space-y-4">
            {pending.map((request) => (
              <li key={request.id}>
                <PendingRequest request={request} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {recent.length > 0 ? (
        <Section title="Recently answered">
          <Card>
            <CardBody className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Organization
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Plan
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      By
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      When (UTC)
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((request) => (
                    <tr key={request.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-ink">{request.organization.name}</span>
                        <span className="ml-2 font-mono text-xs text-ink-muted">
                          {request.organization.slug}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {request.fromPlanName} → {request.planName}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[request.status]}>
                          {request.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {request.decidedBy?.name ?? request.decidedBy?.email ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                        {request.decidedAt ? when.format(request.decidedAt) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {request.decisionReason ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </Section>
      ) : null}
    </main>
  );
}

function PendingRequest({ request }: { request: AdminPlanRequest }) {
  const current = request.current;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="font-medium text-ink">
              {request.organization.name}
              <span className="ml-2 font-mono text-xs text-ink-muted">
                {request.organization.slug}
              </span>
            </p>
            <p className="text-sm text-ink-secondary">
              Asks for <span className="font-medium text-ink">{request.planName}</span>
              {current ? ` (now on ${current.planName})` : null}
            </p>
          </div>
          <p className="text-xs text-ink-muted">
            {request.requestedBy?.name ?? request.requestedBy?.email ?? 'A former member'} ·{' '}
            {when.format(request.createdAt)} UTC
          </p>
        </div>

        {request.requestedBy?.email ? (
          <p className="text-sm text-ink-secondary">
            Contact: <span className="font-mono text-xs">{request.requestedBy.email}</span>
          </p>
        ) : null}

        {request.note ? (
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-ink-secondary">
            {request.note}
          </blockquote>
        ) : null}

        <table className="w-full max-w-lg text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th scope="col" className="py-1 font-medium">
                Limit
              </th>
              <th scope="col" className="py-1 font-medium">
                Now
              </th>
              <th scope="col" className="py-1 font-medium">
                After approval
              </th>
            </tr>
          </thead>
          <tbody>
            {PLAN_LIMIT_KEYS.map((key) => (
              <tr key={key}>
                <td className="py-1 text-ink-muted">{LIMIT_LABELS[key]}</td>
                <td className="py-1 tabular-nums text-ink-secondary">
                  {current ? formatLimit(key, current.limits) : '—'}
                </td>
                <td className="py-1 font-medium tabular-nums text-ink">
                  {request.requested ? formatLimit(key, request.requested) : 'Not offered'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <PlanRequestActions requestId={request.id} planName={request.planName} />
      </CardBody>
    </Card>
  );
}
