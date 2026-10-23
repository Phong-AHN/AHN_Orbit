'use client';

import * as React from 'react';
import { Badge, Button, Field, Textarea, cn } from '@orbit/ui';
import { compactAge } from '@/features/community/thread';
import { attachmentsOf, participantLabel, windowLabel, type WindowView } from '../inbox';
import { useMessageActions } from './use-message-actions';

/**
 * One private conversation, drawn as a chat (**D-107**).
 *
 * The person on the left, the brand on the right — the convention both
 * Messenger and Instagram use, so somebody who answers messages there all day
 * reads this without thinking. Like the comment thread, it follows the
 * platforms' conventions and copies none of their branding.
 *
 * The composer shows the reply deadline before anybody types. A conversation
 * the platform no longer lets the brand answer has no composer at all, and
 * says why, rather than accepting a reply the server must refuse.
 */

export interface ThreadMessageView {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string | null;
  attachments: unknown;
  sentAt: string;
  deletedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
}

export interface ConversationThreadProps {
  orgSlug: string;
  renderedAt: string;
  canReply: boolean;
  members: ReadonlyArray<{ id: string; name: string | null; email: string }>;
  conversation: {
    id: string;
    state: 'NEW' | 'HANDLED';
    participantName: string | null;
    participantUsername: string | null;
    assignedTo: { id: string; name: string | null; email: string } | null;
    account: { displayName: string; platform: string; avatarUrl: string | null };
  };
  messages: ThreadMessageView[];
  window: WindowView;
  needsReconnect: boolean;
  maxMessageLength: number | null;
}

export function ConversationThread(props: ConversationThreadProps) {
  const { orgSlug, conversation, messages, canReply, members } = props;
  const now = React.useMemo(() => new Date(props.renderedAt), [props.renderedAt]);
  const actions = useMessageActions(orgSlug, conversation.id);
  const [draft, setDraft] = React.useState('');

  const person = participantLabel(conversation);
  const deadline = windowLabel(props.window, now);
  const closed = props.window.state === 'CLOSED';
  const tooLong = props.maxMessageLength !== null && draft.length > props.maxMessageLength;

  async function send() {
    const text = draft.trim();
    if (!text) return;
    // Cleared only on success: a failed send keeps the words.
    if (await actions.reply(text)) setDraft('');
  }

  return (
    <section
      aria-label={`Conversation with ${person}`}
      className="flex min-h-[28rem] flex-col rounded-lg border border-line bg-surface"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{person}</h2>
          <p className="truncate text-xs text-ink-muted">
            To {conversation.account.displayName} ·{' '}
            {conversation.account.platform.charAt(0) +
              conversation.account.platform.slice(1).toLowerCase()}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {conversation.state === 'NEW' ? (
            <Badge tone="warning">Needs a reply</Badge>
          ) : (
            <Badge tone="success">Handled</Badge>
          )}

          {canReply ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={actions.busy}
                onClick={() => void actions.setHandled(conversation.state !== 'HANDLED')}
              >
                {conversation.state === 'HANDLED' ? 'Reopen' : 'Mark handled'}
              </Button>

              {members.length > 0 ? (
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  Assign
                  <select
                    value={conversation.assignedTo?.id ?? ''}
                    disabled={actions.busy}
                    onChange={(event) => void actions.assign(event.target.value || null)}
                    className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink"
                  >
                    <option value="">Nobody</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name ?? member.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <ol className="flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-label="Messages">
        {messages.length === 0 ? (
          <li className="py-8 text-center text-sm text-ink-muted">No messages yet.</li>
        ) : (
          messages.map((message) => <Bubble key={message.id} message={message} now={now} />)
        )}
      </ol>

      <footer className="border-t border-line px-4 py-3">
        {actions.error ? (
          <p role="alert" className="mb-2 text-sm font-medium text-danger">
            {actions.error}
          </p>
        ) : null}

        {props.needsReconnect ? (
          <p className="text-sm text-ink-secondary">
            {conversation.account.displayName} was connected before messages were switched on.
            Reconnect it under Settings → Accounts to reply from Orbit.
          </p>
        ) : !canReply ? (
          <p className="text-sm text-ink-muted">You can read this conversation but not reply.</p>
        ) : closed ? (
          <p className="text-sm text-ink-secondary">
            {deadline.text}. The platform only lets a brand answer a person who has written
            recently.
          </p>
        ) : (
          <div className="space-y-2">
            <Field
              label={`Reply to ${person}`}
              htmlFor={`message-${conversation.id}`}
              hint={deadline.text}
            >
              <Textarea
                id={`message-${conversation.id}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder={`Message as ${conversation.account.displayName}…`}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={send}
                loading={actions.busy}
                loadingLabel="Sending"
                disabled={draft.trim().length === 0 || tooLong}
              >
                Send
              </Button>
              {props.maxMessageLength !== null ? (
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    tooLong ? 'font-medium text-danger' : 'text-ink-muted',
                  )}
                >
                  {draft.length.toLocaleString()} / {props.maxMessageLength.toLocaleString()}
                </span>
              ) : null}
              {deadline.tone !== 'neutral' ? (
                <Badge tone={deadline.tone === 'danger' ? 'danger' : 'warning'}>
                  {deadline.text}
                </Badge>
              ) : null}
            </div>
          </div>
        )}
      </footer>
    </section>
  );
}

function Bubble({ message, now }: { message: ThreadMessageView; now: Date }) {
  const ours = message.direction === 'OUTBOUND';
  const attachments = attachmentsOf(message.attachments);

  return (
    <li className={cn('flex', ours ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[80%] space-y-1', ours ? 'items-end text-right' : 'items-start')}>
        <div
          className={cn(
            'inline-block rounded-2xl px-3 py-2 text-left text-sm',
            ours ? 'bg-accent text-accent-ink' : 'bg-surface-sunken text-ink',
            message.deletedAt ? 'italic opacity-70' : null,
          )}
        >
          {message.deletedAt ? (
            'Message unsent'
          ) : (
            <>
              {message.text ? (
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
              ) : null}
              {attachments.map((attachment, index) =>
                attachment.url ? (
                  <a
                    key={index}
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block underline underline-offset-2"
                  >
                    Open {attachment.type}
                  </a>
                ) : (
                  <p key={index}>{attachment.type}</p>
                ),
              )}
              {!message.text && attachments.length === 0 ? <p>Sent a message</p> : null}
            </>
          )}
        </div>
        <p className="text-[11px] text-ink-muted">
          <time dateTime={message.sentAt}>{compactAge(message.sentAt, now)}</time>
          {ours && message.createdBy?.name ? ` · ${message.createdBy.name}` : null}
          {ours && !message.createdBy ? ' · sent outside Orbit' : null}
        </p>
      </div>
    </li>
  );
}
