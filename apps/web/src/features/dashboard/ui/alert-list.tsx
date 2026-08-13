import Link from 'next/link';
import { Badge, Card, CardBody, cn, type BadgeTone } from '@orbit/ui';
import type { Alert, AlertKind, AlertSeverity } from '../alerts';

/**
 * The list an agency works from in the morning (SRS §20).
 *
 * Ranked by the service, rendered in that order, and never re-sorted here —
 * "what is most urgent" is a domain decision, not a presentation one.
 */

const SEVERITY_TONE: Record<AlertSeverity, BadgeTone> = {
  CRITICAL: 'danger',
  WARNING: 'warning',
  INFO: 'neutral',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  CRITICAL: 'Blocking',
  WARNING: 'Needs a look',
  INFO: 'For information',
};

/**
 * Where each alert's action goes, as a total record.
 *
 * A new alert kind is a type error here until someone decides where its button
 * leads — an alert whose action goes nowhere is worse than no alert.
 */
const ALERT_HREF: Record<AlertKind, (orgSlug: string) => string> = {
  ACCOUNT_NEEDS_RECONNECT: (org) => `/orgs/${org}/settings/accounts`,
  ACCOUNT_DISCONNECTED: (org) => `/orgs/${org}/settings/accounts`,
  PUBLISH_NEEDS_REVIEW: (org) => `/orgs/${org}/publishing?view=attention`,
  PUBLISH_FAILED: (org) => `/orgs/${org}/publishing?view=failed`,
  SCHEDULE_OVERDUE: (org) => `/orgs/${org}/calendar`,
  APPROVAL_BACKLOG: (org) => `/orgs/${org}/approvals`,
};

export function AlertList({ alerts, orgSlug }: { alerts: readonly Alert[]; orgSlug: string }) {
  if (alerts.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm font-medium text-success">Nothing needs attention.</p>
          <p className="mt-1 text-sm text-ink-muted">
            Every account is connected, nothing has failed, and no review is overdue.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <ul className="space-y-2.5">
      {alerts.map((alert) => (
        <li key={alert.kind}>
          <Card
            className={cn(
              alert.severity === 'CRITICAL' && 'border-danger/40',
              alert.severity === 'WARNING' && 'border-warning/40',
            )}
          >
            <CardBody>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{alert.title}</span>
                <Badge tone={SEVERITY_TONE[alert.severity]}>{SEVERITY_LABEL[alert.severity]}</Badge>
              </div>

              <p className="mt-1 text-sm text-ink-muted">{alert.detail}</p>

              <Link
                href={ALERT_HREF[alert.kind](orgSlug)}
                className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
              >
                {alert.action} →
              </Link>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
