import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Definition,
  Definitions,
  Item,
  LegalSection,
  LegalTitle,
  List,
  P,
} from '@/components/legal-prose';
import { getSupportEmail } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What MatchDay collects, why, who processes it, how long it is kept, and how to delete your account.',
};

/**
 * MatchDay's privacy policy.
 *
 * ── WRITTEN FROM THE SCHEMA, NOT FROM A TEMPLATE ───────────────────────────
 *
 * Every claim below was checked against the code before it was written: the
 * columns on `profiles`, the tables that hold participation, what
 * `finalize_account_deletion()` deletes and what it deliberately keeps, and the
 * one outbound call this application makes to anything that is not Supabase.
 *
 * Two things are stated plainly because the implementation makes them true and
 * a generic policy would get them wrong in opposite directions:
 *
 *   * deletion is real — the Auth identity goes, the profile is scrubbed, the
 *     photos are removed;
 *   * deletion is not total — the league keeps its record of matches that were
 *     played, with the departed person shown as "Former member".
 *
 * If the implementation changes, this page is part of the change.
 */
export default function PrivacyPage() {
  const supportEmail = getSupportEmail();

  return (
    <>
      <LegalTitle updated="20 August 2026">Privacy Policy</LegalTitle>

      <LegalSection title="In short">
        <P>
          MatchDay helps groups organise pickup matches. We collect what is needed to run a league
          — who you are, which leagues you belong to, and which matches you have signed up for. We
          do not sell your information, we do not show advertising, and we do not track you across
          other apps or websites.
        </P>
        <P>
          You can delete your account from inside the app at any time. What that removes, and what
          it deliberately leaves behind, is described under{' '}
          <Link href="#deletion" className="underline underline-offset-4">
            Deleting your account
          </Link>
          .
        </P>
      </LegalSection>

      <LegalSection title="Information you give us">
        <Definitions>
          <Definition term="Your name and email address">
            Required. Your name identifies you to other members of your leagues. Your email address
            is how you sign in and how we send match notifications by email.
          </Definition>
          <Definition term="Optional profile details">
            A phone number, gender, the positions you prefer, and whether you are willing to play in
            goal. All optional, and shown only to the administrator of a league you belong to —
            they help with picking balanced teams. You can change or clear them at any time.
          </Definition>
          <Definition term="A profile photo">
            Optional. If you add one, it helps other players recognise you on a roster or team
            sheet. See <em>Photos</em> below for how it is stored.
          </Definition>
          <Definition term="Messages you write">
            The note attached to a request to join a league, and a reason you may give when
            cancelling a spot. These are shown to that league&rsquo;s administrator.
          </Definition>
        </Definitions>
      </LegalSection>

      <LegalSection title="Information created as you use MatchDay">
        <List>
          <Item>Which leagues you belong to, your role in each, and your membership status.</Item>
          <Item>
            Requests to join a league, and whether they were approved or declined.
          </Item>
          <Item>
            Match participation: signups, waitlist positions, cancellations, team assignments and
            published team sheets.
          </Item>
          <Item>
            Attendance recorded by a league administrator after a match — for example whether you
            played, cancelled in time, or did not turn up.
          </Item>
          <Item>
            Whether you have accepted a league&rsquo;s guidelines, and when.
          </Item>
          <Item>
            Notifications sent to you, and whether you have read them.
          </Item>
          <Item>
            Notes an administrator writes about your membership. These are private to that
            league&rsquo;s administrator and are never shown to other players.
          </Item>
          <Item>
            A record of significant actions in a league — who created a match, who approved a
            request, who changed a member&rsquo;s status — kept so an administrator can see what
            happened in the league they run.
          </Item>
          <Item>Which league you last had selected, so the app opens where you left off.</Item>
        </List>
      </LegalSection>

      <LegalSection title="Photos">
        <P>
          A profile photo you upload is stored with our hosting provider and served from a web
          address containing a random identifier. That address is unguessable and is not listed
          anywhere public, but it is not secret: anyone you have shared the link with could open it
          while the photo exists. Replacing or removing your photo, or deleting your account,
          deletes the stored file.
        </P>
      </LegalSection>

      <LegalSection title="Notifications and push">
        <P>
          Every notification is kept in your MatchDay inbox. If you additionally turn on phone
          notifications for a device, your browser gives us a subscription for that device — a
          delivery address supplied by your browser vendor, along with the keys needed to encrypt
          messages to it, and a label you can set so you can tell your devices apart. We also record
          whether each delivery succeeded, so a device that has stopped working can be retired.
        </P>
        <P>
          Sending a push notification means handing an encrypted message to the push service your
          browser chose — operated by Apple, Google or Mozilla depending on the browser. We do not
          choose that service and cannot see inside their systems. You can turn phone notifications
          off for any device from Profile → Phone notifications, or in your browser&rsquo;s
          settings.
        </P>
      </LegalSection>

      <LegalSection title="Signing in">
        <P>
          Authentication is handled by Supabase Auth. You can sign in with a password or with a
          one-time code sent to your email address. We never see or store your password — it is
          held by Supabase in hashed form, and MatchDay has no way to read it.
        </P>
        <P>
          Staying signed in uses a session cookie set by your browser. It exists only to keep you
          signed in and to keep your session current; it is not used for advertising or analytics,
          and it is cleared when you sign out.
        </P>
      </LegalSection>

      <LegalSection title="Why we use this information">
        <List>
          <Item>To run the product: sign-in, leagues, matches, rosters, teams and attendance.</Item>
          <Item>To tell you about things that concern you, such as a match being published or cancelled.</Item>
          <Item>To let league administrators manage their own leagues and members.</Item>
          <Item>To keep the service secure and working, and to investigate problems.</Item>
        </List>
        <P>
          We do not use your information for advertising, for building a profile of you across other
          services, or for any form of automated decision-making about you.
        </P>
      </LegalSection>

      <LegalSection title="Who else processes it">
        <P>
          MatchDay is built on a small number of services that process data on our behalf. We do not
          sell or rent your information to anyone, and none of these providers is permitted to use
          it for their own purposes.
        </P>
        <Definitions>
          <Definition term="Supabase">
            Our database, file storage and authentication. Effectively everything described above is
            stored there.
          </Definition>
          <Definition term="Vercel">
            Hosting. Like any web host, Vercel processes the technical details of each request —
            including your IP address, the page requested and your browser&rsquo;s user agent — in
            order to serve the page and to protect the service.
          </Definition>
          <Definition term="Brevo">
            Delivers the emails Supabase Auth sends: sign-in links, one-time codes and password
            resets. This means your email address and the content of those messages.
          </Definition>
          <Definition term="Better Stack">
            Receives our operational logs and a scheduled health signal, so we can tell when
            something has broken. Our logs are written as structured events that deliberately
            exclude names, email addresses, phone numbers, message contents and credentials.
          </Definition>
          <Definition term="Your browser&rsquo;s push service">
            Apple, Google or Mozilla, depending on the browser you use. Involved only if you turn on
            phone notifications, and only to deliver the message to your device.
          </Definition>
        </Definitions>
      </LegalSection>

      <LegalSection title="What we do not collect">
        <List>
          <Item>No location or GPS data.</Item>
          <Item>No contacts, calendar or photo library access beyond a photo you choose to upload.</Item>
          <Item>No health, fitness or medical information.</Item>
          <Item>No payment or financial information — MatchDay is free and takes no payments.</Item>
          <Item>No advertising identifiers, and no analytics or tracking software of any kind.</Item>
          <Item>No browsing history or search history from outside MatchDay.</Item>
        </List>
      </LegalSection>

      <LegalSection title="Tracking">
        <P>
          MatchDay does not track you. We do not link your activity to data collected by other
          companies&rsquo; apps or websites, we do not use advertising identifiers, and we do not
          share your information with data brokers or advertising networks. The app contains no
          advertising or analytics software.
        </P>
      </LegalSection>

      <LegalSection title="How long we keep things">
        <P>
          Your profile and participation records are kept while your account exists, because a
          league&rsquo;s history is the point of keeping them. Notifications and their delivery
          records are kept as part of your inbox. Operational logs are short-lived and are held by
          our logging provider under their retention settings.
        </P>
      </LegalSection>

      <LegalSection title="Deleting your account">
        <div id="deletion" className="scroll-mt-6">
          <P>
            You can delete your MatchDay account yourself, from inside the app: go to{' '}
            <strong>Profile → Account → Delete account</strong>. You will be asked to confirm your
            identity, and if you are the administrator of a league you will first be asked either to
            hand that league to another member or to close it, so that no league is left without an
            administrator.
          </P>
        </div>
        <P>Deleting your account removes:</P>
        <List>
          <Item>your sign-in identity, so the account can no longer be used;</Item>
          <Item>
            your profile details — name, email address, phone number, gender, positions and
            goalkeeper preference;
          </Item>
          <Item>your profile photos, including any earlier ones still stored;</Item>
          <Item>your notification inbox and any push subscriptions for your devices;</Item>
          <Item>any pending requests to join a league;</Item>
          <Item>private notes an administrator had written about your membership;</Item>
          <Item>your saved app preferences.</Item>
        </List>
        <P>
          <strong>What remains, and why.</strong> Matches that have already been played are part of
          the record of the leagues you played in, and they belong to those leagues as much as to
          you. So the entries themselves stay — the roster, the team sheet, the attendance register —
          but they no longer identify you. Your name and photo are replaced everywhere with{' '}
          <strong>Former member</strong>, and nothing links those records back to you. Records of
          significant administrative actions in a league are likewise kept in this de-identified
          form, so that administrators retain an accurate history of their own league.
        </P>
        <P>
          Deleting your account does not stop you coming back. Signing up again with the same email
          address creates a completely new account, with no connection to the old one and none of
          its history.
        </P>
        {supportEmail === null ? null : (
          <P>
            If you are unable to reach the in-app deletion flow for any reason, contact us at{' '}
            <a href={`mailto:${supportEmail}`} className="underline underline-offset-4">
              {supportEmail}
            </a>{' '}
            and we will help — but the in-app route is the fastest, and it does not depend on us.
          </P>
        )}
      </LegalSection>

      <LegalSection title="Your choices">
        <List>
          <Item>
            <strong>Review or change your details</strong> at any time from Profile.
          </Item>
          <Item>
            <strong>Leave a league</strong> without deleting your account, from the league menu.
          </Item>
          <Item>
            <strong>Turn phone notifications off</strong> per device from Profile → Phone
            notifications.
          </Item>
          <Item>
            <strong>Delete your account</strong> from Profile → Account → Delete account.
          </Item>
        </List>
        {supportEmail === null ? null : (
          <P>
            If you would like a copy of the information we hold about you, or have a question we
            have not answered here, write to us and we will do our best to help.
          </P>
        )}
      </LegalSection>

      <LegalSection title="Security">
        <P>
          We take reasonable measures to protect your information: access to league data is enforced
          in the database itself rather than only in the application, credentials are never written
          to our logs, and administrative operations run on the server and never in your browser. No
          service can promise perfect security, and we do not claim to — but we would rather tell you
          what we actually do than make a guarantee nobody can keep.
        </P>
      </LegalSection>

      <LegalSection title="Children">
        <P>
          MatchDay is intended for adults organising and playing in pickup matches. It is not
          directed at children, and we do not knowingly collect information from them.
        </P>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <P>
          If we change what MatchDay collects or how it is used, we will update this page and change
          the date at the top. Significant changes will also be announced in the app.
        </P>
      </LegalSection>

      <LegalSection title="Contact us">
        {supportEmail === null ? (
          <P>
            Questions about this policy can be raised through the support channel shown in the app.
          </P>
        ) : (
          <P>
            Questions about this policy? Email{' '}
            <a href={`mailto:${supportEmail}`} className="underline underline-offset-4">
              {supportEmail}
            </a>
            .
          </P>
        )}
      </LegalSection>
    </>
  );
}
