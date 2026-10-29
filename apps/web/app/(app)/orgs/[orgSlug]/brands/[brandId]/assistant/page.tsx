import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ orgSlug: string; brandId: string }>;
}

/**
 * Moved to the AI Assistant section (`/assistant/{brandId}`), which is where a
 * feature of its own belongs. Kept so a bookmark or an old link still lands.
 */
export default async function LegacyBrandAssistantPage({ params }: PageProps) {
  const { orgSlug, brandId } = await params;
  redirect(`/orgs/${encodeURIComponent(orgSlug)}/assistant/${encodeURIComponent(brandId)}`);
}
