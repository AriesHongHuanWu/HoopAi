/**
 * My Profile — the player's identity card and editor.
 *
 * A broadcast header (nickname, experience chip, an age/height/weight stat
 * strip that rolls in via MotionStat, and the signature shot arc traced
 * faintly behind it) sits over an editable list of every profile field. Each
 * row opens the same picker the first-run wizard used, as a bottom sheet
 * modal, so editing later feels identical to setting it the first time. A
 * trophy-case card previews the latest Records medals; a "Complete your
 * profile" progress chip appears while tracked fields are still empty, and a
 * collapsed "Why we ask" explainer states plainly that this all stays on the
 * phone and powers coaching + fair comparisons — no health or BMI claims.
 *
 * Everything remains optional: any field can be cleared back to "Add".
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState, type ComponentProps, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router, useFocusEffect } from 'expo-router';

import { DayStreakShelf } from '@/components/DayStreakShelf';
import { ArcReveal, MotionStat, useCardStagger, type EnteringProp } from '@/components/motion';
import { ChoiceCard, ChipSelect } from '@/components/profile/Choice';
import { NumberSlider } from '@/components/profile/NumberSlider';
import { SeasonCard } from '@/components/SeasonCard';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Chip, PillButton, PressableCard, Row, Screen, StatNumber } from '@/components/ui';
import { color, font, iconSize, layout, motion, palette, radius, space, touch, type } from '@/constants/tokens';
import {
  ACHIEVEMENTS,
  evaluate,
  type AchievementDef,
  type BadgeTier,
  type LifetimeTotals,
} from '@/core/achievements';
import type { ShootingHand } from '@/core/types';
import { lifetimeTotals } from '@/data/db';
import { useAchievementsSeen } from '@/state/achievementsSeenStore';
import {
  ageFromBirthYear,
  DEFAULT_HEIGHT_CM,
  DEFAULT_WEIGHT_KG,
  EXPERIENCE_BLURB,
  EXPERIENCE_LABEL,
  GOAL_BLURB,
  GOAL_LABEL,
  MAX_HEIGHT_CM,
  MAX_WEIGHT_KG,
  MAX_WINGSPAN_CM,
  MIN_HEIGHT_CM,
  MIN_WEIGHT_KG,
  MIN_WINGSPAN_CM,
  POSITION_LABEL,
  maxBirthYear,
  profileProgress,
  useProfile,
  type Experience,
  type Position,
  type TrainingGoal,
} from '@/state/profileStore';
import { useSettings } from '@/state/settingsStore';

type IconName = ComponentProps<typeof Ionicons>['name'];

const DEFAULT_BIRTH_YEAR = 2005;
const DEFAULT_WINGSPAN_CM = 180;

const EXPERIENCES: Experience[] = ['rookie', 'casual', 'club', 'veteran'];
const GOALS: TrainingGoal[] = ['fun', 'improve', 'team', 'pro'];

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

/** Which editor a row opens. */
type EditorKey =
  | 'nickname'
  | 'height'
  | 'weight'
  | 'wingspan'
  | 'birthYear'
  | 'experience'
  | 'playsPerWeek'
  | 'position'
  | 'goal';

// ---------------------------------------------------------------------------
// Editable row — label + current value (or "Add"), opens an editor sheet.
// ---------------------------------------------------------------------------

