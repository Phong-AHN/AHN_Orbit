import { Suspense } from 'react';
import type { Metadata } from 'next';
import { serverEnv } from '@orbit/config';
import { selectIdentityProvider } from '@orbit/auth';
import { Card, CardBody, CardHeader, CardTitle, Loading, PageHeader } from '@orbit/ui';
import { SignInForm } from '@/features/auth/ui/sign-in-form';
import { GoogleSignInButton } from '@/features/auth/ui/google-sign-in-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Sign in (SRS §6).
 *
 * Which form appears is not this page's decision — it asks
 * `selectIdentityProvider()`, the same function the session endpoint uses to
 * decide what it will accept. That matters: when the two disagree, the symptom
 * is a form that submits successfully into a rejection, and the cause is
 * invisible from the browser. One source of truth removes the failure mode
 * rather than documenting it.
 *
 *  • **Firebase configured** — Google sign-in. The client SDK obtains an ID
 *    token, which is exchanged for the session cookie.
 *  • **Otherwise, outside production** — the development provider, whose token
 *    is `dev:{email}`. Everything after the exchange is identical (**D-004**).
 *
 * The route group is `(auth)` and has no shell: a signed-out person has no
 * organization, so there is no navigation to give them.
 */
export default function SignInPage() {
  const env = serverEnv();
  const provider = selectIdentityProvider();

  const firebaseWebConfig =
    provider.kind === 'firebase' &&
    env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
    env.NEXT_PUBLIC_FIREBASE_APP_ID &&
    env.FIREBASE_PROJECT_ID
      ? {
          apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
          authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
          projectId: env.FIREBASE_PROJECT_ID,
          appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
        }
      : undefined;

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <PageHeader
        eyebrow="AHN Orbit"
        title="Sign in"
        description={
          provider.kind === 'firebase'
            ? 'Use your Google account. An account is created the first time you sign in.'
            : 'Development sign-in. No password — an account is created the first time an address is used.'
        }
      />

      <Card className="mt-8">
        <CardBody>
          <Suspense fallback={<Loading label="Loading the sign-in form" rows={2} />}>
            {provider.kind === 'firebase' ? (
              firebaseWebConfig ? (
                <GoogleSignInButton config={firebaseWebConfig} />
              ) : (
                <MissingWebConfig />
              )
            ) : (
              <SignInForm />
            )}
          </Suspense>
        </CardBody>
      </Card>

      {provider.kind === 'firebase' ? null : (
        <Card className="mt-4 border-warning/40">
          <CardHeader>
            <CardTitle>Why there is no password</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-ink-muted">
              AHN Orbit stores no password material at all — Firebase owns credentials in
              production, and this is its local stand-in. The provider refuses to run when{' '}
              <span className="font-mono text-xs">APP_ENV=production</span>, so this form cannot
              reach a real deployment.
            </p>
          </CardBody>
        </Card>
      )}
    </main>
  );
}

/**
 * The server is on Firebase but the browser has no way to reach it. Production
 * cannot start in this state — env validation requires the three public keys —
 * so this is reachable only in development, where saying which half is missing
 * is more useful than a button that cannot work.
 */
function MissingWebConfig() {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">Sign-in is half-configured</p>
      <p className="text-sm text-ink-muted">
        The server has Firebase Admin credentials, but{' '}
        <span className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_API_KEY</span>,{' '}
        <span className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN</span> and{' '}
        <span className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_APP_ID</span> are not set, so the
        browser cannot obtain a token. Copy them from the Firebase console under Project settings →
        Your apps → Web app.
      </p>
    </div>
  );
}
