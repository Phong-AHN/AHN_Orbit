import Link from 'next/link';
import { Alert, Card, CardBody, CardHeader, CardTitle, buttonClassName, cn } from '@orbit/ui';
import type { SetupProgress } from '../setup-progress';

/**
 * The first thing a new agency sees, and the only thing until setup is done.
 *
 * ## Numbered, and that is not decoration
 *
 * Orbit's setup is a real dependency chain: a social account attaches to a
 * brand, a brand lives in a client's workspace, and a post needs an account to
 * go to. Numbers encode that order. They would be decoration on a list of
 * independent options; here they are the information.
 *
 * ## One action, not four
 *
 * Only the current step gets a button. A new organization offered four buttons
 * invites somebody to start at step three and meet a dead end — which is what
 * the old empty dashboard did implicitly, by linking everywhere and explaining
 * nothing.
 *
 * ## It leaves on its own
 *
 * No dismiss control and no stored flag. The guide is a view of the data, so it
 * disappears when the last step is done and returns if somebody deletes the
 * only client — which is the honest behaviour, because at that moment the
 * product genuinely cannot publish again.
 */
export function SetupGuide({ progress, base }: { progress: SetupProgress; base: string }) {
  if (progress.finished) return null;

  const current = progress.steps.find((step) => step.current);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Set up your agency{' '}
          <span className="text-sm font-normal text-ink-muted">
            — {progress.completed} of {progress.steps.length} done
          </span>
        </CardTitle>
      </CardHeader>

      <CardBody className="space-y-4">
        {/* Said before the list, because somebody who cannot act on the next
            step needs to know that before they read four instructions. */}
        {progress.blockedOnSomeoneElse ? (
          <Alert tone="info" title="Someone with more access has to go first">
            {current ? `"${current.label}" ` : 'The next step '}
            is not something your role can do. Ask whoever set up this agency to do it, and the rest
            is yours.
          </Alert>
        ) : null}

        <ol className="space-y-3">
          {progress.steps.map((step, index) => (
            <li key={step.id} className="flex gap-3">
              {/* The number is the structure. A done step keeps its number
                  rather than turning into a tick, so the sequence stays
                  readable once part of it is behind you. */}
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm',
                  'font-display text-sm font-semibold tabular-nums',
                  step.done && 'bg-accent-soft text-accent',
                  step.current && !step.done && 'bg-accent text-accent-ink',
                  !step.done && !step.current && 'bg-surface-sunken text-ink-muted',
                )}
              >
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-sm font-medium',
                    step.done ? 'text-ink-muted line-through' : 'text-ink',
                  )}
                >
                  {step.label}
                  {step.done ? <span className="sr-only"> (done)</span> : null}
                </p>

                {/* The reason, shown only where it is still useful. Explaining a
                    step somebody has already finished is clutter. */}
                {!step.done ? (
                  <p className="mt-0.5 max-w-measure text-sm text-ink-secondary">{step.detail}</p>
                ) : null}

                {step.current && step.permitted ? (
                  <Link
                    href={`${base}${step.path}`}
                    className={cn(buttonClassName({ size: 'sm' }), 'mt-2')}
                  >
                    {step.action}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
