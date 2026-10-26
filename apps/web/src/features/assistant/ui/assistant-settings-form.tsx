'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
  cn,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * How the AI assistant behaves for one brand (**D-108**).
 *
 * The three modes are described by what they do to a customer, not by what
 * they are called, because that is the decision being made. AUTO is disabled
 * with its reasons listed until it may be chosen, so nobody discovers the rule
 * by being refused.
 *
 * Staffed hours are one period per weekday. Two shifts a day is rare enough
 * for an agency inbox that the plainer form wins.
 */

type Mode = 'OFF' | 'SUGGEST' | 'AUTO';

interface Period {
  day: number;
  start: string;
  end: string;
}

export interface AssistantSettingsFormProps {
  orgSlug: string;
  brandId: string;
  timezone: string;
  settings: {
    mode: Mode;
    staffedHours: Period[];
    graceMinutes: number;
    holdingMessage: string | null;
    maxRepliesPerConversation: number;
    escalationTerms: string[];
  };
  auto: { allowed: boolean; reasons: string[] };
  freeTier: boolean;
  disclosure: string;
  defaultHoldingMessage: string;
}

/** Monday first, as a working week reads; `day` is still 0 = Sunday. */
const WEEK = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
  { day: 0, label: 'Sunday' },
];

const MODES: { value: Mode; title: string; description: string }[] = [
  {
    value: 'OFF',
    title: 'Off',
    description: 'The assistant does nothing. The team answers every message.',
  },
  {
    value: 'SUGGEST',
    title: 'Suggest replies',
    description:
      'A “Suggest a reply” button drafts an answer from the brand’s documents. A colleague reads, edits and sends it. Nothing reaches a customer by itself.',
  },
  {
    value: 'AUTO',
    title: 'Answer when nobody is on',
    description:
      'Outside staffed hours, or when the team has not replied within the grace period, the assistant answers from the documents on its own — and hands anything else to the team.',
  },
];

