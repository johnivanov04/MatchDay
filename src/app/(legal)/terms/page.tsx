import type { Metadata } from 'next';
import Link from 'next/link';
import { Item, LegalSection, LegalTitle, List, P } from '@/components/legal-prose';
import { getSupportEmail } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Terms of Use',
  description:
    'The ground rules for using MatchDay: your account, conduct in leagues, organiser responsibilities and the limits of the service.',
};

/**
 * Terms of Use.
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
 *
 * A free coordination tool for pickup matches. The terms are written to match
 * that and no more: they do not pretend MatchDay runs the matches, hires the
 * referees, inspects the pitch or supervises anybody. It keeps a list of who is
 * playing on Thursday.
 *
 * That distinction is the point of the participation section. Saying "you are
 * responsible for your own safety" is honest for a tool that coordinates games
 * organised by other people; a paragraph of medical disclaimers would imply an
 * involvement in the game itself that the product does not have.
 */
export default function TermsPage() {
  const supportEmail = getSupportEmail();

  return (
    <>
      <LegalTitle updated="20 August 2026">Terms of Use</LegalTitle>

      <LegalSection title="What MatchDay is">
        <P>
          MatchDay is a free tool for organising pickup matches. It keeps track of who is in a
          league, who has signed up for which match, who is on the waitlist, and who ended up on
          which team. That is all it does.
        </P>
        <P>
          MatchDay does not organise, run, referee or supervise matches. Those are arranged by the
          people who run each league, and they are responsible for them. Using these terms means
          agreeing to them; if you do not, please do not use MatchDay.
        </P>
      </LegalSection>

      <LegalSection title="Your account">
        <List>
          <Item>Use an email address you control, and give a real name that your fellow players will recognise.</Item>
          <Item>Keep your sign-in details to yourself. Anything done from your account is treated as done by you.</Item>
          <Item>One account per person. Do not sign up on somebody else&rsquo;s behalf or pretend to be them.</Item>
          <Item>Tell us if you think somebody else has got into your account.</Item>
        </List>
      </LegalSection>

      <LegalSection title="Playing well with others">
        <P>
          A league is a group of people who want a game. Treat them accordingly:
        </P>
        <List>
          <Item>Be civil to other members, in the app and on the pitch.</Item>
          <Item>
            Sign up only when you intend to play, and cancel as early as you can if your plans
            change. Somebody on the waitlist is waiting for that spot.
          </Item>
          <Item>Follow the guidelines of any league you join. Each league sets its own.</Item>
          <Item>
            Do not harass, threaten or abuse anyone, and do not post content that is unlawful or
            designed to upset people.
          </Item>
          <Item>
            Do not misuse other members&rsquo; information. Details you can see because you share a
            league are for organising matches, not for anything else.
          </Item>
        </List>
      </LegalSection>

      <LegalSection title="If you run a league">
        <P>
          League administrators can see their members&rsquo; profile details, record attendance,
          write private notes and manage membership. With that comes responsibility:
        </P>
        <List>
          <Item>Use what you can see to run your league, and for nothing else.</Item>
          <Item>Be accurate and fair when recording attendance or changing somebody&rsquo;s status.</Item>
          <Item>
            The arrangements for your matches — the pitch, the equipment, permissions, insurance,
            and anything else the game needs — are yours to make. MatchDay is not part of them.
          </Item>
          <Item>
            A league always needs one administrator. Before you delete your account you will be
            asked to hand your league to another member or to close it.
          </Item>
        </List>
      </LegalSection>

      <LegalSection title="Matches, and what is not guaranteed">
        <P>
          Matches are created and cancelled by the people who run each league. A match appearing in
          MatchDay is not a promise that it will happen, that a pitch is booked, that enough people
          will turn up, or that you will get a spot. Waitlists and rosters work the way each league
          has configured them.
        </P>
        <P>
          We aim to keep MatchDay available and working, but it can be interrupted for maintenance
          or by problems outside our control. Do not rely on a notification arriving as the only way
          you would learn that a match is off.
        </P>
      </LegalSection>

      <LegalSection title="Playing football is a physical activity">
        <P>
          Soccer involves running, contact and the ordinary risk of injury. You take part at your
          own risk, and you are responsible for deciding whether you are fit to play. If you are
          unsure, that is a conversation with a doctor rather than with us.
        </P>
        <P>
          MatchDay is not present at your matches and has no role in how they are run, so we are not
          responsible for what happens at them. Whoever organises a match is responsible for how it
          is organised, and each player is responsible for themselves.
        </P>
      </LegalSection>

      <LegalSection title="Content you add">
        <P>
          You keep whatever rights you have in the content you add — your profile photo, the notes
          you write. By adding it you allow us to store and display it inside MatchDay for the
          purpose of running the product, which is what makes it appear on a roster or a team sheet.
          Removing it, or deleting your account, ends that.
        </P>
      </LegalSection>

      <LegalSection title="Ending your use of MatchDay">
        <P>
          You can leave a league at any time, and you can delete your account at any time from
          Profile → Account → Delete account. The{' '}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>{' '}
          explains exactly what deletion removes and what stays in a league&rsquo;s records.
        </P>
        <P>
          We may suspend or remove an account that is being used to harass people, to break these
          terms, or in a way that damages the service for everybody else. Where it is reasonable to
          do so, we will say why.
        </P>
      </LegalSection>

      <LegalSection title="Changes to MatchDay and to these terms">
        <P>
          MatchDay changes as it is developed: features are added, altered and sometimes removed. We
          may update these terms to match. When we do, the date at the top changes, and significant
          changes are announced in the app. Continuing to use MatchDay after that means the updated
          terms apply.
        </P>
      </LegalSection>

      <LegalSection title="Limits">
        <P>
          MatchDay is provided free and as it is. We cannot promise it will be uninterrupted or
          error-free, and to the extent the law allows, we are not liable for losses arising from
          using it — including a match you missed because a notification did not arrive. Nothing
          here removes rights you have that cannot be removed by agreement.
        </P>
      </LegalSection>

      <LegalSection title="Contact">
        {supportEmail === null ? (
          <P>Questions about these terms can be raised through the support channel shown in the app.</P>
        ) : (
          <P>
            Questions about these terms? Email{' '}
            <a href={`mailto:${supportEmail}`} className="underline underline-offset-4">
              {supportEmail}
            </a>
            , or see{' '}
            <Link href="/support" className="underline underline-offset-4">
              Support
            </Link>
            .
          </P>
        )}
      </LegalSection>
    </>
  );
}
