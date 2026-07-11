/**
 * Settings — grouped cards wired straight to the persisted settings store.
 * Sections: Feedback (sounds/haptics/voice), Detection (model/rate/debug),
 * Video (record + clip retention), Player (hand, height),
 * Help (restart tutorial / replay onboarding), About (version + model licenses).
 */
import { Ionicons } from '@expo/vector-icons';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  getSoundSource,
  SOUND_PACKS,
  SOUND_PACK_LABELS,
  type SoundPack,
} from '@/camera/soundPacks';
import { BackPill } from '@/components/ShotList';
import { CalibrationHealthCard } from '@/components/CalibrationHealthCard';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { ShootingHand } from '@/core/types';
import {
  HARD_EXAMPLE_EXPORT_LIMIT,
  countHardExamples,
  exportHardExamples,
} from '@/data/hardExamples';
import { runBackupExport, runBackupImport } from '@/data/backupRunner';
import { useCardStagger } from '@/components/motion';
import { haptic } from '@/utils/haptics';
import {
  CLIP_POST_ROLL_MAX,
  CLIP_POST_ROLL_MIN,
  CLIP_PRE_ROLL_MAX,
  CLIP_PRE_ROLL_MIN,
  presetFromKnobs,
  useSettings,
  type DetectionRate,
  type KeepMode,
  type TrackingPreset,
  type VoiceMetric,
} from '@/state/settingsStore';
import * as Device from 'expo-device';
import { resolvedTuning } from '@/camera/deviceTuning';
import { tierLabel, type DeviceTier } from '@/core/deviceProfile';

const MIN_HEIGHT_CM = 120;
const MAX_HEIGHT_CM = 230;
const DEFAULT_HEIGHT_CM = 175;

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

const DETECTION_RATE_OPTIONS: { value: DetectionRate; label: string; blurb: string }[] = [
  { value: 'auto', label: 'Auto · recommended', blurb: 'Smooth tracking on every supported phone.' },
  { value: 'battery', label: 'Battery saver', blurb: 'Cooler phone, longer sessions.' },
  { value: 'max', label: 'Maximum', blurb: 'Newest phones only.' },
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
  blurb: string;
}[] = [
  {
    value: 'accuracy',
    label: 'Best accuracy · recommended',
    blurb: 'YOLOX on CPU — numerically exact, the same path the Test AI screen uses. The most reliable ball tracking; runs in real time on most phones.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    blurb: 'YOLOX on the GPU — faster on phones where the CPU can’t keep up, at a small cost to precision on some devices.',
  },
  {
    value: 'smooth',
    label: 'Smooth · newest phones',
    blurb: 'YOLOX on the GPU, analysing every frame — the smoothest tracking, best on recent phones with power to spare.',
  },
];

/** Selection tick — the haptic util gates on the user's Haptics setting. */
function tick() {
  haptic.selection();
}

/** Human copy for the measured device tier, from the last on-device benchmark. */
function benchmarkSummary(bench: { delegate: string; ms: number } | null): string {
  if (bench == null) return 'Run a session once to benchmark this phone.';
  const tier = bench.ms <= AUTO_PRECISE_MAX_MS ? 'Precise recommended' : 'Standard recommended';
  return `Your phone: ${bench.delegate} · ${bench.ms}ms — ${tier}`;
}

/** Mirrors AUTO_PRECISE_MAX_MS in src/camera/useShotEngine.ts (auto step-down budget). */
const AUTO_PRECISE_MAX_MS = 55;

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
        <Ionicons name={icon} size={14} color={color.accent} />
      </View>
      <Eyebrow>{children}</Eyebrow>
    </Row>
  );
}

