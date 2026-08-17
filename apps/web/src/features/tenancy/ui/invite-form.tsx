'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Select } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Inviting somebody to the organization.
 *
 * The invitation endpoint returns the token **once**, to the inviter, because
 * only its hash is stored — so this shows the link and says plainly that it will
 * not be shown again. That design predates email delivery and is the reason the
 * product is usable without it (docs/DECISIONS.md, D-034).
 *
 * A CLIENT must be given workspaces, and the form insists: a client with no
 * workspace can sign in and see nothing at all, which reads as a broken
 * invitation rather than an incomplete one.
 */

export interface InviteFormWorkspace {
  id: string;
  name: string;
}

export interface InviteFormProps {
  orgSlug: string;
  workspaces: InviteFormWorkspace[];
}

const ROLES = [
  { value: 'ACCOUNT_MANAGER', label: 'Account manager', hint: 'Runs their clients end to end.' },
  { value: 'CONTENT_CREATOR', label: 'Content creator', hint: 'Writes and submits for review.' },
  { value: 'APPROVER', label: 'Approver', hint: 'Approves internally; does not publish.' },
  { value: 'CLIENT', label: 'Client', hint: 'Reviews their own content in the portal.' },
  { value: 'ADMIN', label: 'Admin', hint: 'Everything except billing and ownership.' },
] as const;

export function InviteForm({ orgSlug, workspaces }: InviteFormProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<string>('CONTENT_CREATOR');
  const [workspaceIds, setWorkspaceIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<string | null>(null);

  const needsWorkspace = role === 'CLIENT';
  const blocked = needsWorkspace && workspaceIds.length === 0;

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Invite someone
      </Button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { token } = await apiRequest<{ token: string }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/invitations`,
        {
          method: 'POST',
          body: JSON.stringify({ email: email.trim().toLowerCase(), role, workspaceIds }),
        },
      );

      setLink(`${window.location.origin}/accept-invitation?token=${encodeURIComponent(token)}`);
      setEmail('');
      setWorkspaceIds([]);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The invitation could not be created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
      </CardHeader>

      <CardBody className="space-y-4">
        {link ? (
          <div className="space-y-2 rounded border border-accent/30 bg-accent/5 p-3">
            <p className="text-sm font-medium text-ink">Send them this link</p>
            <Input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
            <p className="text-xs text-ink-muted">
              Shown once. Only a hash is stored, so nobody — including us — can show it again; if it
              is lost, invite them a second time.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setLink(null);
                setOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void submit(e)}>
            <Field label="Email" htmlFor="invite-email" required>
              <Input
                id="invite-email"
                type="email"
                autoFocus
                value={email}
                disabled={busy}
                placeholder="name@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>

            <Field
              label="Role"
              htmlFor="invite-role"
              required
              hint={ROLES.find((option) => option.value === role)?.hint}
            >
              <Select
                id="invite-role"
                value={role}
                disabled={busy}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium text-ink">
                Client workspaces
                {needsWorkspace ? <span className="ml-0.5 text-danger">*</span> : null}
              </legend>

              {workspaces.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No workspaces yet. A client needs one before they can be invited.
                </p>
              ) : (
                workspaces.map((workspace) => (
                  <label
                    key={workspace.id}
                    className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={workspaceIds.includes(workspace.id)}
                      disabled={busy}
                      onChange={(event) =>
                        setWorkspaceIds((current) =>
                          event.target.checked
                            ? [...current, workspace.id]
                            : current.filter((id) => id !== workspace.id),
                        )
                      }
                    />
                    {workspace.name}
                  </label>
                ))
              )}

              <p className="text-xs text-ink-muted">
                {needsWorkspace
                  ? 'A client sees only the workspaces named here — and nothing else in the organization.'
                  : 'Optional for agency roles; leave empty to grant access through their role instead.'}
              </p>
            </fieldset>

            {error ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {error}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                loading={busy}
                disabled={busy || email.trim().length === 0 || blocked}
              >
                Create invitation
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
