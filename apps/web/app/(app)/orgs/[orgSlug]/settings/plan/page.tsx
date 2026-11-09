import type { Metadata } from 'next';
import { Alert, Badge, Card, CardBody, PageHeader, PermissionDenied, Section, cn } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getPlanOverview, type PlanUsage } from '@/features/billing/service';
import { PLANS, type PlanLimitKey } from '@/features/billing/plans';
import {
  LIMIT_LABELS,
  PLAN_LIMIT_KEYS,
  formatAmount,
  formatLimit,
  subscriptionStatusLabel,
} from '@/features/billing/ui/format';
import { RequestPlanButton, WithdrawPlanRequestButton } from '@/features/billing/ui/plan-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Plan' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

const USAGE_OF: Record<PlanLimitKey, keyof PlanUsage> = {
  workspaces: 'workspaces',
  socialAccounts: 'socialAccounts',
  aiCreditsPerMonth: 'aiCreditsThisMonth',
  storageBytes: 'storageBytes',
};

/**
 * The organization's plan, what it uses, and asking for more (D-116).
 *
 * Plans change by hand for now: the Owner asks here, AHN arranges payment, and
 * a platform administrator switches the plan. The paid plans are placeholders
 * until their contents and prices are settled, which is why none has a price.
 *
 * Owners and Admins can see this page (`billing:read`); only the Owner can ask
 * (`billing:manage`), and the API checks that again.
 */
export default async function PlanPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'billing:read')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="see this organization’s plan" />
      </main>
    );
  }

  const canRequest = pageCan(ctx, 'billing:manage');
  const overview = await getPlanOverview(ctx);
  const pending = overview.pendingRequest;
  const decision = pending ? null : overview.recentDecision;

  const dateFormat = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeZone: organization.timezone,
  });
  const date = (value: Date) => dateFormat.format(value);

  // Why the request buttons are absent, said once under the plans. A waiting
  // request explains itself in the banner above.
  const notRequestable = !canRequest
    ? 'Only the organization owner can ask for a different plan.'
    : overview.unlimited
      ? 'Your organization has no plan limits at the moment, so there is nothing to upgrade.'
      : null;
  const mayRequest = canRequest && !overview.unlimited && !pending;

  return (
    <main id="main" className="space-y-8 px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Plan"
        description="What your organization can use, and how to get more."
      />

      {pending ? (
        <Alert
          tone="info"
          title={`${pending.planName} requested on ${date(pending.createdAt)}`}
          actions={
            canRequest ? (
              <WithdrawPlanRequestButton orgSlug={orgSlug} planName={pending.planName} />
            ) : null
          }
        >
          AHN will be in touch to arrange payment, then switch your plan. Your current limits apply
          until then.
        </Alert>
      ) : null}

      {decision?.status === 'APPROVED' && decision.decidedAt ? (
        <Alert
          tone="success"
          title={`Moved to ${decision.planName} on ${date(decision.decidedAt)}`}
        >
          The new limits are already in effect.
        </Alert>
      ) : null}

      {decision?.status === 'DECLINED' && decision.decidedAt ? (
        <Alert
          tone="warning"
          title={`Your request for ${decision.planName} was declined on ${date(decision.decidedAt)}`}
        >
          {decision.decisionReason ?? 'Contact AHN for details.'}
        </Alert>
      ) : null}

      <Section title="Current plan">
        <Card>
          <CardBody className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-display text-lg font-semibold text-ink">{overview.plan.name}</p>
              <Badge tone={overview.status === 'ACTIVE' ? 'success' : 'neutral'}>
                {subscriptionStatusLabel(overview.status)}
              </Badge>
            </div>

            {overview.unlimited ? (
              <p className="text-sm text-ink-secondary">
                No limits apply to your organization at the moment.
              </p>
            ) : null}

            <dl className="grid gap-4 sm:grid-cols-2">
              {PLAN_LIMIT_KEYS.map((key) => (
                <UsageRow
                  key={key}
                  label={key === 'aiCreditsPerMonth' ? 'AI requests this month' : LIMIT_LABELS[key]}
                  used={formatAmount(key, overview.usage[USAGE_OF[key]])}
                  usedValue={overview.usage[USAGE_OF[key]]}
                  limit={overview.limits[key]}
                  limitText={formatLimit(key, overview.limits)}
                />
              ))}
            </dl>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Plans"
        description="Plans change by hand for now: ask for one here, and AHN arranges payment with you before switching it. Prices are still being set."
      >
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((plan) => {
            const current = plan.id === overview.plan.id;
            return (
              <li key={plan.id}>
                <Card className={cn('h-full', current && 'border-accent')}>
                  <CardBody className="flex h-full flex-col gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-base font-semibold text-ink">
                          {plan.name}
                        </h3>
                        {current ? <Badge tone="accent">Current plan</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm font-medium text-ink-secondary">
                        {plan.price ?? 'Price to be announced'}
                      </p>
                      <p className="mt-2 text-sm text-ink-muted">{plan.summary}</p>
                    </div>

                    <dl className="space-y-1.5 text-sm">
                      {PLAN_LIMIT_KEYS.map((key) => (
                        <div key={key} className="flex justify-between gap-3">
                          <dt className="text-ink-muted">{LIMIT_LABELS[key]}</dt>
                          <dd className="font-medium tabular-nums text-ink">
                            {formatLimit(key, plan.limits)}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    {!current && plan.requestable && mayRequest ? (
                      <div className="mt-auto">
                        <RequestPlanButton
                          orgSlug={orgSlug}
                          planId={plan.id}
                          planName={plan.name}
                        />
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>

        {notRequestable ? <p className="mt-4 text-sm text-ink-muted">{notRequestable}</p> : null}
      </Section>
    </main>
  );
}

function UsageRow({
  label,
  used,
  usedValue,
  limit,
  limitText,
}: {
  label: string;
  used: string;
  usedValue: number;
  limit: number | undefined;
  limitText: string;
}) {
  const share = limit === undefined || limit === 0 ? null : Math.min(1, usedValue / limit);
  const tone =
    share === null
      ? 'bg-accent'
      : share >= 1
        ? 'bg-danger'
        : share >= 0.8
          ? 'bg-warning'
          : 'bg-accent';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <dt className="text-ink-secondary">{label}</dt>
        <dd className="tabular-nums text-ink">
          <span className="font-medium">{used}</span>
          <span className="text-ink-muted"> / {limitText}</span>
        </dd>
      </div>
      {share !== null ? (
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          role="presentation"
        >
          <div className={cn('h-full rounded-full', tone)} style={{ width: `${share * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}
