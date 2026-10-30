import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_STAGES,
  APPROVAL_STATES,
  MEDIA_KINDS,
  POST_STATUSES,
  SOCIAL_COMMENT_STATES,
} from '@orbit/core';
import {
  createPostSchema,
  updatePostSchema,
  updateVariantSchema,
} from '@/features/posts/contracts';
import {
  createIdeaSchema,
  generateIdeasSchema,
  updateIdeaSchema,
} from '@/features/ideas/contracts';
import { createCommentSchema } from '@/features/approvals/contracts';
import { scheduleSchema } from '@/features/scheduling/contracts';
import { messageReplySchema } from '@/features/messaging/contracts';
import { replySchema } from '@/features/community/contracts';
import { createReportSchema } from '@/features/reports/contracts';
import {
  adaptRequestSchema,
  captionRequestSchema,
  explainRequestSchema,
  researchRequestSchema,
  hashtagRequestSchema,
  rewriteRequestSchema,
} from '@/features/ai/contracts';
import type { RouteCall } from './dispatch';
import type { AgentTool, PreparedAction } from './types';

/**
 * The agent tool catalogue (D-109, docs/AGENT-MCP-PLAN.md §4).
 *
 * Every tool is a thin wrapper over one tenant API route: same contract, same
 * permission check, same response a person would get. Inputs reuse the route's
 * own zod schema wherever one exists, so a tool cannot accept anything the API
 * would refuse. What this file adds is the description for the model, the tier,
 * and — for outward actions — the summary the user confirms.
 */

const id = z.string().uuid();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'An ISO date, e.g. 2026-11-01');

function tool<I>(definition: AgentTool<I>): AgentTool<I> {
  return definition;
}

// ── Summaries for confirmation ─────────────────────────────────────────────────

