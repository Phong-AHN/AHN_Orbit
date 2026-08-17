'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Breadcrumbs,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  useToast,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Folders, above the grid (SRS §12).
 *
 * A bar rather than a sidebar: a library is browsed by narrowing, and a
 * permanent tree competes for the width the photographs need. The breadcrumb
 * answers "where am I", the chips answer "where can I go", and both collapse to
 * nothing at the root — which is where most agencies will stay for a while.
 *
 * **Deleting says what will happen to the contents**, because the surprising
 * thing about this feature is that nothing is lost. A dialog that only asked
 * "are you sure?" would leave somebody assuming the worst and not pressing it.
 */

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  assetCount: number;
  childCount: number;
}

export interface FolderBarProps {
  orgSlug: string;
  workspaceId: string;
  /** Every folder in this workspace; the bar picks the level it needs. */
  folders: Folder[];
  /** `null` at the workspace root. */
  currentId: string | null;
  path: Array<{ id: string; name: string }>;
  canManage: boolean;
  /** Selected assets, if any — enables filing them here. */
  selectedAssetIds: readonly string[];
  onMoved: () => void;
}

export function FolderBar({
  orgSlug,
  workspaceId,
  folders,
  currentId,
  path,
  canManage,
  selectedAssetIds,
  onMoved,
}: FolderBarProps) {
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Folder | null>(null);
  const [deleting, setDeleting] = React.useState<Folder | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/media`;
  const children = folders.filter((folder) => folder.parentId === currentId);
  const current = folders.find((folder) => folder.id === currentId) ?? null;

  function go(folderId: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (folderId) params.set('folderId', folderId);
    else params.delete('folderId');
    params.set('workspaceId', workspaceId);

    router.replace(`/orgs/${orgSlug}/media?${params.toString()}`);
  }

  async function call(path: string, init: RequestInit, message: string) {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(path, init);
      toast.show(message);
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be done.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function fileHere(folderId: string | null) {
    const { moved } = await apiRequest<{ moved: number }>(`${base}/move`, {
      method: 'POST',
      body: JSON.stringify({ assetIds: [...selectedAssetIds], folderId }),
    }).catch(() => ({ moved: 0 }));

    if (moved === 0) {
      setError('Nothing moved — those files belong to a different client.');
      return;
    }

    toast.show(moved === 1 ? 'Filed.' : `${moved} files filed.`);
    onMoved();
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Breadcrumbs
          items={[
            { label: 'All files', href: `/orgs/${orgSlug}/media?workspaceId=${workspaceId}` },
            ...path.map((entry) => ({
              label: entry.name,
              href: `/orgs/${orgSlug}/media?workspaceId=${workspaceId}&folderId=${entry.id}`,
            })),
          ]}
        />

        <div className="ml-auto flex flex-wrap gap-2">
          {selectedAssetIds.length > 0 ? (
            <Button size="sm" disabled={busy} onClick={() => void fileHere(currentId)}>
              File {selectedAssetIds.length} here
            </Button>
          ) : null}

          {canManage ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setCreating(true)}>
              New folder
            </Button>
          ) : null}

          {canManage && current ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setRenaming(current)}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setDeleting(current)}
              >
                Delete folder
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {children.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {children.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => go(folder.id)}
                className="inline-flex items-center gap-1.5 rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span aria-hidden="true">📁</span>
                {folder.name}
                {folder.assetCount > 0 ? <Badge tone="neutral">{folder.assetCount}</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <CreateFolder
        open={creating}
        busy={busy}
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          const ok = await call(
            `${base}/folders`,
            {
              method: 'POST',
              body: JSON.stringify({
                workspaceId,
                name,
                ...(currentId ? { parentId: currentId } : {}),
              }),
            },
            'Folder created.',
          );
          if (ok) setCreating(false);
        }}
      />

      <RenameFolder
        folder={renaming}
        busy={busy}
        onClose={() => setRenaming(null)}
        onSubmit={async (name) => {
          if (!renaming) return;
          const ok = await call(
            `${base}/folders/${renaming.id}`,
            { method: 'PATCH', body: JSON.stringify({ name }) },
            'Renamed.',
          );
          if (ok) setRenaming(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;

          const ok = await call(
            `${base}/folders/${deleting.id}`,
            { method: 'DELETE' },
            'Folder removed. Nothing was deleted.',
          );

          if (ok) {
            setDeleting(null);
            // Standing inside a folder that no longer exists would be a dead
            // page; step up to where its contents went.
            go(deleting.parentId);
          }
        }}
        title={`Remove “${deleting?.name}”?`}
        description="The folder goes. Nothing inside it is deleted."
        confirmLabel="Remove folder"
      >
        <p className="text-sm text-ink-secondary">
          {deleting && (deleting.assetCount > 0 || deleting.childCount > 0)
            ? `${describeContents(deleting)} will move up a level, not be deleted. A folder is only a label.`
            : 'This folder is empty.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}

function describeContents(folder: Folder): string {
  const parts: string[] = [];
  if (folder.assetCount > 0) {
    parts.push(`${folder.assetCount} ${folder.assetCount === 1 ? 'file' : 'files'}`);
  }
  if (folder.childCount > 0) {
    parts.push(`${folder.childCount} ${folder.childCount === 1 ? 'folder' : 'folders'}`);
  }
  return parts.join(' and ');
}

function CreateFolder({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = React.useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New folder"
      description="Folders are shared across every brand for this client."
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={busy || name.trim().length === 0}
            onClick={() => void onSubmit(name.trim())}
          >
            Create
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="folder-name" required>
        <Input
          id="folder-name"
          autoFocus
          value={name}
          disabled={busy}
          placeholder="Spring campaign"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}

function RenameFolder({
  folder,
  busy,
  onClose,
  onSubmit,
}: {
  folder: Folder | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    setName(folder?.name ?? '');
  }, [folder]);

  return (
    <Dialog
      open={folder !== null}
      onClose={onClose}
      title="Rename folder"
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={busy || name.trim().length === 0}
            onClick={() => void onSubmit(name.trim())}
          >
            Rename
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="folder-rename" required>
        <Input
          id="folder-rename"
          autoFocus
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}
