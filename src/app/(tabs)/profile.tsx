/**
 * My Profile — the player's identity card and editor.
 *
 * A broadcast header (nickname, experience chip, and an age/height/weight stat
 * strip) sits over an editable list of every profile field. Each row opens the
 * same picker the first-run wizard used, as a bottom sheet modal, so editing
 * later feels identical to setting it the first time. A "Complete your profile"
 * progress chip appears while tracked fields are still empty, and a collapsed
 * "Why we ask" explainer states plainly that this all stays on the phone and
 * powers coaching + fair comparisons — no health or BMI claims.
 *
 * Everything remains optional: any field can be cleared back to "Add".
 */
import { Ionicons } from '@expo/vector-icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router } from 'expo-router';

import { ChoiceCard, ChipSelect } from '@/components/profile/Choice';
import { NumberSlider } from '@/components/profile/NumberSlider';
import { SeasonCard } from '@/components/SeasonCard';
import { Card, Chip, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { ShootingHand } from '@/core/types';
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
        <Ionicons name={icon} size={15} color={color.accent} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={[styles.rowValue, !filled && styles.rowValueEmpty]} numberOfLines={1}>
          {filled ? value : 'Add'}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={color.textFaint} />
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

export default function ProfileScreen() {
  const reducedMotion = useReducedMotion();
  const enter = (i: number) =>
    reducedMotion ? FadeIn.duration(160) : FadeInDown.duration(360).delay(40 + i * 60);

  const p = useProfile();
  const setP = p.set;
  const shootingHand = useSettings((s) => s.shootingHand);
  const ballSize = useSettings((s) => s.ballSize);
  const setSetting = useSettings((s) => s.set);

  const [editor, setEditor] = useState<EditorKey | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState(p.nickname);

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
        <Row style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint="Open app settings, storage and legal"
            hitSlop={space.sm}
            onPress={() => router.push('/settings')}
            style={({ pressed }) => [styles.settingsBtn, pressed && styles.settingsBtnPressed]}
          >
            <Ionicons name="settings-sharp" size={22} color={color.textDim} />
          </Pressable>
        </Row>

        {/* Broadcast header */}
        <Animated.View entering={enter(0)} style={styles.header}>
          <Text style={styles.eyebrow}>PLAYER CARD</Text>
          <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {p.nickname.trim() || 'Your name'}
          </Text>
          {(expLabel != null || p.trainingGoal != null) && (
            <Row gap={space.sm} style={styles.headerChips}>
              {expLabel != null && <Chip label={expLabel} tone="accent" />}
              {p.trainingGoal != null && <Chip label={GOAL_LABEL[p.trainingGoal]} />}
            </Row>
          )}
          {/* Stat strip — the three headline numbers. Dashes when unknown. */}
          <Row gap={space.xl} style={styles.statStrip}>
            <StatNumber size="medium" value={age != null ? String(age) : '—'} label="Age" />
            <View style={styles.statDivider} />
            <StatNumber
              size="medium"
              value={p.heightCm != null ? String(p.heightCm) : '—'}
              label={p.heightCm != null ? 'cm' : 'Height'}
            />
            <View style={styles.statDivider} />
            <StatNumber
              size="medium"
              value={p.weightKg != null ? String(p.weightKg) : '—'}
              label={p.weightKg != null ? 'kg' : 'Weight'}
            />
          </Row>
        </Animated.View>

        {/* Living season scoreboard — the profile's heartbeat */}
        <SeasonCard entering={enter(1)} />

        {/* Complete-your-profile progress chip (only while incomplete) */}
        {!complete && (
          <Animated.View entering={enter(1)}>
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
        <Card entering={enter(2)}>
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
        <Card entering={enter(3)}>
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
        <Card entering={enter(4)}>
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

        {/* Why we ask — expandable, privacy-first */}
        <Card entering={enter(5)}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: whyOpen }}
            accessibilityLabel="Why we ask"
            accessibilityHint="Explains how your profile is used and stored"
            onPress={() => setWhyOpen((v) => !v)}
            style={styles.whyHeader}
          >
            <Row gap={space.sm}>
              <Ionicons name="lock-closed" size={15} color={color.make} />
              <Text style={styles.whyTitle}>Why we ask</Text>
            </Row>
            <Ionicons name={whyOpen ? 'chevron-up' : 'chevron-down'} size={16} color={color.textFaint} />
          </Pressable>
          {whyOpen && (
            <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(160)} style={styles.whyBody}>
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
    gap: space.lg,
    paddingTop: space.md,
  },
  topBar: {
    justifyContent: 'flex-end',
  },
  settingsBtn: {
    width: touch.minTarget,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  settingsBtnPressed: {
    backgroundColor: color.surfaceRaised,
  },
  header: {
    gap: space.sm,
    paddingVertical: space.sm,
  },
  eyebrow: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1.2,
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
    borderColor: color.accent,
    padding: space.lg,
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
    ...type.caption,
    color: color.textFaint,
    marginBottom: space.sm,
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
    backgroundColor: 'rgba(0,0,0,0.55)',
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
