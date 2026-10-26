'use client';

import * as React from 'react';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Textarea } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import { categoryLabel } from '../labels';

/**
 * Ask the assistant something, as a customer would, and see exactly what it
 * would send (**D-108**). Nobody receives the answer. The quickest way to find
 * out whether the documents say what the agency thinks they say.
 */

interface TestResult {
  action: 'REPLY' | 'ESCALATE';
  category: string | null;
  reason: string | null;
  text: string | null;
  cited: { id: string; title: string }[];
}

export function AssistantTester({ orgSlug, brandId }: { orgSlug: string; brandId: string }) {
  const [question, setQuestion] = React.useState('');
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { result: answer } = await apiRequest<{ result: TestResult }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/brands/${encodeURIComponent(brandId)}/assistant/test`,
        { method: 'POST', body: JSON.stringify({ text: question.trim() }) },
      );
      setResult(answer);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The assistant could not answer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Try it</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="space-y-3" onSubmit={(e) => void ask(e)}>
          <Field
            label="A customer’s message"
            htmlFor="assistant-test"
            hint="Nothing is sent to anyone. Uses one AI credit when the assistant is asked."
          >
            <Textarea
              id="assistant-test"
              rows={2}
              value={question}
              maxLength={1_000}
              placeholder="Shop mở cửa lúc mấy giờ?"
              disabled={busy}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy} loadingLabel="Thinking" disabled={!question.trim()}>
            Ask
          </Button>
        </form>

        {error ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="mt-4 rounded-md border border-line p-3" aria-live="polite">
            {result.action === 'REPLY' ? (
              <>
                <Badge tone="info">Would reply</Badge>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">
                  {result.text}
                </p>
                {result.cited.length > 0 ? (
                  <p className="mt-2 text-xs text-ink-muted">
                    From: {result.cited.map((entry) => entry.title).join(', ')}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <Badge tone="warning">Would hand to the team</Badge>
                <p className="mt-2 text-sm text-ink">
                  {result.category ? categoryLabel(result.category) : 'Needs a person'}
                </p>
                {result.reason ? (
                  <p className="mt-1 text-xs text-ink-muted">{result.reason}</p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
