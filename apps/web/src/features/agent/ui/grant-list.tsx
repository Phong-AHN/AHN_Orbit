'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/** AI apps that can act for people in this organization, with a way to cut them off (D-109 §6). */

export interface GrantRow {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  person: string;
}

const SCOPE_LABEL: Record<string, string> = {
  read: 'Read',
  content: 'Draft content',
  workflow: 'Publish & schedule (with your confirmation)',
  engagement: 'Inbox & comments',
};

export function GrantList({ orgSlug, grants }: { orgSlug: string; grants: GrantRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/agent-grants/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Access could not be revoked. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="space-y-3">
        {grants.map((grant) => (
          <li key={grant.id}>
            <Card>
              <CardBody className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-ink">{grant.clientName}</p>
                  <p className="text-xs text-ink-muted">
                    {grant.person} · connected {new Date(grant.createdAt).toLocaleDateString()} ·{' '}
                    {grant.lastUsedAt
                      ? `last used ${new Date(grant.lastUsedAt).toLocaleString()}`
                      : 'not used yet'}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {grant.scopes.map((scope) => (
                      <Badge key={scope} tone="info">
                        {SCOPE_LABEL[scope] ?? scope}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void revoke(grant.id)}
                  loading={busy === grant.id}
                  loadingLabel="Revoking"
                  disabled={busy !== null}
                >
                  Revoke access
                </Button>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
