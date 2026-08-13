import { Loading, PageHeader } from '@orbit/ui';

export default function ApprovalsLoading() {
  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader title="Approvals" description="Loading what's waiting…" />
      <Loading className="mt-8" label="Loading the approval queue" rows={4} />
    </main>
  );
}
