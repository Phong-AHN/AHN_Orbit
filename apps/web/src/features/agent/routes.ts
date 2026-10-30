import type { NextRequest } from 'next/server';

/**
 * The tenant API routes agent tools may call (D-109).
 *
 * A closed table rather than a path the tool builds: a stored action names a
 * key from here, so even a tampered action row can only ever replay one of
 * these handlers — each of which runs `withAuth`, with its own permission and
 * resource check, exactly as for a browser.
 *
 * Loaded lazily so that listing tools does not import every route module.
 */

type Handler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface RouteModule {
  GET?: Handler;
  POST?: Handler;
  PATCH?: Handler;
  PUT?: Handler;
  DELETE?: Handler;
}

const load = (loader: () => Promise<unknown>) => loader as () => Promise<RouteModule>;

export const ROUTES = {
  workspaces: load(() => import('../../../app/api/v1/orgs/[orgSlug]/workspaces/route')),
  workspaceBrands: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/workspaces/[workspaceId]/brands/route'),
  ),
  brand: load(() => import('../../../app/api/v1/orgs/[orgSlug]/brands/[brandId]/route')),
  brandVoice: load(() => import('../../../app/api/v1/orgs/[orgSlug]/brands/[brandId]/voice/route')),
  socialAccounts: load(() => import('../../../app/api/v1/orgs/[orgSlug]/social-accounts/route')),
  ideas: load(() => import('../../../app/api/v1/orgs/[orgSlug]/content-ideas/route')),
  idea: load(() => import('../../../app/api/v1/orgs/[orgSlug]/content-ideas/[ideaId]/route')),
  ideasGenerate: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/content-ideas/generate/route'),
  ),
  ideaConvert: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/content-ideas/[ideaId]/convert/route'),
  ),
  posts: load(() => import('../../../app/api/v1/orgs/[orgSlug]/posts/route')),
  post: load(() => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/route')),
  postValidate: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/validate/route'),
  ),
  postPublishing: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/publishing/route'),
  ),
  postTransition: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/transition/route'),
  ),
  postSchedule: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/schedule/route'),
  ),
  postPublishNow: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/publish-now/route'),
  ),
  postRetry: load(() => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/retry/route')),
  postComments: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/comments/route'),
  ),
  postDuplicate: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/duplicate/route'),
  ),
  variant: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/posts/[postId]/variants/[variantId]/route'),
  ),
  approvals: load(() => import('../../../app/api/v1/orgs/[orgSlug]/approvals/route')),
  approvalDecide: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/approvals/[approvalId]/decide/route'),
  ),
  calendar: load(() => import('../../../app/api/v1/orgs/[orgSlug]/calendar/route')),
  queueSlots: load(() => import('../../../app/api/v1/orgs/[orgSlug]/queue-slots/route')),
  media: load(() => import('../../../app/api/v1/orgs/[orgSlug]/media/route')),
  mediaGenerate: load(() => import('../../../app/api/v1/orgs/[orgSlug]/media/generate/route')),
  conversations: load(() => import('../../../app/api/v1/orgs/[orgSlug]/messages/route')),
  conversation: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/messages/[conversationId]/route'),
  ),
  conversationSuggest: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/messages/[conversationId]/suggest/route'),
  ),
  conversationReply: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/messages/[conversationId]/reply/route'),
  ),
  conversationHandled: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/messages/[conversationId]/handled/route'),
  ),
  comments: load(() => import('../../../app/api/v1/orgs/[orgSlug]/community/route')),
  commentSuggest: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/community/[commentId]/suggest/route'),
  ),
  commentReply: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/community/[commentId]/reply/route'),
  ),
  commentHandled: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/community/[commentId]/handled/route'),
  ),
  analyticsOverview: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/analytics/overview/route'),
  ),
  analyticsBestTimes: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/analytics/best-times/route'),
  ),
  analyticsExplain: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/analytics/explain/route'),
  ),
  analyticsPosts: load(() => import('../../../app/api/v1/orgs/[orgSlug]/analytics/posts/route')),
  analyticsAccount: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/analytics/accounts/[accountId]/route'),
  ),
  reports: load(() => import('../../../app/api/v1/orgs/[orgSlug]/reports/route')),
  report: load(() => import('../../../app/api/v1/orgs/[orgSlug]/reports/[reportId]/route')),
  reportDownload: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/reports/[reportId]/download/route'),
  ),
  dashboard: load(() => import('../../../app/api/v1/orgs/[orgSlug]/dashboard/route')),
  myTasks: load(() => import('../../../app/api/v1/orgs/[orgSlug]/tasks/mine/route')),
  aiCaption: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/caption/route')),
  aiRewrite: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/rewrite/route')),
  aiHashtags: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/hashtags/route')),
  aiRepurpose: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/repurpose/route')),
  aiResearch: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/research/route')),
  aiUsage: load(() => import('../../../app/api/v1/orgs/[orgSlug]/ai/usage/route')),
  // Reading an action's state only. Confirming and rejecting are deliberately
  // absent: they are a person's act, never an agent's.
  agentAction: load(
    () => import('../../../app/api/v1/orgs/[orgSlug]/agent-actions/[actionId]/route'),
  ),
} as const;
