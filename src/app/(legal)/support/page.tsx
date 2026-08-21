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
import { isNativeIOSApp } from '@/lib/platform/native-server';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'Help with MatchDay: signing in, joining a league, match signup and waitlists, notifications, and deleting your account.',
};

/**
 * The Support URL an App Store listing points at.
 *
 * ── A PAGE, NOT A `mailto:` ────────────────────────────────────────────────
 *
 * Apple's Support URL has to land somewhere useful. A page that only says
 * "email us" satisfies the field and nothing else — most of what people write
 * in about is answered by four paragraphs, and the two questions that most need
 * answering fast (how do I get back in, how do I delete my account) are both
 * things somebody can do themselves once they know where to look.
 *
 * The address comes from `NEXT_PUBLIC_SUPPORT_EMAIL`, the same configuration
 * the in-app footer already uses, so there is one place to change it. When it
 * is unset the page still works and simply does not show a dead link.
 */
export default async function SupportPage() {
  const supportEmail = getSupportEmail();
  const isNativeApp = await isNativeIOSApp();

  return (
    <>
      <LegalTitle updated="20 August 2026">MatchDay Support</LegalTitle>

      <LegalSection title="Getting help">
        <P>
          MatchDay organises pickup matches for leagues: membership, signup, waitlists, rosters and
          teams in one place. Most questions are answered below. If yours is not, we read every
          message.
        </P>
        {supportEmail === null ? (
          <P>
            Support contact details are shown in the app footer and on any error screen.
          </P>
        ) : (
          <P>
            Email us at{' '}
            <a
              href={`mailto:${supportEmail}`}
              className="font-semibold underline underline-offset-4"
            >
              {supportEmail}
            </a>
            . Telling us the email address on your account and which league you are asking about
            helps us answer in one reply rather than three.
          </P>
        )}
      </LegalSection>

      <LegalSection title="Account and signing in">
        <Definitions>
          <Definition term="I cannot sign in">
            You can sign in with your password, or choose <em>Sign in with a code instead</em> and
            we will email you a one-time code. If a code has not arrived after a minute, check your
            spam folder before requesting another — asking again replaces the previous code.
          </Definition>
          <Definition term="I have forgotten my password">
            Use <em>Forgot password</em> on the sign-in screen. If you have never set a password —
            some accounts only ever used email codes — the same link lets you create one.
          </Definition>
          <Definition term="My confirmation link does not work">
            Confirmation links can be opened on any device, including one that did not start the
            sign-up. Open the link and press <em>Continue to MatchDay</em>. Links expire, so if
            yours has, request a new one from the sign-in screen.
          </Definition>
          <Definition term="Changing my name or details">
            Profile → Your details. Your optional details — phone, gender, positions, goalkeeper
            preference — are visible only to the administrators of leagues you belong to.
          </Definition>
        </Definitions>
      </LegalSection>

      <LegalSection title="Joining a league">
        <Definitions>
          <Definition term="Finding a league">
            Use <em>Find a league</em> and search by name or area. Leagues that have chosen to be
            searchable appear there; private leagues do not, and are joined by invitation link.
          </Definition>
          <Definition term="Waiting for approval">
            A request has to be approved by that league&rsquo;s administrator. Until then the league
            shows as <em>Awaiting approval</em> and you cannot sign up for its matches yet. You can
            withdraw a request from the same screen.
          </Definition>
          <Definition term="I was invited but the link will not work">
            Invitation links expire, can be limited to a number of uses, and can be revoked. Ask the
            person who invited you for a fresh one.
          </Definition>
          <Definition term="Leaving a league">
            Open the league menu — the bar showing your active league — and choose{' '}
            <em>Leave league</em>. You will be taken out of upcoming matches; matches you have
            already played stay in the league&rsquo;s records. You can ask to rejoin later.
          </Definition>
        </Definitions>
      </LegalSection>

      <LegalSection title="Match signup and waitlists">
        <Definitions>
          <Definition term="Signing up">
            Open a match and take a spot. Depending on how the league is set up, either you are
            confirmed immediately or your request waits for the administrator to select the roster.
          </Definition>
          <Definition term="I am on the waitlist">
            You will be told your position. If the league promotes automatically, a spot opening
            moves you up and you will be notified. Otherwise the administrator chooses who comes in.
          </Definition>
          <Definition term="Cancelling a spot">
            Cancel from the match. Each league sets a cutoff — cancelling after it is recorded as a
            late cancellation, which the administrator can see. Cancel as early as you can so
            somebody on the waitlist can take the place.
          </Definition>
          <Definition term="Teams and rosters">
            The administrator publishes the roster and, if the league uses them, the teams. You will
            be notified when they are published and again if they change.
          </Definition>
        </Definitions>
      </LegalSection>

      <LegalSection title="Notifications">
        <List>
          <Item>
            Every notification appears in your MatchDay inbox, whether or not you use phone
            notifications.
          </Item>
          <Item>
            To also get alerts when MatchDay is closed, go to Profile → Phone notifications and turn
            them on for that device. Each device is separate.
          </Item>
          {/* Web and home-screen PWA only.
              Suppressed inside the iOS app, where "install this from Safari" is
              both wrong and exactly the sentence an App Review rejection quotes
              back at you. `/support` is a public page, so this is the one place
              in the product where the signal has to be read per-request without
              a session in play. */}
          {isNativeApp ? (
            <Item>
              In the MatchDay iOS app, push notifications are coming in a future update. Everything
              still arrives in your in-app inbox.
            </Item>
          ) : (
            <Item>
              On iPhone and iPad, add MatchDay to your Home Screen first — Safari only offers
              notifications to apps installed that way.
            </Item>
          )}
          <Item>
            Not receiving them? Check that notifications are allowed for MatchDay in your device
            settings, then turn the device off and on again in Profile → Phone notifications.
          </Item>
        </List>
      </LegalSection>

      <LegalSection title="Deleting your account">
        <P>
          You can delete your account yourself, from inside the app:{' '}
          <strong>Profile → Account → Delete account</strong>. You will be asked to confirm your
          identity first.
        </P>
        <P>
          If you administer a league, you will be asked either to transfer it to another member or
          to close it before your account can be deleted — a league cannot be left without an
          administrator. If nobody else is available to take it on, closing the league is offered and
          keeps its past matches intact.
        </P>
        <P>
          Deletion removes your account and personal details permanently. Matches you have already
          played remain in each league&rsquo;s records, shown as <em>Former member</em> with no name
          or photo. The{' '}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>{' '}
          explains this in full.
        </P>
      </LegalSection>

      <LegalSection title="Also useful">
        <List>
          <Item>
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy Policy
            </Link>{' '}
            — what we collect, who processes it, and what deletion does.
          </Item>
          <Item>
            <Link href="/terms" className="underline underline-offset-4">
              Terms of Use
            </Link>{' '}
            — the ground rules for using MatchDay.
          </Item>
        </List>
      </LegalSection>
    </>
  );
}