function FieldRow({
  icon,
  label,
  value,
  filled,
  onPress,
}: {
  icon: IconName;
  label: string;
  /** Rendered value, or a call to fill it in. */
  value: string;
  filled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={filled ? `${label}: ${value}` : `Add ${label.toLowerCase()}`}
      accessibilityHint="Opens a picker to edit this"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={iconSize.sm} color={color.accent} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={[styles.rowValue, !filled && styles.rowValueEmpty]} numberOfLines={1}>
          {filled ? value : 'Add'}
        </Text>
        <Ionicons name="chevron-forward" size={iconSize.md} color={color.textFaint} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Editor bottom sheet — the shared modal every row opens into.
// ---------------------------------------------------------------------------

function EditorSheet({
  title,
  onClose,
  onClear,
  children,
}: {
  title: string;
  onClose: () => void;
  /** When present, renders a "Clear" action (field is skippable). */
  onClear?: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal visible transparent animationType={reducedMotion ? 'fade' : 'slide'} onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.sheetHandle} importantForAccessibility="no-hide-descendants" />
        <Row style={styles.sheetHeader}>
          <Text style={styles.sheetTitle} accessibilityRole="header">
            {title}
          </Text>
          {onClear != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear this field"
              onPress={onClear}
              hitSlop={space.sm}
              style={({ pressed }) => [styles.clearBtn, pressed && styles.topBtnPressed]}
            >
              <Text style={styles.clearLabel}>Clear</Text>
            </Pressable>
          )}
        </Row>
        <View style={styles.sheetBody}>{children}</View>
        <PillButton label="Done" onPress={onClose} />
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Trophy case — the pocket view of the Records badge board.
// ---------------------------------------------------------------------------

/** Tier ring colors for the showcased medals — the tokens tier metals. */
const TROPHY_TIER: Record<BadgeTier, string> = {
  bronze: palette.tierBronze,
  silver: palette.tierSilver,
  gold: palette.tierGold,
};

/** How many medals the pocket view showcases. */
const TROPHY_MEDALS = 3;

/**
 * The medals most recently CONFIRMED unlocked, newest first.
 *
 * Honesty note: unlock timestamps are not stored anywhere, so "recent" uses
 * the only real record there is — the order the seen-store observed each
 * badge unlocked (seenBadgeIds appends in observation order). Unlocked badges
 * the store has not recorded yet are the newest of all. Nothing is invented.
 */
function recentUnlocked(
  unlocked: readonly AchievementDef[],
  seenIds: readonly string[],
): AchievementDef[] {
  const rank = (d: AchievementDef) => {
    const i = seenIds.indexOf(d.id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...unlocked]
    .sort((a, b) => rank(a) - rank(b))
    .slice(-TROPHY_MEDALS)
    .reverse();
}

/**
 * Entry card to the Records badge board: the latest medals (AchievementRow's
 * medal circle, ringed in its tier metal), the unlocked count, and a NEW pip
 * when the seen-store says a badge unlocked since the last Records visit.
 * READ-ONLY against that store — marking badges seen stays Records' job, so
 * the pip survives here until the board itself is opened.
 */
function TrophyCaseCard({ entering }: { entering?: EnteringProp }) {
  /** null = totals not loaded yet — render nothing rather than fake zeros. */
  const [totals, setTotals] = useState<LifetimeTotals | null>(null);
  const hasVisited = useAchievementsSeen((s) => s.hasVisited);
  const seenBadgeIds = useAchievementsSeen((s) => s.seenBadgeIds);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void lifetimeTotals()
        .then((t) => {
          if (alive) setTotals(t);
        })
        .catch(() => {
          if (alive) setTotals(null);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  if (totals == null) return null;

  const { unlocked } = evaluate(totals);
  const anyUnlocked = unlocked.length > 0;
  // Mirrors records.tsx's first-visit guard: before the board has ever been
  // opened, everything already unlocked is not "new" — no pip shower.
  const newCount = hasVisited
    ? unlocked.filter((d) => !seenBadgeIds.includes(d.id)).length
    : 0;
  // With nothing unlocked yet, preview the first rungs of the board — shown
  // in their locked state, never dressed up as earned.
  const showcased = anyUnlocked
    ? recentUnlocked(unlocked, seenBadgeIds)
    : ACHIEVEMENTS.slice(0, TROPHY_MEDALS);

  return (
    <PressableCard
      entering={entering}
      onPress={() => router.push('/records')}
      haptic="selection"
      accessibilityLabel={`Trophy case: ${unlocked.length} of ${ACHIEVEMENTS.length} badges unlocked${
        newCount > 0 ? `, ${newCount} new` : ''
      }. Opens Records.`}
    >
      <Row style={styles.trophyHead}>
        <SectionEyebrow icon="trophy-outline">Trophy case</SectionEyebrow>
        {newCount > 0 && (
          <View style={styles.trophyNewPip}>
            <Text style={styles.trophyNewPipText}>NEW</Text>
          </View>
        )}
      </Row>
      <Row gap={space.md} style={styles.trophyRow}>
        {showcased.map((def) => (
          <View
            key={def.id}
            style={[
              styles.trophyMedal,
              anyUnlocked
                ? { borderColor: TROPHY_TIER[def.tier] }
                : styles.trophyMedalLocked,
            ]}
          >
            <Text style={[styles.trophyEmoji, !anyUnlocked && styles.trophyEmojiLocked]}>
              {def.emoji}
            </Text>
          </View>
        ))}
        <View style={styles.trophyCount}>
          <Text style={styles.trophyCountLine}>
            {`${unlocked.length} of ${ACHIEVEMENTS.length} unlocked`}
          </Text>
          <Text style={styles.trophySub}>
            {anyUnlocked ? 'Your latest medals — open the board' : 'Every badge still waiting — open the board'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={color.textFaint} />
      </Row>
    </PressableCard>
  );
}

export default function ProfileScreen() {
  const reducedMotion = useReducedMotion();
  // Canonical card stagger. Under reduced motion this renders still (undefined
  // entering) instead of the old quick FadeIn — the standardized idiom.
  const enter = useCardStagger({ baseDelayMs: 40, stepMs: 60 });

  const p = useProfile();
  const setP = p.set;
  const shootingHand = useSettings((s) => s.shootingHand);
  const ballSize = useSettings((s) => s.ballSize);
  const setSetting = useSettings((s) => s.set);

  const [editor, setEditor] = useState<EditorKey | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState(p.nickname);
  // Measured header-card size, feeding the arc backdrop's Skia canvas.
  const [headerSize, setHeaderSize] = useState({ w: 0, h: 0 });

  const { filled, total } = profileProgress(p);
  const complete = filled >= total;
  const age = ageFromBirthYear(p.birthYear);

  const open = (key: EditorKey) => {
    if (key === 'nickname') setNickDraft(p.nickname);
    setEditor(key);
  };
  const close = () => {
    // Commit the nickname draft on close (other editors write live).
    if (editor === 'nickname') setP('nickname', nickDraft.trim());
    setEditor(null);
  };

  const expLabel = p.experience ? EXPERIENCE_LABEL[p.experience] : null;

  return (
    <Screen scroll>
      <View style={styles.stack}>
        {/* Broadcast header */}
        <Animated.View
          entering={enter(0)}
          style={styles.header}
          onLayout={(e) =>
            setHeaderSize({
              w: Math.round(e.nativeEvent.layout.width),
              h: Math.round(e.nativeEvent.layout.height),
            })
          }
        >
          {/* The signature shot arc, traced faintly behind the card content.
              Static ArcReveal (animate={false}) — the finished frame, plain
              declarative Skia, no draw-in and no worklet callbacks here. */}
          {headerSize.w > 0 && (
            <View style={styles.headerArc} pointerEvents="none">
              <ArcReveal width={headerSize.w} height={headerSize.h} animate={false} dot={false} />
            </View>
          )}
          {/* Eyebrow row also carries the settings gear — the old dedicated
              top bar spent a full row on that one glyph. */}
          <Row style={styles.eyebrowRow}>
            <Text style={styles.eyebrow}>PLAYER CARD</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              accessibilityHint="Open app settings, storage and legal"
              hitSlop={space.sm}
              onPress={() => router.push('/settings')}
              style={({ pressed }) => [styles.settingsBtn, pressed && styles.settingsBtnPressed]}
            >
              <Ionicons name="settings-sharp" size={iconSize.lg} color={color.textDim} />
            </Pressable>
          </Row>
          <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {p.nickname.trim() || 'Your name'}
          </Text>
          {(expLabel != null || p.trainingGoal != null) && (
            <Row gap={space.sm} style={styles.headerChips}>
              {expLabel != null && <Chip label={expLabel} tone="accent" />}
              {p.trainingGoal != null && <Chip label={GOAL_LABEL[p.trainingGoal]} />}
            </Row>
          )}
          {/* Stat strip — the three headline numbers roll in via MotionStat
              (same visuals as StatNumber). Dashes stay static: there is no
              numeral to roll when the field is unknown. */}
          <Row gap={space.xl} style={styles.statStrip}>
            {age != null ? (
              <MotionStat size="medium" value={age} label="Age" />
            ) : (
              <StatNumber size="medium" value="—" label="Age" />
            )}
            <View style={styles.statDivider} />
            {p.heightCm != null ? (
              <MotionStat size="medium" value={p.heightCm} label="cm" />
            ) : (
              <StatNumber size="medium" value="—" label="Height" />
            )}
            <View style={styles.statDivider} />
            {p.weightKg != null ? (
              <MotionStat size="medium" value={p.weightKg} label="kg" />
            ) : (
              <StatNumber size="medium" value="—" label="Weight" />
            )}
          </Row>
        </Animated.View>

        {/* Living season scoreboard — the profile's heartbeat */}
        <SeasonCard entering={enter(1)} />

        {/* Consecutive-practice-DAY badge shelf — the don't-break-the-chain reward */}
        <DayStreakShelf entering={enter(2)} />

        {/* Trophy case — latest medals + unlocked count, pressing opens Records */}
        <TrophyCaseCard entering={enter(3)} />

        {/* Complete-your-profile progress chip (only while incomplete) */}
        {!complete && (
          <Animated.View entering={enter(4)}>
            <View
              accessible
              accessibilityLabel={`Profile ${filled} of ${total} complete`}
              style={styles.progressCard}
            >
              <View style={styles.progressText}>
                <Text style={styles.progressTitle}>Complete your profile</Text>
                <Text style={styles.progressSub}>{`${filled} of ${total} filled — add the rest anytime.`}</Text>
              </View>
              <View style={styles.progressTrack} importantForAccessibility="no-hide-descendants">
                <View style={[styles.progressFill, { width: `${(filled / total) * 100}%` }]} />
              </View>
            </View>
          </Animated.View>
        )}

        {/* Identity fields */}
        <Card entering={enter(5)}>
          <Text style={styles.sectionEyebrow}>IDENTITY</Text>
          <FieldRow icon="person-outline" label="Nickname" filled={p.nickname.trim().length > 0} value={p.nickname.trim()} onPress={() => open('nickname')} />
          <View style={styles.divider} />
          <FieldRow icon="resize-outline" label="Height" filled={p.heightCm != null} value={`${p.heightCm} cm`} onPress={() => open('height')} />
          <View style={styles.divider} />
          <FieldRow icon="barbell-outline" label="Weight" filled={p.weightKg != null} value={`${p.weightKg} kg`} onPress={() => open('weight')} />
          <View style={styles.divider} />
          <FieldRow icon="git-compare-outline" label="Wingspan" filled={p.wingspanCm != null} value={`${p.wingspanCm} cm`} onPress={() => open('wingspan')} />
          <View style={styles.divider} />
          <FieldRow icon="calendar-outline" label="Birth year" filled={p.birthYear != null} value={`${p.birthYear}${age != null ? ` · ${age} yrs` : ''}`} onPress={() => open('birthYear')} />
        </Card>

        {/* Game fields */}
        <Card entering={enter(6)}>
          <Text style={styles.sectionEyebrow}>YOUR GAME</Text>
          <FieldRow icon="flame-outline" label="Experience" filled={p.experience != null} value={expLabel ?? ''} onPress={() => open('experience')} />
          <View style={styles.divider} />
          <FieldRow icon="repeat-outline" label="Plays per week" filled={p.playsPerWeek != null} value={p.playsPerWeek != null ? (PLAYS_OPTIONS.find((o) => o.value === p.playsPerWeek)?.label ?? String(p.playsPerWeek)) : ''} onPress={() => open('playsPerWeek')} />
          <View style={styles.divider} />
          <FieldRow icon="body-outline" label="Position" filled={p.position != null} value={p.position ? POSITION_LABEL[p.position] : ''} onPress={() => open('position')} />
          <View style={styles.divider} />
          <FieldRow icon="trophy-outline" label="Goal" filled={p.trainingGoal != null} value={p.trainingGoal ? GOAL_LABEL[p.trainingGoal] : ''} onPress={() => open('goal')} />
        </Card>

        {/* Tracking (existing settings keys) — inline chips, no sheet needed */}
        <Card entering={enter(7)}>
          <Text style={styles.sectionEyebrow}>TRACKING</Text>
          <View style={styles.inlineGroup}>
            <Text style={styles.inlineLabel}>Shooting hand</Text>
            <ChipSelect label="Shooting hand" options={HAND_OPTIONS} value={shootingHand} onChange={(v) => setSetting('shootingHand', v)} />
          </View>
          <View style={styles.divider} />
          <View style={styles.inlineGroup}>
            <Text style={styles.inlineLabel}>Ball size</Text>
            <ChipSelect label="Ball size" options={BALL_OPTIONS} value={ballSize} onChange={(v) => setSetting('ballSize', v)} />
          </View>
        </Card>

        {/* Why we ask — expandable, privacy-first. The disclosure grammar:
            the reflowing container rides a quick LinearTransition so opening
            GROWS the card instead of popping it; the revealed body keeps its
            quick FadeIn. Layout lives on an inner Animated.View because Card
            (read-only ui.tsx) forwards no layout prop — the same idiom as
            ShotReceipt's expanding column. */}
        <Card entering={enter(8)}>
          <Animated.View
            layout={LinearTransition.duration(motion.quick).reduceMotion(ReduceMotion.System)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: whyOpen }}
              accessibilityLabel="Why we ask"
              accessibilityHint="Explains how your profile is used and stored"
              onPress={() => setWhyOpen((v) => !v)}
              style={styles.whyHeader}
            >
              <Row gap={space.sm}>
                <Ionicons name="lock-closed" size={iconSize.sm} color={color.make} />
                <Text style={styles.whyTitle}>Why we ask</Text>
              </Row>
              <Ionicons name={whyOpen ? 'chevron-up' : 'chevron-down'} size={iconSize.md} color={color.textFaint} />
            </Pressable>
            {whyOpen && (
              <Animated.View
                entering={reducedMotion ? undefined : FadeIn.duration(motion.quick)}
                style={styles.whyBody}
              >
                <Text style={styles.whyText}>
                  Your profile personalizes coaching cues and lets us compare you fairly with
                  players of a similar age and experience — not against everyone at once.
                </Text>
                <Text style={styles.whyText}>
                  It all stays on this phone. Nothing here is uploaded, and none of it is health
                  or fitness advice — just context to make the numbers mean more to you.
                </Text>
              </Animated.View>
            )}
          </Animated.View>
        </Card>
      </View>

      {/* ---- Editor sheets ---- */}
      {editor === 'nickname' && (
        <EditorSheet
          title="Nickname"
          onClose={close}
          onClear={p.nickname.trim() ? () => { setNickDraft(''); setP('nickname', ''); } : undefined}
        >
          <TextInput
            value={nickDraft}
            onChangeText={setNickDraft}
            placeholder="Nickname"
            placeholderTextColor={color.textFaint}
            style={styles.input}
            maxLength={24}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={close}
            accessibilityLabel="Nickname"
            selectionColor={color.accent}
          />
        </EditorSheet>
      )}

      {editor === 'height' && (
        <EditorSheet title="Height" onClose={() => setEditor(null)} onClear={p.heightCm != null ? () => { setP('heightCm', null); setEditor(null); } : undefined}>
          <NumberSlider label="Height" value={p.heightCm ?? DEFAULT_HEIGHT_CM} min={MIN_HEIGHT_CM} max={MAX_HEIGHT_CM} unit="cm" formatValue={(v) => `${v}`} onChange={(v) => setP('heightCm', v)} />
        </EditorSheet>
      )}

      {editor === 'weight' && (
        <EditorSheet title="Weight" onClose={() => setEditor(null)} onClear={p.weightKg != null ? () => { setP('weightKg', null); setEditor(null); } : undefined}>
          <NumberSlider label="Weight" value={p.weightKg ?? DEFAULT_WEIGHT_KG} min={MIN_WEIGHT_KG} max={MAX_WEIGHT_KG} unit="kg" onChange={(v) => setP('weightKg', v)} />
        </EditorSheet>
      )}

      {editor === 'wingspan' && (
        <EditorSheet title="Wingspan" onClose={() => setEditor(null)} onClear={p.wingspanCm != null ? () => { setP('wingspanCm', null); setEditor(null); } : undefined}>
          <NumberSlider label="Wingspan" value={p.wingspanCm ?? DEFAULT_WINGSPAN_CM} min={MIN_WINGSPAN_CM} max={MAX_WINGSPAN_CM} unit="cm" formatValue={(v) => `${v}`} onChange={(v) => setP('wingspanCm', v)} />
        </EditorSheet>
      )}

      {editor === 'birthYear' && (
        <EditorSheet title="Birth year" onClose={() => setEditor(null)} onClear={p.birthYear != null ? () => { setP('birthYear', null); setEditor(null); } : undefined}>
          <NumberSlider label="Birth year" value={p.birthYear ?? DEFAULT_BIRTH_YEAR} min={1930} max={maxBirthYear()} formatValue={(v) => `${v}`} onChange={(v) => setP('birthYear', v)} />
        </EditorSheet>
      )}

      {editor === 'experience' && (
        <EditorSheet title="Experience" onClose={() => setEditor(null)} onClear={p.experience != null ? () => { setP('experience', null); setEditor(null); } : undefined}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Experience level" style={styles.cardStack}>
            {EXPERIENCES.map((v) => (
              <ChoiceCard
                key={v}
                icon={v === 'rookie' ? 'sparkles-outline' : v === 'casual' ? 'walk-outline' : v === 'club' ? 'people-outline' : 'flame-outline'}
                title={EXPERIENCE_LABEL[v]}
                blurb={EXPERIENCE_BLURB[v]}
                selected={p.experience === v}
                onPress={() => setP('experience', v)}
              />
            ))}
          </View>
        </EditorSheet>
      )}

      {editor === 'playsPerWeek' && (
        <EditorSheet title="Plays per week" onClose={() => setEditor(null)} onClear={p.playsPerWeek != null ? () => { setP('playsPerWeek', null); setEditor(null); } : undefined}>
          <ChipSelect label="Sessions per week" options={PLAYS_OPTIONS} value={p.playsPerWeek} onChange={(v) => setP('playsPerWeek', v)} />
        </EditorSheet>
      )}

      {editor === 'position' && (
        <EditorSheet title="Position" onClose={() => setEditor(null)} onClear={p.position != null ? () => { setP('position', null); setEditor(null); } : undefined}>
          <ChipSelect label="Position" options={POSITION_OPTIONS} value={p.position} onChange={(v) => setP('position', v)} />
        </EditorSheet>
      )}

      {editor === 'goal' && (
        <EditorSheet title="Goal" onClose={() => setEditor(null)} onClear={p.trainingGoal != null ? () => { setP('trainingGoal', null); setEditor(null); } : undefined}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Training goal" style={styles.cardStack}>
            {GOALS.map((v) => (
              <ChoiceCard
                key={v}
                icon={v === 'fun' ? 'happy-outline' : v === 'improve' ? 'trending-up-outline' : v === 'team' ? 'shirt-outline' : 'trophy-outline'}
                title={GOAL_LABEL[v]}
                blurb={GOAL_BLURB[v]}
                selected={p.trainingGoal === v}
                onPress={() => setP('trainingGoal', v)}
              />
            ))}
          </View>
        </EditorSheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    // Common tab rhythm — see `layout` in constants/tokens.ts. Profile used to
    // stack tighter than Home/Records, so swiping across visibly compressed
    // the page.
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  settingsBtn: {
    width: touch.minTarget,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    // Full 48dp target, but the eyebrow row keeps its optical height: the
    // button overhangs into the card padding instead of inflating the row.
    marginVertical: -space.md,
    marginRight: -space.sm,
  },
  settingsBtnPressed: {
    backgroundColor: color.surfaceRaised,
  },
  /**
   * The player card is Profile's ENTRY POINT. It used to be loose text on the
   * canvas, so it carried no more weight than the five identical cards below
   * it. Raised surface + a full-weight accent edge (the same emphasis Coach's
   * weekly hero wears) gives the eye somewhere to land first.
   */
  header: {
    gap: space.sm,
    // `surface`, NOT surfaceRaised, even though this is the hero: the header
    // carries a default-tone Chip (the training goal) whose ground IS
    // surfaceRaised, so raising the card would swallow it whole. The emphasis
    // comes from the full-weight accent edge instead — it is the only bordered
    // accent card on the screen, against five hairline-neutral ones.
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.accentEdge,
    padding: layout.cardPadding,
    // Clip the arc backdrop's launch point (it starts just off-canvas).
    overflow: 'hidden',
  },
  headerArc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  eyebrowRow: {
    justifyContent: 'space-between',
  },
  eyebrow: {
    ...type.eyebrow,
    color: color.accent,
  },
  name: {
    ...type.statLarge,
    color: color.text,
  },
  headerChips: {
    flexWrap: 'wrap',
    marginTop: space.xs,
  },
  statStrip: {
    marginTop: space.md,
    alignItems: 'center',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.border,
  },
  progressCard: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    // Hairline-weight accent: the player card above is the hero now, and two
    // full-strength accent borders on one screen cancel each other out.
    borderColor: color.accentEdge,
    padding: layout.cardPadding,
    gap: space.md,
  },
  progressText: {
    gap: space.xs,
  },
  progressTitle: {
    ...type.heading,
    color: color.text,
  },
  progressSub: {
    ...type.body,
    color: color.textDim,
  },
  progressTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  sectionEyebrow: {
    ...type.eyebrow,
    color: color.textFaint,
    marginBottom: space.sm,
  },
  // ---- Trophy case ----
  trophyHead: {
    justifyContent: 'space-between',
  },
  trophyRow: {
    marginTop: space.md,
  },
  /** AchievementRow's medal circle, ringed in the badge's tier metal. */
  trophyMedal: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trophyMedalLocked: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.border,
  },
  trophyEmoji: {
    fontSize: 22,
    lineHeight: 28,
  },
  trophyEmojiLocked: {
    opacity: 0.45,
  },
  trophyCount: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  trophyCountLine: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  trophySub: {
    ...type.caption,
    color: color.textFaint,
  },
  /** Mirrors AchievementRow's NEW pip so "new badge" reads identically. */
  trophyNewPip: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  trophyNewPipText: {
    ...type.micro,
    fontFamily: font.bodySemiBold,
    color: color.onAccent,
  },
  row: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: -space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  rowPressed: {
    backgroundColor: color.surfaceRaised,
  },
  rowIcon: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    ...type.bodyMedium,
    color: color.text,
    flex: 1,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    maxWidth: '55%',
  },
  rowValue: {
    ...type.body,
    color: color.textDim,
    flexShrink: 1,
  },
  rowValueEmpty: {
    color: color.accent,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.xs,
  },
  inlineGroup: {
    gap: space.md,
    paddingVertical: space.xs,
  },
  inlineLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
  whyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.minTarget,
  },
  whyTitle: {
    ...type.heading,
    color: color.text,
  },
  whyBody: {
    gap: space.sm,
    marginTop: space.sm,
  },
  whyText: {
    ...type.body,
    color: color.textDim,
  },
  // ---- Editor sheet ----
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // The one app-wide overlay scrim. Darker than the old 0.55 black; the
    // sheet content below still reads through as shapes, which is all a
    // dismiss target needs to show.
    backgroundColor: color.scrim,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.xl,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.border,
  },
  sheetHeader: {
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sheetTitle: {
    ...type.title,
    color: color.text,
  },
  sheetBody: {
    minHeight: 80,
    justifyContent: 'center',
  },
  clearBtn: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  topBtnPressed: {
    backgroundColor: color.surfaceRaised,
  },
  clearLabel: {
    ...type.bodyMedium,
    color: color.miss,
  },
  cardStack: {
    gap: space.sm,
  },
  input: {
    ...type.statMedium,
    color: color.text,
    borderBottomWidth: 2,
    borderBottomColor: color.border,
    paddingVertical: space.sm,
  },
});
