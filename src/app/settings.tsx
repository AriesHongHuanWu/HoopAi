/**
 * Settings — grouped cards wired straight to the persisted settings store.
 * Sections: Feedback (sounds/haptics/voice), Detection (tracking preset,
 * device tier, the two make-suppressing guards, Debug — the Debug-gated
 * detector internals live on the pushed /settings-advanced screen),
 * Video (record + clip retention), Player (hand, height),
 * Help (restart tutorial / replay onboarding), About (version + model licenses).
 */
import { Ionicons } from '@expo/vector-icons';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';

import {
  getSoundSource,
  SOUND_PACKS,
  SOUND_PACK_LABELS,
  type SoundPack,
} from '@/camera/soundPacks';
import { BackPill } from '@/components/ShotList';
import { CalibrationHealthCard } from '@/components/CalibrationHealthCard';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, iconSize, layout, motion, radius, space, touch, type } from '@/constants/tokens';
import type { ShootingHand } from '@/core/types';
import { runBackupExport, runBackupImport } from '@/data/backupRunner';
import { useCardStagger, type EnteringProp } from '@/components/motion';
// Concrete paths (the ScreenHeader precedent): suites that stub the motion
// barrel down to the stagger hooks must not lose the wave-3 primitives.
import { SelectableChip } from '@/components/motion/SelectableChip';
import { SheetScrim } from '@/components/motion/SheetScrim';
import { haptic } from '@/utils/haptics';
import {
  CLIP_POST_ROLL_MAX,
  CLIP_POST_ROLL_MIN,
  CLIP_PRE_ROLL_MAX,
  CLIP_PRE_ROLL_MIN,
  presetFromKnobs,
  useSettings,
  type KeepMode,
  type TrackingPreset,
  type VoiceMetric,
} from '@/state/settingsStore';
// Height is PROFILE data — the row's copy says "Saved to your profile", so it
// reads and writes profileStore.heightCm (the store Coach, Jump Lab and the
// wizard actually consume), using the profile's own bounds. settingsStore
// still carries its legacy playerHeightCm key so persisted shapes stay
// migration-stable; the UI just never touches it anymore.
import {
  DEFAULT_HEIGHT_CM,
  MAX_HEIGHT_CM,
  MIN_HEIGHT_CM,
  useProfile,
} from '@/state/profileStore';
import {
  formatDisplayHeight,
  fromDisplayHeight,
  HEIGHT_UNIT_OPTIONS,
  heightUnitSuffix,
  spokenHeight,
  toDisplayHeight,
} from '@/core/heightUnits';
import * as Device from 'expo-device';
import { resolvedTuning } from '@/camera/deviceTuning';
import { tierLabel, type DeviceTier } from '@/core/deviceProfile';

/** Daily goal stepper bounds (see Home's GoalRing). 0 = off. */
const DAILY_GOAL_MIN = 0;
const DAILY_GOAL_MAX = 500;
const DAILY_GOAL_STEP = 10;

/**
 * Privacy policy + support links, required by App Store Connect / Play
 * Console before submission.
 *
 * TODO(launch, blocking): PRIVACY_POLICY_URL currently points at the repo
 * root, NOT a real policy page — there isn't one yet. Publish an actual
 * privacy policy (what the camera/mic/photo-library permissions are used
 * for, that video stays on-device unless the user shares it, whether any
 * analytics/crash reporting is added later) and repoint this before
 * submitting to App Store Connect / Play Console, which also require this
 * same URL in their listing metadata.
 */
const PRIVACY_POLICY_URL = 'https://github.com/AriesHongHuanWu/HoopAi';
const SUPPORT_EMAIL_URL = 'mailto:support@hoopai.app?subject=HoopAI%20support';

const VOICE_OPTIONS: { value: VoiceMetric; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'result', label: 'Make or miss' },
  { value: 'entryAngle', label: 'Entry angle' },
  { value: 'fgPct', label: 'FG%' },
];

const KEEP_OPTIONS: { value: KeepMode; label: string; blurb: string }[] = [
  { value: 'makes', label: 'Makes only', blurb: 'Save a clip for every made shot. The default.' },
  { value: 'decided', label: 'Makes and misses', blurb: 'Save every decided shot; skip unsure ones.' },
  { value: 'all', label: 'Everything', blurb: 'Keep a clip for every attempt, unsure included.' },
  { value: 'none', label: 'No clips', blurb: 'Track stats only; discard video when the session ends.' },
];

