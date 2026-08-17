import type { Metadata } from 'next';
import Link from 'next/link';
import { accessibleWorkspaceIds, clock, isUserPrincipal } from '@orbit/core';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listCalendar } from '@/features/scheduling/service';
import { Calendar, CalendarList } from '@/features/scheduling/ui/calendar';
import { CalendarWeek } from '@/features/scheduling/ui/calendar-week';
import type { CalendarPost } from '@/features/scheduling/ui/calendar-shared';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Calendar' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  values: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = values[key];
  return Array.isArray(value) ? value[0] : value;
}

/** `YYYY-MM` for the month being shown, defaulting to the current one. */
function resolveMonth(requested: string | undefined, timeZone: string): string {
  if (requested && /^\d{4}-\d{2}$/.test(requested)) return requested;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(clock.now());

  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The calendar (SRS §12).
 *
 * The **display** zone comes from the viewer's profile; what each post is
 * scheduled for was settled in the workspace's zone and stored in UTC
 * (assumption C5). The two are deliberately different concerns, and the chips
 * show both whenever they disagree.
 */
export default async function CalendarPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const { ctx, organization, user } = await requirePageContext(orgSlug);

  const workspaceId = readParam(query, 'workspaceId');
  const brandId = readParam(query, 'brandId');

  if (
    !pageCan(ctx, 'post:read', {
      ...(workspaceId ? { workspaceId } : {}),
      ...(brandId ? { brandId } : {}),
    })
  ) {
    return (
      <main id="main" className="mx-auto max-w-6xl px-6 py-10">
        <PermissionDenied action="see the calendar" />
      </main>
    );
  }

  const viewerTimeZone = user.timezone || organization.timezone || 'UTC';
  const month = resolveMonth(readParam(query, 'month'), viewerTimeZone);
  const requested = readParam(query, 'view');
  const view: 'month' | 'week' | 'list' =
    requested === 'list' ? 'list' : requested === 'week' ? 'week' : 'month';

  // Week is anchored on a Monday, taken from the URL or from today. Month
  // navigation still drives the window, so switching views keeps your place.
  const weekStart = resolveWeekStart(readParam(query, 'week'), month, viewerTimeZone);

  const [year, monthNumber] = month.split('-').map(Number);
  // A month grid shows six weeks, so the window is padded either side rather
  // than clipped to the calendar month — otherwise the leading and trailing
  // squares would always look empty.
  const from = new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1));
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(Date.UTC(year ?? 1970, monthNumber ?? 1, 1));
  to.setUTCDate(to.getUTCDate() + 7);

  const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';

  const rows = await listCalendar(ctx, {
    from: { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() },
    to: { year: to.getUTCFullYear(), month: to.getUTCMonth() + 1, day: to.getUTCDate() },
    timeZone: viewerTimeZone,
    ...(workspaceId ? { workspaceId } : {}),
    ...(brandId ? { brandId } : {}),
    ...(isClient ? { statuses: CLIENT_VISIBLE_STATUSES } : {}),
    accessibleWorkspaces: accessibleWorkspaceIds(ctx),
  });

  const posts: CalendarPost[] = rows.map((post) => ({
    id: post.id,
    title: post.title,
    body: post.body,
    status: post.status,
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    timezone: post.timezone,
    variants: post.variants.map((variant) => ({
      id: variant.id,
      platform: variant.platform,
      status: variant.status,
      accountName: variant.socialAccount.displayName,
    })),
  }));

  // Dragging is a reschedule, so the affordance follows the right — the API
  // re-checks it per post regardless of what the calendar renders.
  const canReschedule = pageCan(ctx, 'post:reschedule', {
    ...(workspaceId ? { workspaceId } : {}),
    intent: 'TRANSITION',
  });

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Calendar"
        description={`Times shown in ${viewerTimeZone.replace(/_/g, ' ')}.`}
      />

      <nav className="mt-6 flex flex-wrap items-center gap-2" aria-label="Calendar controls">
        <MonthLink orgSlug={orgSlug} month={shiftMonth(month, -1)} view={view} label="← Previous" />
        <span className="px-2 text-sm font-medium text-ink">{monthLabel(month)}</span>
        <MonthLink orgSlug={orgSlug} month={shiftMonth(month, 1)} view={view} label="Next →" />

        <span className="ml-auto flex gap-1.5">
          <ViewLink orgSlug={orgSlug} month={month} view="month" active={view === 'month'} />
          <ViewLink orgSlug={orgSlug} month={month} view="week" active={view === 'week'} />
          <ViewLink orgSlug={orgSlug} month={month} view="list" active={view === 'list'} />
        </span>
      </nav>

      <div className="mt-6">
        {view === 'list' ? (
          <CalendarList posts={posts} orgSlug={orgSlug} viewerTimeZone={viewerTimeZone} />
        ) : view === 'week' ? (
          <CalendarWeek
            orgSlug={orgSlug}
            posts={posts}
            weekStart={weekStart}
            viewerTimeZone={viewerTimeZone}
            todayKey={new Intl.DateTimeFormat('en-CA', { timeZone: viewerTimeZone }).format(
              clock.now(),
            )}
            canReschedule={canReschedule}
          />
        ) : (
          <Calendar
            orgSlug={orgSlug}
            posts={posts}
            month={`${month}-01`}
            viewerTimeZone={viewerTimeZone}
            canReschedule={canReschedule}
          />
        )}
      </div>
    </main>
  );
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)));
}

function MonthLink({
  orgSlug,
  month,
  view,
  label,
}: {
  orgSlug: string;
  month: string;
  view: string;
  label: string;
}) {
  return (
    <Link
      href={`/orgs/${orgSlug}/calendar?month=${month}&view=${view}`}
      className="rounded px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
    >
      {label}
    </Link>
  );
}

function ViewLink({
  orgSlug,
  month,
  view,
  active,
}: {
  orgSlug: string;
  month: string;
  view: 'month' | 'week' | 'list';
  active: boolean;
}) {
  return (
    <Link
      href={`/orgs/${orgSlug}/calendar?month=${month}&view=${view}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-full px-3 py-1.5 text-sm capitalize transition-colors',
        active ? 'bg-accent text-accent-ink' : 'bg-surface-sunken text-ink-muted hover:text-ink',
      )}
    >
      {view}
    </Link>
  );
}

/**
 * The Monday anchoring the week view.
 *
 * Taken from `?week=` when present, otherwise from today if today falls inside
 * the month being browsed, otherwise the first Monday of that month — so
 * switching from month to week lands somewhere related to what you were looking
 * at rather than snapping back to this week.
 */
function resolveWeekStart(requested: string | undefined, month: string, timeZone: string): string {
  if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;

  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone }).format(clock.now());
  const anchor = todayKey.startsWith(month) ? todayKey : `${month}-01`;

  const [year, monthNumber, day] = anchor.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, day ?? 1, 12));

  // Monday = 0.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
