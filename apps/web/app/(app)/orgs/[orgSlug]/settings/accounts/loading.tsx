import { Loading, PageHeader } from '@orbit/ui';

export default function AccountsLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Connected accounts" description="Checking your connections…" />
      <Loading className="mt-8" label="Loading connected accounts" rows={4} />
    </main>
  );
}