function ToggleRow({
  label,
  description,
  value,
  disabled,
  experimental,
  onValueChange,
}: {
  label: string;
  description?: string;
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.selectChip,
        selected && styles.selectChipSelected,
        pressed && !selected && styles.selectChipPressed,
        pressed && selected && { opacity: 0.82 },
      ]}
    >
      {selected && <Ionicons name="checkmark" size={13} color={color.accent} />}
      <Text style={[styles.selectChipLabel, selected && styles.selectChipLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Tracking preset row — the one selector where the active choice must be
 * unmistakable: accent border, tinted fill and a check, while inactive
 * presets stay quiet outlined cards.
 */
function PresetRow({
  label,
  blurb,
  selected,
  onPress,
}: {
  label: string;
  blurb: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={blurb}
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
  selected,
  disabled,
  onPress,
}: {
  label: string;
  blurb: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={blurb}
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
      <Ionicons name="chevron-forward" size={18} color={color.textFaint} />
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
  const playerHeightCm = useSettings((s) => s.playerHeightCm);
  const detectorModel = useSettings((s) => s.detectorModel);
  const detectionRate = useSettings((s) => s.detectionRate);
  const perfMode = useSettings((s) => s.perfMode);
  const detectorEngine = useSettings((s) => s.detectorEngine);
  const detectorAccel = useSettings((s) => s.detectorAccel);
  const lastBenchmark = useSettings((s) => s.lastBenchmark);
  const debugMode = useSettings((s) => s.debugMode);
  const roiZoom = useSettings((s) => s.roiZoom);
  const depthVeto = useSettings((s) => s.depthVeto);
  const reappearance = useSettings((s) => s.reappearance);
  const motionAssist = useSettings((s) => s.motionAssist);
  const metric23 = useSettings((s) => s.metric23);
  const nanoV2 = useSettings((s) => s.nanoV2);
  const useFlightArc = useSettings((s) => s.useFlightArc);
  const replay3d = useSettings((s) => s.replay3d);
  const multiBallGuard = useSettings((s) => s.multiBallGuard);
  const rimGuard = useSettings((s) => s.rimGuard);
  const trackerRescue = useSettings((s) => s.trackerRescue);
  const adaptiveThermal = useSettings((s) => s.adaptiveThermal);
  const lensCheck = useSettings((s) => s.lensCheck);
  const formAnalysis = useSettings((s) => s.formAnalysis);
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
  // page stays a 30-second read; flipping Debug reveals everything.

  // Transient caption shown after "Restart tutorial" is tapped.
  const [tutorialNotice, setTutorialNotice] = useState(false);
  const tutorialNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Correction flywheel (Debug-gated "Improve detection" block): live count of
  // exportable hard examples + a transient caption when an export can't run.
  const [hardExampleCount, setHardExampleCount] = useState<number | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const exportNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (exportNoticeTimer.current != null) clearTimeout(exportNoticeTimer.current);
    if (backupNoticeTimer.current != null) clearTimeout(backupNoticeTimer.current);
  }, []);

  // Count once on mount — corrections happen on other screens, so the number
  // is stable while Settings is open.
  useEffect(() => {
    let alive = true;
    void countHardExamples().then((n) => {
      if (alive) setHardExampleCount(n);
    });
    return () => {
      alive = false;
    };
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

  const runHardExampleExport = async () => {
    tick();
    const result = await exportHardExamples();
    if (!result.ok && result.count > 0) {
      // Collected fine but the share sheet never opened — worth a caption.
      // (ok:false with count 0 can't happen here; the row is disabled at 0.)
      setExportNotice("Couldn't open the share sheet — try again.");
      if (exportNoticeTimer.current != null) clearTimeout(exportNoticeTimer.current);
      exportNoticeTimer.current = setTimeout(() => setExportNotice(null), 3000);
    }
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

  const bumpHeight = (delta: number) => {
    tick();
    // First tap lands on a sensible default; later taps step by 1 cm.
    const next =
      playerHeightCm == null
        ? DEFAULT_HEIGHT_CM
        : Math.min(MAX_HEIGHT_CM, Math.max(MIN_HEIGHT_CM, playerHeightCm + delta));
    set('playerHeightCm', next);
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
        <Card entering={enter(0)}>
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
                  tick();
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
                  tick();
                  set('voiceMetric', opt.value);
                }}
              />
            ))}
          </View>
        </Card>

        {/* Detection */}
        <Card entering={enter(1)}>
          <SectionHeader icon="scan">Detection</SectionHeader>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Tracking mode</Text>
            <Text style={styles.settingDesc}>
              One choice that trades accuracy against speed for your phone. Most
              people never need the advanced controls.
            </Text>
          </View>
          <View style={styles.presetList}>
            {PRESET_OPTIONS.map((opt) => (
              <PresetRow
                key={opt.value}
                label={opt.label}
                blurb={opt.blurb}
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
              Custom — your advanced controls below don&apos;t match a preset.
              Pick one above to snap back to a bundle.
            </Text>
          )}
          <View style={styles.divider} />
          {/* Per-device tuning — the app detects this phone's capability and
              tunes detection for it; the user can override if it runs hot or
              wants max quality. */}
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Your device</Text>
            <Text style={styles.settingDesc}>
              {deviceName} · tuned for{' '}
              <Text style={{ color: color.accent }}>{tierLabel(resolvedTier)}</Text>. We pick the
              detector model and speed that fit your phone. Override only if you know better.
            </Text>
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
          {/* Debug mode is the ONE switch that reveals every advanced knob —
              the settings stay a 30-second read for everyone else. */}
          <ToggleRow
            label="Debug mode"
            description="Show live detector diagnostics and unlock the advanced detection controls below."
            value={debugMode}
            onValueChange={(v) => {
              tick();
              set('debugMode', v);
            }}
          />
          {debugMode && (
          <>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Device benchmark</Text>
            <Text style={styles.settingDesc}>{benchmarkSummary(lastBenchmark)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detector model</Text>
            <Text style={styles.settingDesc}>
              Auto measures your phone at start and picks the best fit —
              precise on recent phones, standard on older ones. You can also
              pin one manually.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="Auto · recommended"
              selected={detectorModel === 'auto'}
              onPress={() => {
                tick();
                set('detectorModel', 'auto');
              }}
            />
            <SelectChip
              label="Standard · fast"
              selected={detectorModel === 'standard'}
              onPress={() => {
                tick();
                set('detectorModel', 'standard');
              }}
            />
            <SelectChip
              label="Precise · accurate"
              selected={detectorModel === 'precise'}
              onPress={() => {
                tick();
                set('detectorModel', 'precise');
              }}
            />
          </View>
          <Text style={styles.tierCaption}>
            Standard: every iPhone since XR · Precise: iPhone 13 and newer recommended.
          </Text>
          <Text style={styles.tierCaption}>
            These Standard/Precise tiers apply only to the YOLO11 fallback below.
          </Text>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detector engine</Text>
            <Text style={styles.settingDesc}>
              YOLOX is the default — an Apache-licensed detector the iPhone GPU
              runs directly for faster, steadier boxes and a clean licence. YOLO11
              is the older fallback (and the Detector model / Performance settings
              above apply to it). Switch anytime.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="YOLOX · default"
              selected={detectorEngine === 'yolox'}
              onPress={() => {
                tick();
                set('detectorEngine', 'yolox');
              }}
            />
            <SelectChip
              label="YOLO11 · fallback"
              selected={detectorEngine === 'yolo'}
              onPress={() => {
                tick();
                set('detectorEngine', 'yolo');
              }}
            />
          </View>
          {detectorEngine === 'yolox' && (
            <>
              <View style={styles.divider} />
              <View style={styles.settingText}>
                <Text style={styles.settingLabel}>YOLOX accelerator</Text>
                <Text style={styles.settingDesc}>
                  CPU is the most accurate (it's what the Test AI screen uses) and
                  runs YOLOX in real time on most phones. GPU is faster but can make
                  the boxes less accurate on some devices. If live tracking looks
                  worse than Test AI, use CPU; if it feels laggy, try GPU. Turn on
                  Debug mode below to see the live fps.
                </Text>
              </View>
              <View style={styles.chipWrap}>
                <SelectChip
                  label="CPU · accurate"
                  selected={detectorAccel === 'cpu'}
                  onPress={() => {
                    tick();
                    set('detectorAccel', 'cpu');
                  }}
                />
                <SelectChip
                  label="GPU · faster"
                  selected={detectorAccel === 'gpu'}
                  onPress={() => {
                    tick();
                    set('detectorAccel', 'gpu');
                  }}
                />
              </View>
            </>
          )}
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Performance</Text>
            <Text style={styles.settingDesc}>
              Input resolution — the biggest accuracy/speed lever. Quality feeds
              the detector a larger image so the small, fast BALL is seen in ~2×
              more frames (YOLOX 640) — best for tracking the ball, but slower.
              Speed is lighter and faster (YOLOX 416) with a hit on a tiny/far
              ball. If the ball keeps getting missed, use Quality.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="Quality · best ball"
              selected={perfMode === 'quality'}
              onPress={() => {
                tick();
                set('perfMode', 'quality');
              }}
            />
            <SelectChip
              label="Speed · faster"
              selected={perfMode === 'speed'}
              onPress={() => {
                tick();
                set('perfMode', 'speed');
              }}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detection rate</Text>
            <Text style={styles.settingDesc}>
              How often each camera frame is analyzed. Lower rates save battery.
            </Text>
          </View>
          {DETECTION_RATE_OPTIONS.map((opt, i) => (
            <View key={opt.value}>
              {i > 0 && <View style={styles.divider} />}
              <OptionRow
                label={opt.label}
                blurb={opt.blurb}
                selected={detectionRate === opt.value}
                onPress={() => {
                  tick();
                  set('detectionRate', opt.value);
                }}
              />
            </View>
          ))}
          <View style={styles.divider} />
          <ToggleRow
            label="Full-flight tracking"
            description="Fits one parabola over the WHOLE shot so the ball keeps being tracked across its entire flight — from the release, under the basket, all the way to the rim — not just near the hoop. On by default; it only recovers real ball detections along the physics path and can't invent a make. Turn off only if a specific phone misbehaves."
            value={useFlightArc}
            onValueChange={(v) => {
              tick();
              set('useFlightArc', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="nano-v2 detector"
            experimental
            description="An aggressive small-ball model for the fast (Nano) rung. Finds a small or fast ball in more frames, but is noisier — it can flash phantom boxes on ceiling lights, rafters or a background hoop, so it runs with a higher confidence bar to hold those back. OFF uses the cleaner conservative model. Only affects the Nano rung (slow phones / Speed); the Tiny model is unchanged. Reloads the detector when toggled."
            value={nanoV2}
            onValueChange={(v) => {
              tick();
              set('nanoV2', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Metric 2/3 distance"
            experimental
            description="Uses the rim's real size (0.45m) and height (3.05m) as a ruler to compute your TRUE shooting distance in meters for the 2/3-point call, instead of the rough on-screen estimate. Falls back automatically when the camera angle can't support it. A successful FT-line calibration on the live screen switches this path on for that session even with this toggle off."
            value={metric23}
            onValueChange={(v) => {
              tick();
              set('metric23', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Parallax guard (optical-illusion)"
            description="Uses your ball's real size vs the rim's to catch a ball that crosses the rim line while flying IN FRONT of (or behind) the hoop — the airball that 'looks like it went in' — instead of counting it as a make. Veto-only: it can cancel a fake make, never invent one, and stays silent beyond its verified range (~1m separation up to ~6m; needs the right Ball size set in Player). ON by default; when it overturns a shot the receipt shows an 'IN FRONT' tag. Takes effect at the next rim lock."
            value={depthVeto}
            onValueChange={(v) => {
              tick();
              set('depthVeto', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Ghost-swish rescue"
            description="When the ball disappears into the net and reappears below the rim on the same flight path, count the make it implies — but only when the net motion or the in-basket detector agrees, so it can never invent a make. Recovers clean swishes the net swallows. ON by default; hardened against rim-bounces and putback fakes."
            value={reappearance}
            onValueChange={(v) => {
              tick();
              set('reappearance', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Rim zoom"
            experimental
            description="When the ball is missed near the basket, re-run the detector on a magnified crop of the rim to recover it at the make/miss moment. Self-limiting — only fires during a shot, only when needed, and only on phones fast enough. Turn on Debug mode to see it working (the 'roi zoom' row)."
            value={roiZoom}
            onValueChange={(v) => {
              tick();
              set('roiZoom', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Motion assist"
            experimental
            description="When the detector loses the ball mid-flight, use frame-to-frame motion to keep following the strongest mover. Can mistake other movement for the ball — leave off unless testing."
            value={motionAssist}
            onValueChange={(v) => {
              tick();
              set('motionAssist', v);
            }}
          />
          <View style={styles.divider} />
          {/* Detection guards — suppression/advisory-only safety nets. None of
              them can ever create a make call; each toggle is an escape hatch. */}
          <Eyebrow>Detection guards</Eyebrow>
          <ToggleRow
            label="Multi-ball guard"
            description="Pause new shot detection while several balls are in the air. Prevents false calls during warmups."
            value={multiBallGuard}
            onValueChange={(v) => {
              tick();
              set('multiBallGuard', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Rim bump guard"
            description="Re-settle the rim quickly after camera bumps and hold judgment while the rim is uncertain."
            value={rimGuard}
            onValueChange={(v) => {
              tick();
              set('rimGuard', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Track rescue"
            description="Recovers a ball the detector keeps seeing but the tracker won’t start on (raised-gate models only). Detection-side only — never changes make/miss judging."
            value={trackerRescue}
            onValueChange={(v) => {
              tick();
              set('trackerRescue', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Thermal auto-throttle"
            description="Ease off detection when the phone runs hot, instead of stuttering."
            value={adaptiveThermal}
            onValueChange={(v) => {
              tick();
              set('adaptiveThermal', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Lens check"
            description="Warn before a session if glare or a smudged lens may hurt tracking."
            value={lensCheck}
            onValueChange={(v) => {
              tick();
              set('lensCheck', v);
            }}
          />
          <View style={styles.divider} />
          {/* Correction flywheel — fully manual, opt-in, one tap. */}
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Improve detection</Text>
            <Text style={styles.settingDesc}>
              Export a manifest of your corrected and unsure shots — the exact
              clips the AI got wrong — to help train better models. Video stays
              on your phone; the export is a text manifest.
            </Text>
          </View>
          <ActionRow
            // Displayed count is capped at the export limit — advertising an
            // uncapped total the export would then silently truncate reads
            // as a bug to the user doing us the favor.
            label={`Export hard examples (${Math.min(
              hardExampleCount ?? 0,
              HARD_EXAMPLE_EXPORT_LIMIT,
            )} available)`}
            description="Opens the share sheet with a JSON manifest of shot timings. No video is attached or uploaded."
            disabled={hardExampleCount == null || hardExampleCount === 0}
            onPress={() => void runHardExampleExport()}
          />
          {exportNotice != null && <Text style={styles.exportNotice}>{exportNotice}</Text>}
          </>
          )}
        </Card>

        {/* Coaching */}
        <Card entering={enter(2)}>
          <SectionHeader icon="school">Coaching</SectionHeader>
          <ToggleRow
            label="Shooting form analysis"
            description="Analyzes your elbow, knee, release and follow-through with a pose model and gives one cue per shot. Runs a second model — best on recent phones (iPhone 12 and newer)."
            value={formAnalysis}
            onValueChange={(v) => {
              tick();
              set('formAnalysis', v);
            }}
          />
        </Card>

        {/* Goals */}
        <Card entering={enter(3)}>
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
            description="A gentle nudge to get some shots up each day. Coming in a store build — needs a notifications capability this preview build doesn't include."
            value={false}
            disabled
            onValueChange={() => {}}
          />
        </Card>

        {/* Video */}
        <Card entering={enter(4)}>
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
          <>
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
          </>
          )}
          <View style={styles.divider} />
          <ActionRow
            label="Manage storage"
            description="See how much space session recordings use and delete old videos. Your stats are always kept — only the video files go."
            onPress={() => {
              tick();
              router.push('/storage');
            }}
          />
        </Card>

        {/* Player */}
        <Card entering={enter(5)}>
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
                  tick();
                  set('shootingHand', opt.value);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Ball size</Text>
            <Text style={styles.settingDesc}>
              The ball is used as a real-world size reference for depth checks
              and distance estimates — set it to what you actually play with.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            {BALL_OPTIONS.map((opt) => (
              <SelectChip
                key={opt.value}
                label={opt.label}
                selected={ballSize === opt.value}
                onPress={() => {
                  tick();
                  set('ballSize', opt.value);
                }}
              />
            ))}
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Rim height</Text>
            <Text style={styles.settingDesc}>
              The rim's height is the ruler for the metric distance estimate —
              set it to the hoop you actually shoot on.
            </Text>
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
              Pin whether your makes score as 2 or 3 when you're shooting from one
              range — accurate scoring without any line setup. Leave on Automatic
              for mixed sessions.
            </Text>
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
                disabled={playerHeightCm != null && playerHeightCm <= MIN_HEIGHT_CM}
                onPress={() => bumpHeight(-1)}
              />
              <Text style={styles.heightValue}>
                {playerHeightCm != null ? `${playerHeightCm}` : '—'}
                <Text style={styles.heightUnit}>{playerHeightCm != null ? ' cm' : ''}</Text>
              </Text>
              <StepperButton
                glyph="+"
                label="Increase height"
                disabled={playerHeightCm != null && playerHeightCm >= MAX_HEIGHT_CM}
                onPress={() => bumpHeight(1)}
              />
            </Row>
          </Row>
        </Card>

        {/* Calibration */}
        <Card entering={enter(6)}>
          <SectionHeader icon="locate">Calibration</SectionHeader>
          {/* `bare` — the health card renders content-only inside this Card. */}
          <CalibrationHealthCard
            variant="settings"
            bare
            onOpenGuide={() => router.push('/calibration-guide')}
          />
        </Card>

        {/* Data */}
        <Card entering={enter(7)}>
          <SectionHeader icon="cloud-download">Data</SectionHeader>
          <ActionRow
            label={backupBusy ? 'Exporting…' : 'Export all data'}
            description="Save a backup file of your sessions, shots, jumps, achievements and challenge points. No video is included — just your stats."
            disabled={backupBusy}
            onPress={() => void runExportAll()}
          />
          <View style={styles.divider} />
          <ActionRow
            label="Import data"
            description="Paste a backup file to merge it in. Existing sessions are kept — only new ones are added, nothing is overwritten."
            disabled={backupBusy}
            onPress={() => {
              tick();
              setImportDraft('');
              setImportOpen(true);
            }}
          />
          {backupNotice != null && <Text style={styles.tutorialNotice}>{backupNotice}</Text>}
        </Card>

        {/* Help */}
        <Card entering={enter(8)}>
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
        </Card>

        {/* About */}
        <Card entering={enter(9)}>
          <SectionHeader icon="information-circle">About</SectionHeader>
          <Row style={styles.settingRow} gap={space.lg}>
            <Text style={styles.settingLabel}>Version</Text>
            <Text style={styles.rowValue}>{version}</Text>
          </Row>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Models & licenses</Text>
            <Text style={styles.aboutBody}>
              Shot detection is trained on Roboflow Universe datasets — "Basketball and rim",
              "Basketball Detection" and "basketball-player-detection-3" — used under CC BY 4.0.
              Make/miss logic references the MIT-licensed projects
              josephattalla/Basketball-Shot-Detection and Ed-Zh/Basketball-Analytics.
            </Text>
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
        </Card>
      </View>

      {/* Import paste sheet — no clipboard/document-picker dependency in this
          build, so the user pastes the backup JSON directly. parseBackup does
          all validation; a bad paste yields a caption, never a crash. */}
      <Modal
        visible={importOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setImportOpen(false)}
      >
        <View style={styles.importBackdrop}>
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
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.lg,
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
    backgroundColor: 'rgba(232, 184, 79, 0.14)',
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
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  presetRowSelected: {
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
  /** Transient failure caption under the hard-example export row. */
  exportNotice: {
    ...type.caption,
    color: color.unsure,
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
  selectChip: {
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  selectChipSelected: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  selectChipPressed: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.textFaint,
  },
  selectChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  selectChipLabelSelected: {
    color: color.accent,
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
    borderWidth: 1,
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
  heightValue: {
    ...type.statMedium,
    color: color.text,
    minWidth: 72,
    textAlign: 'center',
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
  // Import paste sheet (P19).
  importBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    padding: space.lg,
  },
  importSheet: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
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
    borderWidth: 1,
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
    borderWidth: 1,
    borderColor: color.border,
  },
  importBtnPrimary: {
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
