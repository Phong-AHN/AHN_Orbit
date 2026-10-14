import { Loading, PageHeader } from '@orbit/ui';

export default function DashboardLoading() {
  return (
    <main id="main" className="mx-auto max-w-content-wide px-4 sm:px-6 py-10">
      <PageHeader title="Today" description="Checking what needs attention…" />
      <Loading className="mt-8" label="Loading the dashboard" rows={5} />
    </main>
  );
}
