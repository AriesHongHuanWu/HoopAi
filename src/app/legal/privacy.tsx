/**
 * Privacy policy (in-app). The honest full version — mirrors
 * docs/PRIVACY-POLICY.md, which is the hosted copy the store listing URL points
 * at. Keep the two in lockstep: reviewers cross-check the listing URL against
 * this screen.
 *
 * The whole posture in one line: everything is processed on-device; nothing is
 * transmitted except data you personally choose to share or export.
 */
import { BackPill } from '@/components/ShotList';
import { Bullet, Callout, DocHeader, P, Section, Strong } from '@/components/legal/Prose';
import { Screen } from '@/components/ui';
import { LAST_UPDATED } from '@/core/legalMeta';

export default function PrivacyPolicy() {
  return (
    <Screen scroll>
      <BackPill />
      <DocHeader eyebrow="Legal" title="Privacy policy" updated={LAST_UPDATED} />

      <Callout>
        <P lead>
          Hoopilot processes everything on your phone. Your camera feed and
          session videos are analysed on-device and are <Strong>never uploaded
          to us or anyone else</Strong>. We run no ads, no third-party trackers
          and no analytics. Nothing leaves your phone unless you tap Share or
          Export yourself.
        </P>
      </Callout>

      <Section heading="Who we are">
        <P>
          Hoopilot is an on-device basketball shot tracker. This policy explains
          what data the app touches, where it stays, and the few cases where you
          — and only you — can send something off the device.
        </P>
      </Section>

      <Section heading="The camera and microphone">
        <P>
          Hoopilot uses your camera to detect the ball and rim and score your
          shots in real time, and the microphone to record court audio alongside
          your session videos. This all happens <Strong>live, on the device</Strong>.
          Frames are analysed and discarded; we do not send any camera or
          microphone data anywhere.
        </P>
      </Section>

      <Section heading="What is stored on your phone">
        <P>Hoopilot keeps the following locally, in the app's own storage:</P>
        <Bullet>Session stats and shot history (makes, misses, angles, streaks).</Bullet>
        <Bullet>
          Recorded clips of your shots, if you keep clips on. You choose whether
          clips are saved and can turn them off entirely in Settings.
        </Bullet>
        <Bullet>
          Your player profile — an optional nickname, and optional height,
          weight, wingspan and birth year. Every field is skippable.
        </Bullet>
        <Bullet>App settings and preferences.</Bullet>
        <P>
          This data lives on your device. It is not synced to a server, and we
          have no account system today, so there is no copy of it anywhere else.
        </P>
      </Section>

      <Section heading="Your profile and fitness data">
        <P>
          If you choose to enter height, weight, wingspan or birth year, Hoopilot
          treats these as <Strong>health and fitness details</Strong>. They are
          stored only on your phone, used only to personalise coaching copy and
          make fair peer comparisons, and are <Strong>not linked to your
          identity, not used for advertising, and never used to track you</Strong>.
          You can clear them any time from your profile, and the app never
          requires them.
        </P>
      </Section>

      <Section heading="When something leaves your phone (only if you choose)">
        <P>
          The only way anything leaves your device is when you deliberately act:
        </P>
        <Bullet>
          <Strong>Share</Strong> a highlight clip or share card — this hands the
          file to the share sheet (Messages, Instagram, etc.) that you pick.
        </Bullet>
        <Bullet>
          <Strong>Export</Strong> a CSV of your stats, or save a clip to your
          photo library — the file goes where you send it.
        </Bullet>
        <Bullet>
          <Strong>Contact support</Strong> by email — anything you write in that
          email is sent by you, through your own mail app.
        </Bullet>
        <P>
          Once you share or export a file, how it is handled is governed by the
          service or person you sent it to, not by us.
        </P>
      </Section>

      <Section heading="What we do NOT do">
        <Bullet>We do not upload your videos, images or audio.</Bullet>
        <Bullet>We do not run ads or embed advertising SDKs.</Bullet>
        <Bullet>We do not use third-party analytics or tracking.</Bullet>
        <Bullet>We do not sell or share your data — there is nothing to sell.</Bullet>
        <Bullet>We do not create advertising or tracking profiles about you.</Bullet>
      </Section>

      <Section heading="Photos and media library">
        <P>
          If you save a highlight to your photo library, or pick an existing
          basketball video to analyse, Hoopilot uses the media-library and
          photo-picker permissions for exactly that action. It reads only the
          video you select and writes only the clips you ask it to save.
        </P>
      </Section>

      <Section heading="Children">
        <P>
          Hoopilot is rated for all ages and does not knowingly collect personal
          information from children. Because everything stays on the device and
          there are no accounts, the app does not build a profile of any user,
          child or adult.
        </P>
      </Section>

      <Section heading="Future changes: accounts, sync and optional telemetry">
        <P>
          Hoopilot has no accounts, cloud sync, or crash/usage reporting today.
          If we add any of these later, they will be introduced honestly:
        </P>
        <Bullet>
          Any crash or performance reporting will be <Strong>opt-in</Strong>,
          clearly described, and never tied to your video.
        </Bullet>
        <Bullet>
          If accounts and cloud sync ship, you will be able to delete your
          account and its data from inside the app.
        </Bullet>
        <Bullet>This policy will be updated before any such feature turns on.</Bullet>
      </Section>

      <Section heading="Contact">
        <P>
          Questions about this policy? Email support@hoopai.app and we will
          answer.
        </P>
      </Section>
    </Screen>
  );
}
