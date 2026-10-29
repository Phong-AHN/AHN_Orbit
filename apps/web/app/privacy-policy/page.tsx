import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Public privacy policy.
 *
 * Sits at the top level rather than inside a route group: it must render for
 * someone with no session, no organization and no cookie — Meta's App Review
 * fetches it anonymously, and a policy behind a login is the same as no policy.
 *
 * Everything below describes what the code actually does. Where a claim maps to
 * a mechanism, the mechanism is named, so this stays checkable against
 * docs/SECURITY.md rather than drifting into the usual boilerplate that is
 * technically unfalsifiable.
 */

// ── The two facts this file cannot know ─────────────────────────────────────
// Both are legal identity, not engineering. Set them before submitting to Meta
// App Review; a reviewer will read this page and both are visible on it.
const OPERATOR = 'AHN Group';
const CONTACT_EMAIL = 'phong@ahnmedia.com';

const LAST_UPDATED = '26 October 2026';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: `How ${OPERATOR} collects, uses and protects data in Social Square.`,
  // The rest of the app is noindex while it is pre-launch. A privacy policy is
  // a public document and there is no reason to hide it.
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">
          Social Square
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">Privacy policy</h1>
        <p className="mt-2 text-sm text-ink-muted">Last updated {LAST_UPDATED}</p>
      </header>

      <div className="space-y-10">
        <Section title="Who this covers">
          <P>
            Social Square is a tool that social media agencies use to plan, review, schedule and
            publish content on behalf of their clients. It is operated by {OPERATOR}.
          </P>
          <P>Two kinds of people have accounts, and they see deliberately different things:</P>
          <List>
            <li>
              <Strong>Agency staff</Strong> — the people who create and publish content.
            </li>
            <li>
              <Strong>Client reviewers</Strong> — people at the client company who are invited to
              approve or comment on content for their own workspace, and who cannot see other
              clients, internal notes, or the identities of individual agency staff.
            </li>
          </List>
          <P>
            A third group is not an account holder and never signs in:{' '}
            <Strong>people who comment on a published post</Strong>. Social Square reads those
            comments back so an agency can answer them, which means it holds something they wrote in
            public. What is kept, and what is deliberately not, is set out under{' '}
            <Strong>Comments from the public</Strong> below.
          </P>
          <P>
            A fourth group, where an agency has switched private messages on:{' '}
            <Strong>people who send a private message</Strong> to a client&rsquo;s connected
            Facebook Page or Instagram account. Social Square shows those conversations to the
            agency so it can answer them; see <Strong>Private messages</Strong> below.
          </P>
          <P>
            Beyond those comments and messages we collect nothing about the audience who sees a
            published post. Social Square sends a post to a social platform; what happens after that
            is governed by that platform&rsquo;s own privacy policy.
          </P>
        </Section>

        <Section title="What we collect">
          <List>
            <li>
              <Strong>Account identity</Strong> — your email address, display name and profile
              picture, received from Google when you sign in. We never receive or store your
              password.
            </li>
            <li>
              <Strong>Content you create</Strong> — posts, captions, comments, approval decisions,
              uploaded images and video, and the schedule you set.
            </li>
            <li>
              <Strong>Organization data</Strong> — your agency, its client workspaces and brands,
              and who has which role.
            </li>
            <li>
              <Strong>Connected social accounts</Strong> — see the next section.
            </li>
            <li>
              <Strong>An audit trail</Strong> — who did what and when, for actions that change
              content, permissions or connected accounts. This exists so that a client can be shown
              exactly what was approved and by whom.
            </li>
            <li>
              <Strong>Comments from the public</Strong> — the text of a comment left on a post
              Social Square published, the public display name shown beside it, the platform&rsquo;s
              own id for the comment and when it was posted. No identifier for the person is stored;
              see the section below.
            </li>
            <li>
              <Strong>Private messages</Strong> — where an agency has switched them on, the messages
              people send to a connected Page or Instagram account and the replies sent back, with
              the identifier the platform gives that person for that one account. See{' '}
              <Strong>Private messages</Strong> below.
            </li>
            <li>
              <Strong>Operational logs</Strong> — request timing, error codes and a correlation id.
              Access tokens, secrets and authorization headers are stripped by key name at every
              depth before anything is written.
            </li>
          </List>
          <P>
            There is no advertising, no behavioural profiling, and we do not sell or share your data
            with anyone for their own purposes. The only third-party script we load is
            Facebook&rsquo;s own login SDK, and only on the page where you connect a Page — see
            below.
          </P>
        </Section>

        <Section title="Facebook and Meta data">
          <P>
            When you connect a Facebook Page, you authorize the connection with Facebook directly.
            On that one page we load Facebook&rsquo;s login SDK from{' '}
            <Code>connect.facebook.net</Code>, which sets its own cookies and is subject to
            Meta&rsquo;s privacy policy. It is not loaded anywhere else in the application, and we
            do not use its analytics features.
          </P>
          <P>To publish to a Facebook Page we ask for these permissions and no others:</P>
          <List>
            <li>
              <Code>pages_show_list</Code> — to show you which Pages you administer, so you can pick
              the right one.
            </li>
            <li>
              <Code>pages_read_engagement</Code> — to read back how posts published through AHN
              Social Square performed.
            </li>
            <li>
              <Code>pages_manage_posts</Code> — to publish the posts you schedule.
            </li>
          </List>
          <P>
            Connecting an <Strong>Instagram</Strong> professional account uses the same Facebook
            sign-in, because an Instagram account is reached through the Page it is linked to. That
            asks for <Code>instagram_basic</Code> and <Code>instagram_content_publish</Code> in
            addition to <Code>business_management</Code>, <Code>pages_show_list</Code> and{' '}
            <Code>pages_read_engagement</Code> — enough to list your accounts, publish the posts you
            schedule, and read back how they performed. We store the account id, username, display
            name and profile picture, and nothing about your followers or the people who interact
            with your posts.
          </P>
          <P>
            From that authorization we store the Page id, the Page name and handle, the Page profile
            picture, and an access token for that Page. We store no personal Facebook profile
            information and no friend lists. The only data we hold about people who interact with
            your Pages is the public comments and, where messages are switched on, the private
            conversations described below.
          </P>
          <P>
            Where an agency switches private messages on, connecting also asks for{' '}
            <Code>pages_messaging</Code> (to read and answer a Page&rsquo;s conversations),{' '}
            <Code>pages_manage_metadata</Code> (so Facebook tells us when a message arrives), and,
            for an Instagram account connected with an Instagram login,{' '}
            <Code>instagram_business_manage_messages</Code>.
          </P>
          <P>
            The access token is encrypted at rest with AES-256-GCM, bound cryptographically to the
            organization and the account it belongs to, so a credential row copied elsewhere cannot
            be decrypted. It is decrypted only in memory, in the process that publishes, and is
            never written to a log, returned by an API or placed in a queue message.
          </P>
          <P>
            You can disconnect a Page at any time from Settings → Connected accounts, which deletes
            the stored token. You can also revoke access from Facebook directly, under Settings →
            Business integrations.
          </P>
        </Section>

        <Section title="Comments from the public">
          <P>
            An agency that publishes for a client is usually expected to answer the comments that
            arrive. So Social Square reads comments back from the platforms on posts it published,
            shows them to the agency in one place, and lets the agency reply — the reply is posted
            to the platform under the client&rsquo;s own account, exactly as if it had been written
            there.
          </P>
          <P>
            The person who wrote a comment has no relationship with us and did not agree to
            anything, so the collection is kept to the minimum that makes answering possible:
          </P>
          <List>
            <li>
              <Strong>What is stored</Strong> — the comment text, the public display name the
              platform shows beside it, the platform&rsquo;s id for the comment, when it was posted,
              and its public link.
            </li>
            <li>
              <Strong>What is not stored</Strong> — any identifier for the person. Not their
              platform user id, not a profile link, not a picture, not an email. Social Square
              cannot group one person&rsquo;s comments together, recognise them on another post, or
              build any profile of them, because it has nothing to key one on. The database has no
              column for it.
            </li>
          </List>
          <P>
            This applies only to posts published through Social Square. A post made directly on the
            platform is not read, and comments on it are never collected.
          </P>
          <P>
            A comment is public at the moment it is written, and deleting it on the platform does
            not reach into our copy automatically. To have a comment removed from Social Square, or
            to ask what is held, write to <Mail /> — the agency that published the post can also
            delete it, and anyone may ask us directly.
          </P>
        </Section>

        <Section title="Private messages">
          <P>
            Many of a brand&rsquo;s customers ask their questions in a private message rather than a
            comment. Where an agency has switched this on, Social Square shows the private
            conversations of a client&rsquo;s connected Facebook Page or Instagram account in one
            inbox, and lets the agency answer — the reply is sent under the client&rsquo;s own
            account, exactly as if it had been written there.
          </P>
          <List>
            <li>
              <Strong>What is stored</Strong> — the messages in the conversation, in both
              directions; links to any photo or file the platform attached (the files themselves are
              not downloaded); the name and username the platform shows for the person; and the
              identifier the platform gives that person for that one account.
            </li>
            <li>
              <Strong>Why the identifier</Strong> — a reply to a private message is addressed to a
              person, and without it nothing can be sent. Facebook and Instagram issue a different
              identifier for each account a person writes to, so it identifies nobody outside that
              one conversation, and Social Square cannot link the same person across different
              clients.
            </li>
            <li>
              <Strong>What the brand can do</Strong> — only answer. The platforms allow a business
              to reply for a limited time after the person last wrote, and never to message somebody
              first; Social Square enforces the same rule.
            </li>
            <li>
              <Strong>How long it is kept</Strong> — while the account stays connected, and never
              more than twelve months. Disconnecting the account deletes its conversations. A
              message the person unsends is erased from Social Square as soon as the platform tells
              us.
            </li>
            <li>
              <Strong>Automatic replies</Strong> — an agency may switch on an AI assistant for a
              brand. It drafts answers for staff, or, where the agency allows it, answers on its own
              when nobody is available — using only information the brand has written down. Every
              message it sends ends with &ldquo;Phản hồi tự động từ AI Assistant&rdquo; (an
              automatic reply from the AI assistant). It never handles complaints, refunds,
              payments, orders, accounts, legal or safety matters, or personal details: those, and
              anything it cannot answer from the brand&rsquo;s information, are passed to a person,
              and the customer is told so. Anyone can ask it to stop by replying &ldquo;stop&rdquo;
              or &ldquo;dừng&rdquo;.
            </li>
            <li>
              <Strong>What the assistant sends to Google</Strong> — to write an answer, the recent
              messages of that one conversation and the brand&rsquo;s written information are sent
              to Google&rsquo;s Gemini API. Phone numbers, card and ID numbers, codes and email
              addresses are removed first. Social Square does not send the person&rsquo;s name or
              identifier. On Google&rsquo;s free tier, Google&rsquo;s terms allow it to use that
              content to improve its products; on paid tiers they do not.
            </li>
          </List>
          <P>
            Social Square never uses messages for advertising, profiling or training machine
            learning models, and they are never shown in the client portal. They are visible only to
            the agency staff working on that client. To ask what is held about you, or to have a
            conversation deleted, write to <Mail />.
          </P>
        </Section>

        <Section title="How we use it">
          <P>
            Only to run the product you are using: to sign you in, to show you your own
            organization&rsquo;s content, to route approvals to the right people, to publish at the
            time you scheduled, to report back what happened, and to keep the audit trail that makes
            approvals meaningful.
          </P>
          <P>
            We do not sell data, we do not share it with advertisers, and we do not use your content
            to train machine learning models.
          </P>
        </Section>

        <Section title="Where it is stored, and who else handles it">
          <P>
            Social Square runs on infrastructure operated by the following providers. Each processes
            data only to provide its service to us.
          </P>
          <Processors />
          <P>
            Data is stored in Singapore, Australia and the United States depending on the service,
            as listed above.
          </P>
        </Section>

        <Section title="How it is protected">
          <List>
            <li>
              Every tenant&rsquo;s data is isolated by two independent mechanisms: a database client
              that scopes every query to one organization, and row-level security in the database
              itself, so a bug in one layer is not sufficient to cross the boundary.
            </li>
            <li>
              Social account credentials are encrypted at rest and bound to their tenant, as
              described above.
            </li>
            <li>
              Uploaded media is verified by inspecting the actual bytes, not the filename or the
              declared type, and is served through short-lived signed links (15 minutes) issued only
              after a permission check.
            </li>
            <li>
              The session cookie is <Code>HttpOnly</Code>, <Code>SameSite=Lax</Code> and{' '}
              <Code>Secure</Code>, so it cannot be read by scripts in the page.
            </li>
            <li>
              Error messages returned to a browser carry a safe summary and a correlation id, never
              a stack trace or a database message.
            </li>
          </List>
        </Section>

        <Section title="How long we keep it">
          <List>
            <li>
              <Strong>Account and content data</Strong> — for as long as the organization has an
              account with us.
            </li>
            <li>
              <Strong>Deleted media</Strong> — removed from storage 30 days after deletion. The
              delay exists so an accidental deletion can be reversed.
            </li>
            <li>
              <Strong>Audit records</Strong> — retained for the life of the organization&rsquo;s
              account. These are append-only by database permission: the application has no ability
              to alter or remove them, which is what makes them worth having.
            </li>
            <li>
              <Strong>Social account tokens</Strong> — deleted immediately when you disconnect the
              account.
            </li>
          </List>
        </Section>

        <Section title="Your rights, and how to delete your data">
          <P>
            You can ask us to show you the data we hold about you, correct it, export it, or delete
            it. Write to <Mail /> and we will respond within 30 days.
          </P>
          <P>Some of this you can do yourself, immediately:</P>
          <List>
            <li>Disconnect a social account — Settings → Connected accounts.</li>
            <li>
              Revoke Social Square&rsquo;s access to your Facebook Pages — Facebook Settings →
              Business integrations.
            </li>
            <li>Delete a post, a comment or an uploaded asset from inside the app.</li>
          </List>
          <P>
            To delete an entire account or organization, write to <Mail /> from the address on the
            account. We will delete the account, its workspaces, brands, posts, media and connected
            account credentials. Audit records that name an action you took are retained where we
            are required to keep a record of what was approved and published; these are minimised to
            the action, the timestamp and the actor.
          </P>
        </Section>

        <Section title="Cookies">
          <P>
            One cookie of our own: <Code>__orbit_session</Code>, which keeps you signed in for up to
            14 days. Removing it signs you out. We set no advertising or analytics cookies.
          </P>
          <P>
            Facebook&rsquo;s login SDK sets its own cookies, but only on the page where you connect
            a Page, and only if you go there. Those cookies are Meta&rsquo;s and are governed by
            their policy.
          </P>
        </Section>

        <Section title="Children">
          <P>
            Social Square is a business tool and is not directed at children. We do not knowingly
            collect data from anyone under 16.
          </P>
        </Section>

        <Section title="Changes to this policy">
          <P>
            If we change how data is handled in a way that affects you, we will update this page and
            change the date at the top. Material changes will also be announced in the application.
          </P>
        </Section>

        <Section title="Contact">
          <P>
            Questions, requests or complaints about privacy: <Mail />.
          </P>
        </Section>
      </div>

      <footer className="mt-14 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-sm">
        <Link href="/terms-of-service" className="text-ink-muted hover:underline">
          Terms of service
        </Link>
        <Link href="/data-deletion" className="text-ink-muted hover:underline">
          Data deletion
        </Link>
        <Link href="/" className="text-ink-muted hover:underline">
          Back to Social Square
        </Link>
      </footer>
    </main>
  );
}

