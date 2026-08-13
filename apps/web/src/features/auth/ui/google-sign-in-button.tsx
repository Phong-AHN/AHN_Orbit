'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Google sign-in, and the browser half of **D-004**.
 *
 * The server has verified ID tokens and minted session cookies since T1.1; what
 * was missing was anything that could obtain a token. This is it. The exchange
 * that follows is byte-for-byte the one the development provider uses — same
 * endpoint, same cookie, same provisioning — so nothing downstream can tell the
 * two apart, which is the property that made the dev provider safe to rely on.
 *
 * Two deliberate choices:
 *
 *  • **The SDK is imported inside the handler.** `firebase/auth` is a large
 *    dependency and this is the only page that needs it; a static import would
 *    put it in the bundle of a page whose whole job is to be fast for someone
 *    who is not signed in.
 *
 *  • **We sign out of Firebase immediately afterwards.** The HttpOnly cookie is
 *    the session. Leaving a Firebase refresh token in browser storage would
 *    create a second, longer-lived credential that our own revocation path does
 *    not reach — signing out means there is exactly one thing to revoke.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export interface GoogleSignInButtonProps {
  config: FirebaseWebConfig;
}

export function GoogleSignInButton({ config }: GoogleSignInButtonProps) {
  const router = useRouter();
  const search = useSearchParams();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Only relative paths, so `next` cannot become an open redirect — the same
  // rule the OAuth `returnTo` follows.
  const rawNext = search.get('next');
  const next = rawNext?.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/orgs';

  async function signIn() {
    setBusy(true);
    setError(null);

    try {
      const [
        { getApp, getApps, initializeApp },
        { getAuth, GoogleAuthProvider, signInWithPopup, signOut },
      ] = await Promise.all([import('firebase/app'), import('firebase/auth')]);

      const app = getApps().length > 0 ? getApp() : initializeApp(config);
      const auth = getAuth(app);

      const credential = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await credential.user.getIdToken();

      // The cookie is minted here; from this point the Firebase session is
      // surplus, so it is discarded rather than left in browser storage.
      await signOut(auth);

      const response = await fetch('/api/v1/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
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
      setError(describe(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button loading={busy} disabled={busy} onClick={() => void signIn()}>
        Continue with Google
      </Button>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Firebase's own error codes are the ones worth translating: closing the popup
 * is not a failure, and a blocked popup is a browser setting rather than
 * anything the person did wrong.
 */
function describe(error: unknown): string | null {
  if (error instanceof ApiError) return error.message;

  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null;
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized in the Firebase project. Add it under Authentication → Settings → Authorized domains.';
    case 'auth/configuration-not-found':
      return 'Google sign-in is not enabled in the Firebase project yet.';
    default:
      return 'Could not sign in. Please try again in a moment.';
  }
}