const HAND_OPTIONS: { value: ShootingHand; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

const BALL_OPTIONS: { value: 7 | 6 | 5; label: string }[] = [
  { value: 7, label: 'Size 7 · standard' },
  { value: 6, label: 'Size 6 · women/youth' },
  { value: 5, label: 'Size 5 · kids' },
];

const RIM_HEIGHT_OPTIONS: { value: 3.05 | 2.6; label: string; blurb: string }[] = [
  {
    value: 3.05,
    label: 'Standard · 3.05m',
    blurb: "Regulation 10-foot rim — the default.",
  },
  {
    value: 2.6,
    label: 'Youth · 2.6m',
    blurb: 'Lowered youth hoop (about 8.5 feet).',
  },
];

const COURT_RANGE_OPTIONS: {
  value: 'auto' | '2pt' | '3pt';
  label: string;
  blurb: string;
}[] = [
  {
    value: 'auto',
    label: 'Automatic',
    blurb: 'Estimate 2 vs 3 from where you shoot. Best for mixed sessions.',
  },
  {
    value: '2pt',
    label: 'All 2-pointers',
    blurb: 'Every make counts as 2 — for close-range / mid-range work.',
  },
  {
    value: '3pt',
    label: 'All 3-pointers',
    blurb: 'Every make counts as 3 — for a pure 3-point session. No setup needed.',
  },
];

const DEVICE_TIER_OPTIONS: { value: 'auto' | DeviceTier; label: string; blurb: string }[] = [
  { value: 'auto', label: 'Auto · recommended', blurb: 'Detect this phone and tune detection for it.' },
  { value: 'high', label: 'High', blurb: 'Newest phones — most accurate small-ball model, all features.' },
  { value: 'mid', label: 'Balanced', blurb: 'Mid-range phones — a good speed / accuracy mix.' },
  { value: 'entry', label: 'Entry', blurb: 'Older phones (iPhone XR class) — smooth, reliable tracking first.' },
];

/**
 * One-tap tracking presets — the primary Detection control. Each bundles the
 * four advanced knobs (see TRACKING_PRESETS in settingsStore). Ordered most →
 * least accurate; 'accuracy' is the default and the one we recommend because
 * precise ball tracking is what this app lives or dies on.
 */
const PRESET_OPTIONS: {
  value: Exclude<TrackingPreset, 'custom'>;
  label: string;
  /** ONE line on the row (text diet); the full pre-diet blurb is `detail`. */
  blurb: string;
  detail: string;
}[] = [
  {
    value: 'accuracy',
    label: 'Best accuracy · recommended',
    blurb: 'CPU — numerically exact, the most reliable tracking.',
    detail:
      'YOLOX on CPU — numerically exact, the same path the Test AI screen uses. The most reliable ball tracking; runs in real time on most phones.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    blurb: 'GPU — faster where the CPU can’t keep up.',
    detail:
      'YOLOX on the GPU — faster on phones where the CPU can’t keep up, at a small cost to precision on some devices.',
  },
  {
    value: 'smooth',
    label: 'Smooth · newest phones',
    blurb: 'GPU, every frame — for recent phones.',
    detail:
      'YOLOX on the GPU, analysing every frame — the smoothest tracking, best on recent phones with power to spare.',
  },
];

/** Selection tick — the haptic util gates on the user's Haptics setting. */
function tick() {
  haptic.selection();
}

// ---------------------------------------------------------------------------
// Disclosure motion grammar (text-diet sweep): the container that reflows
// rides a quick LinearTransition, revealed copy fades in on the same token,
// and collapse stays an instant unmount by design (no exiting animation).
// Both builders defer to the system Reduce Motion switch.
// ---------------------------------------------------------------------------

const cardReflow = LinearTransition.duration(motion.quick).reduceMotion(ReduceMotion.System);
const detailFade = FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System);
const revealFade = FadeInDown.duration(motion.quick).reduceMotion(ReduceMotion.System);

// ---------------------------------------------------------------------------
// Sound pack preview — plays the pack's make sound on select
// ---------------------------------------------------------------------------

let previewPlayer: AudioPlayer | null = null;

function previewPack(pack: SoundPack) {
  previewPlayer?.release();
  previewPlayer = createAudioPlayer(getSoundSource(pack, 'make'));
  previewPlayer.play();
}

function releasePreview() {
  previewPlayer?.release();
  previewPlayer = null;
}

/** Ionicons glyph name — section bubbles, chip checks, chevrons. */
type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * Card section header — a small accent-tinted icon bubble beside the Eyebrow
 * so each section is scannable by glyph before its label is read.
 * The bubble mirrors the Eyebrow's built-in bottom margin so the pair stays
 * optically centered on one line.
 */
function SectionHeader({ icon, children }: { icon: IconName; children: string }) {
  return (
    <Row gap={space.sm}>
      <View style={styles.sectionIcon}>
        <Ionicons name={icon} size={iconSize.sm} color={color.accent} />
      </View>
      <Eyebrow>{children}</Eyebrow>
    </Row>
  );
}

/**
 * Card whose box grows/shrinks smoothly when a More/Less disclosure (or the
 * Debug reveal) changes its content height. The layout transition rides an
 * inner Animated.View because ui.tsx's Card is read-only and forwards no
 * layout prop — the ShotReceipt expanding-column idiom.
 */
function ReflowCard({ entering, children }: { entering?: EnteringProp; children: ReactNode }) {
  return (
    <Card entering={entering}>
      <Animated.View layout={cardReflow}>{children}</Animated.View>
    </Card>
  );
}

/**
 * "More"/"Less" disclosure — the settings-wide text-diet pattern. Long-form
 * copy is parked here so a row's visible description stays ONE honest
 * sentence; nothing is deleted, it just waits behind one tap.
 */
function MoreDetail({ label, detail }: { label: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {expanded && (
        <Animated.View entering={detailFade}>
          <Text style={styles.settingDesc}>{detail}</Text>
        </Animated.View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? `Less about ${label}` : `More about ${label}`}
        accessibilityState={{ expanded }}
        hitSlop={space.sm}
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => pressed && { opacity: 0.7 }}
      >
        <Text style={styles.moreLink}>{expanded ? 'Less' : 'More'}</Text>
      </Pressable>
    </>
  );
}

function ToggleRow({
  label,
  description,
  detail,
  value,
  disabled,
  experimental,
  onValueChange,
}: {
  label: string;
  /** ONE honest sentence — the full story lives behind `detail`. */
  description?: string;
  /** Collapsed long-form copy behind a "More" disclosure. Never deleted. */
  detail?: string;
  value: boolean;
  disabled?: boolean;
  /** Renders a flask badge so pre-release features read as a class. */
  experimental?: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <Row style={[styles.settingRow, disabled === true && styles.disabled]} gap={space.lg}>
      <View style={styles.settingText}>
        <View style={styles.labelRow}>
          <Text style={styles.settingLabel}>{label}</Text>
          {experimental === true && (
            <View style={styles.flaskBadge}>
              <Ionicons name="flask" size={10} color={color.unsure} />
              <Text style={styles.flaskBadgeLabel}>Experimental</Text>
            </View>
          )}
        </View>
        {description != null && <Text style={styles.settingDesc}>{description}</Text>}
        {detail != null && <MoreDetail label={label} detail={detail} />}
      </View>
      <Switch
        accessibilityLabel={experimental === true ? `${label} (experimental)` : label}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled === true}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: color.border, true: color.accent }}
        thumbColor={color.text}
        ios_backgroundColor={color.border}
      />
    </Row>
  );
}

