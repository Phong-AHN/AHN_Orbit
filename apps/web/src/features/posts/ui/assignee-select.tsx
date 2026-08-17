'use client';

import * as React from 'react';
import { Field, Select } from '@orbit/ui';
import { ApiError, postsApi } from './api';

/**
 * Who owns this post.
 *
 * `POST /posts/{id}/assign` has existed since T1.9 with no way to reach it, so
 * every post in the product was unowned. Assignment is what turns a queue of
 * drafts into somebody's work — and it is the field the dashboard and the task
 * list both read from.
 *
 * Saved immediately rather than behind a button: there is one field, and a
 * "save" for a single dropdown is a step that exists only to be forgotten.
 */

export interface AssigneeOption {
  id: string;
  name: string | null;
  email: string;
}

export interface AssigneeSelectProps {
  orgSlug: string;
  postId: string;
  assignedToId: string | null;
  members: AssigneeOption[];
  disabled?: boolean;
}

export function AssigneeSelect({
  orgSlug,
  postId,
  assignedToId,
  members,
  disabled,
}: AssigneeSelectProps) {
  const api = React.useMemo(() => postsApi(orgSlug), [orgSlug]);
  const [value, setValue] = React.useState(assignedToId ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function choose(next: string) {
    const previous = value;
    setValue(next);
    setBusy(true);
    setError(null);

    try {
      await api.assign(postId, next || null);
    } catch (e) {
      // Put the field back: showing a name that was not saved is worse than
      // showing the old one with an error beside it.
      setValue(previous);
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field
      label="Owner"
      htmlFor={`assignee-${postId}`}
      hint="Who is responsible for getting this out."
      {...(error ? { error } : {})}
    >
      <Select
        id={`assignee-${postId}`}
        value={value}
        disabled={disabled || busy}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">Nobody yet</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name ?? member.email}
          </option>
        ))}
      </Select>
    </Field>
  );
}