// ── Presentation ────────────────────────────────────────────────────────────

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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-xs text-ink">
      {children}
    </span>
  );
}

function Mail() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:underline">
      {CONTACT_EMAIL}
    </a>
  );
}

const PROCESSORS = [
  { name: 'Google Firebase Authentication', purpose: 'Sign-in', region: 'United States' },
  { name: 'Supabase (PostgreSQL)', purpose: 'Application database', region: 'Singapore' },
  { name: 'Amazon Web Services S3', purpose: 'Uploaded images and video', region: 'Australia' },
  { name: 'Redis Cloud', purpose: 'Scheduling queue', region: 'Singapore' },
  { name: 'Vercel', purpose: 'Application hosting', region: 'United States' },
  { name: 'Meta Platforms', purpose: 'Publishing to Facebook Pages', region: 'United States' },
  {
    name: 'Google Gemini API',
    purpose: 'AI writing suggestions and, where switched on, automatic message replies',
    region: 'United States',
  },
];

function Processors() {
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-sunken text-left text-xs text-ink-muted">
            <th scope="col" className="px-4 py-2 font-medium">
              Provider
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Purpose
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Region
            </th>
          </tr>
        </thead>
        <tbody>
          {PROCESSORS.map((processor) => (
            <tr key={processor.name} className="border-b border-line last:border-0">
              <td className="px-4 py-2 text-ink">{processor.name}</td>
              <td className="px-4 py-2 text-ink-secondary">{processor.purpose}</td>
              <td className="px-4 py-2 text-ink-secondary">{processor.region}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
