import { Loading, PageHeader } from '@orbit/ui';

export default function CalendarLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Calendar" description="Loading what's scheduled…" />
      <Loading className="mt-8" label="Loading the calendar" rows={6} />
    </main>
  );
}
