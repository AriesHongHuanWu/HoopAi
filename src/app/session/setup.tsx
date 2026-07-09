/**
 * Session setup — the pre-flight checklist before opening the camera.
 * No camera renders here; we only check permissions and session options.
 */
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';

import { BackPill } from '@/components/ShotList';
import { CalibrationHealthCard } from '@/components/CalibrationHealthCard';
import { ModeMark } from '@/components/modes/modeIdentity';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, font, motion, radius, space, touch, type } from '@/constants/tokens';
import { getModeDef } from '@/core/gameModes';
import { useMode } from '@/state/modeStore';
import { useSession } from '@/state/sessionStore';
import { useSettings, type KeepMode } from '@/state/settingsStore';

const TIMED_DURATIONS = [30, 60, 90, 120] as const;
const SPOT_MAKE_TARGETS = [3, 5, 7, 10] as const;

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

const KEEP_OPTIONS: { mode: KeepMode; label: string }[] = [
  { mode: 'makes', label: 'Makes only' },
  { mode: 'decided', label: 'Makes + misses' },
  { mode: 'all', label: 'Every shot' },
  { mode: 'none', label: 'No clips' },
];

/** Last-glance placement reminders next to the GO button — copy only. */
const PLACEMENT_TIPS: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string }[] = [
  { icon: 'footsteps-outline', label: '15–30 FT SIDE VIEW' },
  { icon: 'scan-outline', label: 'WHOLE RIM VISIBLE' },
  { icon: 'lock-closed-outline', label: 'STEADY PROP' },
];

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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The broadcast GO moment — one oversized live-style button. Same press
 * spring as PillButton, same disabled semantics as the old CTA.
 */
function GoCta({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel="Start session — open the camera"
      accessibilityState={{ disabled }}
      style={[styles.go, disabled && styles.goDisabled, animStyle]}
    >
      <View style={styles.goIcon}>
        <Ionicons name="videocam" size={22} color={color.onAccent} />
      </View>
      <View style={styles.goBody}>
        <Text style={styles.goLabel}>START SESSION</Text>
        <Text style={styles.goSub}>Opens the camera — tracking starts with your first shot</Text>
      </View>
    </AnimatedPressable>
  );
}

