/**
 * Onboarding — first-run player-identity wizard. ONE question per screen.
 *
 * A pro app opens by learning who's holding it: nickname, the numbers
 * (height/weight/age), how much basketball they play, and what they're here
 * for. Every data step is SKIPPABLE and OPTIONAL — the App Store forbids
 * forcing personal-data collection (5.1.1), and everything captured stays on
 * this phone (see profileStore.ts). We collect it to personalize coaching and
 * make peer comparisons fair, nothing more; no health/BMI claims are made.
 *
 * Flow (welcome + primer + done are non-data; the rest write profileStore or,
 * for the two existing settings keys, useSettings):
 *   welcome → nickname → height → weight → birth year → experience →
 *   plays/week → position → goal → hand + ball size → camera primer → done
 *
 * CONTRACT: index.tsx redirects here with <Redirect href="/onboarding" /> when
 * settings.onboardingDone is false, and _layout registers this screen with a
 * fade + gestureEnabled:false so it can't be swiped away. Finishing OR skipping
 * MUST set settings.onboardingDone = true and router.replace('/') so returning
 * users never see it again — that exact contract is preserved here.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceCard, ChipSelect } from '@/components/profile/Choice';
import { NumberSlider } from '@/components/profile/NumberSlider';
import { PillButton, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import {
  DEFAULT_HEIGHT_CM,
  DEFAULT_WEIGHT_KG,
  EXPERIENCE_BLURB,
  EXPERIENCE_LABEL,
  GOAL_BLURB,
  GOAL_LABEL,
  MAX_HEIGHT_CM,
  MAX_WEIGHT_KG,
  MIN_HEIGHT_CM,
  MIN_WEIGHT_KG,
  POSITION_LABEL,
  maxBirthYear,
  useProfile,
  type Experience,
  type Position,
  type TrainingGoal,
} from '@/state/profileStore';
import { useSettings } from '@/state/settingsStore';
import type { ShootingHand } from '@/core/types';

const DEFAULT_BIRTH_YEAR = 2005;

/** cm → a "5'11"" style label for the height readout. */
function cmToFtIn(cm: number): string {
  const totalIn = Math.round(cm / 2.54);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${ft}'${inch}"`;
}

interface StepChrome {
  /** Small accent eyebrow above the title. */
  eyebrow: string;
  /** The one big question. */
  title: string;
  /** Optional supporting sentence under the title. */
  body?: string;
  /** The interactive control (or null for the intro/primer/done copy steps). */
  content: ReactNode;
  /** Data steps show Back + Skip; intro/primer/done do not. */
  isDataStep: boolean;
  /** Overrides the primary CTA label (defaults "Continue"). */
  ctaLabel?: string;
  /** Leading icon on the primary CTA. */
  ctaIcon?: React.ComponentProps<typeof Ionicons>['name'];
}

/** One progress dot; grows into a pill and warms up when active. Copied from
 *  the previous onboarding so the progress language is unchanged. */
function PagerDot({ active }: { active: boolean }) {
  const style = useAnimatedStyle(() => ({
    width: withTiming(active ? space.xl : space.sm, {
      duration: motion.quick,
      reduceMotion: ReduceMotion.System,
    }),
    opacity: withTiming(active ? 1 : 0.5, {
      duration: motion.quick,
      reduceMotion: ReduceMotion.System,
    }),
  }));
  return <Animated.View style={[styles.dot, active && styles.dotActive, style]} />;
}

const POSITION_OPTIONS: { value: Position; label: string }[] = (
  ['guard', 'wing', 'big'] as Position[]
).map((v) => ({ value: v, label: POSITION_LABEL[v] }));

const PLAYS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Rarely' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
  { value: 6, label: '6' },
  { value: 7, label: 'Daily' },
];

