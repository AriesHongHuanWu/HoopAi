/**
 * Settings — grouped cards wired straight to the persisted settings store.
 * Sections: Feedback (sounds/haptics/voice), Detection (model/rate/debug),
 * Video (record + clip retention), Player (hand, height),
 * Help (restart tutorial / replay onboarding), About (version + model licenses).
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  getSoundSource,
  SOUND_PACKS,
  SOUND_PACK_LABELS,
  type SoundPack,
} from '@/camera/soundPacks';
import { BackPill } from '@/components/ShotList';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { ShootingHand } from '@/core/types';
import {
  CLIP_POST_ROLL_MAX,
  CLIP_POST_ROLL_MIN,
  CLIP_PRE_ROLL_MAX,
  CLIP_PRE_ROLL_MIN,
  useSettings,
  type DetectionRate,
  type KeepMode,
  type VoiceMetric,
} from '@/state/settingsStore';

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

const DETECTION_RATE_OPTIONS: { value: DetectionRate; label: string; blurb: string }[] = [
  { value: 'auto', label: 'Auto · recommended', blurb: 'Smooth tracking on every supported phone.' },
  { value: 'battery', label: 'Battery saver', blurb: 'Cooler phone, longer sessions.' },
  { value: 'max', label: 'Maximum', blurb: 'Newest phones only.' },
];

/** Fires selection haptics when the user has them enabled. */
function tick() {
  if (useSettings.getState().hapticsEnabled) void Haptics.selectionAsync();
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

function ToggleRow({
  label,
  description,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <Row style={[styles.settingRow, disabled === true && styles.disabled]} gap={space.lg}>
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        {description != null && <Text style={styles.settingDesc}>{description}</Text>}
      </View>
      <Switch
        accessibilityLabel={label}
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
        pressed && !selected && { backgroundColor: color.surfaceRaised },
      ]}
    >
      <Text style={[styles.selectChipLabel, selected && { color: color.accent }]}>{label}</Text>
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
  onPress,
}: {
  label: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && { backgroundColor: color.surfaceRaised },
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Text style={styles.chevron}>{'›'}</Text>
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
        pressed && { backgroundColor: color.surfaceRaised },
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
  const playerHeightCm = useSettings((s) => s.playerHeightCm);
  const detectorModel = useSettings((s) => s.detectorModel);
  const detectionRate = useSettings((s) => s.detectionRate);
  const perfMode = useSettings((s) => s.perfMode);
  const detectorEngine = useSettings((s) => s.detectorEngine);
  const lastBenchmark = useSettings((s) => s.lastBenchmark);
  const debugMode = useSettings((s) => s.debugMode);
  const formAnalysis = useSettings((s) => s.formAnalysis);
  const dailyGoalMakes = useSettings((s) => s.dailyGoalMakes);
  const set = useSettings((s) => s.set);
  const resetTutorial = useSettings((s) => s.resetTutorial);

  // Transient caption shown after "Restart tutorial" is tapped.
  const [tutorialNotice, setTutorialNotice] = useState(false);
  const tutorialNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Release the sound-pack preview player when leaving the screen.
  useEffect(() => releasePreview, []);
  // Clear the pending notice timer on unmount.
  useEffect(() => () => {
    if (tutorialNoticeTimer.current != null) clearTimeout(tutorialNoticeTimer.current);
  }, []);

  const restartTutorial = () => {
    if (useSettings.getState().hapticsEnabled) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
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
        <Card>
          <Eyebrow>Feedback</Eyebrow>
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
              // Confirm with a tap only when turning haptics ON.
              if (v) void Haptics.selectionAsync();
              set('hapticsEnabled', v);
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
        <Card>
          <Eyebrow>Detection</Eyebrow>
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
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Performance</Text>
            <Text style={styles.settingDesc}>
              Input resolution — the biggest speed lever. Speed runs a 320px
              model (~4× faster, 30–60fps on iPhone XR) with a small hit on a
              tiny or far ball. Quality keeps full 640px accuracy.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="Quality · 640"
              selected={perfMode === 'quality'}
              onPress={() => {
                tick();
                set('perfMode', 'quality');
              }}
            />
            <SelectChip
              label="Speed · 320"
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
            label="Debug mode"
            description="Show live detector diagnostics over the camera."
            value={debugMode}
            onValueChange={(v) => {
              tick();
              set('debugMode', v);
            }}
          />
        </Card>

        {/* Coaching */}
        <Card>
          <Eyebrow>Coaching</Eyebrow>
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
        <Card>
          <Eyebrow>Goals</Eyebrow>
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
        </Card>

        {/* Video */}
        <Card>
          <Eyebrow>Video</Eyebrow>
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
        </Card>

        {/* Player */}
        <Card>
          <Eyebrow>Player</Eyebrow>
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
          <Row style={styles.settingRow} gap={space.lg}>
            <View style={styles.settingText}>
              <Text style={styles.settingLabel}>Height</Text>
              <Text style={styles.settingDesc}>
                Saved to your profile. Not yet used to calibrate estimates — coming in a future
                update.
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

        {/* Help */}
        <Card>
          <Eyebrow>Help</Eyebrow>
          <ActionRow
            label="Restart tutorial"
            description="Replay the coach marks on Home, Live and Summary."
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
        <Card>
          <Eyebrow>About</Eyebrow>
          <Row style={styles.settingRow} gap={space.lg}>
            <Text style={styles.settingLabel}>Version</Text>
            <Text style={styles.settingDesc}>{version}</Text>
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
            label="Privacy policy"
            description="How your camera, video and session data are used and stored."
            onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)}
          />
          <View style={styles.divider} />
          <ActionRow
            label="Contact support"
            description="Questions or an issue with a session? We read every email."
            onPress={() => void Linking.openURL(SUPPORT_EMAIL_URL)}
          />
        </Card>
      </View>
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
  chevron: {
    ...type.statMedium,
    color: color.textFaint,
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
  selectChip: {
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectChipSelected: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  selectChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  optionRow: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.sm,
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
});
