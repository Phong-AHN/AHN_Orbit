import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Public terms of service.
 *
 * The third of the three URLs Meta's App Dashboard asks for, alongside the
 * privacy policy and the data deletion instructions. Like those, it sits at the
 * top level rather than inside a route group: it has to render for somebody
 * with no session, no organization and no cookie, because App Review fetches it
 * anonymously and a document behind a login is the same as no document.
 *
 * ## Written against the product, not from a template
 *
 * Meta rejects "generic template language that doesn't cover the requested
 * permissions", and the generic version would also be *wrong* here. Orbit does
 * several unusual things that a reader is entitled to know before agreeing:
 * it publishes on their behalf through somebody else's API, it may stop and ask
 * rather than retry when an outcome is ambiguous (**D-027**), it refuses to
 * report analytics it could not fetch as zero, and it never lets a language
 * model write into content without a person accepting it first.
 *
 * Each of those is a real guarantee enforced in code, so each one is stated
 * here as a promise rather than disclaimed away. The same rule the privacy
 * policy follows: where a claim maps to a mechanism, name the mechanism, so
 * this stays checkable instead of unfalsifiable.
 */

// ── The facts this file cannot know ─────────────────────────────────────────
// Legal identity and jurisdiction, not engineering. All three are visible on
// the rendered page and a reviewer will read them, so they must be set before
// submitting to Meta App Review. `GOVERNING_LAW` is deliberately not guessed:
// the operating entity's seat decides it.
const OPERATOR = 'AHN Group';
const CONTACT_EMAIL = 'phong@ahnmedia.com';
const GOVERNING_LAW = 'Viet Nam';

const LAST_UPDATED = '13 October 2026';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: `The agreement between ${OPERATOR} and the agencies that use AHN Orbit.`,
  // The rest of the app is noindex while it is pre-launch. These terms are a
  // public document and there is no reason to hide them — the same decision the
  // privacy policy makes, for the same reason.
  robots: { index: true, follow: true },
};

