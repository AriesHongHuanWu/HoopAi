/**
 * Terms of use (in-app). Fair, plain-language terms: a personal-use license,
 * a no-warranty clause, and — because this app gets people moving on a court —
 * a sports-activity safety disclaimer. No dark patterns, no hidden data grabs.
 */
import { BackPill } from '@/components/ShotList';
import { Bullet, Callout, DocHeader, P, Section, Strong } from '@/components/legal/Prose';
import { Screen } from '@/components/ui';
import { LAST_UPDATED } from '@/core/legalMeta';

export default function TermsOfUse() {
  return (
    <Screen scroll>
      <BackPill />
      <DocHeader eyebrow="Legal" title="Terms of use" updated={LAST_UPDATED} />

      <Callout>
        <P lead>
          These are the plain-language terms for using Hoopilot. The short
          version: use it for your own basketball training, it comes with no
          guarantees, and <Strong>play safe — Hoopilot is a training aid, not a
          referee or a coach who can keep you from getting hurt</Strong>.
        </P>
      </Callout>

      <Section heading="Using Hoopilot">
        <P>
          We grant you a personal, non-exclusive license to use Hoopilot on your
          own devices for your own basketball training and enjoyment. Please do
          not resell the app, reverse-engineer it, or use it to break the law or
          anyone else's rights.
        </P>
      </Section>

      <Section heading="Your content stays yours">
        <P>
          Videos, clips, stats and profile details you create in Hoopilot are
          <Strong> yours</Strong>. They live on your device; we do not claim any
          ownership of them and we cannot see them. When you share or export a
          file, you are responsible for where you send it and for having the
          right to record and share whatever it contains — including other
          people who appear in your footage.
        </P>
      </Section>

      <Section heading="Sports activity — play safe">
        <P>
          Basketball is a physical activity with real risk of injury. Hoopilot
          measures and gives feedback on your shooting; it does not supervise
          you, assess your health, or make your court safe.
        </P>
        <Bullet>Warm up, and stop if you feel pain or dizziness.</Bullet>
        <Bullet>Keep your eyes on your surroundings, not on the phone screen, while you move.</Bullet>
        <Bullet>
          If you have any medical condition, consult a professional before
          starting or changing a training routine.
        </Bullet>
        <P>
          You take part in basketball and any drills at your own risk. To the
          extent the law allows, Hoopilot is not responsible for injury or loss
          arising from your physical activity.
        </P>
      </Section>

      <Section heading="Accuracy and coaching feedback">
        <P>
          Shot detection, form analysis and jump metrics are computed estimates
          from a phone camera — not precise instruments. Form and jump readings
          are 2D estimates and are <Strong>illustrative, not clinical</Strong>.
          Player comparisons reference public, factual pro-shooting benchmarks;
          they are motivational, not a claim you match any player. Use the
          feedback as a guide, not as ground truth.
        </P>
      </Section>

      <Section heading="No warranty">
        <P>
          Hoopilot is provided <Strong>“as is”</Strong>, without warranties of
          any kind, express or implied. We do not promise it will be error-free,
          uninterrupted, or fit for a particular purpose. To the maximum extent
          permitted by law, we are not liable for indirect or consequential
          damages arising from your use of the app.
        </P>
      </Section>

      <Section heading="Purchases">
        <P>
          Hoopilot is free while in beta, with every feature unlocked. If paid
          plans launch later, their price and terms will be shown clearly before
          you buy, and any subscription is billed and managed by the App Store or
          Google Play under their standard terms.
        </P>
      </Section>

      <Section heading="Changes and contact">
        <P>
          We may update these terms as the app evolves; the “Last updated” date
          above shows the current version. Questions? Email support@hoopai.app.
        </P>
      </Section>
    </Screen>
  );
}
