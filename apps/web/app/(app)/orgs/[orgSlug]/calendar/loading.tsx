import { Loading, PageHeader } from '@orbit/ui';

export default function CalendarLoading() {
  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader title="Calendar" description="Loading what's scheduled…" />
      <Loading className="mt-8" label="Loading the calendar" rows={6} />
    </main>
  );
}
