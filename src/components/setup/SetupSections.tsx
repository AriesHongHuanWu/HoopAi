/**
 * SetupSections — the five Options section bodies for /session/setup, extracted
 * so the screen file only wires state. Every body is PURE presentation:
 * props in, callbacks out, NO store value imports (type-only imports allowed).
 * The parent (setup.tsx) owns all reads/writes to settings/mode stores and
 * passes current values + handlers down.
 *
 * Copy, styles and a11y labels are moved verbatim from the pre-collapse
 * setup.tsx cards so the redesign is a re-layout, not a re-write.
 */
import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { CalibrationHealthCard } from '@/components/CalibrationHealthCard';
import { ModeMark } from '@/components/modes/modeIdentity';
import { Chip, Eyebrow, PillButton, Row } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { GameModeId } from '@/core/types';
import type { KeepMode } from '@/state/settingsStore';

// ---------------------------------------------------------------------------
// Shared copy constants (moved from setup.tsx)

/** Which clips survive a recorded session — labels double as subtitle copy. */
export const KEEP_OPTIONS: { mode: KeepMode; label: string }[] = [
  { mode: 'makes', label: 'Makes only' },
  { mode: 'decided', label: 'Makes + misses' },
  { mode: 'all', label: 'Every shot' },
  { mode: 'none', label: 'No clips' },
];

const CHECKLIST = [
  {
    title: 'Rim fully visible',
    body: 'Frame the whole hoop — rim, net and a bit of backboard.',
  },
  {
    title: '15–30 ft side view',
    body: 'Place the phone 15–30 ft away, 30–60° off the backboard. Straight-on views hide makes.',
  },
  {
    title: 'Phone stable',
    body: 'Use a tripod, or lean the phone against a bag or bottle — portrait or landscape both work. A bumped camera pauses tracking.',
  },
  {
    title: 'Good light',
    body: 'Bright, even light keeps the ball easy to track. Dim gyms cut the frame rate.',
  },
] as const;

// ---------------------------------------------------------------------------
// OptionChip — the shared selectable pill (keepChip styles from setup.tsx)

