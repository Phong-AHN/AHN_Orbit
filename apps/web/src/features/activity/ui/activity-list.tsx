import { Badge } from '@orbit/ui';

/**
 * The feed, rendered.
 *
 * A server component on purpose: it displays and does nothing else, so it needs
 * no client bundle. Every entry falls back to a readable sentence built from
 * the action string, which means an action added tomorrow appears here tomorrow
 * — a feed that silently omits what it does not recognise is worse than one
 * that renders it plainly.
 */

export interface ActivityEntry {
  id: string;
  action: string;
  actorType: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  createdAt: string;
  actorUser: { id: string; name: string | null; email: string } | null;
}

/** Sentences for the actions worth reading as English rather than as a slug. */
const PHRASE: Record<string, string> = {
  'post.created': 'created a post',
  'post.updated': 'edited a post',
  'post.transitioned': 'moved a post',
  'post.assigned': 'reassigned a post',
  'post.duplicated': 'duplicated a post',
  'post.deleted': 'deleted a post',
  'post.scheduled': 'scheduled a post',
  'post.rescheduled': 'rescheduled a post',
  'post.publish_now': 'sent a post to publish now',
  'post.publish_retried': 'retried publishing',
  'post.publish_settled': 'finished publishing',
  'post_variant.updated': 'edited a channel version',
  'post_variant.publish_retried': 'retried one channel',
  'post_variant.publish_resolved': 'resolved a stuck publish by hand',
  'approval.approved_on_behalf_of': 'approved on the client’s behalf',
  'comment.created': 'commented',
  'comment.updated': 'edited a comment',
  'comment.resolved': 'resolved a comment',
  'comment.deleted': 'deleted a comment',
  'task.created': 'added a production task',
  'task.updated': 'moved a production task',
  'task.deleted': 'removed a production task',
  'media.uploaded': 'uploaded media',
  'media.deleted': 'deleted media',
  'social_account.connected': 'connected a social account',
  'social_account.disconnected': 'disconnected a social account',
  'social_account.health_degraded': 'flagged an account as unhealthy',
  'social_account.health_recovered': 'restored a healthy account',
  'invitation.created': 'invited someone',
  'invitation.revoked': 'revoked an invitation',
  'invitation.accepted': 'joined the organization',
  'member.role_changed': 'changed a member’s role',
  'member.removed': 'removed a member',
  'workspace_member.removed': 'removed someone from a workspace',
  'organization.created': 'created the organization',
  'organization.updated': 'changed organization settings',
  'workspace.created': 'created a client workspace',
  'workspace.updated': 'updated a client workspace',
  'workspace.deleted': 'archived a client workspace',
  'brand.created': 'added a brand',
  'brand.updated': 'updated a brand',
  'brand.deleted': 'archived a brand',
  'admin.job_retried': 'retried a background job',
  'admin.job_discarded': 'discarded a background job',
};

export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ol className="space-y-1">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line py-2.5 last:border-0"
        >
          <span className="text-sm font-medium text-ink">{actor(entry)}</span>
          <span className="text-sm text-ink-secondary">{phrase(entry.action)}</span>

          {/* SYSTEM and WORKER rows are the ones people misread as a colleague's
              doing — the scheduler publishing at 09:00 is not somebody working
              early. Label them. */}
          {entry.actorType !== 'USER' ? (
            <Badge tone="neutral">{entry.actorType === 'WORKER' ? 'Automated' : 'System'}</Badge>
          ) : null}

          <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-muted">
            {when(entry.createdAt)}
          </span>

          {entry.reason ? <p className="w-full text-xs text-ink-muted">“{entry.reason}”</p> : null}
        </li>
      ))}
    </ol>
  );
}

function actor(entry: ActivityEntry): string {
  if (entry.actorUser) return entry.actorUser.name ?? entry.actorUser.email;
  if (entry.actorType === 'WORKER') return 'Orbit';
  if (entry.actorType === 'SYSTEM') return 'Orbit';
  // A USER row with no user is a person who has since been removed. Their
  // actions still happened, and the log says so rather than hiding the row.
  return 'A removed member';
}

/**
 * `post.publish_settled` → "finished publishing"; anything unmapped →
 * "publish settled". Never a raw slug, and never nothing.
 */
function phrase(action: string): string {
  const known = PHRASE[action];
  if (known) return known;

  const verb = action.split('.').slice(1).join(' ').replace(/_/g, ' ');
  return verb.length > 0 ? verb : action;
}

function when(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
