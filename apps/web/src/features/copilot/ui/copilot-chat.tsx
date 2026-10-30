'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, Textarea } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import type { CopilotActionView, CopilotMessage } from '../service';

/**
 * The Copilot conversation (D-109 phase 5).
 *
 * Actions the Copilot prepared appear as cards under its reply. The card's
 * text is the server's summary of exactly what will run; the buttons call the
 * same confirm and reject routes as the AI agent actions page — a click in
 * the person's own session, which the model cannot make.
 */

type ActionState = 'PENDING' | 'EXECUTED' | 'FAILED' | 'REJECTED';

export function CopilotChat({
  orgSlug,
  threadId: initialThreadId,
  initialMessages,
}: {
  orgSlug: string;
  threadId: string | null;
  initialMessages: CopilotMessage[];
}) {
  const router = useRouter();
  const [threadId, setThreadId] = React.useState(initialThreadId);
  const [messages, setMessages] = React.useState(initialMessages);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const end = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setMessages((current) => [...current, { role: 'user', text, at: '' }]);
    setDraft('');
    try {
      const result = await apiRequest<{ thread: { id: string }; messages: CopilotMessage[] }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/copilot/messages`,
        { method: 'POST', body: JSON.stringify({ threadId, text }) },
      );
      setMessages((current) => [...current.slice(0, -1), ...result.messages]);
      if (!threadId) {
        setThreadId(result.thread.id);
        router.replace(`/orgs/${orgSlug}/copilot?thread=${result.thread.id}`);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The Copilot could not answer. Try again.');
      setMessages((current) => current.slice(0, -1));
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] flex-col gap-4">
      <div className="flex-1 space-y-4">
        {messages.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            Ask for anything you would do in Social Square: “Plan next week for AHN on Facebook and
            Instagram”, “What is waiting in the inbox?”, “How did October go?”. Publishing,
            scheduling and replies always wait for your confirmation here.
          </p>
        ) : null}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <p className="max-w-[80%] whitespace-pre-wrap rounded-md bg-accent px-4 py-2 text-sm text-accent-ink">
                {message.text}
              </p>
            </div>
          ) : (
            <div key={index} className="max-w-[90%] space-y-2">
              {message.steps.length > 0 ? (
                <details className="text-xs text-ink-muted">
                  <summary>
                    {message.steps.length} step{message.steps.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {message.steps.map((step, i) => (
                      <li key={i}>
                        {step.ok ? '✓' : '✕'} <code className="font-mono">{step.tool}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="whitespace-pre-wrap text-sm text-ink">{message.text}</p>
              {message.actions.map((action) => (
                <ActionCard key={action.id} orgSlug={orgSlug} action={action} />
              ))}
            </div>
          ),
        )}
        {busy ? <p className="text-sm text-ink-muted">Working…</p> : null}
        <div ref={end} />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form onSubmit={(e) => void send(e)} className="flex items-end gap-2">
        <label className="sr-only" htmlFor="copilot-input">
          Message
        </label>
        <Textarea
          id="copilot-input"
          rows={2}
          value={draft}
          maxLength={4_000}
          disabled={busy}
          placeholder="Ask the Copilot…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
          className="flex-1"
        />
        <Button type="submit" loading={busy} loadingLabel="Working" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}

function ActionCard({ orgSlug, action }: { orgSlug: string; action: CopilotActionView }) {
  const [state, setState] = React.useState<ActionState>('PENDING');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  async function decide(verb: 'confirm' | 'reject') {
    setBusy(true);
    setProblem(null);
    try {
      const result = await apiRequest<{ status: ActionState; error?: string }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/agent-actions/${encodeURIComponent(action.id)}/${verb}`,
        { method: 'POST' },
      );
      setState(result.status);
      if (result.error) setProblem(result.error);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge
            tone={
              state === 'PENDING'
                ? 'warning'
                : state === 'EXECUTED'
                  ? 'success'
                  : state === 'FAILED'
                    ? 'danger'
                    : 'neutral'
            }
          >
            {state === 'PENDING'
              ? 'Needs your confirmation'
              : state === 'EXECUTED'
                ? 'Done'
                : state === 'FAILED'
                  ? 'Failed'
                  : 'Rejected'}
          </Badge>
        </div>
        <p className="whitespace-pre-wrap text-sm text-ink">{action.summary}</p>
        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}
        {state === 'PENDING' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void decide('confirm')}
              loading={busy}
              loadingLabel="Running"
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void decide('reject')}
              disabled={busy}
            >
              Reject
            </Button>
            <Link
              className="text-xs text-ink-muted underline"
              href={`/orgs/${orgSlug}/agent-actions?action=${action.id}`}
            >
              All actions
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