export default function TermsOfServicePage() {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">AHN Orbit</p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">Terms of service</h1>
        <p className="mt-2 text-sm text-ink-muted">Last updated {LAST_UPDATED}</p>
      </header>

      <div className="space-y-10">
        <Section title="The agreement">
          <P>
            These terms are between {OPERATOR} (&ldquo;we&rdquo;) and the organization using AHN
            Orbit (&ldquo;you&rdquo;). Creating an organization, or signing in to one somebody
            invited you to, means accepting them.
          </P>
          <P>
            If you accept on behalf of an agency or a company, you are confirming that you have the
            authority to bind it. Orbit is a tool for businesses rather than consumers, and an
            organization&rsquo;s owner is accountable for what everyone they invite does inside it.
          </P>
        </Section>

        <Section title="What AHN Orbit does">
          <P>
            Orbit is a workspace where a social media agency plans content, has it reviewed
            internally and by its client, schedules it, and publishes it to social platforms on the
            client&rsquo;s behalf. It also reads back how published posts performed.
          </P>
          <P>
            It is not a social network, and it does not reach the audience who eventually sees a
            post. Orbit hands a post to a platform; everything after that is the platform&rsquo;s.
          </P>
        </Section>

        <Section title="Your account">
          <List>
            <li>
              You need a Google account to sign in. We never receive or store your password — see
              the{' '}
              <Link href="/privacy-policy" className="text-accent hover:underline">
                privacy policy
              </Link>
              .
            </li>
            <li>
              You must be old enough to enter a contract where you live, and at least 18. Orbit is
              not for children.
            </li>
            <li>
              Keep your sign-in secure. Anything done from a signed-in session is treated as done by
              that person, and the audit log records it that way.
            </li>
            <li>
              One person, one account. Sharing a login defeats the audit trail that the approval
              workflow depends on.
            </li>
          </List>
        </Section>

        <Section title="Your content stays yours">
          <P>
            The posts, images, video, captions, comments and client records you put into Orbit
            remain yours. We claim no ownership of them and we do not use them to train models.
          </P>
          <P>
            You grant us only the licence we need to run the service: to store your content, show it
            to the people in your organization and the client reviewers you invite, and transmit it
            to the social platforms you have told us to publish to. That licence exists so the
            product can function, and it ends when you delete the content or close the account.
          </P>
          <P>
            You are responsible for having the rights to what you upload — including images, music,
            fonts and anything featuring an identifiable person — and for your client having agreed
            to it being published.
          </P>
        </Section>

        <Section title="Connected social accounts and the platforms behind them">
          <P>
            Connecting a Facebook Page, Instagram account, TikTok account or any other channel
            authorises us to act on that account through the platform&rsquo;s API, within the
            permissions you granted at the moment you connected it, and for the purposes shown to
            you then.
          </P>
          <List>
            <li>
              <Strong>Each platform&rsquo;s own terms still apply to you.</Strong> Publishing
              through Orbit does not exempt you from Meta&rsquo;s, TikTok&rsquo;s or any other
              platform&rsquo;s rules, and you are responsible for content that breaks them.
            </li>
            <li>
              <Strong>You may disconnect at any time</Strong>, from Orbit or from the
              platform&rsquo;s own settings. Either removes our ability to publish to that account.
              What happens to the stored credential and what does not is set out on the{' '}
              <Link href="/data-deletion" className="text-accent hover:underline">
                data deletion
              </Link>{' '}
              page.
            </li>
            <li>
              <Strong>Platforms change, and we do not control them.</Strong> A platform may revoke a
              token, change an API, restrict a feature, reject content or remove a post. When that
              happens we report it to you as plainly as we can, but we cannot overrule it.
            </li>
            <li>
              <Strong>Only you may connect accounts you are entitled to.</Strong> Connecting a
              client&rsquo;s channel means you have their permission to manage it.
            </li>
          </List>
        </Section>

        <Section title="What we promise about publishing">
          <P>
            Scheduling is a commitment to attempt a post at the time you set, not a guarantee that
            the platform will accept it. These are the specific guarantees the system does make, and
            they are enforced in code rather than offered as intentions:
          </P>
          <List>
            <li>
              <Strong>We will not publish the same post twice.</Strong> Every publish passes through
              several independent checks whose job is to make a duplicate impossible, even if a job
              is retried or two processes race.
            </li>
            <li>
              <Strong>If we cannot establish what happened, we stop and tell you.</Strong> When a
              platform times out and we cannot confirm whether a post went out, we do not retry — a
              retry is how one post becomes two. The post is parked for a person to look at, and
              labelled as needing review rather than as failed, because we genuinely do not know.
            </li>
            <li>
              <Strong>We will not quietly change what you wrote.</Strong> Content is published as
              composed, apart from platform-required transformations you can see before approving.
            </li>
            <li>
              <Strong>A failure is explained, not hidden.</Strong> When a publish fails you get the
              platform&rsquo;s reason, translated into something actionable, in the publishing log.
            </li>
          </List>
        </Section>

        <Section title="Analytics">
          <P>
            Orbit reads engagement and reach figures back from the platforms. Those figures are the
            platforms&rsquo;, not ours: they can be delayed, revised, or restricted by a
            platform&rsquo;s own rules about what an app may read.
          </P>
          <P>
            <Strong>Where a figure is unavailable we say so rather than showing zero.</Strong> A
            zero is a measurement and an absence is not, and conflating them is how somebody
            concludes a campaign failed when it was simply never measured.
          </P>
        </Section>

        <Section title="AI features">
          <P>
            Orbit can draft captions, suggest ideas and rewrite a post for a particular platform.
            Two rules hold:
          </P>
          <List>
            <li>
              <Strong>Nothing a model writes becomes your content until you accept it.</Strong>{' '}
              Suggestions are presented for a person to take, edit or discard. Orbit does not write
              into a post, publish, or schedule on a model&rsquo;s initiative.
            </li>
            <li>
              <Strong>You remain the author.</Strong> Check what a model produces before it goes
              out: it can be wrong, stale, or inappropriate for the brand, and the published post is
              yours.
            </li>
          </List>
        </Section>

        <Section title="Clients and client reviewers">
          <P>
            You can invite people from a client company to review and approve content for their own
            workspace. They see that workspace and nothing else — not your other clients, not your
            internal notes, and not which member of your staff did what.
          </P>
          <P>
            Inviting somebody is your decision and your responsibility. You confirm you may share
            the content in that workspace with them, and you remain responsible for removing their
            access when the relationship ends.
          </P>
        </Section>

        <Section title="What you must not do">
          <List>
            <li>
              Publish content that is unlawful, that infringes somebody else&rsquo;s rights, or that
              breaks the rules of the platform it is going to.
            </li>
            <li>
              Use Orbit for spam, engagement farming, coordinated inauthentic behaviour, or to
              operate accounts that impersonate a person or organization.
            </li>
            <li>
              Try to reach another organization&rsquo;s data, probe for tenant boundaries, or work
              around a permission you were not granted.
            </li>
            <li>
              Extract credentials or tokens, whether yours or anyone else&rsquo;s, from the service.
            </li>
            <li>
              Resell or sublicense access, or use the service to build a competing product by
              automated extraction.
            </li>
            <li>
              Interfere with the service — load that degrades it for others, scraping, or attacks on
              the infrastructure.
            </li>
          </List>
        </Section>

        <Section title="Plans, limits and payment">
          <P>
            A subscription sets limits on workspaces, team members, connected accounts, storage and
            AI usage. Those limits are enforced when you reach them, with a message saying which one
            you hit rather than a generic failure.
          </P>
          <P>
            Fees, billing periods and any trial are whatever was agreed when you subscribed. Unless
            your agreement says otherwise, fees are charged in advance and are not refundable for a
            period already begun. If a payment fails we will tell you before access changes.
          </P>
        </Section>

        <Section title="Availability">
          <P>
            We aim to keep Orbit running and we monitor it, but we do not offer an uptime guarantee
            under these terms. The product depends on third-party platforms and infrastructure
            providers, and an outage at one of those can stop a post going out at the moment it was
            scheduled.
          </P>
          <P>
            We may change, add or remove features. Where a change removes something you rely on, we
            will give reasonable notice.
          </P>
        </Section>

        <Section title="Ending the agreement">
          <P>
            You can stop using Orbit at any time and ask us to close your organization. What is
            deleted and when is described in the{' '}
            <Link href="/privacy-policy" className="text-accent hover:underline">
              privacy policy
            </Link>
            .
          </P>
          <P>
            We may suspend or close an account that breaks these terms, that puts other customers at
            risk, or that we are required to act on by law or by a platform we depend on. Except
            where something is urgent or unlawful, we will tell you first and say why.
          </P>
          <P>
            Your content remains exportable for a reasonable period after closure so that ending the
            relationship does not mean losing your records.
          </P>
        </Section>

        <Section title="Liability">
          <P>
            Orbit is provided as it is. To the extent the law allows, we do not give implied
            warranties of merchantability or fitness for a particular purpose, and we are not liable
            for lost profits, lost audience or indirect loss.
          </P>
          <P>
            We are not responsible for a platform&rsquo;s own decisions: a rejected post, a
            suspended account, a removed page, a changed API, or an algorithm that reached fewer
            people than expected.
          </P>
          <P>
            Where liability cannot be excluded, it is limited to the fees you paid us in the twelve
            months before the claim. Nothing here limits liability that the law does not permit us
            to limit.
          </P>
        </Section>

        <Section title="Changes to these terms">
          <P>
            We may update these terms. The date at the top changes with them, and for a change that
            materially affects you we will give notice in the product or by email before it takes
            effect. Continuing to use Orbit after that means accepting the new version.
          </P>
        </Section>

        <Section title="Governing law">
          <P>
            These terms are governed by the laws of {GOVERNING_LAW}, and its courts have
            jurisdiction over any dispute. If part of these terms is unenforceable, the rest still
            applies.
          </P>
        </Section>

        <Section title="Contact">
          <P>
            Questions about these terms, or anything in them, go to <Mail />. A person reads that
            address.
          </P>
        </Section>
      </div>

      <footer className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-sm">
        <Link href="/privacy-policy" className="text-ink-muted hover:underline">
          Privacy policy
        </Link>
        <Link href="/data-deletion" className="text-ink-muted hover:underline">
          Data deletion
        </Link>
        <Link href="/" className="text-ink-muted hover:underline">
          Home
        </Link>
      </footer>
    </main>
  );
}

// ── Presentation ────────────────────────────────────────────────────────────
// Deliberately the same four helpers the privacy policy uses, rather than an
// import from it: these are two standalone legal documents, and one should not
// start rendering differently because the other was restyled.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="max-w-prose text-sm leading-relaxed text-ink-secondary">{children}</p>;
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="max-w-prose list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-secondary">
      {children}
    </ul>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-medium text-ink">{children}</strong>;
}

function Mail() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:underline">
      {CONTACT_EMAIL}
    </a>
  );
}