export default function SessionSetupScreen() {
  const camera = useCameraPermission();
  const mic = useMicrophonePermission();
  const recordVideo = useSettings((s) => s.recordVideo);
  const keepMode = useSettings((s) => s.keepMode);
  const set = useSettings((s) => s.set);
  const beginSetup = useSession((s) => s.beginSetup);
  const activeMode = useMode((s) => s.activeMode);
  const selectMode = useMode((s) => s.selectMode);
  const modeDef = activeMode != null ? getModeDef(activeMode.modeId) : null;

  // Pre-flight config for the modes that need it — duration for Timed
  // Challenge, makes-per-spot for Spot Shooting. Re-inits the active mode's
  // running state (fresh clock/spots) whenever the player changes the value,
  // so this must happen before the camera opens (initMode is a full reset).
  const [durationSec, setDurationSec] = useState(activeMode?.config?.durationSec ?? 60);
  const [makesPerSpot, setMakesPerSpot] = useState(activeMode?.config?.makesPerSpot ?? 5);
  // Orientation the live session LOCKS to (chosen here). Locking it in live.tsx
  // means the camera never rotates mid-session, so the detection overlay can't
  // dislocate on a portrait/landscape flip. Defaults to portrait.
  const [orient, setOrient] = useState<'portrait' | 'landscape'>('portrait');

  // Entrance stagger — cards drop in one after another; off under reduced motion.
  const reducedMotion = useReducedMotion();
  const enter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.duration(motion.standard).delay(i * 70);

  const openCamera = async () => {
    if (!camera.hasPermission && camera.canRequestPermission) {
      const granted = await camera.requestPermission();
      if (!granted) return;
    }
    if (recordVideo && !mic.hasPermission && mic.canRequestPermission) {
      // Best effort — recording works without game audio if declined.
      await mic.requestPermission();
    }
    beginSetup();
    // Remember the choice so Home's quick-start can skip this screen next time.
    useSettings.getState().set('lastOrient', orient);
    router.push(`/session/live?orient=${orient}`);
  };

  return (
    <Screen scroll>
      <Row style={styles.backRow}>
        <BackPill />
      </Row>
      <Animated.View entering={enter(0)}>
        <Eyebrow>New session</Eyebrow>
        <Text style={styles.title} accessibilityRole="header">
          Get the hoop in frame
        </Text>
        <Text style={styles.lede}>
          One minute of setup keeps make/miss calls accurate all session.
        </Text>
      </Animated.View>

      {/* Chosen game mode (or Free Play when none picked) */}
      <Card entering={enter(1)} style={styles.card}>
        <Row style={styles.modeRow} gap={space.md}>
          {/* The mode's Ionicons identity mark (shared ModeMark) — the picker,
              banner and complete sheet all draw this same glyph-on-tint, so
              the setup card must not fall back to the legacy catalog emoji. */}
          <ModeMark modeId={activeMode?.modeId ?? 'free'} size={48} />
          <View style={styles.checkBody}>
            <Eyebrow>Game mode</Eyebrow>
            <Text style={styles.itemTitle}>{modeDef?.name ?? 'Free Play'}</Text>
            <Text style={styles.itemBody}>
              {modeDef?.tagline ?? 'Just shoot — every make counts.'}
            </Text>
          </View>
          <PillButton
            label={modeDef != null ? 'Change' : 'Choose'}
            variant="ghost"
            onPress={() => router.push('/modes')}
            style={styles.modeChange}
          />
        </Row>

        {modeDef?.needsTimer && (
          <View style={styles.configBlock}>
            <Eyebrow>Duration</Eyebrow>
            <View style={styles.keepWrap}>
              {TIMED_DURATIONS.map((sec) => {
                const selected = durationSec === sec;
                return (
                  <Pressable
                    key={sec}
                    accessibilityRole="button"
                    accessibilityLabel={`${sec} seconds`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setDurationSec(sec);
                      selectMode('timed', { durationSec: sec });
                    }}
                    style={({ pressed }) => [
                      styles.keepChip,
                      selected && styles.keepChipSelected,
                      pressed && styles.keepChipPressed,
                    ]}
                  >
                    <Text style={[styles.keepChipLabel, selected && styles.keepChipLabelSelected]}>
                      {sec}s
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {modeDef?.id === 'spotShooting' && (
          <View style={styles.configBlock}>
            <Eyebrow>Makes per spot</Eyebrow>
            <View style={styles.keepWrap}>
              {SPOT_MAKE_TARGETS.map((n) => {
                const selected = makesPerSpot === n;
                return (
                  <Pressable
                    key={n}
                    accessibilityRole="button"
                    accessibilityLabel={`${n} makes per spot`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setMakesPerSpot(n);
                      selectMode('spotShooting', { makesPerSpot: n });
                    }}
                    style={({ pressed }) => [
                      styles.keepChip,
                      selected && styles.keepChipSelected,
                      pressed && styles.keepChipPressed,
                    ]}
                  >
                    <Text style={[styles.keepChipLabel, selected && styles.keepChipLabelSelected]}>
                      {n}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </Card>

      {/* Placement checklist — check-circle rail from step to step. */}
      <Card entering={enter(2)} style={styles.card}>
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
      </Card>

      {/* Calibration health — receipts for the three rituals + guide entry.
          The component renders its own Card (no style prop), so a plain View
          carries the between-card margin; the entering animation lives on the
          inner Card. Duplicate stagger index is fine (Home precedent). */}
      <View style={styles.card}>
        <CalibrationHealthCard
          variant="setup"
          entering={enter(3)}
          onOpenGuide={() => router.push('/calibration-guide')}
        />
      </View>

      <Card entering={enter(3)} style={styles.card}>
        <Row style={styles.optionRow} gap={space.md}>
          <View style={styles.checkBody}>
            <Text style={styles.itemTitle}>Record video</Text>
            <Text style={styles.itemBody}>Save the session so makes become replay clips.</Text>
          </View>
          <Switch
            value={recordVideo}
            onValueChange={(v) => set('recordVideo', v)}
            trackColor={{ false: color.surfaceRaised, true: color.accentTint }}
            thumbColor={recordVideo ? color.accent : color.textFaint}
            accessibilityLabel="Record video"
          />
        </Row>
        {recordVideo && (
          <View style={styles.keepBlock}>
            <Eyebrow>Keep clips</Eyebrow>
            <View style={styles.keepWrap}>
              {KEEP_OPTIONS.map((opt) => {
                const selected = keepMode === opt.mode;
                return (
                  <Pressable
                    key={opt.mode}
                    accessibilityRole="button"
                    accessibilityLabel={`Keep clips: ${opt.label}`}
                    accessibilityState={{ selected }}
                    onPress={() => set('keepMode', opt.mode)}
                    style={({ pressed }) => [
                      styles.keepChip,
                      selected && styles.keepChipSelected,
                      pressed && styles.keepChipPressed,
                    ]}
                  >
                    <Text style={[styles.keepChipLabel, selected && styles.keepChipLabelSelected]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </Card>

      <Card entering={enter(4)} style={styles.card}>
        <Row style={styles.optionRow} gap={space.md}>
          <View
            style={[
              styles.permBadge,
              { backgroundColor: camera.hasPermission ? color.makeTint : color.accentTint },
            ]}
          >
            <Ionicons
              name={camera.hasPermission ? 'videocam' : 'videocam-outline'}
              size={20}
              color={camera.hasPermission ? color.make : color.accent}
            />
          </View>
          <View style={styles.checkBody}>
            <Text style={styles.itemTitle}>Camera access</Text>
            <Text style={styles.itemBody}>
              {camera.hasPermission
                ? 'Granted — the live view is ready to go.'
                : camera.canRequestPermission
                  ? 'Needed to watch the rim and track shots. Nothing is uploaded.'
                  : 'Camera access is off. Turn it on in system settings to track shots.'}
            </Text>
          </View>
          {camera.hasPermission && <Chip label="Ready" tone="make" />}
        </Row>
        {!camera.hasPermission && (
          <PillButton
            label={camera.canRequestPermission ? 'Allow camera access' : 'Open settings'}
            variant="ghost"
            style={styles.permissionButton}
            onPress={() => {
              if (camera.canRequestPermission) void camera.requestPermission();
              else void Linking.openSettings();
            }}
          />
        )}
        {recordVideo && !mic.hasPermission && (
          <Row gap={space.xs} style={styles.micNoteRow}>
            <Ionicons name="mic-outline" size={13} color={color.textFaint} />
            <Text style={styles.micNote}>
              The microphone is only used for game audio in recordings.
            </Text>
          </Row>
        )}
      </Card>

      {/* Orientation — two rich cards with mini viewfinder diagrams. */}
      <Card entering={enter(5)} style={styles.card}>
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
                onPress={() => setOrient(o)}
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
      </Card>

      {/* Final glance: placement tips strip, then the GO moment. */}
      <Animated.View entering={enter(6)} style={styles.ctaBlock}>
        <View style={styles.tipsStrip}>
          {PLACEMENT_TIPS.map((tip, i) => (
            <React.Fragment key={tip.label}>
              {i > 0 && (
                <Text
                  style={styles.tipDivider}
                  accessible={false}
                  importantForAccessibility="no"
                >
                  ·
                </Text>
              )}
              <View style={styles.tipItem}>
                <Ionicons name={tip.icon} size={12} color={color.accent} />
                <Text style={styles.tipLabel}>{tip.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </View>
        <GoCta
          onPress={() => void openCamera()}
          disabled={!camera.hasPermission && !camera.canRequestPermission}
        />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backRow: {
    marginBottom: space.md,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.xl,
  },
  card: {
    marginBottom: space.lg,
  },
  modeRow: {
    alignItems: 'center',
  },
  configBlock: {
    marginTop: space.lg,
  },
  modeChange: {
    paddingHorizontal: space.lg,
  },
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
  optionRow: {
    alignItems: 'center',
  },
  keepBlock: {
    marginTop: space.lg,
  },
  keepWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  keepChip: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  keepChipSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  keepChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  keepChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  keepChipLabelSelected: {
    color: color.accent,
  },
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
  // --- Orientation cards ------------------------------------------------
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
  // --- Tips strip + GO CTA ----------------------------------------------
  ctaBlock: {
    marginTop: space.sm,
    marginBottom: space.xl,
  },
  tipsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  tipItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  tipLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  tipDivider: {
    ...type.micro,
    color: color.textFaint,
  },
  go: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 72,
    backgroundColor: color.accent,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
  },
  goDisabled: {
    opacity: 0.4,
  },
  goIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(20, 10, 5, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  goBody: {
    flex: 1,
  },
  goLabel: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 26,
    letterSpacing: 1,
    color: color.onAccent,
  },
  goSub: {
    ...type.caption,
    color: color.onAccent,
    opacity: 0.7,
    marginTop: 2,
  },
});
