'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  Field,
  Input,
  useToast,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import type { SlackIntegrationView } from '../slack';

/**
 * Connecting the organization's Slack channel (D-129).
 *
 * The webhook URL goes one way. Once saved it is never shown again — only its
 * last four characters — so changing which events are sent does not ask for
 * it, and replacing it is a deliberate, separate field.
 */

interface EventOption {
  type: string;
  label: string;
  hint: string;
}

export interface SlackSettingsFormProps {
  orgSlug: string;
  timezone: string;
  slack: SlackIntegrationView;
  events: EventOption[];
}

const endpoint = (orgSlug: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgSlug)}/integrations/slack`;

export function SlackSettingsForm({ orgSlug, timezone, slack, events }: SlackSettingsFormProps) {
  const router = useRouter();
  const toast = useToast();

  const [webhookUrl, setWebhookUrl] = React.useState('');
  const [channel, setChannel] = React.useState(slack.connected ? (slack.channel ?? '') : '');
  const [chosen, setChosen] = React.useState<Set<string>>(
    () => new Set(slack.connected ? slack.events : events.map((event) => event.type)),
  );
  const [replacing, setReplacing] = React.useState(false);

  const [busy, setBusy] = React.useState<'save' | 'test' | 'disconnect' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);

  const askForUrl = !slack.connected || replacing;

  const date = (iso: string) =>
    iso
      ? new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: timezone,
        }).format(new Date(iso))
      : '';

  function toggle(type: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(type);
      else next.delete(type);
      return next;
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError(null);

    try {
      await apiRequest(endpoint(orgSlug), {
        method: 'PUT',
        body: JSON.stringify({
          ...(askForUrl ? { webhookUrl: webhookUrl.trim() } : {}),
          channel: channel.trim() || null,
          events: events.map((option) => option.type).filter((type) => chosen.has(type)),
        }),
      });
      toast.show(
        askForUrl
          ? 'Slack connected. A test message was sent to the channel.'
          : 'Slack notifications saved.',
      );
      setWebhookUrl('');
      setReplacing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    setError(null);
    try {
      await apiRequest(`${endpoint(orgSlug)}/test`, { method: 'POST' });
      toast.show('Test message sent. Check the channel.');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The test message could not be sent.');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    setError(null);
    try {
      await apiRequest(endpoint(orgSlug), { method: 'DELETE' });
      toast.show('Slack disconnected.');
      setConfirmDisconnect(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Slack could not be disconnected.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-6">
        {slack.connected ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={slack.failure ? 'warning' : 'success'}>
              {slack.failure ? 'Stopped' : 'Connected'}
            </Badge>
            <span className="text-ink">{slack.channel || 'Slack channel'}</span>
            <span className="text-ink-muted">
              webhook ending …{slack.hint}
              {slack.connectedAt ? ` · since ${date(slack.connectedAt)}` : ''}
              {slack.connectedBy ? ` by ${slack.connectedBy}` : ''}
            </span>
          </div>
        ) : (
          <p className="text-sm text-ink-secondary">
            Send publishing updates to a Slack channel your team already watches. In Slack, open{' '}
            <span className="font-medium text-ink">Apps → Incoming Webhooks</span> (or create an app
            at api.slack.com/apps and turn on Incoming Webhooks), choose the channel, and paste the
            webhook URL here.
          </p>
        )}

        {slack.connected && slack.failure ? (
          <Alert
            tone="warning"
            title={`Slack stopped accepting messages on ${date(slack.failure.at)}`}
          >
            Slack said “{slack.failure.reason}”: the webhook was removed, or its channel archived.
            Nothing is being sent. Paste a new webhook URL below, or send a test message once it is
            fixed in Slack.
          </Alert>
        ) : null}

        <form className="space-y-5" onSubmit={(e) => void save(e)}>
          {askForUrl ? (
            <Field
              label="Webhook URL"
              htmlFor="slack-webhook"
              hint="Starts with https://hooks.slack.com/services/. Kept encrypted and never shown again. A test message is sent when you save."
            >
              <Input
                id="slack-webhook"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://hooks.slack.com/services/…"
                value={webhookUrl}
                disabled={busy !== null}
                onChange={(e) => setWebhookUrl(e.target.value)}
                required
              />
            </Field>
          ) : null}

          <Field
            label="Channel name"
            htmlFor="slack-channel"
            hint="Optional, so this page can say where messages go — for example #social-alerts. The webhook decides the real channel."
          >
            <Input
              id="slack-channel"
              value={channel}
              maxLength={80}
              disabled={busy !== null}
              onChange={(e) => setChannel(e.target.value)}
            />
          </Field>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Send to Slack when</legend>
            <div className="space-y-2">
              {events.map((option) => (
                <label key={option.type} className="flex cursor-pointer gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={chosen.has(option.type)}
                    disabled={busy !== null}
                    onChange={(e) => toggle(option.type, e.target.checked)}
                  />
                  <span>
                    <span className="block font-medium text-ink">{option.label}</span>
                    <span className="block text-ink-secondary">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={busy === 'save'}
              loadingLabel={askForUrl ? 'Connecting' : 'Saving'}
              disabled={busy !== null && busy !== 'save'}
            >
              {slack.connected ? (replacing ? 'Replace webhook' : 'Save') : 'Connect Slack'}
            </Button>

            {slack.connected ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy === 'test'}
                  loadingLabel="Sending"
                  disabled={busy !== null && busy !== 'test'}
                  onClick={() => void sendTest()}
                >
                  Send test message
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setReplacing((value) => !value);
                    setWebhookUrl('');
                    setError(null);
                  }}
                >
                  {replacing ? 'Keep current webhook' : 'Use a different webhook'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
        </form>
      </CardBody>

      <ConfirmDialog
        open={confirmDisconnect}
        busy={busy === 'disconnect'}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        title="Disconnect Slack?"
        description="Nothing more will be sent to the channel. In-app and email notifications carry on as before."
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