export function AssistantSettingsForm(props: AssistantSettingsFormProps) {
  const router = useRouter();
  const { settings } = props;

  const [mode, setMode] = React.useState<Mode>(settings.mode);
  const [days, setDays] = React.useState(
    () =>
      Object.fromEntries(
        WEEK.map(({ day }) => {
          const period = settings.staffedHours.find((entry) => entry.day === day);
          return [
            day,
            { on: Boolean(period), start: period?.start ?? '08:00', end: period?.end ?? '17:30' },
          ];
        }),
      ) as Record<number, { on: boolean; start: string; end: string }>,
  );
  const [grace, setGrace] = React.useState(String(settings.graceMinutes));
  const [maxReplies, setMaxReplies] = React.useState(String(settings.maxRepliesPerConversation));
  const [holding, setHolding] = React.useState(settings.holdingMessage ?? '');
  const [terms, setTerms] = React.useState(settings.escalationTerms.join(', '));

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const autoLocked = !props.auto.allowed && settings.mode !== 'AUTO';

  function setDay(day: number, patch: Partial<{ on: boolean; start: string; end: string }>) {
    setDays((current) => ({ ...current, [day]: { ...current[day]!, ...patch } }));
    setSaved(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/brands/${encodeURIComponent(props.brandId)}/assistant`,
        {
          method: 'PUT',
          body: JSON.stringify({
            mode,
            staffedHours: WEEK.flatMap(({ day }) => {
              const entry = days[day]!;
              return entry.on ? [{ day, start: entry.start, end: entry.end }] : [];
            }),
            graceMinutes: Number(grace),
            maxRepliesPerConversation: Number(maxReplies),
            holdingMessage: holding.trim(),
            escalationTerms: terms
              .split(',')
              .map((term) => term.trim())
              .filter(Boolean),
          }),
        },
      );
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the assistant behaves</CardTitle>
      </CardHeader>

      <CardBody>
        {props.freeTier && mode !== 'OFF' ? (
          <p
            role="note"
            className="mb-4 rounded-md border border-line bg-warning-soft px-3 py-2 text-sm text-ink"
          >
            <strong className="font-semibold">Free Gemini tier.</strong> On the free tier, Google
            may use what is sent — the brand’s documents and customers’ messages — to improve its
            products, and limits how many requests can be made. Upgrade before using this with a
            client’s customers in earnest.
          </p>
        ) : null}

        <form className="space-y-6" onSubmit={(e) => void save(e)}>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Mode</legend>
            <div className="space-y-2">
              {MODES.map((option) => {
                const disabled = busy || (option.value === 'AUTO' && autoLocked);
                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer gap-3 rounded-md border px-3 py-2',
                      mode === option.value ? 'border-accent' : 'border-line',
                      disabled ? 'cursor-not-allowed opacity-60' : null,
                    )}
                  >
                    <input
                      type="radio"
                      name="assistant-mode"
                      value={option.value}
                      checked={mode === option.value}
                      disabled={disabled}
                      onChange={() => {
                        setMode(option.value);
                        setSaved(false);
                      }}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink">{option.title}</span>
                      <span className="block text-sm text-ink-secondary">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            {autoLocked ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
                {props.auto.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </fieldset>

          <div className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
            Every message the assistant sends on its own ends with{' '}
            <span className="font-medium text-ink">“— {props.disclosure}”</span>, so the customer
            always knows. It never answers refunds, complaints, orders, legal or safety matters, or
            anything the documents do not cover — those go to the team.
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-ink">Staffed hours</legend>
            <p className="mb-2 text-xs text-ink-muted">
              In {props.timezone}. During these hours the assistant waits for the team first.
            </p>
            <div className="space-y-2">
              {WEEK.map(({ day, label }) => {
                const entry = days[day]!;
                return (
                  <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex w-32 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={entry.on}
                        disabled={busy}
                        onChange={(e) => setDay(day, { on: e.target.checked })}
                      />
                      {label}
                    </label>
                    {entry.on ? (
                      <>
                        <Input
                          type="time"
                          aria-label={`${label} start`}
                          value={entry.start}
                          disabled={busy}
                          onChange={(e) => setDay(day, { start: e.target.value })}
                          className="w-32"
                        />
                        <span className="text-ink-muted">to</span>
                        <Input
                          type="time"
                          aria-label={`${label} end`}
                          value={entry.end}
                          disabled={busy}
                          onChange={(e) => setDay(day, { end: e.target.value })}
                          className="w-32"
                        />
                      </>
                    ) : (
                      <span className="text-ink-muted">Nobody on</span>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Grace period (minutes)"
              htmlFor="assistant-grace"
              hint="During staffed hours, how long the team has to reply first."
            >
              <Input
                id="assistant-grace"
                type="number"
                min={0}
                max={240}
                value={grace}
                disabled={busy}
                onChange={(e) => {
                  setGrace(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>

            <Field
              label="Automatic replies per conversation"
              htmlFor="assistant-max"
              hint="After this many, the team takes over."
            >
              <Input
                id="assistant-max"
                type="number"
                min={1}
                max={10}
                value={maxReplies}
                disabled={busy}
                onChange={(e) => {
                  setMaxReplies(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
          </div>

          <Field
            label="Message when handing over"
            htmlFor="assistant-holding"
            hint="Sent once, when the assistant hands a conversation to the team. Leave empty for the default."
          >
            <Textarea
              id="assistant-holding"
              rows={2}
              value={holding}
              placeholder={props.defaultHoldingMessage}
              disabled={busy}
              onChange={(e) => {
                setHolding(e.target.value);
                setSaved(false);
              }}
            />
          </Field>

          <Field
            label="Always hand over when a customer mentions"
            htmlFor="assistant-terms"
            hint="Comma separated. Matched with or without diacritics, e.g. bảo hành, trả góp."
          >
            <Input
              id="assistant-terms"
              value={terms}
              disabled={busy}
              onChange={(e) => {
                setTerms(e.target.value);
                setSaved(false);
              }}
            />
          </Field>

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" loading={busy} loadingLabel="Saving">
              Save
            </Button>
            {saved ? <Badge tone="success">Saved</Badge> : null}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
