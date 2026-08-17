'use client';

import * as React from 'react';
import { Empty } from '@orbit/ui';
import { FolderBar, type Folder } from './folder-bar';
import { MediaGrid, type LibraryAsset } from './media-grid';

/**
 * The library: folders above, files below (SRS §12).
 *
 * Selection lives here rather than in either child, because it is the thing
 * they share — the grid produces it and the folder bar consumes it. Keeping it
 * one level up is what lets "select three, then press File here" work without
 * either component knowing about the other.
 *
 * Folders need a workspace, and the library spans all of them. Until somebody
 * picks a client there is nothing to file *into*, so the bar is simply absent —
 * which is more honest than showing an empty folder strip that cannot be used.
 */

export interface LibraryProps {
  orgSlug: string;
  assets: LibraryAsset[];
  /** Absent until a client is chosen; folders are per workspace. */
  workspaceId: string | null;
  folders: Folder[];
  currentFolderId: string | null;
  folderPath: Array<{ id: string; name: string }>;
  canManageFolders: boolean;
  filtered: boolean;
}

export function Library({
  orgSlug,
  assets,
  workspaceId,
  folders,
  currentFolderId,
  folderPath,
  canManageFolders,
  filtered,
}: LibraryProps) {
  const [selected, setSelected] = React.useState<string[]>([]);

  // Anything filed has moved and may no longer be in view; keeping it selected
  // would leave the count claiming files that are no longer here.
  const clearSelection = React.useCallback(() => setSelected([]), []);

  return (
    <div className="space-y-4">
      {workspaceId ? (
        <FolderBar
          orgSlug={orgSlug}
          workspaceId={workspaceId}
          folders={folders}
          currentId={currentFolderId}
          path={folderPath}
          canManage={canManageFolders}
          selectedAssetIds={selected}
          onMoved={clearSelection}
        />
      ) : null}

      {assets.length === 0 ? (
        <Empty
          title={filtered ? 'Nothing matches that' : 'No media here'}
          description={
            filtered
              ? 'Try a different filename, tag, client or folder.'
              : currentFolderId
                ? 'This folder is empty. Select files elsewhere and file them here.'
                : 'Files uploaded while writing a post land here automatically.'
          }
        />
      ) : (
        <MediaGrid
          assets={assets}
          selectedIds={selected}
          {...(workspaceId
            ? {
                onToggle: (assetId: string, isSelected: boolean) =>
                  setSelected((current) =>
                    isSelected ? [...current, assetId] : current.filter((id) => id !== assetId),
                  ),
              }
            : {})}
        />
      )}
    </div>
  );
}
