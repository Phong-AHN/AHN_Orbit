'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Textarea } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * A client's comment.
 *
 * There is no visibility control here, and there should not be: everything a
 * client writes is client-visible by definition. The server forces it (T1.10)
 * and refuses a body that tries to say otherwise, so offering a choice would be
 * offering one that does not exist.
 */
export function CommentBox({ postId }: { postId: string }) {
  const router = useRouter();
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/portal/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: trimmed }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const envelope =
          payload && typeof payload === 'object' && 'error' in payload
            ? (payload as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      setBody('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That comment could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor="portal-comment" className="sr-only">
        Add a comment
      </label>
      <Textarea
        id="portal-comment"
        rows={2}
        value={body}
        disabled={busy}
        placeholder="Add a note for the team…"
        onChange={(e) => {
          setBody(e.target.value);
        }}
      />

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={busy || body.trim().length === 0}
        onClick={() => void submit()}
      >
        Send
      </Button>
    </div>
  );
}
