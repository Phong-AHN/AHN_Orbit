import { Loading, PageHeader } from '@orbit/ui';

export default function ApprovalsLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Approvals" description="Loading what's waiting…" />
      <Loading className="mt-8" label="Loading the approval queue" rows={4} />
    </main>
  );
}