const HAND_OPTIONS: { value: ShootingHand; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

const BALL_OPTIONS: { value: 7 | 6 | 5; label: string }[] = [
  { value: 7, label: "Size 7 · men's" },
  { value: 6, label: 'Size 6 · women/youth' },
  { value: 5, label: 'Size 5 · kids' },
];

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);

  // Live profile values so a tapped-back step shows what was entered.
  const profile = useProfile();
  const setProfile = profile.set;

  // Existing settings keys the wizard is allowed to write at runtime.
  const shootingHand = useSettings((s) => s.shootingHand);
  const ballSize = useSettings((s) => s.ballSize);
  const setSetting = useSettings((s) => s.set);

  // Local drafts for the slider steps so dragging feels instant even before
  // the user commits by tapping Continue; committed to the store on advance.
  const [heightDraft, setHeightDraft] = useState(profile.heightCm ?? DEFAULT_HEIGHT_CM);
  const [weightDraft, setWeightDraft] = useState(profile.weightKg ?? DEFAULT_WEIGHT_KG);
  const [yearDraft, setYearDraft] = useState(profile.birthYear ?? DEFAULT_BIRTH_YEAR);
  const [nickDraft, setNickDraft] = useState(profile.nickname);

  const [step, setStep] = useState(0);

  const maxYear = maxBirthYear();

  const finish = useCallback(() => {
    if (hapticsEnabled) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    // Stamp the profile as done (even a fully-skipped one) and honor the exact
    // onboardingDone contract index.tsx / _layout depend on.
    useProfile.getState().markComplete();
    setSetting('onboardingDone', true);
    router.replace('/');
  }, [hapticsEnabled, setSetting]);

  const steps: StepChrome[] = useMemo(() => {
    const tick = () => {
      if (useSettings.getState().hapticsEnabled) void Haptics.selectionAsync();
    };
    return [
      // 0 — Welcome (non-data): value + the privacy promise up front.
      {
        eyebrow: 'Welcome',
        title: "Let's build your player card",
        body: 'A few quick questions tailor your coaching and keep comparisons fair. Every one is optional, and your answers stay on this phone — nothing is uploaded.',
        content: (
          <Row gap={space.sm} style={styles.primer}>
            <Ionicons name="lock-closed" size={16} color={color.make} />
            <Text style={styles.primerText}>
              On-device only. You can skip anything, and change it all later in your profile.
            </Text>
          </Row>
        ),
        isDataStep: false,
        ctaLabel: 'Get started',
      },
      // 1 — Nickname
      {
        eyebrow: 'Step 1 · You',
        title: 'What should we call you?',
        body: 'Your name on the scoreboard and your shared clips.',
        content: (
          <TextInput
            value={nickDraft}
            onChangeText={setNickDraft}
            placeholder="Nickname"
            placeholderTextColor={color.textFaint}
            style={styles.input}
            maxLength={24}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel="Nickname"
            selectionColor={color.accent}
          />
        ),
        isDataStep: true,
      },
      // 2 — Height
      {
        eyebrow: 'Step 2 · Measurements',
        title: 'How tall are you?',
        body: 'Used to calibrate release height and jump — never shared.',
        content: (
          <NumberSlider
            label="Height"
            value={heightDraft}
            min={MIN_HEIGHT_CM}
            max={MAX_HEIGHT_CM}
            unit="cm"
            formatValue={(v) => `${v}`}
            onChange={setHeightDraft}
          />
        ),
        isDataStep: true,
      },
      // 3 — Weight (optional)
      {
        eyebrow: 'Step 3 · Measurements',
        title: 'And your weight?',
        body: 'Optional — it helps size effort in future training modes. Skip if you’d rather not say.',
        content: (
          <NumberSlider
            label="Weight"
            value={weightDraft}
            min={MIN_WEIGHT_KG}
            max={MAX_WEIGHT_KG}
            unit="kg"
            onChange={setWeightDraft}
          />
        ),
        isDataStep: true,
      },
      // 4 — Birth year (age derived)
      {
        eyebrow: 'Step 4 · You',
        title: 'What year were you born?',
        body: 'We only keep the year, to compare you with players your age.',
        content: (
          <NumberSlider
            label="Birth year"
            value={yearDraft}
            min={1930}
            max={maxYear}
            formatValue={(v) => `${v}`}
            onChange={setYearDraft}
          />
        ),
        isDataStep: true,
      },
      // 5 — Experience (4 rich cards)
      {
        eyebrow: 'Step 5 · Your game',
        title: 'How much have you played?',
        body: 'Sets how your coaching cues are pitched.',
        content: (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Experience level"
            style={styles.cardStack}
          >
            {(['rookie', 'casual', 'club', 'veteran'] as Experience[]).map((v) => (
              <ChoiceCard
                key={v}
                icon={
                  v === 'rookie'
                    ? 'sparkles-outline'
                    : v === 'casual'
                      ? 'walk-outline'
                      : v === 'club'
                        ? 'people-outline'
                        : 'flame-outline'
                }
                title={EXPERIENCE_LABEL[v]}
                blurb={EXPERIENCE_BLURB[v]}
                selected={profile.experience === v}
                onPress={() => {
                  tick();
                  setProfile('experience', v);
                }}
              />
            ))}
          </View>
        ),
        isDataStep: true,
      },
      // 6 — Plays per week
      {
        eyebrow: 'Step 6 · Your game',
        title: 'How often do you play?',
        body: 'Sessions per week — powers realistic goals.',
        content: (
          <ChipSelect
            label="Sessions per week"
            options={PLAYS_OPTIONS}
            value={profile.playsPerWeek}
            onChange={(v) => {
              tick();
              setProfile('playsPerWeek', v);
            }}
          />
        ),
        isDataStep: true,
      },
      // 7 — Position
      {
        eyebrow: 'Step 7 · Your game',
        title: "What's your position?",
        body: 'Frames which shots and drills we surface first.',
        content: (
          <ChipSelect
            label="Position"
            options={POSITION_OPTIONS}
            value={profile.position}
            onChange={(v) => {
              tick();
              setProfile('position', v);
            }}
          />
        ),
        isDataStep: true,
      },
      // 8 — Goal (4 rich cards)
      {
        eyebrow: 'Step 8 · Your game',
        title: "What's your goal?",
        body: 'The finish line we help you train toward.',
        content: (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Training goal"
            style={styles.cardStack}
          >
            {(['fun', 'improve', 'team', 'pro'] as TrainingGoal[]).map((v) => (
              <ChoiceCard
                key={v}
                icon={
                  v === 'fun'
                    ? 'happy-outline'
                    : v === 'improve'
                      ? 'trending-up-outline'
                      : v === 'team'
                        ? 'shirt-outline'
                        : 'trophy-outline'
                }
                title={GOAL_LABEL[v]}
                blurb={GOAL_BLURB[v]}
                selected={profile.trainingGoal === v}
                onPress={() => {
                  tick();
                  setProfile('trainingGoal', v);
                }}
              />
            ))}
          </View>
        ),
        isDataStep: true,
      },
      // 9 — Shooting hand + ball size (writes existing settings keys)
      {
        eyebrow: 'Step 9 · Setup',
        title: 'Your hand and ball',
        body: 'Two quick tracking settings so the AI is dialed in from your first shot.',
        content: (
          <View style={styles.dualStack}>
            <View style={styles.labeledGroup}>
              <Text style={styles.groupLabel}>SHOOTING HAND</Text>
              <ChipSelect
                label="Shooting hand"
                options={HAND_OPTIONS}
                value={shootingHand}
                onChange={(v) => {
                  tick();
                  setSetting('shootingHand', v);
                }}
              />
            </View>
            <View style={styles.labeledGroup}>
              <Text style={styles.groupLabel}>BALL SIZE</Text>
              <ChipSelect
                label="Ball size"
                options={BALL_OPTIONS}
                value={ballSize}
                onChange={(v) => {
                  tick();
                  setSetting('ballSize', v);
                }}
              />
            </View>
          </View>
        ),
        isDataStep: true,
      },
      // 10 — Camera permission primer (non-data; the OS ask stays in setup)
      {
        eyebrow: 'Step 10 · Almost there',
        title: 'The camera does the counting',
        body: 'When you start a session, we ask for camera access. Every frame is analyzed right here on your phone — no video ever leaves the device unless you choose to share a clip.',
        content: (
          <Row gap={space.sm} style={styles.primer}>
            <Ionicons name="shield-checkmark-outline" size={16} color={color.make} />
            <Text style={styles.primerText}>
              We ask for the camera on the setup screen, right before your first session — not now.
            </Text>
          </Row>
        ),
        isDataStep: false,
      },
      // 11 — Done celebration
      {
        eyebrow: "You're set",
        title: nickDraft.trim() ? `Let's hoop, ${nickDraft.trim()}.` : "Let's hoop.",
        body: 'Your player card is ready. Prop your phone up, start a session, and every shot gets tracked.',
        content: (
          <View style={styles.doneMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Ionicons name="basketball" size={64} color={color.accent} />
          </View>
        ),
        isDataStep: false,
        ctaLabel: "Let's hoop",
        ctaIcon: 'basketball',
      },
    ];
  }, [
    ballSize,
    heightDraft,
    maxYear,
    nickDraft,
    profile.experience,
    profile.playsPerWeek,
    profile.position,
    profile.trainingGoal,
    setProfile,
    setSetting,
    shootingHand,
    weightDraft,
    yearDraft,
  ]);

  const lastIndex = steps.length - 1;
  const current = steps[step]!;

  /** Persist the current step's draft (slider/text) before moving on. */
  const commitDrafts = () => {
    if (step === 1) setProfile('nickname', nickDraft.trim());
    else if (step === 2) setProfile('heightCm', heightDraft);
    else if (step === 3) setProfile('weightKg', weightDraft);
    else if (step === 4) setProfile('birthYear', yearDraft);
  };

  const advance = () => {
    if (step >= lastIndex) {
      finish();
      return;
    }
    commitDrafts();
    setStep((s) => Math.min(lastIndex, s + 1));
  };

  const back = () => {
    if (step <= 0) return;
    if (hapticsEnabled) void Haptics.selectionAsync();
    setStep((s) => Math.max(0, s - 1));
  };

  /** Skip = advance WITHOUT committing this step's draft (leaves it null). */
  const skip = () => {
    if (hapticsEnabled) void Haptics.selectionAsync();
    if (step >= lastIndex) {
      finish();
      return;
    }
    setStep((s) => Math.min(lastIndex, s + 1));
  };

  // Entrance stagger, re-keyed per step so each question animates in. Off
  // under reduced motion (falls back to a plain cross-fade for the header).
  const enter = (i: number) =>
    reducedMotion ? FadeIn.duration(motion.quick) : FadeInDown.duration(motion.standard).delay(60 + i * 70);

  return (
    <Screen padded={false}>
      {/* Top bar: Back (left, data steps only) + Skip (right, data steps only) */}
      <Row style={styles.topBar}>
        {current.isDataStep && step > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={back}
            hitSlop={space.sm}
            style={({ pressed }) => [styles.topBtn, pressed && styles.topBtnPressed]}
          >
            <Ionicons name="chevron-back" size={18} color={color.textDim} />
            <Text style={styles.backLabel}>Back</Text>
          </Pressable>
        ) : (
          <View style={styles.topBtn} />
        )}
        {current.isDataStep ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip this question"
            accessibilityHint="Leaves it blank — you can add it later in your profile"
            onPress={skip}
            hitSlop={space.sm}
            style={({ pressed }) => [styles.topBtn, pressed && styles.topBtnPressed]}
          >
            <Text style={styles.skipLabel}>Skip</Text>
          </Pressable>
        ) : (
          <View style={styles.topBtn} />
        )}
      </Row>

      {/* The one question. Re-keyed by step so the whole block re-animates. */}
      <View style={styles.body} key={step}>
        <Animated.View entering={enter(0)} style={styles.copyBlock}>
          <Text style={styles.eyebrow}>{current.eyebrow.toUpperCase()}</Text>
          <Text style={styles.title} accessibilityRole="header">
            {current.title}
          </Text>
          {current.body != null && <Text style={styles.bodyText}>{current.body}</Text>}
        </Animated.View>
        <Animated.View entering={enter(1)} style={styles.control}>
          {current.content}
        </Animated.View>
      </View>

      {/* Footer: progress dots + primary CTA */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.xl }]}>
        <View importantForAccessibility="no-hide-descendants">
          <Row gap={space.sm} style={styles.dots}>
            {steps.map((s, i) => (
              <PagerDot key={i} active={i === step} />
            ))}
          </Row>
        </View>
        <PillButton
          label={current.ctaLabel ?? 'Continue'}
          icon={current.ctaIcon}
          onPress={advance}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  topBtn: {
    minWidth: touch.minTarget,
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  topBtnPressed: {
    backgroundColor: color.surfaceRaised,
  },
  backLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  skipLabel: {
    ...type.bodyMedium,
    color: color.textFaint,
  },
  body: {
    flex: 1,
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    gap: space.xxl,
  },
  copyBlock: {
    gap: space.md,
  },
  eyebrow: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1.2,
  },
  title: {
    ...type.title,
    fontSize: 34,
    lineHeight: 38,
    color: color.text,
  },
  bodyText: {
    ...type.body,
    color: color.textDim,
  },
  control: {
    flex: 1,
    justifyContent: 'center',
  },
  cardStack: {
    gap: space.sm,
  },
  dualStack: {
    gap: space.xl,
  },
  labeledGroup: {
    gap: space.md,
  },
  groupLabel: {
    ...type.caption,
    color: color.textFaint,
  },
  input: {
    ...type.statMedium,
    color: color.text,
    borderBottomWidth: 2,
    borderBottomColor: color.border,
    paddingVertical: space.sm,
    alignSelf: 'stretch',
  },
  primer: {
    alignItems: 'flex-start',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.md,
    padding: space.md,
  },
  primerText: {
    ...type.caption,
    color: color.textDim,
    flex: 1,
    lineHeight: 17,
  },
  doneMark: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xl,
  },
  footer: {
    paddingHorizontal: space.xl,
    gap: space.lg,
  },
  dots: {
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  dot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.border,
  },
  dotActive: {
    backgroundColor: color.accent,
  },
});
