import { Badge, Card, CardBody } from '@orbit/ui';
import { MetricGrid } from './metric-grid';

/**
 * Account-level figures — a Facebook Page's followers, views and engagement —
 * one card per connected account (D-121).
 *
 * The worker reads these once a day, so each card says which day its figures
 * are for. A metric the platform has withdrawn is left out rather than shown as
 * a gap: it is gone for every account, and a row of them read as if this
 * account were broken. A metric that is expected and missing is still shown as
 * "—" with its reason, never as zero.
 */

export interface AccountInsightsItem {
  id: string;
  displayName: string;
  platform: string;
  snapshot: {
    date: Date;
    metrics: Record<string, number>;
    availability: Record<string, string>;
  } | null;
}

export function AccountInsights({ accounts }: { accounts: AccountInsightsItem[] }) {
  if (accounts.length === 0) return null;

  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {accounts.map((account) => {
        const availability = account.snapshot
          ? Object.fromEntries(
              Object.entries(account.snapshot.availability).filter(
                ([, state]) => state !== 'DEPRECATED',
              ),
            )
          : {};

        return (
          <li key={account.id}>
            <Card className="h-full">
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="truncate text-sm font-medium text-ink">{account.displayName}</p>
                  <Badge tone="neutral">{account.platform}</Badge>
                  <span className="ml-auto text-xs text-ink-muted">
                    {account.snapshot
                      ? `As of ${account.snapshot.date.toISOString().slice(0, 10)} (UTC day)`
                      : 'Not measured yet'}
                  </span>
                </div>

                {account.snapshot ? (
                  <MetricGrid metrics={account.snapshot.metrics} availability={availability} />
                ) : (
                  <p className="text-sm text-ink-muted">
                    Account figures are read once a day. They appear after the next read.
                  </p>
                )}
              </CardBody>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
