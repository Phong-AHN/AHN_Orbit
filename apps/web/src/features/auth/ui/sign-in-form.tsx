'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Development sign-in.
 *
 * The session exchange is the same one production uses: this posts an ID token
 * to `POST /api/v1/auth/session`, the server verifies it and mints an HttpOnly
 * cookie, and nothing about the identity is read from anything the browser
 * asserts (T1.1, **D-004**). What differs is only where the token comes from.
 *
 * Outside production the identity provider is `devIdentityProvider`, whose
 * "token" is the string `dev:{email}`. It is guarded three ways: the provider
 * refuses to mint or verify anything when `APP_ENV=production`, env validation
 * requires the `FIREBASE_*` variables in production, and this form is not
 * rendered there at all.
 *
 * **The real Firebase sign-in is not built** — no client SDK is installed and no
 * Firebase project is configured. That is the honest state, and the page says so
 * rather than showing a form that would fail.
 */
export function SignInForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Only relative paths, so `next` cannot become an open redirect — the same
  // rule the OAuth `returnTo` follows.
  const rawNext = search.get('next');
  const next = rawNext?.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/orgs';

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const address = email.trim().toLowerCase();
    if (address.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: `dev:${address}` }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const envelope =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      // `refresh()` as well as `push()`: the session is a cookie, and the server
      // components on the destination were already rendered without it.
      router.push(next);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not sign in. Is the server running?');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <Field
        label="Email"
        htmlFor="sign-in-email"
        required
        hint="Any address. A user is provisioned on first sign-in."
      >
        <Input
          id="sign-in-email"
          type="email"
          autoComplete="email"
          value={email}
          disabled={busy}
          placeholder="you@agency.test"
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={busy} disabled={busy || email.trim().length === 0}>
        Continue
      </Button>
    </form>
  );
}
