import type { Metadata } from 'next';
import Link from 'next/link';
import { SignInPanel } from '@/features/auth/ui/sign-in-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Client sign-in' };

/**
 * The client entrance.
 *
 * Exists so an agency can send a client a link that reads as the client's own,
 * rather than one that announces a product they are not using. The wording
 * stays on their side of the relationship: reviewing and approving their
 * content, not "organizations" and "workspaces".
 *
 * `entrance="portal"` matters for exactly one shape of person — somebody who is
 * agency staff in one organization *and* a client in another. Without the hint
 * they land in the agency surface, because that is where they have more to do;
 * with it they reach the portal, which is what they just asked for.
 */
export default function ClientSignInPage() {
  return (
    <SignInPanel
      entrance="portal"
      eyebrow="Client portal"
      title="Review your content"
      description="Sign in to see what is waiting for your approval, what is scheduled, and what has gone out."
      footer={
        <>
          Part of the agency team?{' '}
          <Link href="/sign-in" className="font-medium text-accent hover:underline">
            Sign in here
          </Link>
          .
        </>
      }
    />
  );
}
