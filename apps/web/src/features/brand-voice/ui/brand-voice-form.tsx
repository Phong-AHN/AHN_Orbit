'use client';

import * as React from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Textarea } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Writing a brand's context (T4.1, SRS §24).
 *
 * Every field is optional and the form says so, because a Brand Brain nobody
 * finished is still worth having — three good sentences ground a generation
 * better than twelve empty boxes.
 *
 * The list fields are comma-separated text rather than tag widgets. That is a
 * deliberate plainness: an agency filling this in for twenty brands wants to
 * paste, not to click.
 */

export interface BrandVoiceValue {
  companyDescription: string | null;
  productsServices: string | null;
  targetAudience: string | null;
  brandVoice: string | null;
  tone: string | null;
  preferredTerms: string[];
  bannedTerms: string[];
  ctas: string[];
  website: string | null;
  exampleContent: unknown;
}

export interface BrandVoiceFormProps {
  orgSlug: string;
  brandId: string;
  brandName: string;
  voice: BrandVoiceValue | null;
  canEdit: boolean;
}

export function BrandVoiceForm({
  orgSlug,
  brandId,
  brandName,
  voice,
  canEdit,
}: BrandVoiceFormProps) {
  const [form, setForm] = React.useState(() => ({
    companyDescription: voice?.companyDescription ?? '',
    productsServices: voice?.productsServices ?? '',
    targetAudience: voice?.targetAudience ?? '',
    brandVoice: voice?.brandVoice ?? '',
    tone: voice?.tone ?? '',
    website: voice?.website ?? '',
    preferredTerms: (voice?.preferredTerms ?? []).join(', '),
    bannedTerms: (voice?.bannedTerms ?? []).join(', '),
    ctas: (voice?.ctas ?? []).join('\n'),
    exampleContent: asLines(voice?.exampleContent).join('\n\n'),
  }));

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  function set(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/brands/${encodeURIComponent(brandId)}/voice`,
        {
          method: 'PUT',
          body: JSON.stringify({
            companyDescription: form.companyDescription.trim(),
            productsServices: form.productsServices.trim(),
            targetAudience: form.targetAudience.trim(),
            brandVoice: form.brandVoice.trim(),
            tone: form.tone.trim(),
            website: form.website.trim(),
            preferredTerms: splitList(form.preferredTerms),
            bannedTerms: splitList(form.bannedTerms),
            ctas: splitLines(form.ctas),
            exampleContent: splitParagraphs(form.exampleContent),
          }),
        },
      );

      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What {brandName} sounds like</CardTitle>
      </CardHeader>

      <CardBody>
        <p className="mb-4 text-sm text-ink-secondary">
          Written once, used to ground every suggestion. All of it is optional — a few honest
          sentences work better than a complete form nobody meant.
        </p>

        <form className="space-y-4" onSubmit={(e) => void save(e)}>
          <Field label="What the company does" htmlFor="bv-company">
            <Textarea
              id="bv-company"
              rows={3}
              value={form.companyDescription}
              disabled={!canEdit || busy}
              onChange={(e) => set('companyDescription', e.target.value)}
            />
          </Field>

          <Field label="Products and services" htmlFor="bv-products">
            <Textarea
              id="bv-products"
              rows={3}
              value={form.productsServices}
              disabled={!canEdit || busy}
              onChange={(e) => set('productsServices', e.target.value)}
            />
          </Field>

          <Field label="Who they are talking to" htmlFor="bv-audience">
            <Textarea
              id="bv-audience"
              rows={2}
              value={form.targetAudience}
              disabled={!canEdit || busy}
              onChange={(e) => set('targetAudience', e.target.value)}
            />
          </Field>

          <Field
            label="Voice"
            htmlFor="bv-voice"
            hint="How they speak — not what they sell. “Direct, a bit dry, never salesy.”"
          >
            <Textarea
              id="bv-voice"
              rows={2}
              value={form.brandVoice}
              disabled={!canEdit || busy}
              onChange={(e) => set('brandVoice', e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tone" htmlFor="bv-tone" hint="One or two words.">
              <Input
                id="bv-tone"
                value={form.tone}
                disabled={!canEdit || busy}
                placeholder="Warm, confident"
                onChange={(e) => set('tone', e.target.value)}
              />
            </Field>

            <Field label="Website" htmlFor="bv-website">
              <Input
                id="bv-website"
                type="url"
                value={form.website}
                disabled={!canEdit || busy}
                placeholder="https://example.com"
                onChange={(e) => set('website', e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Preferred words" htmlFor="bv-preferred" hint="Comma separated.">
              <Input
                id="bv-preferred"
                value={form.preferredTerms}
                disabled={!canEdit || busy}
                onChange={(e) => set('preferredTerms', e.target.value)}
              />
            </Field>

            <Field
              label="Words to avoid"
              htmlFor="bv-banned"
              hint="Comma separated. Suggestions are checked against these and flagged, not blocked."
            >
              <Input
                id="bv-banned"
                value={form.bannedTerms}
                disabled={!canEdit || busy}
                onChange={(e) => set('bannedTerms', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Calls to action" htmlFor="bv-ctas" hint="One per line.">
            <Textarea
              id="bv-ctas"
              rows={3}
              value={form.ctas}
              disabled={!canEdit || busy}
              onChange={(e) => set('ctas', e.target.value)}
            />
          </Field>

          <Field
            label="Posts that sound right"
            htmlFor="bv-examples"
            hint="Blank line between each. Examples teach tone better than adjectives do."
          >
            <Textarea
              id="bv-examples"
              rows={6}
              value={form.exampleContent}
              disabled={!canEdit || busy}
              onChange={(e) => set('exampleContent', e.target.value)}
            />
          </Field>

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          {canEdit ? (
            <div className="flex items-center gap-3">
              <Button type="submit" loading={busy} disabled={busy}>
                Save
              </Button>
              {saved ? <span className="text-sm text-ink-muted">Saved.</span> : null}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">You can read this but not change it.</p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function splitParagraphs(value: string): string[] {
  return value
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function asLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