/**
 * Single-choice pickers on this screen use one of two patterns — pick by
 * content shape, not preference:
 * - SelectChip: short, single-word-ish options with no blurb needed
 *   (sound pack, voice metric, detector model, shooting hand).
 * - OptionRow: options that need a one-line explanation per choice
 *   (detection rate, clip keep mode).
 */
function SelectChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  // SelectableChip owns the press spring, the selected-color crossfade and
  // the (settings-gated) selection tick - call sites no longer tick() here.
  // Same a11y shape as the hand-rolled chip: role button, label, {selected}.
  // `check` keeps the checkmark the hand-rolled chip carried: on a picker
  // the chip is the ONLY record of the choice, so it may not be color-only.
  return <SelectableChip check label={label} selected={selected} onPress={onPress} />;
}

/**
 * Tracking preset row — the one selector where the active choice must be
 * unmistakable: accent border, tinted fill and a check, while inactive
 * presets stay quiet outlined cards.
 */
function PresetRow({
  label,
  blurb,
  detail,
  selected,
  onPress,
}: {
  label: string;
  /** ONE honest sentence — the full story lives behind `detail`. */
  blurb: string;
  /** Collapsed long-form copy behind a "More" disclosure. Never deleted. */
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      // The radio Pressable groups its children away from screen readers, so
      // the hint must carry the FULL story, not just the one-line blurb.
      accessibilityHint={detail != null ? `${blurb} ${detail}` : blurb}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.presetRow,
        selected && styles.presetRowSelected,
        pressed && !selected && { backgroundColor: color.surfaceRaised },
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{blurb}</Text>
        {detail != null && <MoreDetail label={label} detail={detail} />}
      </View>
      {selected ? (
        <Ionicons name="checkmark-circle" size={22} color={color.accent} />
      ) : (
        <View style={styles.presetRadioIdle} />
      )}
    </Pressable>
  );
}

function OptionRow({
  label,
  blurb,
  detail,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  /** ONE honest sentence — the full story lives behind `detail`. */
  blurb: string;
  /** Collapsed long-form copy behind a "More" disclosure. Never deleted. */
  detail?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      // Grouped children are invisible to screen readers — the hint carries
      // the full story when a detail disclosure exists.
      accessibilityHint={detail != null ? `${blurb} ${detail}` : blurb}
      accessibilityState={{ selected, disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && { backgroundColor: color.surfaceRaised },
        disabled === true && styles.disabled,
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{blurb}</Text>
        {detail != null && <MoreDetail label={label} detail={detail} />}
      </View>
      <View style={[styles.radioOuter, selected && { borderColor: color.accent }]}>
        {selected && <View style={styles.radioInner} />}
      </View>
    </Pressable>
  );
}

/** Tappable row for a navigational/one-shot action (chevron affordance). */
function ActionRow({
  label,
  description,
  disabled,
  onPress,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled === true}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && { backgroundColor: color.surfaceRaised },
        disabled === true && styles.disabled,
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={iconSize.lg} color={color.textFaint} />
    </Pressable>
  );
}

function StepperButton({
  glyph,
  label,
  disabled,
  onPress,
}: {
  glyph: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.stepper,
        pressed && styles.stepperPressed,
        disabled === true && styles.disabled,
      ]}
    >
      <Text style={styles.stepperGlyph}>{glyph}</Text>
    </Pressable>
  );
}

