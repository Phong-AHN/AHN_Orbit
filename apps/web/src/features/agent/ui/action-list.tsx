'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, type BadgeTone } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * What an AI agent prepared, for the person to confirm or reject (D-109 §5).
 *
 * The summary was written by the server from the exact call that will run;
 * the agent had no hand in it. Confirming here is the only way an agent's
 * publish, schedule or reply ever happens.
 */

export interface ActionRow {
  id: string;
  channel: 'MCP' | 'COPILOT';
  tool: string;
  summary: string;
  status: 'PENDING' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'REJECTED' | 'EXPIRED';
  expiresAt: string;
  error: string | null;
  createdAt: string;
}

const STATUS: Record<ActionRow['status'], { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Waiting for you', tone: 'warning' },
  EXECUTING: { label: 'Running', tone: 'info' },
  EXECUTED: { label: 'Done', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

export function ActionList({
  orgSlug,
  actions,
  highlight,
}: {
  orgSlug: string;
  actions: ActionRow[];
  highlight: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  async function decide(id: string, verb: 'confirm' | 'reject') {
    setBusy(id);
    setErrors((current) => ({ ...current, [id]: '' }));
    try {
      const result = await apiRequest<{ status: string; error?: string }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/agent-actions/${encodeURIComponent(id)}/${verb}`,
        { method: 'POST' },
      );
      if (result.status === 'FAILED' && result.error) {
        setErrors((current) => ({ ...current, [id]: result.error ?? '' }));
      }
      router.refresh();
    } catch (e) {
      setErrors((current) => ({
        ...current,
        [id]: e instanceof ApiError ? e.message : 'That did not go through. Try again.',
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="space-y-3">
      {actions.map((action) => {
        const status = STATUS[action.status];
        const problem = errors[action.id] || action.error;
        return (
          <li key={action.id} id={`action-${action.id}`}>
            <Card className={action.id === highlight ? 'ring-2 ring-accent' : undefined}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span>
                    {action.channel === 'MCP' ? 'From a connected AI app' : 'From the Copilot'}
                  </span>
                  <span>· {new Date(action.createdAt).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-ink">{action.summary}</p>
                {problem ? (
                  <p role="alert" className="text-sm text-danger">
                    {problem}
                  </p>
                ) : null}
                {action.status === 'PENDING' ? (
                  <div className="flex gap-2">
                    <Button
                      onClick={() => void decide(action.id, 'confirm')}
                      loading={busy === action.id}
                      loadingLabel="Running"
                      disabled={busy !== null}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void decide(action.id, 'reject')}
                      disabled={busy !== null}
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
