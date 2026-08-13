import { Suspense } from 'react';
import type { Metadata } from 'next';
import { serverEnv } from '@orbit/config';
import { Card, CardBody, CardHeader, CardTitle, Loading, PageHeader } from '@orbit/ui';
import { SignInForm } from '@/features/auth/ui/sign-in-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Sign in (SRS §6).
 *
 * Two paths, and only one of them is built:
 *
 *  • **Outside production** — the development identity provider, whose token is
 *    `dev:{email}`. The session exchange, the cookie, the user provisioning and
 *    every downstream check are identical to production; only the source of the
 *    verified identity differs (**D-004**).
 *  • **In production** — Firebase's client SDK issues the ID token. That SDK is
 *    **not installed and no project is configured**, so rather than render a
 *    form that cannot work, this says so.
 *
 * The route group is `(auth)` and has no shell: a signed-out person has no
 * organization, so there is no navigation to give them.
 */
export default function SignInPage() {
  const env = serverEnv();
  const developmentSignIn = env.APP_ENV !== 'production';

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <PageHeader
        eyebrow="AHN Orbit"
        title="Sign in"
        description={
          developmentSignIn
            ? 'Development sign-in. No password — an account is created the first time an address is used.'
            : 'Sign in to continue.'
        }
      />

      <Card className="mt-8">
        <CardBody>
          {developmentSignIn ? (
            <Suspense fallback={<Loading label="Loading the sign-in form" rows={2} />}>
              <SignInForm />
            </Suspense>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink">Sign-in is not configured</p>
              <p className="text-sm text-ink-muted">
                This deployment expects Firebase Auth, and no client SDK is installed yet. See{' '}
                <span className="font-mono text-xs">docs/DEPLOYMENT.md</span>.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {developmentSignIn ? (
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
      ) : null}
    </main>
  );
}