interface PostView {
  title?: string | null;
  body?: string | null;
  status?: string;
  scheduledFor?: string | null;
  variants?: Array<{ platform?: string; socialAccount?: { name?: string | null } | null }>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The post as the person confirming should see it: its words and where it goes. */
async function describePost(call: RouteCall, postId: string): Promise<string> {
  const { post } = await call.get<{ post: PostView }>('post', { postId });
  const name = post.title?.trim() || clip(post.body?.trim() || '(no text)', 60);
  const targets = (post.variants ?? [])
    .map((v) => [v.platform, v.socialAccount?.name].filter(Boolean).join(' '))
    .filter(Boolean);
  return [
    `Post “${name}” (currently ${post.status ?? 'unknown'})`,
    targets.length > 0 ? `Accounts: ${targets.join(', ')}` : 'Accounts: none selected',
    post.body ? `Text: ${clip(post.body, 600)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function prepared(summary: string, request: PreparedAction['request']): PreparedAction {
  return { summary, request };
}

// ── Context ────────────────────────────────────────────────────────────────────

const context = [
  tool({
    name: 'list_workspaces_and_brands',
    title: 'List workspaces and brands',
    description:
      'Lists the client workspaces and their brands you can work in. Start here: every other tool takes a workspaceId and/or brandId from this list.',
    tier: 'R',
    scope: 'read',
    permission: 'workspace:read',
    input: z.object({}),
    run: async (_input, call) => {
      const { workspaces } = await call.get<{ workspaces: Array<{ id: string; name: string }> }>(
        'workspaces',
      );
      return {
        workspaces: await Promise.all(
          workspaces.map(async (workspace) => ({
            ...workspace,
            brands: (
              await call
                .get<{ brands: unknown[] }>('workspaceBrands', { workspaceId: workspace.id })
                .catch(() => ({ brands: [] }))
            ).brands,
          })),
        ),
      };
    },
  }),
  tool({
    name: 'get_brand_brain',
    title: 'Read a brand’s voice',
    description:
      'Reads the Brand Brain: description, audience, voice, tone, preferred and banned terms, CTAs. Read it before writing anything for a brand.',
    tier: 'R',
    scope: 'read',
    permission: 'brand_voice:read',
    input: z.object({ brandId: id }),
    run: ({ brandId }, call) => call.get('brandVoice', { brandId }),
  }),
  tool({
    name: 'list_social_accounts',
    title: 'List connected accounts',
    description:
      'Lists connected social accounts (Facebook Pages, Instagram, TikTok, YouTube, Pinterest…) with their health. A post targets accounts by these ids. Accounts that need reconnecting can only be fixed by a person in Social Square.',
    tier: 'R',
    scope: 'read',
    permission: 'social_account:read',
    input: z.object({ workspaceId: id.optional(), brandId: id.optional() }),
    run: (query, call) => call.get('socialAccounts', {}, query),
  }),
];

// ── Ideas ──────────────────────────────────────────────────────────────────────

const ideas = [
  tool({
    name: 'list_ideas',
    title: 'List content ideas',
    description: 'Lists saved content ideas, optionally for one brand, state or search text.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      q: z.string().max(200).optional(),
      state: z.enum(['SUGGESTED', 'ACCEPTED', 'DISMISSED', 'CONVERTED']).optional(),
    }),
    run: (query, call) => call.get('ideas', {}, query),
  }),
  tool({
    name: 'create_idea',
    title: 'Save a content idea',
    description: 'Saves one content idea for a brand. Nothing is published.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:create',
    input: createIdeaSchema,
    run: (body, call) => call.send('ideas', 'POST', {}, { body }),
  }),
  tool({
    name: 'update_idea',
    title: 'Edit a content idea',
    description: 'Edits an idea, or accepts or dismisses it.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:update',
    input: z.object({ ideaId: id, changes: updateIdeaSchema }),
    run: ({ ideaId, changes }, call) => call.send('idea', 'PATCH', { ideaId }, { body: changes }),
  }),
  tool({
    name: 'generate_ideas',
    title: 'Generate content ideas',
    description:
      'Asks the AI for up to 20 post ideas for a brand, grounded on its Brand Brain and its best-performing posts of the last 90 days, and saves them as SUGGESTED ideas with a reason each. Optionally pass researchNotes from research_topic. Spends one AI credit. Nothing is published.',
    tier: 'AI',
    scope: 'content',
    permission: 'post:create',
    input: generateIdeasSchema,
    run: (body, call) => call.send('ideasGenerate', 'POST', {}, { body }),
  }),
  tool({
    name: 'research_topic',
    title: 'Research a topic on the web',
    description:
      'Searches the web (Google Search) and returns a short summary with its sources. Use it for trends, events, competitors or facts to build content on. Only the question is sent. Spends one AI credit. Cite the sources to the user; never present a claim without one.',
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    untrustedOutput: true,
    input: researchRequestSchema,
    run: (body, call) => call.send('aiResearch', 'POST', {}, { body }),
  }),
  tool({
    name: 'convert_idea_to_post',
    title: 'Turn an idea into a draft',
    description:
      'Creates a draft post from an idea. The draft still needs accounts, review and scheduling.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:create',
    input: z.object({ ideaId: id }),
    run: ({ ideaId }, call) => call.send('ideaConvert', 'POST', { ideaId }),
  }),
];

// ── Content ────────────────────────────────────────────────────────────────────

const content = [
  tool({
    name: 'list_posts',
    title: 'List posts',
    description: `Lists posts, optionally for one workspace, brand or status (${POST_STATUSES.join(', ')}).`,
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      status: z.enum(POST_STATUSES).optional(),
    }),
    run: (query, call) => call.get('posts', {}, query),
  }),
  tool({
    name: 'get_post',
    title: 'Read a post',
    description: 'Reads one post with its per-account variants, media and status.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({ postId: id }),
    run: ({ postId }, call) => call.get('post', { postId }),
  }),
  tool({
    name: 'create_post_draft',
    title: 'Create a draft post',
    description:
      'Creates a DRAFT post for a brand, targeting the given account ids. Nothing is published or scheduled. Call validate_post afterwards to check platform rules.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:create',
    input: createPostSchema,
    run: (body, call) => call.send('posts', 'POST', {}, { body }),
  }),
  tool({
    name: 'update_post',
    title: 'Edit a draft post',
    description:
      'Edits a post’s shared text, link, hashtags, media or target accounts. Approved and scheduled posts are locked; they must be reopened by a person first.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:update',
    input: z.object({ postId: id, changes: updatePostSchema }),
    run: ({ postId, changes }, call) => call.send('post', 'PATCH', { postId }, { body: changes }),
  }),
  tool({
    name: 'update_variant',
    title: 'Edit one account’s version',
    description:
      'Overrides the text, media or platform options for one account (e.g. a shorter Instagram caption, YouTube madeForKids, a Pinterest boardId).',
    tier: 'W1',
    scope: 'content',
    permission: 'post:update',
    input: z.object({ postId: id, variantId: id, changes: updateVariantSchema }),
    run: ({ postId, variantId, changes }, call) =>
      call.send('variant', 'PATCH', { postId, variantId }, { body: changes }),
  }),
  tool({
    name: 'validate_post',
    title: 'Check a post against platform rules',
    description:
      'Checks every variant against its platform’s limits and requirements, and lists problems.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({ postId: id }),
    run: ({ postId }, call) => call.send('postValidate', 'POST', { postId }),
  }),
  tool({
    name: 'duplicate_post',
    title: 'Duplicate a post',
    description: 'Copies a post into a new draft.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:create',
    input: z.object({ postId: id }),
    run: ({ postId }, call) => call.send('postDuplicate', 'POST', { postId }),
  }),
  tool({
    name: 'search_media',
    title: 'Search the media library',
    description: 'Searches a brand’s uploaded images and videos, to attach to a post by id.',
    tier: 'R',
    scope: 'read',
    permission: 'media:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      kind: z.enum(MEDIA_KINDS).optional(),
      q: z.string().max(200).optional(),
    }),
    run: (query, call) => call.get('media', {}, query),
  }),
  tool({
    name: 'add_internal_comment',
    title: 'Comment on a post internally',
    description:
      'Leaves a comment on a post for the agency team. Clients never see internal comments.',
    tier: 'W1',
    scope: 'content',
    permission: 'comment:create',
    input: z.object({
      postId: id,
      body: createCommentSchema.shape.body,
      postVariantId: createCommentSchema.shape.postVariantId,
    }),
    run: ({ postId, ...body }, call) =>
      call.send('postComments', 'POST', { postId }, { body: { ...body, visibility: 'INTERNAL' } }),
  }),
  tool({
    name: 'generate_caption',
    title: 'Write a caption',
    description:
      'Writes a caption in the brand’s voice. Spends one AI credit. Returns text only; nothing is saved.',
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    input: captionRequestSchema,
    run: (body, call) => call.send('aiCaption', 'POST', {}, { body }),
  }),
  tool({
    name: 'rewrite_text',
    title: 'Rewrite text',
    description: 'Shortens, expands, rephrases or changes the tone of text. Spends one AI credit.',
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    input: rewriteRequestSchema,
    run: (body, call) => call.send('aiRewrite', 'POST', {}, { body }),
  }),
  tool({
    name: 'generate_hashtags',
    title: 'Suggest hashtags',
    description: 'Suggests hashtags for a text. Spends one AI credit.',
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    input: hashtagRequestSchema,
    run: (body, call) => call.send('aiHashtags', 'POST', {}, { body }),
  }),
  tool({
    name: 'adapt_for_platform',
    title: 'Adapt text for another platform',
    description:
      'Adapts existing text for a different platform’s length and conventions. Spends one AI credit.',
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    input: adaptRequestSchema,
    run: (body, call) => call.send('aiRepurpose', 'POST', {}, { body }),
  }),
  tool({
    name: 'get_ai_usage',
    title: 'AI credits used',
    description: 'How many AI credits the organization has used this month, and its limit.',
    tier: 'R',
    scope: 'read',
    permission: 'ai:view_usage',
    input: z.object({}),
    run: (_input, call) => call.get('aiUsage'),
  }),
];

// ── Workflow, calendar, publishing ─────────────────────────────────────────────

const workflow = [
  tool({
    name: 'submit_for_internal_review',
    title: 'Send to internal review',
    description: 'Moves a DRAFT to INTERNAL_REVIEW so a reviewer at the agency can approve it.',
    tier: 'W1',
    scope: 'content',
    permission: 'post:submit_internal_review',
    input: z.object({ postId: id, comment: z.string().trim().max(2000).optional() }),
    run: ({ postId, comment }, call) =>
      call.send('postTransition', 'POST', { postId }, { body: { to: 'INTERNAL_REVIEW', comment } }),
  }),
  tool({
    name: 'list_approvals',
    title: 'List approvals',
    description: 'Lists approval requests waiting on the agency or the client.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      stage: z.enum(APPROVAL_STAGES).optional(),
      state: z.enum(APPROVAL_STATES).optional(),
    }),
    run: (query, call) => call.get('approvals', {}, query),
  }),
  tool({
    name: 'get_calendar',
    title: 'Read the calendar',
    description: 'Lists scheduled and published posts between two dates.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({
      from: isoDay,
      to: isoDay,
      workspaceId: id.optional(),
      brandId: id.optional(),
      socialAccountId: id.optional(),
      timeZone: z.string().max(64).optional(),
    }),
    run: (query, call) => call.get('calendar', {}, query),
  }),
  tool({
    name: 'list_queue_slots',
    title: 'List posting slots',
    description: 'Lists the recurring posting times configured for a workspace.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({ workspaceId: id }),
    run: (query, call) => call.get('queueSlots', {}, query),
  }),
  tool({
    name: 'suggest_posting_times',
    title: 'Best times to post',
    description:
      'The weekday-and-hour slots where each account’s posts got the most interactions over the last 90 days, computed from real analytics (no AI). Accounts with too few measured posts return NOT_ENOUGH_DATA — then use list_queue_slots instead and say so.',
    tier: 'R',
    scope: 'read',
    permission: 'analytics:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      socialAccountId: id.optional(),
      timeZone: z.string().max(64).optional(),
    }),
    run: (query, call) => call.get('analyticsBestTimes', {}, query),
  }),
  tool({
    name: 'get_publishing_status',
    title: 'Publishing status',
    description:
      'Shows, per account, whether a post published, failed (and why) or is still in progress.',
    tier: 'R',
    scope: 'read',
    permission: 'post:read',
    input: z.object({ postId: id }),
    run: ({ postId }, call) => call.get('postPublishing', { postId }),
  }),
  tool({
    name: 'submit_for_client_review',
    title: 'Send to the client for approval',
    description:
      'Sends an internally approved post to the client. The client is notified. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:submit_client_review',
    input: z.object({ postId: id, comment: z.string().trim().max(2000).optional() }),
    prepare: async ({ postId, comment }, call) =>
      prepared(
        `Send to the client for approval (the client is notified).\n${await describePost(call, postId)}`,
        {
          route: 'postTransition',
          method: 'POST',
          params: { postId },
          body: { to: 'CLIENT_REVIEW', ...(comment ? { comment } : {}) },
        },
      ),
  }),
  tool({
    name: 'decide_approval',
    title: 'Approve or request changes',
    description:
      'Records the user’s own approval decision on an approval request. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:approve_internal',
    input: z.object({
      approvalId: id,
      decision: z.enum(APPROVAL_DECISIONS),
      comment: z.string().trim().max(4000).optional(),
    }),
    prepare: async ({ approvalId, decision, comment }) =>
      prepared(
        `Record your decision “${decision}” on approval request ${approvalId}.${comment ? `\nComment: ${clip(comment, 600)}` : ''}`,
        {
          route: 'approvalDecide',
          method: 'POST',
          params: { approvalId },
          // Never on someone else’s behalf: an agent records only its user’s own decision.
          body: { decision, ...(comment ? { comment } : {}), onBehalfOf: false },
        },
      ),
  }),
  tool({
    name: 'schedule_post',
    title: 'Schedule a post',
    description:
      'Schedules an APPROVED post at a wall-clock time in the workspace’s time zone (localTime, e.g. "2026-11-06T19:00"), or in the next queue slot. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:schedule',
    input: z.object({
      postId: id,
      localTime: z.string().max(32).optional(),
      useNextQueueSlot: z.boolean().optional(),
    }),
    prepare: async ({ postId, ...when }, call) => {
      const body = scheduleSchema.parse(when);
      const at = body.useNextQueueSlot
        ? 'in the next queue slot'
        : `at ${body.localTime} (workspace time)`;
      return prepared(`Schedule ${at}.\n${await describePost(call, postId)}`, {
        route: 'postSchedule',
        method: 'POST',
        params: { postId },
        body,
      });
    },
  }),
  tool({
    name: 'reschedule_post',
    title: 'Move a scheduled post',
    description: 'Moves a SCHEDULED post to another time. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:reschedule',
    input: z.object({ postId: id, localTime: z.string().max(32) }),
    prepare: async ({ postId, localTime }, call) => {
      const body = scheduleSchema.parse({ localTime });
      return prepared(
        `Move to ${localTime} (workspace time).\n${await describePost(call, postId)}`,
        {
          route: 'postSchedule',
          method: 'PATCH',
          params: { postId },
          body,
        },
      );
    },
  }),
  tool({
    name: 'cancel_schedule',
    title: 'Take a post off the schedule',
    description:
      'Unschedules a SCHEDULED post; it goes back to APPROVED. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:cancel_scheduled',
    input: z.object({ postId: id }),
    prepare: async ({ postId }, call) =>
      prepared(`Take off the schedule.\n${await describePost(call, postId)}`, {
        route: 'postSchedule',
        method: 'DELETE',
        params: { postId },
      }),
  }),
  tool({
    name: 'publish_now',
    title: 'Publish now',
    description:
      'Publishes an APPROVED post to its accounts immediately. Cannot be undone from Social Square. Always requires the user’s confirmation inside Social Square.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:publish_now',
    input: z.object({ postId: id }),
    prepare: async ({ postId }, call) =>
      prepared(`PUBLISH NOW — this goes live immediately.\n${await describePost(call, postId)}`, {
        route: 'postPublishNow',
        method: 'POST',
        params: { postId },
      }),
  }),
  tool({
    name: 'retry_failed_publish',
    title: 'Retry a failed publish',
    description:
      'Retries the accounts a post failed to publish to. Requires the user’s confirmation.',
    tier: 'W2',
    scope: 'workflow',
    permission: 'post:retry_failed',
    input: z.object({ postId: id }),
    prepare: async ({ postId }, call) =>
      prepared(
        `Retry publishing to the accounts that failed.\n${await describePost(call, postId)}`,
        {
          route: 'postRetry',
          method: 'POST',
          params: { postId },
        },
      ),
  }),
  tool({
    name: 'get_action_status',
    title: 'Status of a prepared action',
    description:
      'Whether an action you prepared was confirmed and ran (EXECUTED), failed (with the reason), was rejected, or expired. Use it after the user says they confirmed.',
    tier: 'R',
    scope: 'read',
    permission: null,
    input: z.object({ actionId: id }),
    run: ({ actionId }, call) => call.get('agentAction', { actionId }),
  }),
  tool({
    name: 'list_my_tasks',
    title: 'My tasks',
    description: 'Lists the production tasks assigned to the user.',
    tier: 'R',
    scope: 'read',
    permission: 'task:read',
    input: z.object({}),
    run: (_input, call) => call.get('myTasks'),
  }),
];

// ── Inbox and comments ─────────────────────────────────────────────────────────

const engagement = [
  tool({
    name: 'list_conversations',
    title: 'List private conversations',
    description:
      'Lists Messenger and Instagram conversations. By default only those waiting for a reply; view "all" for every one.',
    tier: 'R',
    scope: 'engagement',
    permission: 'message:read',
    untrustedOutput: true,
    input: z.object({ view: z.enum(['waiting', 'all']).optional() }),
    run: (query, call) => call.get('conversations', {}, query),
  }),
  tool({
    name: 'get_conversation',
    title: 'Read a conversation',
    description: 'Reads the messages of one conversation, and whether a reply can still be sent.',
    tier: 'R',
    scope: 'engagement',
    permission: 'message:read',
    untrustedOutput: true,
    input: z.object({ conversationId: id }),
    run: ({ conversationId }, call) => call.get('conversation', { conversationId }),
  }),
  tool({
    name: 'suggest_message_reply',
    title: 'Draft a reply to a message',
    description:
      'Drafts a reply from the brand’s assistant documents. Nothing is sent. Spends one AI credit. May answer that a person should handle it.',
    tier: 'AI',
    scope: 'engagement',
    permission: 'message:reply',
    untrustedOutput: true,
    input: z.object({ conversationId: id }),
    run: ({ conversationId }, call) => call.send('conversationSuggest', 'POST', { conversationId }),
  }),
  tool({
    name: 'reply_to_conversation',
    title: 'Send a private reply',
    description:
      'Sends a private message reply as the brand. Requires the user’s confirmation of the exact text.',
    tier: 'W2',
    scope: 'engagement',
    permission: 'message:reply',
    input: z.object({ conversationId: id, text: messageReplySchema.shape.text }),
    prepare: async ({ conversationId, text }, call) => {
      // Proves the conversation exists here before anything is shown.
      await call.get('conversation', { conversationId });
      return prepared(
        `Send this private reply as the brand (conversation ${conversationId}):\n${text}`,
        {
          route: 'conversationReply',
          method: 'POST',
          params: { conversationId },
          body: { text },
        },
      );
    },
  }),
  tool({
    name: 'set_conversation_handled',
    title: 'Mark a conversation handled',
    description: 'Marks a conversation as dealt with, or puts it back in the queue.',
    tier: 'W1',
    scope: 'engagement',
    permission: 'message:reply',
    input: z.object({ conversationId: id, handled: z.boolean() }),
    run: ({ conversationId, handled }, call) =>
      call.send('conversationHandled', 'POST', { conversationId }, { body: { handled } }),
  }),
  tool({
    name: 'list_comments',
    title: 'List audience comments',
    description: 'Lists public comments on published posts, by default only the audience’s.',
    tier: 'R',
    scope: 'engagement',
    permission: 'comment:read_public',
    untrustedOutput: true,
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      socialAccountId: id.optional(),
      state: z.enum(SOCIAL_COMMENT_STATES).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: (query, call) => call.get('comments', {}, query),
  }),
  tool({
    name: 'suggest_comment_reply',
    title: 'Draft a reply to a comment',
    description:
      'Drafts a public reply to an audience comment from the brand’s assistant documents. Nothing is sent. Spends one AI credit when the model is asked. May answer that a person should handle it (complaints, anything the documents do not cover).',
    tier: 'AI',
    scope: 'engagement',
    permission: 'comment:reply',
    untrustedOutput: true,
    input: z.object({ commentId: id }),
    run: ({ commentId }, call) => call.send('commentSuggest', 'POST', { commentId }),
  }),
  tool({
    name: 'reply_to_comment',
    title: 'Reply to a comment in public',
    description:
      'Replies publicly to a comment as the brand. Requires the user’s confirmation of the exact text.',
    tier: 'W2',
    scope: 'engagement',
    permission: 'comment:reply',
    input: z.object({ commentId: id, message: replySchema.shape.message }),
    prepare: async ({ commentId, message }) =>
      prepared(`Reply IN PUBLIC as the brand to comment ${commentId}:\n${message}`, {
        route: 'commentReply',
        method: 'POST',
        params: { commentId },
        body: { message },
      }),
  }),
  tool({
    name: 'set_comment_handled',
    title: 'Mark a comment handled',
    description: 'Marks a comment as dealt with, or puts it back in the queue.',
    tier: 'W1',
    scope: 'engagement',
    permission: 'comment:reply',
    input: z.object({ commentId: id, handled: z.boolean() }),
    run: ({ commentId, handled }, call) =>
      call.send('commentHandled', 'POST', { commentId }, { body: { handled } }),
  }),
];

// ── Analytics and reports ──────────────────────────────────────────────────────

const analyticsNote =
  'A null metric means the platform has not reported it (not synced, not available, or not permitted) — never zero. Say so rather than reporting 0.';

const analytics = [
  tool({
    name: 'get_analytics_overview',
    title: 'Analytics overview',
    description: `Totals and trends across accounts for a date range (default: last 30 days). ${analyticsNote}`,
    tier: 'R',
    scope: 'read',
    permission: 'analytics:read',
    input: z.object({ workspaceId: id.optional(), from: isoDay.optional(), to: isoDay.optional() }),
    run: (query, call) => call.get('analyticsOverview', {}, query),
  }),
  tool({
    name: 'list_post_analytics',
    title: 'Per-post analytics',
    description: `Metrics per published post for a date range, to find what performed best. ${analyticsNote}`,
    tier: 'R',
    scope: 'read',
    permission: 'analytics:read',
    input: z.object({
      workspaceId: id.optional(),
      brandId: id.optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: (query, call) => call.get('analyticsPosts', {}, query),
  }),
  tool({
    name: 'get_account_analytics',
    title: 'One account’s analytics',
    description: `Follower and engagement history for one connected account. ${analyticsNote}`,
    tier: 'R',
    scope: 'read',
    permission: 'analytics:read',
    input: z.object({
      accountId: id,
      workspaceId: id.optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    run: ({ accountId, ...query }, call) => call.get('analyticsAccount', { accountId }, query),
  }),
  tool({
    name: 'explain_performance',
    title: 'Explain a period’s performance',
    description: `Figures for a brand over a period (from/to as YYYY-MM-DD) against the period before, plus a short plain-language reading. The reading is dropped (explanation: null, explanationRefused: true) if it contained any number not in the figures — then summarise the figures yourself without computing new numbers. Spends one AI credit. ${'A null figure means not reported, never zero.'}`,
    tier: 'AI',
    scope: 'content',
    permission: 'ai:generate',
    input: explainRequestSchema,
    run: (body, call) => call.send('analyticsExplain', 'POST', {}, { body }),
  }),
  tool({
    name: 'get_dashboard_summary',
    title: 'Today at a glance',
    description:
      'What needs attention: approvals waiting, failures, unanswered messages, upcoming posts.',
    tier: 'R',
    scope: 'read',
    permission: 'org:read',
    input: z.object({}),
    run: (_input, call) => call.get('dashboard'),
  }),
  tool({
    name: 'create_report',
    title: 'Generate a report',
    description:
      'Starts generating a performance report (CSV) in the background. Check it with get_report.',
    tier: 'W1',
    scope: 'content',
    permission: 'report:generate',
    input: createReportSchema,
    run: (body, call) => call.send('reports', 'POST', {}, { body }),
  }),
  tool({
    name: 'get_report',
    title: 'Report status',
    description: 'Whether a report is ready.',
    tier: 'R',
    // The route checks report:generate, which only the content scope covers.
    scope: 'content',
    permission: 'report:generate',
    input: z.object({ reportId: id }),
    run: ({ reportId }, call) => call.get('report', { reportId }),
  }),
  tool({
    name: 'get_report_download_link',
    title: 'Report download link',
    description: 'A short-lived link to download a finished report.',
    tier: 'R',
    scope: 'read',
    permission: 'report:export',
    input: z.object({ reportId: id }),
    run: ({ reportId }, call) => call.get('reportDownload', { reportId }),
  }),
];

export const AGENT_TOOLS: readonly AgentTool<never>[] = [
  ...context,
  ...ideas,
  ...content,
  ...workflow,
  ...engagement,
  ...analytics,
] as unknown as readonly AgentTool<never>[];
