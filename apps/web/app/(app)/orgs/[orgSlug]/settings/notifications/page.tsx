import type { Metadata } from 'next';
import { Badge, Card, CardBody, PageHeader, PermissionDenied, Section } from '@orbit/ui';
import { serverEnv } from '@orbit/config';
import {
  EMAIL_DELIVERY_ENABLED,
  SLACK_EVENT_LABELS,
  SLACK_EVENT_TYPES,
} from '@orbit/notifications';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getSlackIntegration } from '@/features/integrations/slack';
import { SlackSettingsForm } from '@/features/integrations/ui/slack-settings-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Notifications' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Where the organization hears about publishing (D-129).
 *
 * Slack is configured here, once, for the whole team. Email is per person and
 * automatic — this page says what is emailed and from where, so nobody has to
 * guess whether a quiet inbox means nothing happened.
 *
 * Owners and Admins only (`org:update`): the channel an agency's alerts go to
 * is configuration, and its webhook is a secret.
 */
export default async function NotificationSettingsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'org:update')) {
    return (
      <main id="main" className="px-4 py-10 sm:px-6">
        <PermissionDenied action="change where this organization’s notifications go" />
      </main>
    );
  }

  const slack = await getSlackIntegration(ctx);
  const env = serverEnv();

  return (
    <main id="main" className="space-y-8 px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={organization.name}
        title="Notifications"
        description="Where your team hears about posts going out, failing, or coming off the schedule."
      />

      <Section title="Slack">
        <SlackSettingsForm
          orgSlug={orgSlug}
          timezone={organization.timezone}
          slack={slack}
          events={SLACK_EVENT_TYPES.map((type) => ({ type, ...SLACK_EVENT_LABELS[type] }))}
        />
      </Section>

      <Section title="Email">
        <Card>
          <CardBody className="space-y-4 text-sm text-ink-secondary">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">Email notifications</span>
              {EMAIL_DELIVERY_ENABLED ? (
                <Badge tone="success">On</Badge>
              ) : (
                <Badge tone="neutral">Not switched on yet</Badge>
              )}
            </div>

            <p>
              {EMAIL_DELIVERY_ENABLED ? 'Sent from ' : 'When switched on, sent from '}
              <span className="font-medium text-ink">
                {env.EMAIL_FROM_NAME} &lt;{env.EMAIL_FROM}&gt;
              </span>{' '}
              to each person’s own address. Everything is also in the bell in Social Square.
            </p>

            <ul className="list-disc space-y-1 pl-5">
              <li>
                <span className="text-ink">A post went out</span>, with its links, a scheduled post
                was canceled, or one was taken off the schedule — to the post’s author, the person
                it is assigned to, and whoever scheduled it.
              </li>
              <li>
                <span className="text-ink">A post failed</span>, with the reason, or we could not
                confirm it went out — to whoever can retry it.
              </li>
              <li>
                <span className="text-ink">An account needs reconnecting</span> — to whoever can
                reconnect it.
              </li>
              <li>
                <span className="text-ink">A post is waiting for review</span>, and a customer the
                AI assistant handed over is waiting for a person.
              </li>
            </ul>

            <p className="text-xs text-ink-muted">
              Nobody is emailed about something they did themselves, or about a post they cannot
              see.
            </p>
          </CardBody>
        </Card>
      </Section>
    </main>
  );
}
