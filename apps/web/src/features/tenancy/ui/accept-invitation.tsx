'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, CardBody, ErrorState } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Redeeming an invitation.
 *
 * The token authorises *joining*; the session decides *who* joins. So this runs
 * only for a signed-in person, and the identity it grants membership to is the
 * one already in the cookie — a token that reached the wrong inbox cannot be
 * used to become somebody else.
 *
 * Deliberately a button rather than an automatic redemption on load. A link
 * that silently changes account membership when it is opened — by a preview
 * fetcher, a scanner, or a mis-click — is a link that acts without being asked.
 */
export function AcceptInvitation() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token');

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | string | null>(null);

  if (!token) {
    return (
      <ErrorState
        title="This link is incomplete"
        description="Ask whoever invited you to send it again — the token is missing from the address."
      />
    );
  }

  async function accept() {
    setBusy(true);
    setError(null);

    try {
      const { organization } = await apiRequest<{
        organization: { slug: string };
        role: string;
      }>('/api/v1/auth/accept-invitation', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });

      router.replace(`/orgs/${organization.slug}/dashboard`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e : 'The invitation could not be accepted.');
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        {error ? (
          <ErrorState
            title="That invitation did not work"
            description={typeof error === 'string' ? error : error.message}
            {...(typeof error !== 'string' && error.correlationId
              ? { correlationId: error.correlationId }
              : {})}
          />
        ) : (
          <p className="text-sm text-ink-secondary">
            You have been invited to join an agency on AHN Orbit. Accepting adds this account — the
            one you are signed in as — to their organization.
          </p>
        )}

        <Button loading={busy} disabled={busy} onClick={() => void accept()}>
          Accept invitation
        </Button>
      </CardBody>
    </Card>
  );
}
