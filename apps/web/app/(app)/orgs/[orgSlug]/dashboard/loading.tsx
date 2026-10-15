import { Loading, PageHeader } from '@orbit/ui';

export default function DashboardLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Today" description="Checking what needs attention…" />
      <Loading className="mt-8" label="Loading the dashboard" rows={5} />
    </main>
  );
}