function OptionChip({
  label,
  selected,
  onPress,
  a11yLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Spoken label when the visual one is terse (e.g. "60s"). */
  a11yLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// 1. Game mode

export interface ModeSectionBodyProps {
  /** Active mode's display name, or null for Free Play fallback. */
  modeName: string | null;
  modeTagline: string | null;
  /** Mode id for the ModeMark glyph ('free' when nothing armed). */
  modeId: string;
  /**
   * A coach drill is armed on the active mode. Drill prescriptions carry
   * their own duration/spot rules — the chips below MUST hide, because
   * re-selecting 'timed'/'spotShooting' here would silently replace the
   * coach prescription with plain spot shooting.
   */
  drillArmed: boolean;
  needsTimer: boolean;
  isSpotShooting: boolean;
  durationSec: number;
  makesPerSpot: number;
  onPickDuration: (sec: number) => void;
  onPickMakes: (n: number) => void;
  onChangeMode: () => void;
  timedDurations: readonly number[];
  spotTargets: readonly number[];
}

export function ModeSectionBody({
  modeName,
  modeTagline,
  modeId,
  drillArmed,
  needsTimer,
  isSpotShooting,
  durationSec,
  makesPerSpot,
  onPickDuration,
  onPickMakes,
  onChangeMode,
  timedDurations,
  spotTargets,
}: ModeSectionBodyProps) {
  return (
    <View>
      <Row style={styles.modeRow} gap={space.md}>
        {/* The mode's Ionicons identity mark (shared ModeMark) — the picker,
            banner and complete sheet all draw this same glyph-on-tint. */}
        <ModeMark modeId={modeId as GameModeId} size={48} />
        <View style={styles.checkBody}>
          <Eyebrow>Game mode</Eyebrow>
          <Text style={styles.itemTitle}>{modeName ?? 'Free Play'}</Text>
          <Text style={styles.itemBody}>{modeTagline ?? 'Just shoot — every make counts.'}</Text>
        </View>
        <PillButton
          label={modeName != null ? 'Change' : 'Choose'}
          variant="ghost"
          onPress={onChangeMode}
          style={styles.modeChange}
        />
      </Row>

      {needsTimer && !drillArmed && (
        <View style={styles.configBlock}>
          <Eyebrow>Duration</Eyebrow>
          <View style={styles.chipWrap}>
            {timedDurations.map((sec) => (
              <OptionChip
                key={sec}
                label={`${sec}s`}
                a11yLabel={`${sec} seconds`}
                selected={durationSec === sec}
                onPress={() => onPickDuration(sec)}
              />
            ))}
          </View>
        </View>
      )}

      {isSpotShooting && !drillArmed && (
        <View style={styles.configBlock}>
          <Eyebrow>Makes per spot</Eyebrow>
          <View style={styles.chipWrap}>
            {spotTargets.map((n) => (
              <OptionChip
                key={n}
                label={`${n}`}
                a11yLabel={`${n} makes per spot`}
                selected={makesPerSpot === n}
                onPress={() => onPickMakes(n)}
              />
            ))}
          </View>
        </View>
      )}

      {drillArmed && <Text style={styles.drillCaption}>Drill rules are set by the drill.</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// 2. Camera & placement

/**
 * Tiny viewfinder diagram for the orientation cards: a phone silhouette
 * framing a minimal court sketch (floor, backboard, rim, ball). Pure Views —
 * decorative only, the card label carries the accessible name.
 */
function OrientDiagram({
  orient,
  selected,
}: {
  orient: 'portrait' | 'landscape';
  selected: boolean;
}) {
  return (
    <View style={styles.orientDiagram}>
      <View
        style={[
          styles.phoneFrame,
          orient === 'portrait' ? styles.phonePortrait : styles.phoneLandscape,
          selected && styles.phoneFrameSelected,
        ]}
      >
        {/* Front camera dot — sells the phone silhouette. */}
        <View
          style={[
            styles.camDot,
            orient === 'portrait' ? styles.camDotPortrait : styles.camDotLandscape,
          ]}
        />
        {/* Court sketch inside the frame: what the camera should see. */}
        <View style={styles.sketchFloor} />
        <View style={styles.sketchBoard} />
        <View style={[styles.sketchRim, selected && styles.sketchRimSelected]} />
        <View style={styles.sketchBall} />
      </View>
    </View>
  );
}

export interface CameraSectionBodyProps {
  orient: 'portrait' | 'landscape';
  onSetOrient: (o: 'portrait' | 'landscape') => void;
  cameraGranted: boolean;
  /** Camera permission can still be requested in-app (not hard-denied). */
  canRequest: boolean;
  onRequestPermission: () => void;
  onOpenSystemSettings: () => void;
  /** recordVideo is on but the mic permission isn't granted yet. */
  showMicNote: boolean;
}

export function CameraSectionBody({
  orient,
  onSetOrient,
  cameraGranted,
  canRequest,
  onRequestPermission,
  onOpenSystemSettings,
  showMicNote,
}: CameraSectionBodyProps) {
  return (
    <View>
      {/* Orientation — two rich cards with mini viewfinder diagrams. */}
      <View>
        <Eyebrow>Orientation</Eyebrow>
        <Text style={styles.itemBody}>
          Lock the camera to how you'll prop your phone — it won't rotate mid-session.
        </Text>
        <Row gap={space.md} style={styles.orientRow}>
          {(['portrait', 'landscape'] as const).map((o) => {
            const selected = orient === o;
            return (
              <Pressable
                key={o}
                accessibilityRole="button"
                accessibilityLabel={
                  o === 'portrait'
                    ? 'Portrait — phone propped upright'
                    : 'Landscape — phone propped on its side'
                }
                accessibilityState={{ selected }}
                onPress={() => onSetOrient(o)}
                style={({ pressed }) => [
                  styles.orientCard,
                  selected && styles.orientCardSelected,
                  pressed && styles.orientCardPressed,
                ]}
              >
                <OrientDiagram orient={o} selected={selected} />
                <Text style={[styles.orientLabel, selected && styles.orientLabelSelected]}>
                  {o === 'portrait' ? 'Portrait' : 'Landscape'}
                </Text>
                <Text style={styles.orientHint}>
                  {o === 'portrait' ? 'Propped upright' : 'Propped sideways'}
                </Text>
                {selected && (
                  <View style={styles.orientCheck}>
                    <Ionicons name="checkmark-circle" size={20} color={color.accent} />
                  </View>
                )}
              </Pressable>
            );
          })}
        </Row>
      </View>

      {/* Camera permission — status copy, action button, ready chip. */}
      <View style={styles.blockGap}>
        <Row style={styles.optionRow} gap={space.md}>
          <View
            style={[
              styles.permBadge,
              { backgroundColor: cameraGranted ? color.makeTint : color.accentTint },
            ]}
          >
            <Ionicons
              name={cameraGranted ? 'videocam' : 'videocam-outline'}
              size={20}
              color={cameraGranted ? color.make : color.accent}
            />
          </View>
          <View style={styles.checkBody}>
            <Text style={styles.itemTitle}>Camera access</Text>
            <Text style={styles.itemBody}>
              {cameraGranted
                ? 'Granted — the live view is ready to go.'
                : canRequest
                  ? 'Needed to watch the rim and track shots. Nothing is uploaded.'
                  : 'Camera access is off. Turn it on in system settings to track shots.'}
            </Text>
          </View>
          {cameraGranted && <Chip label="Ready" tone="make" />}
        </Row>
        {!cameraGranted && (
          <PillButton
            label={canRequest ? 'Allow camera access' : 'Open settings'}
            variant="ghost"
            style={styles.permissionButton}
            onPress={canRequest ? onRequestPermission : onOpenSystemSettings}
          />
        )}
        {showMicNote && (
          <Row gap={space.xs} style={styles.micNoteRow}>
            <Ionicons name="mic-outline" size={13} color={color.textFaint} />
            <Text style={styles.micNote}>
              The microphone is only used for game audio in recordings.
            </Text>
          </Row>
        )}
      </View>

      {/* Placement checklist — check-circle rail from step to step. */}
      <View style={styles.blockGap}>
        <Eyebrow>Placement checklist</Eyebrow>
        {CHECKLIST.map((item, i) => (
          <Row key={item.title} style={styles.checkRow} gap={space.md}>
            <View style={styles.checkRail}>
              <View style={styles.badge}>
                <Ionicons name="checkmark" size={16} color={color.accent} />
              </View>
              {i < CHECKLIST.length - 1 && <View style={styles.railLine} />}
            </View>
            <View style={[styles.checkBody, i < CHECKLIST.length - 1 && styles.checkBodyGap]}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.itemBody}>{item.body}</Text>
            </View>
          </Row>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 3. Recording

export interface RecordingSectionBodyProps {
  recordVideo: boolean;
  keepMode: KeepMode;
  onToggleRecord: (v: boolean) => void;
  onSetKeepMode: (m: KeepMode) => void;
}

export function RecordingSectionBody({
  recordVideo,
  keepMode,
  onToggleRecord,
  onSetKeepMode,
}: RecordingSectionBodyProps) {
  return (
    <View>
      <Row style={styles.optionRow} gap={space.md}>
        <View style={styles.checkBody}>
          <Text style={styles.itemTitle}>Record video</Text>
          <Text style={styles.itemBody}>Save the session so makes become replay clips.</Text>
        </View>
        <Switch
          value={recordVideo}
          onValueChange={onToggleRecord}
          trackColor={{ false: color.surfaceRaised, true: color.accentTint }}
          thumbColor={recordVideo ? color.accent : color.textFaint}
          accessibilityLabel="Record video"
        />
      </Row>
      {recordVideo && (
        <View style={styles.configBlock}>
          <Eyebrow>Keep clips</Eyebrow>
          <View style={styles.chipWrap}>
            {KEEP_OPTIONS.map((opt) => (
              <OptionChip
                key={opt.mode}
                label={opt.label}
                a11yLabel={`Keep clips: ${opt.label}`}
                selected={keepMode === opt.mode}
                onPress={() => onSetKeepMode(opt.mode)}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// 4. Court & ball

const RIM_OPTIONS: { value: 3.05 | 2.6; label: string; a11y: string }[] = [
  { value: 3.05, label: '10 ft standard', a11y: 'Rim height: 10 feet standard' },
  { value: 2.6, label: '8.5 ft youth', a11y: 'Rim height: 8.5 feet youth' },
];

const BALL_OPTIONS: { value: 7 | 6 | 5; label: string; a11y: string }[] = [
  { value: 7, label: "7 · Men's", a11y: "Ball size 7, men's" },
  { value: 6, label: '6 · Women & youth', a11y: 'Ball size 6, women and youth' },
  { value: 5, label: '5 · Kids', a11y: 'Ball size 5, kids' },
];

const RANGE_OPTIONS: { value: 'auto' | '2pt' | '3pt'; label: string; a11y: string }[] = [
  { value: 'auto', label: 'Auto (estimated)', a11y: 'Shot value: auto, estimated' },
  { value: '2pt', label: 'All 2s', a11y: 'Shot value: all 2-pointers' },
  { value: '3pt', label: 'All 3s', a11y: 'Shot value: all 3-pointers' },
];

export interface CourtBallSectionBodyProps {
  rimHeightM: 3.05 | 2.6;
  ballSize: 7 | 6 | 5;
  courtRange: 'auto' | '2pt' | '3pt';
  onSetRimHeight: (m: 3.05 | 2.6) => void;
  onSetBallSize: (s: 7 | 6 | 5) => void;
  onSetCourtRange: (r: 'auto' | '2pt' | '3pt') => void;
}

export function CourtBallSectionBody({
  rimHeightM,
  ballSize,
  courtRange,
  onSetRimHeight,
  onSetBallSize,
  onSetCourtRange,
}: CourtBallSectionBodyProps) {
  return (
    <View>
      <View>
        <Eyebrow>Rim height</Eyebrow>
        <View style={styles.chipWrap}>
          {RIM_OPTIONS.map((opt) => (
            <OptionChip
              key={opt.label}
              label={opt.label}
              a11yLabel={opt.a11y}
              selected={rimHeightM === opt.value}
              onPress={() => onSetRimHeight(opt.value)}
            />
          ))}
        </View>
        <Text style={styles.honestyCaption}>
          The rim is the ruler — the wrong height overstates every distance.
        </Text>
      </View>

      <View style={styles.blockGap}>
        <Eyebrow>Ball size</Eyebrow>
        <View style={styles.chipWrap}>
          {BALL_OPTIONS.map((opt) => (
            <OptionChip
              key={opt.label}
              label={opt.label}
              a11yLabel={opt.a11y}
              selected={ballSize === opt.value}
              onPress={() => onSetBallSize(opt.value)}
            />
          ))}
        </View>
      </View>

      <View style={styles.blockGap}>
        <Eyebrow>Shot value</Eyebrow>
        <View style={styles.chipWrap}>
          {RANGE_OPTIONS.map((opt) => (
            <OptionChip
              key={opt.label}
              label={opt.label}
              a11yLabel={opt.a11y}
              selected={courtRange === opt.value}
              onPress={() => onSetCourtRange(opt.value)}
            />
          ))}
        </View>
        {/* Honesty rule: estimated values are labeled estimated, here and in
            the receipts — auto never pretends to measure the court. */}
        <Text style={styles.honestyCaption}>
          Auto estimates shot value from rim geometry — estimated, not measured.
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 5. Calibration

export function CalibrationSectionBody({
  onOpenGuide,
  entering,
}: {
  onOpenGuide: () => void;
  entering?: React.ComponentProps<typeof CalibrationHealthCard>['entering'];
}) {
  // The health card renders its own Card chrome — the parent mounts this
  // section with CollapsibleSection plainBody so it isn't double-boxed.
  return <CalibrationHealthCard variant="setup" onOpenGuide={onOpenGuide} entering={entering} />;
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Shared row/body scaffolding (moved verbatim from setup.tsx).
  modeRow: {
    alignItems: 'center',
  },
  modeChange: {
    paddingHorizontal: space.lg,
  },
  configBlock: {
    marginTop: space.lg,
  },
  blockGap: {
    marginTop: space.xl,
  },
  optionRow: {
    alignItems: 'center',
  },
  checkBody: {
    flex: 1,
  },
  checkBodyGap: {
    paddingBottom: space.lg,
  },
  itemTitle: {
    ...type.heading,
    color: color.text,
  },
  itemBody: {
    ...type.body,
    color: color.textDim,
    marginTop: 2,
  },
  drillCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.lg,
  },
  honestyCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  // Option chips (keepChip styles from setup.tsx).
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  chipSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  chipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  chipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  chipLabelSelected: {
    color: color.accent,
  },
  // Checklist rail.
  checkRow: {
    alignItems: 'stretch',
  },
  checkRail: {
    width: 28,
    alignItems: 'center',
  },
  railLine: {
    flex: 1,
    width: 1.5,
    borderRadius: 1,
    backgroundColor: color.border,
    marginTop: space.xs,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Camera permission block.
  permBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionButton: {
    marginTop: space.md,
  },
  micNoteRow: {
    marginTop: space.md,
    alignItems: 'flex-start',
  },
  micNote: {
    ...type.caption,
    color: color.textFaint,
    flex: 1,
  },
  // Orientation cards (moved verbatim from setup.tsx).
  orientRow: {
    marginTop: space.md,
    alignItems: 'stretch',
  },
  orientCard: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
  },
  orientCardSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  orientCardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  orientCheck: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
  },
  orientDiagram: {
    height: 64,
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  phoneFrame: {
    borderWidth: 1.5,
    borderColor: color.textDim,
    borderRadius: 6,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  phoneFrameSelected: {
    borderColor: color.accent,
  },
  phonePortrait: {
    width: 34,
    height: 56,
  },
  phoneLandscape: {
    width: 56,
    height: 34,
  },
  camDot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: color.textFaint,
  },
  camDotPortrait: {
    top: 3,
    alignSelf: 'center',
  },
  camDotLandscape: {
    left: 3,
    top: '50%',
    marginTop: -1.5,
  },
  sketchFloor: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    bottom: '10%',
    height: 1.5,
    backgroundColor: color.border,
  },
  sketchBoard: {
    position: 'absolute',
    right: '16%',
    top: '22%',
    width: 2,
    height: '32%',
    borderRadius: 1,
    backgroundColor: color.textDim,
  },
  sketchRim: {
    position: 'absolute',
    right: '26%',
    top: '44%',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: color.textDim,
  },
  sketchRimSelected: {
    borderColor: color.accent,
  },
  sketchBall: {
    position: 'absolute',
    left: '18%',
    bottom: '18%',
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: color.accent,
  },
  orientLabel: {
    ...type.heading,
    color: color.text,
  },
  orientLabelSelected: {
    color: color.accent,
  },
  orientHint: {
    ...type.caption,
    color: color.textFaint,
    marginTop: 2,
  },
});