/** Stepper row: label + description on the left, − value + on the right. */
function StepperRow({
  label,
  description,
  value,
  unit,
  min,
  max,
  step = 1,
  valueLabel,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  /** Amount each tap changes the value by. Defaults to 1. */
  step?: number;
  /** Override the displayed/spoken value (e.g. "Off" at 0). Defaults to `value`. */
  valueLabel?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const bump = (delta: number) => {
    tick();
    onChange(Math.min(max, Math.max(min, value + delta)));
  };
  return (
    <Row style={[styles.settingRow, disabled === true && styles.disabled]} gap={space.lg}>
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Row gap={space.sm}>
        <StepperButton
          glyph="−"
          label={`Decrease ${label.toLowerCase()}`}
          disabled={disabled === true || value <= min}
          onPress={() => bump(-step)}
        />
        <Text
          style={styles.stepValue}
          accessibilityLabel={`${label}: ${valueLabel ?? `${value} ${unit}`}`}
        >
          {valueLabel ?? (
            <>
              {value}
              <Text style={styles.stepUnit}>{` ${unit}`}</Text>
            </>
          )}
        </Text>
        <StepperButton
          glyph="+"
          label={`Increase ${label.toLowerCase()}`}
          disabled={disabled === true || value >= max}
          onPress={() => bump(step)}
        />
      </Row>
    </Row>
  );
}

export default function SettingsScreen() {
  const soundsEnabled = useSettings((s) => s.soundsEnabled);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const soundPack = useSettings((s) => s.soundPack);
  const recordVideo = useSettings((s) => s.recordVideo);
  const saveToPhotos = useSettings((s) => s.saveToPhotos);
  const keepMode = useSettings((s) => s.keepMode);
  const clipPreRollSec = useSettings((s) => s.clipPreRollSec);
  const clipPostRollSec = useSettings((s) => s.clipPostRollSec);
  const voiceMetric = useSettings((s) => s.voiceMetric);
  const shootingHand = useSettings((s) => s.shootingHand);
  const ballSize = useSettings((s) => s.ballSize);
  const rimHeightM = useSettings((s) => s.rimHeightM);
  const courtRange = useSettings((s) => s.courtRange);
  // The advanced detector knobs (model/engine/rate, experiments, guards) are
  // read on /settings-advanced; this screen only keeps the four preset knobs
  // (to derive the active preset) plus what its own rows render.
  const detectionRate = useSettings((s) => s.detectionRate);
  const perfMode = useSettings((s) => s.perfMode);
  const detectorEngine = useSettings((s) => s.detectorEngine);
  const detectorAccel = useSettings((s) => s.detectorAccel);
  const lastBenchmark = useSettings((s) => s.lastBenchmark);
  const debugMode = useSettings((s) => s.debugMode);
  const rattleGuard = useSettings((s) => s.rattleGuard);
  const settleWindow = useSettings((s) => s.settleWindow);
  const replay3d = useSettings((s) => s.replay3d);
  const formAnalysis = useSettings((s) => s.formAnalysis);
  // Height reads the PROFILE store (see the import comment): the row promises
  // "Saved to your profile", so that has to be literally true.
  const heightCm = useProfile((s) => s.heightCm);
  const setProfileField = useProfile((s) => s.set);
  // Which unit height is SHOWN in — a display preference, so it lives in
  // settings while the value itself stays centimetres in the profile.
  const heightUnit = useSettings((s) => s.heightUnit);
  const dailyGoalMakes = useSettings((s) => s.dailyGoalMakes);
  const set = useSettings((s) => s.set);
  const applyTrackingPreset = useSettings((s) => s.applyTrackingPreset);
  const resetTutorial = useSettings((s) => s.resetTutorial);
  const deviceTierOverride = useSettings((s) => s.deviceTierOverride);
  const setDeviceTier = useSettings((s) => s.setDeviceTier);
  // Live tier: the model-string guess refined by the last measured benchmark.
  const resolvedTier = resolvedTuning(deviceTierOverride, lastBenchmark?.ms ?? null).tier;
  const deviceName = Device.modelName ?? Device.deviceName ?? 'your phone';

  // Staggered card entrance (i = card index top-to-bottom). The hook returns
  // undefined under Reduce Motion, so cards appear in place.
  const enter = useCardStagger({ stepMs: 70, durationMs: 380 });

  // Derived tracking preset (never persisted — always reflects the live knobs).
  const activePreset = presetFromKnobs({
    detectorEngine,
    detectorAccel,
    perfMode,
    detectionRate,
  });
  // Advanced detector knobs live behind Debug mode (two-tier settings): the
  // page stays a 30-second read; flipping Debug reveals the row that pushes
  // /settings-advanced, where every diagnostic knob now lives.

  // Transient caption shown after "Restart tutorial" is tapped.
  const [tutorialNotice, setTutorialNotice] = useState(false);
  const tutorialNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // P19 backup — export/import all data. `backupBusy` guards double taps;
  // `backupNotice` is the transient result caption under the rows.
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const backupNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Import paste sheet (no clipboard/document-picker dep in this build).
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState('');

  const showBackupNotice = (msg: string) => {
    setBackupNotice(msg);
    if (backupNoticeTimer.current != null) clearTimeout(backupNoticeTimer.current);
    backupNoticeTimer.current = setTimeout(() => setBackupNotice(null), 5000);
  };

  // Release the sound-pack preview player when leaving the screen.
  useEffect(() => releasePreview, []);
  // Clear the pending notice timers on unmount.
  useEffect(() => () => {
    if (tutorialNoticeTimer.current != null) clearTimeout(tutorialNoticeTimer.current);
    if (backupNoticeTimer.current != null) clearTimeout(backupNoticeTimer.current);
  }, []);

  const restartTutorial = () => {
    haptic.success();
    resetTutorial();
    setTutorialNotice(true);
    if (tutorialNoticeTimer.current != null) clearTimeout(tutorialNoticeTimer.current);
    tutorialNoticeTimer.current = setTimeout(() => setTutorialNotice(false), 3000);
  };

  const replayOnboarding = () => {
    tick();
    set('onboardingDone', false);
    router.push('/onboarding');
  };

  const runExportAll = async () => {
    if (backupBusy) return;
    tick();
    setBackupBusy(true);
    const ok = await runBackupExport();
    setBackupBusy(false);
    if (!ok) showBackupNotice("Couldn't open the share sheet — try again.");
  };

  const IMPORT_ERRORS: Record<string, string> = {
    'not-json': "That doesn't look like a backup file.",
    'wrong-format': 'This is not a Hoopilot backup.',
    'unsupported-version': 'This backup is from a newer version of the app.',
    malformed: 'This backup is incomplete or damaged.',
    'checksum-mismatch': 'This backup looks corrupted — it may have been truncated.',
    'write-failed': "Couldn't save the imported data — nothing was changed.",
  };

  const runImport = async () => {
    if (backupBusy) return;
    const raw = importDraft.trim();
    if (raw.length === 0) return;
    tick();
    setBackupBusy(true);
    const result = await runBackupImport(raw);
    setBackupBusy(false);
    setImportOpen(false);
    setImportDraft('');
    if (result.ok) {
      haptic.success();
      showBackupNotice(`Imported ${result.imported}, skipped ${result.skipped}.`);
    } else {
      showBackupNotice(IMPORT_ERRORS[result.error] ?? 'Import failed.');
    }
  };

  // Steps by ONE UNIT OF WHAT'S ON SCREEN — 1 cm in metric, 1 inch in
  // imperial, so a tap always moves the readout. What lands in the profile is
  // canonical centimetres either way (src/core/heightUnits.ts).
  const bumpHeight = (delta: number) => {
    tick();
    if (heightCm == null) {
      // First tap lands on a sensible default rather than stepping off a dash.
      setProfileField('heightCm', DEFAULT_HEIGHT_CM);
      return;
    }
    const shown = toDisplayHeight(heightCm, heightUnit) + delta;
    setProfileField(
      'heightCm',
      fromDisplayHeight(shown, heightUnit, MIN_HEIGHT_CM, MAX_HEIGHT_CM),
    );
  };

  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>
        <Text style={styles.title} accessibilityRole="header">
          Settings
        </Text>

        {/* Feedback */}
        <ReflowCard entering={enter(0)}>
          <SectionHeader icon="volume-high">Feedback</SectionHeader>
          <ToggleRow
            label="Sounds"
            description="Swish and rim sounds after every shot."
            value={soundsEnabled}
            onValueChange={(v) => {
              tick();
              set('soundsEnabled', v);
            }}
          />
          <View style={styles.divider} />
          <View style={[styles.settingText, !soundsEnabled && styles.disabled]}>
            <Text style={styles.settingLabel}>Sound pack</Text>
            <Text style={styles.settingDesc}>
              Pick the voice of your feedback sounds. Tap to hear the make.
            </Text>
          </View>
          <View style={[styles.chipWrap, !soundsEnabled && styles.disabled]}>
            {SOUND_PACKS.map((pack) => (
              <SelectChip
                key={pack}
                label={SOUND_PACK_LABELS[pack]}
                selected={soundPack === pack}
                onPress={() => {
                  set('soundPack', pack);
                  if (soundsEnabled) previewPack(pack);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <ToggleRow
            label="Haptics"
            description="Gentle taps for buttons and milestones."
            value={hapticsEnabled}
            onValueChange={(v) => {
              // Write first, then tick: the util gates on the store, so the
              // confirmation tap fires only when haptics were just turned ON.
              set('hapticsEnabled', v);
              haptic.selection();
            }}
          />
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Voice announcements</Text>
            <Text style={styles.settingDesc}>Read one metric aloud after each shot.</Text>
          </View>
          <View style={styles.chipWrap}>
            {VOICE_OPTIONS.map((opt) => (
              <SelectChip
                key={opt.value}
                label={opt.label}
                selected={voiceMetric === opt.value}
                onPress={() => {
                  set('voiceMetric', opt.value);
                }}
              />
            ))}
          </View>
        </ReflowCard>

        {/* Detection */}
        <ReflowCard entering={enter(1)}>
          <SectionHeader icon="scan">Detection</SectionHeader>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Tracking mode</Text>
            {/* Text diet: one line; the pre-diet intro waits behind More. */}
            <Text style={styles.settingDesc}>One choice — accuracy vs speed on your phone.</Text>
            <MoreDetail
              label="Tracking mode"
              detail="One choice that trades accuracy against speed for your phone. Most people never need the advanced controls."
            />
          </View>
          <View style={styles.presetList}>
            {PRESET_OPTIONS.map((opt) => (
              <PresetRow
                key={opt.value}
                label={opt.label}
                blurb={opt.blurb}
                detail={opt.detail}
                selected={activePreset === opt.value}
                onPress={() => {
                  tick();
                  applyTrackingPreset(opt.value);
                }}
              />
            ))}
          </View>
          {activePreset === 'custom' && (
            <Text style={styles.tierCaption}>
              Custom — your advanced detection controls don&apos;t match a preset.
              Pick one above to snap back to a bundle.
            </Text>
          )}
          <View style={styles.divider} />
          {/* Per-device tuning — the app detects this phone's capability and
              tunes detection for it; the user can override if it runs hot or
              wants max quality. */}
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Your device</Text>
            {/* Text diet: the live device·tier read stays on the row (it is
                the receipt); the teaching sentence waits behind More. */}
            <Text style={styles.settingDesc}>
              {deviceName} · tuned for{' '}
              <Text style={{ color: color.accent }}>{tierLabel(resolvedTier)}</Text>.
            </Text>
            <MoreDetail
              label="Your device"
              detail="We pick the detector model and speed that fit your phone. Override only if you know better."
            />
          </View>
          <View style={styles.presetList}>
            {DEVICE_TIER_OPTIONS.map((opt) => (
              <OptionRow
                key={opt.value}
                label={opt.label}
                blurb={opt.blurb}
                selected={deviceTierOverride === opt.value}
                onPress={() => {
                  tick();
                  setDeviceTier(opt.value);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          {/* The two make-suppressing guards live OUTSIDE the debug block on
              purpose. They can only hold a make back, so when one misfires the
              symptom is "my shot wasn't counted" — the user must be able to
              reach the off switch without first discovering Debug mode. */}
          <ToggleRow
            label="Rattle-out guard"
            // Guard honesty COMPRESSED, not deleted: the can-only-downgrade
            // claim stays on the row; the full wording stays in `detail`.
            description="Holds a visible rattle-out as unsure — never invents a miss."
            detail="If you SEE the ball carom back out of the rim — landing outside the hoop, or popping back up above it — hold that shot as 'unsure' instead of counting a make. It now needs to actually see the ball leave the rim; it no longer holds a shot back just because the drop-through was hidden by the net. It can only downgrade a make to unsure, never invent a miss. Turn it off if makes still go uncounted."
            value={rattleGuard}
            onValueChange={(v) => {
              tick();
              set('rattleGuard', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Late bounce-out check"
            // Same compression rule as the rattle guard above.
            description="Waits ~0.13s after a rim-touch drop — can only downgrade to unsure."
            detail="After a shot that TOUCHED the rim drops below it, wait a few frames (~0.13s) to catch a late bounce-out — the ball dips in, then pops back over the rim and out. A clean swish no longer waits, so makes register immediately. Like the guard above, it can only downgrade a make to unsure."
            value={settleWindow}
            onValueChange={(v) => {
              tick();
              set('settleWindow', v);
            }}
          />
          <View style={styles.divider} />
          {/* Debug mode is the ONE switch that reveals the advanced surface —
              the settings stay a 30-second read for everyone else. */}
          <ToggleRow
            label="Debug mode"
            description="Show live diagnostics and unlock the advanced screen below."
            value={debugMode}
            onValueChange={(v) => {
              tick();
              set('debugMode', v);
            }}
          />
          {debugMode && (
            <Animated.View entering={revealFade}>
              <View style={styles.divider} />
              {/* The 14-knob debug block lives on its own pushed screen so
                  the Detection card stays scannable even with Debug on. */}
              <ActionRow
                label="Advanced detection & diagnostics"
                description="Benchmark, detector internals, experiments and exports."
                onPress={() => {
                  tick();
                  router.push('/settings-advanced');
                }}
              />
            </Animated.View>
          )}
        </ReflowCard>

        {/* Coaching */}
        <ReflowCard entering={enter(2)}>
          <SectionHeader icon="school">Coaching</SectionHeader>
          <ToggleRow
            label="Shooting form analysis"
            description="One cue per shot from a pose model."
            detail="Analyzes your elbow, knee, release and follow-through with a pose model, gives one cue per shot, and unlocks Form Studio's side-by-side comparison against an NBA reference. It runs a second model, so on older phones it samples at a lower rate (about 10 times a second) rather than every frame — enough for the dip, set, release and follow-through it compares."
            value={formAnalysis}
            onValueChange={(v) => {
              tick();
              set('formAnalysis', v);
            }}
          />
        </ReflowCard>

        {/* Goals */}
        <ReflowCard entering={enter(3)}>
          <SectionHeader icon="flag">Goals</SectionHeader>
          <StepperRow
            label="Daily goal"
            description="Shows a progress ring on Home for makes logged today. Off hides the ring."
            value={dailyGoalMakes}
            unit={dailyGoalMakes === 0 ? '' : 'makes'}
            min={DAILY_GOAL_MIN}
            max={DAILY_GOAL_MAX}
            step={DAILY_GOAL_STEP}
            valueLabel={dailyGoalMakes === 0 ? 'Off' : undefined}
            onChange={(v) => set('dailyGoalMakes', v)}
          />
          <View style={styles.divider} />
          {/* P18 daily reminder. Local notifications need expo-notifications,
              which isn't bundled in the current Expo Go / preview client — the
              scheduling API is a no-op without a store/dev build. Rather than
              ship a switch that silently does nothing, surface it as a disabled
              "coming soon" row so the intent is visible and honest. When the
              dependency lands, this becomes a working hour-picker toggle. */}
          <ToggleRow
            label="Daily reminder"
            description="Coming in a store build — this preview can't schedule notifications."
            value={false}
            disabled
            onValueChange={() => {}}
          />
        </ReflowCard>

        {/* Video */}
        <ReflowCard entering={enter(4)}>
          <SectionHeader icon="videocam">Video</SectionHeader>
          <ToggleRow
            label="Record sessions"
            description="Capture video while you shoot so clips can be saved."
            value={recordVideo}
            onValueChange={(v) => {
              tick();
              set('recordVideo', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Save recordings to Photos"
            description="Add the full session video to your photo library when a session ends."
            value={saveToPhotos}
            disabled={!recordVideo}
            onValueChange={(v) => {
              tick();
              set('saveToPhotos', v);
            }}
          />
          <View style={styles.divider} />
          {KEEP_OPTIONS.map((opt, i) => (
            <View key={opt.value}>
              {i > 0 && <View style={styles.divider} />}
              <OptionRow
                label={opt.label}
                blurb={opt.blurb}
                selected={keepMode === opt.value}
                disabled={!recordVideo}
                onPress={() => {
                  tick();
                  set('keepMode', opt.value);
                }}
              />
            </View>
          ))}
          <View style={styles.divider} />
          {/* Replay rendering — independent of recording: the 3D theater draws
              from persisted arc/skeleton data, so it works without clips. */}
          <ToggleRow
            label="3D replay"
            description="Render shot replays as a 3D scene. Turn off if replay feels slow on this phone."
            value={replay3d}
            onValueChange={(v) => {
              tick();
              set('replay3d', v);
            }}
          />
          {debugMode && (
          // Same reveal grammar as the Advanced row: Debug-gated content fades
          // in; hiding it stays an instant unmount.
          <Animated.View entering={revealFade}>
          <View style={styles.divider} />
          <StepperRow
            label="Seconds before a make"
            description="How much lead-in each highlight clip keeps."
            value={clipPreRollSec}
            unit="s"
            min={CLIP_PRE_ROLL_MIN}
            max={CLIP_PRE_ROLL_MAX}
            disabled={!recordVideo || keepMode === 'none'}
            onChange={(v) => set('clipPreRollSec', v)}
          />
          <View style={styles.divider} />
          <StepperRow
            label="Seconds after a make"
            description="How long each highlight clip runs past the shot."
            value={clipPostRollSec}
            unit="s"
            min={CLIP_POST_ROLL_MIN}
            max={CLIP_POST_ROLL_MAX}
            disabled={!recordVideo || keepMode === 'none'}
            onChange={(v) => set('clipPostRollSec', v)}
          />
          </Animated.View>
          )}
          <View style={styles.divider} />
          <ActionRow
            label="Manage storage"
            description="Delete old session videos — your stats are always kept."
            onPress={() => {
              tick();
              router.push('/storage');
            }}
          />
        </ReflowCard>

        {/* Player */}
        <ReflowCard entering={enter(5)}>
          <SectionHeader icon="person">Player</SectionHeader>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Shooting hand</Text>
            <Text style={styles.settingDesc}>Used by form analysis to read your release arm.</Text>
          </View>
          <View style={styles.chipWrap}>
            {HAND_OPTIONS.map((opt) => (
              <SelectChip
                key={opt.value}
                label={opt.label}
                selected={shootingHand === opt.value}
                onPress={() => {
                  set('shootingHand', opt.value);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Ball size</Text>
            <Text style={styles.settingDesc}>
              A real-world size reference — set what you actually play with.
            </Text>
            <MoreDetail
              label="Ball size"
              detail="The ball is used as a real-world size reference for depth checks and distance estimates — set it to what you actually play with."
            />
          </View>
          <View style={styles.chipWrap}>
            {BALL_OPTIONS.map((opt) => (
              <SelectChip
                key={opt.value}
                label={opt.label}
                selected={ballSize === opt.value}
                onPress={() => {
                  set('ballSize', opt.value);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Rim height</Text>
            <Text style={styles.settingDesc}>
              The ruler for distance estimates — set your actual hoop.
            </Text>
            <MoreDetail
              label="Rim height"
              detail="The rim's height is the ruler for the metric distance estimate — set it to the hoop you actually shoot on."
            />
          </View>
          {RIM_HEIGHT_OPTIONS.map((opt, i) => (
            <View key={opt.value}>
              {i > 0 && <View style={styles.divider} />}
              <OptionRow
                label={opt.label}
                blurb={opt.blurb}
                selected={rimHeightM === opt.value}
                onPress={() => {
                  tick();
                  set('rimHeightM', opt.value);
                }}
              />
            </View>
          ))}
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Court range</Text>
            <Text style={styles.settingDesc}>
              Score makes as 2 or 3 without any line setup.
            </Text>
            <MoreDetail
              label="Court range"
              detail="Pin whether your makes score as 2 or 3 when you're shooting from one range — accurate scoring without any line setup. Leave on Automatic for mixed sessions."
            />
          </View>
          {COURT_RANGE_OPTIONS.map((opt, i) => (
            <View key={opt.value}>
              {i > 0 && <View style={styles.divider} />}
              <OptionRow
                label={opt.label}
                blurb={opt.blurb}
                selected={courtRange === opt.value}
                onPress={() => {
                  tick();
                  set('courtRange', opt.value);
                }}
              />
            </View>
          ))}
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Height unit</Text>
            <Text style={styles.settingDesc}>
              Show your height in centimetres or in feet and inches. Switching changes the display
              only — never the height itself.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            {HEIGHT_UNIT_OPTIONS.map((opt) => (
              <SelectChip
                key={opt.value}
                label={opt.label}
                selected={heightUnit === opt.value}
                onPress={() => set('heightUnit', opt.value)}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <Row style={styles.settingRow} gap={space.lg}>
            <View style={styles.settingText}>
              <Text style={styles.settingLabel}>Height</Text>
              <Text style={styles.settingDesc}>
                Saved to your profile. Not yet used to calibrate on-court distance — that's coming
                in a future update.
              </Text>
            </View>
            <Row gap={space.sm}>
              <StepperButton
                glyph="−"
                label="Decrease height"
                disabled={heightCm != null && heightCm <= MIN_HEIGHT_CM}
                onPress={() => bumpHeight(-1)}
              />
              {/* Numeral and unit stay separate Texts — see NumberSlider's
                  readout rule; nothing nests inside a hero numeral. */}
              <View
                style={styles.heightReadout}
                accessible
                accessibilityLabel={`Height: ${heightCm != null ? spokenHeight(heightCm, heightUnit) : 'not set'}`}
              >
                <Text style={styles.heightValue}>
                  {heightCm != null
                    ? formatDisplayHeight(toDisplayHeight(heightCm, heightUnit), heightUnit)
                    : '—'}
                </Text>
                {heightCm != null && heightUnitSuffix(heightUnit) != null && (
                  <Text style={styles.heightUnit}>{heightUnitSuffix(heightUnit)}</Text>
                )}
              </View>
              <StepperButton
                glyph="+"
                label="Increase height"
                disabled={heightCm != null && heightCm >= MAX_HEIGHT_CM}
                onPress={() => bumpHeight(1)}
              />
            </Row>
          </Row>
        </ReflowCard>

        {/* Calibration */}
        <ReflowCard entering={enter(6)}>
          <SectionHeader icon="locate">Calibration</SectionHeader>
          {/* `bare` — the health card renders content-only inside this Card. */}
          <CalibrationHealthCard
            variant="settings"
            bare
            onOpenGuide={() => router.push('/calibration-guide')}
          />
        </ReflowCard>

        {/* Data */}
        <ReflowCard entering={enter(7)}>
          <SectionHeader icon="cloud-download">Data</SectionHeader>
          <ActionRow
            label={backupBusy ? 'Exporting…' : 'Export all data'}
            description="Back up sessions, shots, jumps and awards — no video, just stats."
            disabled={backupBusy}
            onPress={() => void runExportAll()}
          />
          <View style={styles.divider} />
          <ActionRow
            label="Import data"
            description="Paste a backup to merge it in — nothing existing is overwritten."
            disabled={backupBusy}
            onPress={() => {
              tick();
              setImportDraft('');
              setImportOpen(true);
            }}
          />
          {backupNotice != null && <Text style={styles.tutorialNotice}>{backupNotice}</Text>}
        </ReflowCard>

        {/* Help */}
        <ReflowCard entering={enter(8)}>
          <SectionHeader icon="help-buoy">Help</SectionHeader>
          <ActionRow
            label="How detection works"
            description="The three signals, receipts and confidence tiers behind every call."
            onPress={() => router.push('/how-it-works')}
          />
          <View style={styles.divider} />
          <ActionRow
            label="Restart tutorial"
            description="Replay the coach marks and first-time hints."
            onPress={restartTutorial}
          />
          {tutorialNotice && (
            <Text style={styles.tutorialNotice}>Tutorial will replay on each screen.</Text>
          )}
          <View style={styles.divider} />
          <ActionRow
            label="Replay onboarding"
            description="See the welcome walkthrough again from the start."
            onPress={replayOnboarding}
          />
        </ReflowCard>

        {/* About */}
        <ReflowCard entering={enter(9)}>
          <SectionHeader icon="information-circle">About</SectionHeader>
          <Row style={styles.settingRow} gap={space.lg}>
            <Text style={styles.settingLabel}>Version</Text>
            <Text style={styles.rowValue}>{version}</Text>
          </Row>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Models & licenses</Text>
            {/* Attribution is NEVER deleted — the one-liner names the license
                classes and the full CC BY 4.0 / MIT credits sit one tap away. */}
            <Text style={styles.aboutBody}>
              Trained on CC BY 4.0 Roboflow datasets + MIT projects.
            </Text>
            <MoreDetail
              label="Models and licenses"
              detail='Shot detection is trained on Roboflow Universe datasets — "Basketball and rim", "Basketball Detection" and "basketball-player-detection-3" — used under CC BY 4.0. Make/miss logic references the MIT-licensed projects josephattalla/Basketball-Shot-Detection and Ed-Zh/Basketball-Analytics.'
            />
          </View>
          <View style={styles.divider} />
          <ActionRow
            label="Legal & privacy"
            description="Privacy policy, terms, and open-source licenses — all read on-device."
            onPress={() => router.push('/legal')}
          />
          <View style={styles.divider} />
          <ActionRow
            label="Contact support"
            description="Questions or an issue with a session? We read every email."
            onPress={() => void Linking.openURL(SUPPORT_EMAIL_URL)}
          />
        </ReflowCard>
      </View>

      {/* Import paste sheet — no clipboard/document-picker dependency in this
          build, so the user pastes the backup JSON directly. parseBackup does
          all validation; a bad paste yields a caption, never a crash. */}
      <Modal
        visible={importOpen}
        transparent
        animationType="none"
        onRequestClose={() => setImportOpen(false)}
      >
        {/* ONE sheet grammar: SheetScrim owns the scrim fade + panel rise
            (Reduce Motion included). Inside an RN Modal `exiting` never
            plays, so only the ENTRANCE moves to the primitive. The old
            animationType="fade" faded the CLOSE too; dismissal is now a hard
            cut. Same trade as the profile sheet - see its note. */}
        <SheetScrim align="center">
          <View style={styles.importSheet}>
            <Text style={styles.importTitle} accessibilityRole="header">
              Import data
            </Text>
            <Text style={styles.settingDesc}>
              Paste the contents of a Hoopilot backup file below. New sessions are
              added; anything you already have is left untouched.
            </Text>
            <TextInput
              value={importDraft}
              onChangeText={setImportDraft}
              placeholder="Paste backup JSON here"
              placeholderTextColor={color.textFaint}
              style={styles.importInput}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Backup file contents"
              selectionColor={color.accent}
            />
            <Row gap={space.md} style={{ justifyContent: 'flex-end' }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel import"
                onPress={() => {
                  setImportOpen(false);
                  setImportDraft('');
                }}
                style={({ pressed }) => [styles.importBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.importBtnLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Import"
                accessibilityState={{ disabled: backupBusy || importDraft.trim().length === 0 }}
                disabled={backupBusy || importDraft.trim().length === 0}
                onPress={() => void runImport()}
                style={({ pressed }) => [
                  styles.importBtn,
                  styles.importBtnPrimary,
                  pressed && { opacity: 0.82 },
                  (backupBusy || importDraft.trim().length === 0) && styles.disabled,
                ]}
              >
                <Text style={[styles.importBtnLabel, styles.importBtnLabelPrimary]}>
                  {backupBusy ? 'Importing…' : 'Import'}
                </Text>
              </Pressable>
            </Row>
          </View>
        </SheetScrim>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  header: {
    marginBottom: space.sm,
  },
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  settingRow: {
    minHeight: touch.minTarget,
    justifyContent: 'space-between',
  },
  settingText: {
    flex: 1,
    gap: space.xs,
    paddingVertical: space.xs,
  },
  settingLabel: {
    ...type.heading,
    color: color.text,
  },
  settingDesc: {
    ...type.body,
    color: color.textDim,
  },
  /** The "More"/"Less" disclosure under a compressed toggle description. */
  moreLink: {
    ...type.bodyMedium,
    color: color.accent,
  },
  aboutBody: {
    ...type.body,
    color: color.textDim,
  },
  tierCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  /** Right-aligned literal values (e.g. version) — brighter than a blurb. */
  rowValue: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  sectionIcon: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    // Mirrors the Eyebrow's built-in bottom margin so the pair stays level.
    marginBottom: space.sm,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  flaskBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    // color.unsure at chip-tint strength (matches the ui.tsx unsure Chip).
    backgroundColor: color.unsureTint,
  },
  flaskBadgeLabel: {
    ...type.micro,
    color: color.unsure,
    textTransform: 'uppercase',
  },
  presetList: {
    gap: space.sm,
    marginTop: space.md,
  },
  presetRow: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.md,
    // Hairline for the plain resting boundary; the selected ring below keeps
    // full weight - borderWidth 1 is reserved for hierarchy, not boxes.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  presetRowSelected: {
    borderWidth: 1,
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  presetRadioIdle: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.border,
  },
  tutorialNotice: {
    ...type.caption,
    color: color.accent,
    marginTop: space.sm,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.md,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  optionRow: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.sm,
    // Inset the pressed wash so it clears the card edge without moving text.
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  disabled: {
    opacity: 0.4,
  },
  stepper: {
    width: touch.minTarget,
    height: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperPressed: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  stepperGlyph: {
    ...type.heading,
    color: color.text,
  },
  // The readout owns the fixed width so the +/- buttons never shuffle as the
  // string changes length (178 cm -> 5'11"); the numeral itself sits natural.
  heightReadout: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: space.xs,
    minWidth: 88,
  },
  heightValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  stepValue: {
    ...type.statMedium,
    color: color.text,
    minWidth: 64,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  stepUnit: {
    ...type.caption,
    color: color.textDim,
  },
  heightUnit: {
    ...type.caption,
    color: color.textDim,
  },
  // Import paste sheet (P19). Scrim + centering live in SheetScrim now.
  importSheet: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
    gap: space.md,
  },
  importTitle: {
    ...type.heading,
    color: color.text,
  },
  importInput: {
    ...type.body,
    color: color.text,
    minHeight: 120,
    maxHeight: 220,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    padding: space.md,
    textAlignVertical: 'top',
  },
  importBtn: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  importBtnPrimary: {
    // Accent ring at full weight - the one emphasized control in the sheet.
    borderWidth: 1,
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  importBtnLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  importBtnLabelPrimary: {
    color: color.accent,
  },
});
