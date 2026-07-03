/**
 * Settings — grouped cards wired straight to the persisted settings store.
 * Sections: Feedback (sounds/haptics/voice), Video (record + clip retention),
 * Player (hand, height), About (version + model licenses).
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  getSoundSource,
  SOUND_PACKS,
  SOUND_PACK_LABELS,
  type SoundPack,
} from '@/camera/soundPacks';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { ShootingHand } from '@/core/types';
import {
  CLIP_POST_ROLL_MAX,
  CLIP_POST_ROLL_MIN,
  CLIP_PRE_ROLL_MAX,
  CLIP_PRE_ROLL_MIN,
  useSettings,
  type KeepMode,
  type VoiceMetric,
} from '@/state/settingsStore';

const MIN_HEIGHT_CM = 120;
const MAX_HEIGHT_CM = 230;
const DEFAULT_HEIGHT_CM = 175;

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

/** Fires selection haptics when the user has them enabled. */
function tick() {
  if (useSettings.getState().hapticsEnabled) void Haptics.selectionAsync();
}

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
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  unit: string;
  min: number;
  max: number;
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
          onPress={() => bump(-1)}
        />
        <Text
          style={styles.stepValue}
          accessibilityLabel={`${label}: ${value} ${unit}`}
        >
          {value}
          <Text style={styles.stepUnit}>{` ${unit}`}</Text>
        </Text>
        <StepperButton
          glyph="+"
          label={`Increase ${label.toLowerCase()}`}
          disabled={disabled === true || value >= max}
          onPress={() => bump(1)}
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
  const debugMode = useSettings((s) => s.debugMode);
  const set = useSettings((s) => s.set);

  // Release the sound-pack preview player when leaving the screen.
  useEffect(() => releasePreview, []);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
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
        <Row gap={space.sm} style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={goBack}
            hitSlop={space.sm}
            style={({ pressed }) => [styles.backButton, pressed && { backgroundColor: color.surfaceRaised }]}
          >
            <Text style={styles.backGlyph}>{'‹'}</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            Settings
          </Text>
        </Row>

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
              <Text style={styles.settingDesc}>Calibrates release height and arc estimates.</Text>
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
  backButton: {
    width: touch.minTarget,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  backGlyph: {
    ...type.statMedium,
    color: color.text,
  },
  title: {
    ...type.title,
    color: color.text,
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
    minWidth: 56,
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
