import { presentFailure } from '@orbit/core';
import { Badge, Card, CardBody, CardHeader, CardTitle, cn } from '@orbit/ui';
import { ACTION_LABEL, ATTEMPT_STATE_LABEL, ATTEMPT_STATE_TONE, type AttemptState } from './status';

/**
 * The attempt chain, read as a narrative (SRS §14).
 *
 * "Attempt 1 timed out, we checked, the post was already there" is a story an
 * operator can act on. A row of error codes is not. Each attempt therefore
 * shows what happened, what it means, and what to do — the last coming from the
 * shared `presentFailure` map so every §37 code has an answer.
 *
 * A server component: it renders from data the page already resolved, and
 * nothing here is interactive.
 */

export interface AttemptRow {
  id: string;
  attemptNumber: number;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  externalPostId: string | null;
  errorCode: string | null;
  /** The vetted message the engine stored. Never a provider payload. */
  errorMessage: string | null;
  errorRetryable: boolean | null;
  correlationId: string;
}

export function AttemptTimeline({ attempts }: { attempts: AttemptRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attempts</CardTitle>
      </CardHeader>
      <CardBody>
        {attempts.length === 0 ? (
          <p className="text-sm text-ink-muted">Publishing has not been attempted yet.</p>
        ) : (
          <ol className="space-y-4">
            {attempts.map((attempt) => {
              const state = attempt.state as AttemptState;
              const presentation = presentFailure(attempt.errorCode);
              const failed = state !== 'SUCCEEDED' && state !== 'RECONCILED';

              return (
                <li key={attempt.id} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      state === 'SUCCEEDED' && 'bg-success',
                      state === 'RECONCILED' && 'bg-success',
                      state === 'FAILED' && 'bg-danger',
                      state === 'INCONCLUSIVE' && 'bg-warning',
                      state === 'IN_FLIGHT' && 'bg-accent',
                    )}
                  />

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-ink">Attempt {attempt.attemptNumber}</span>
                      <Badge tone={ATTEMPT_STATE_TONE[state] ?? 'neutral'}>
                        {ATTEMPT_STATE_LABEL[state] ?? state}
                      </Badge>
                      {attempt.durationMs !== null ? (
                        <span className="font-mono text-xs text-ink-muted">
                          {(attempt.durationMs / 1000).toFixed(1)}s
                        </span>
                      ) : null}
                    </p>

                    <p className="mt-0.5 text-xs text-ink-muted">
                      <time dateTime={attempt.startedAt}>
                        {attempt.startedAt.slice(0, 19).replace('T', ' ')}
                      </time>
                      {' · '}
                      {/* The handle support asks for. */}
                      <span className="font-mono">{attempt.correlationId}</span>
                    </p>

                    {attempt.externalPostId ? (
                      <p className="mt-1 font-mono text-xs text-ink-secondary">
                        {attempt.externalPostId}
                      </p>
                    ) : null}

                    {failed ? (
                      <div className="mt-1.5 border-l-2 border-line pl-3">
                        <p className="text-sm text-ink-secondary">
                          {attempt.errorMessage ?? presentation.summary}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {ACTION_LABEL[presentation.action]}
                          {attempt.errorRetryable ? ' · retried automatically' : ''}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
