import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getBrand } from '@/features/tenancy/service';
import { getBrandVoice } from '@/features/brand-voice/service';
import { BrandVoiceForm } from '@/features/brand-voice/ui/brand-voice-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Brand' };

interface PageProps {
  params: Promise<{ orgSlug: string; brandId: string }>;
}

/**
 * One brand's settings, which for now is its Brand Brain (SRS §24).
 *
 * Reachable from the client list. The brand's own fields — name, colour, logo —
 * are edited from there already; this is the material that grounds writing,
 * which is a different job and a much longer form.
 */
export default async function BrandPage({ params }: PageProps) {
  const { orgSlug, brandId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'brand_voice:read', { brandId })) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-6 py-10">
        <PermissionDenied action="see this brand" />
      </main>
    );
  }

  // Scoped, so a brand from another tenant is simply not found.
  const brand = await getBrand(ctx, brandId);
  const voice = await getBrandVoice(ctx, brandId);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        eyebrow={`${organization.name} · ${brand.workspace.name}`}
        title={brand.name}
        description="The context every suggestion for this brand is grounded in."
      />

      <BrandVoiceForm
        orgSlug={orgSlug}
        brandId={brandId}
        brandName={brand.name}
        voice={voice}
        canEdit={pageCan(ctx, 'brand_voice:update', { brandId })}
      />

      <p className="mt-6 text-sm text-ink-muted">
        <Link href={`/orgs/${orgSlug}/settings/workspaces`} className="hover:underline">
          Back to clients
        </Link>
      </p>
    </main>
  );
}
