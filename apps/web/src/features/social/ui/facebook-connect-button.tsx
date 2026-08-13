'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import { loadFacebookSdk } from './facebook-sdk';

/**
 * Connect a Page through Facebook's JavaScript SDK.
 *
 * `FB.login` is asked for a **code**, not an access token
 * (`response_type: 'code'` with `override_default_response_type`), so what
 * comes back to the browser cannot publish anything and expires unused. The
 * code is posted to our own endpoint, which exchanges it server-side with the
 * app secret exactly as the redirect callback does.
 *
 * That distinction is the whole reason this component can exist. Meta's sample
 * hands `authResponse.accessToken` to JavaScript; taking that route would put a
 * live credential where any extension or injected script could read it, and
 * would buy nothing — the server still has to trade it for a long-lived token
 * and then for Page tokens, because publishing happens hours later in a worker
 * with no browser present.
 *
 * The redirect flow remains for reconnection and for deployments with no Login
 * for Business configuration.
 */

export interface FacebookConnectButtonProps {
  orgSlug: string;
  workspaceId: string;
  brandId: string;
  appId: string;
  configId: string;
  graphVersion: string;
  /** Where to go once accounts are staged and ready to pick. */
  pickerHref: string;
}

export function FacebookConnectButton({
  orgSlug,
  workspaceId,
  brandId,
  appId,
  configId,
  graphVersion,
  pickerHref,
}: FacebookConnectButtonProps) {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    loadFacebookSdk({ appId, graphVersion })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            'Facebook could not be reached. Check whether an extension or network filter is blocking connect.facebook.net.',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appId, graphVersion]);

  function connect() {
    if (!window.FB) return;
    setError(null);

    // Called synchronously inside the click, so the popup is attributed to the
    // user gesture. Everything asynchronous happens after consent returns.
    window.FB.login(
      (response) => {
        if (!response.code) {
          // No code means the person closed the dialog or declined. Not a
          // failure worth reporting back to them as one.
          return;
        }
        void exchange(response.code);
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
      },
    );
  }

  async function exchange(code: string) {
    setBusy(true);

    try {
      const { staged } = await apiRequest<{ staged: number }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/oauth/facebook/exchange`,
        { method: 'POST', body: JSON.stringify({ code, workspaceId, brandId }) },
      );

      if (staged === 0) {
        setError(
          'That account does not administer any Page this brand could publish to. Try again with an account that does.',
        );
        setBusy(false);
        return;
      }

      // The picker reads the staged rows from the server; nothing about them
      // travels through this component.
      router.replace(pickerHref);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not finish connecting. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button loading={busy} disabled={!ready || busy} onClick={connect}>
        {ready ? 'Continue with Facebook' : 'Loading Facebook…'}
      </Button>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
