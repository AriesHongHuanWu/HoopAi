/**
 * Form Studio — the motion-comparison theater.
 *
 * Pick one of your shots that captured a form SEQUENCE, pick an NBA archetype,
 * and watch your shooting motion play beside a synthesized reference form:
 * two animated skeletons, scrubbable, with phase labels, angle callouts and a
 * ranked list of posture-correction cues underneath.
 *
 * HONESTY: this is a 2D MOTION comparison (MoveNet keypoints) with a subtle
 * 2.5D depth illusion (limb layering + parallax + shadow) — NOT a 3D capture.
 * Real 2D→3D lifting is a future upgrade (see src/core/formSequence.ts).
 *
 * Works on the LIVE session (no param) or any HISTORY session (?sid=<rowId>),
 * mirroring the Shot Lab. Reduced motion: autoplay is disabled and a frame
 * stepper replaces the transport.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import { FormMotionStage, type StagePhase } from '@/components/charts/FormMotionStage';
import { Card, Chip, EmptyState, Row, Screen } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
import { sessionShots, shotFromRow } from '@/data/db';
import { decodeSequence, type DecodedFrame } from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { posturePlan, type PostureCue } from '@/core/postureFix';
import type { ResolvedShot } from '@/core/types';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** Frames-per-second the autoplay loop advances the aligned timeline. */
const PLAY_FPS = 20;

/** Phase label for a scrub fraction (matches the reference phase timeline). */
function phaseForPos(pos: number): StagePhase {
  if (pos < 0.35) return 'DIP';
  if (pos < 0.66) return 'RISE';
  if (pos < 0.82) return 'RELEASE';
  return 'FOLLOW';
}

/** A shot that carries a decodable form sequence, plus a display label. */
interface StudioShot {
  shot: ResolvedShot;
  seq: DecodedFrame[];
  label: string;
}

function SectionEyebrow({
  icon,
  children,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  children: string;
}) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

export default function FormStudioScreen() {
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  const { width } = useWindowDimensions();
  const hand = useSettings((s) => s.shootingHand);
  const reducedMotion = useReducedMotion();

  // Live-session shots (used when no sid param).
  const liveEntries = useSession((s) => s.shots);
  const liveShots = useMemo(() => liveEntries.map((e) => e.shot), [liveEntries]);

  // History-session shots (loaded async when sid is present).
  const [historyShots, setHistoryShots] = useState<ResolvedShot[] | null>(null);
  const historyId = sid != null ? Number(sid) : null;
  useEffect(() => {
    if (historyId == null || !Number.isFinite(historyId)) return;
    let alive = true;
    void sessionShots(historyId).then((rows) => {
      if (alive) setHistoryShots(rows.map(shotFromRow));
    });
    return () => {
      alive = false;
    };
  }, [historyId]);

  const shots = historyId != null ? (historyShots ?? []) : liveShots;
  const loading = historyId != null && historyShots == null;

  // Shots that actually captured a motion sequence.
  const studioShots = useMemo<StudioShot[]>(() => {
    const out: StudioShot[] = [];
    for (const shot of shots) {
      const seq = shot.form?.sequence;
      if (!seq) continue;
      const decoded = decodeSequence(seq);
      if (decoded.length < 2) continue;
      out.push({
        shot,
        seq: decoded,
        label: `Shot ${shot.id} · ${shot.outcome}`,
      });
    }
    return out;
  }, [shots]);

  const [shotIdx, setShotIdx] = useState(0);
  const [archIdx, setArchIdx] = useState(0);
  // Keep selection in range if the underlying data changes.
  useEffect(() => {
    if (shotIdx >= studioShots.length) setShotIdx(0);
  }, [studioShots.length, shotIdx]);

  const selected = studioShots[Math.min(shotIdx, Math.max(0, studioShots.length - 1))] ?? null;
  const archetype: PlayerArchetype = PLAYER_ARCHETYPES[archIdx] ?? PLAYER_ARCHETYPES[0]!;

  const reference = useMemo(() => referenceSequence(archetype, hand), [archetype, hand]);
  const cues = useMemo<PostureCue[]>(
    () => (selected ? posturePlan(selected.seq, reference, hand) : []),
    [selected, reference, hand],
  );

  // ---- Transport (scrub / play / slow-mo) --------------------------------
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slowMo, setSlowMo] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef<number>(0);

  // Autoplay loop (disabled under reduced motion). Advances `pos` in real time
  // so slow-mo is a true rate change, and loops back to 0 at the end.
  useEffect(() => {
    if (!playing || reducedMotion) return;
    const rate = slowMo ? 0.25 : 1;
    const step = (ts: number) => {
      if (lastTs.current === 0) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      setPos((p) => {
        // One full pass ≈ 1.4 s at 1×; loop.
        const next = p + (dt / 1.4) * rate;
        return next >= 1 ? 0 : next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTs.current = 0;
    };
  }, [playing, slowMo, reducedMotion]);

  // Pause playback whenever the selection changes so the new motion starts calm.
  useEffect(() => {
    setPlaying(false);
    setPos(0);
  }, [shotIdx, archIdx]);

  const frameCount = selected ? selected.seq.length : 1;
  const phase = phaseForPos(pos);

  // Scrub track: tap/drag maps x → pos. Uses RN's responder system (no extra
  // deps) so it works identically on the reduced-motion stepper screen too.
  const trackWidthRef = useRef(1);
  const seekFromEvent = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    const w = trackWidthRef.current;
    setPos(Math.max(0, Math.min(1, x / w)));
  };
  const stepFrame = (dir: 1 | -1) => {
    const n = frameCount;
    const cur = Math.round(pos * (n - 1));
    const next = Math.max(0, Math.min(n - 1, cur + dir));
    setPos(n <= 1 ? 0 : next / (n - 1));
  };

  const stageW = Math.min(width - 40, 560);
  const stageH = Math.round(stageW * 0.62);

  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>
        <View>
          <Text style={styles.kicker}>FORM STUDIO</Text>
          <Text style={styles.title} accessibilityRole="header">
            Motion Lab
          </Text>
        </View>

        {loading ? (
          <Text style={styles.dim}>Loading session…</Text>
        ) : studioShots.length === 0 ? (
          <EmptyState
            title="No motion captured yet"
            body="Form Studio needs a shot recorded with Shooting form analysis on (Settings › Coaching). Track a session with your body in frame from the side, then come back to compare your motion to an NBA form."
            actionLabel="Back"
            onAction={() => router.back()}
          />
        ) : (
          <>
            {/* Pickers */}
            <Card entering={cardEnter(0)}>
              <SectionEyebrow icon="albums-outline">Pick a shot</SectionEyebrow>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pickerRow}
              >
                {studioShots.map((s, i) => (
                  <Pressable
                    key={s.shot.id}
                    onPress={() => setShotIdx(i)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: i === shotIdx }}
                    style={[styles.pick, i === shotIdx && styles.pickOn]}
                  >
                    <Text style={[styles.pickText, i === shotIdx && styles.pickTextOn]}>
                      {s.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              <SectionEyebrow icon="people-outline">Compare against</SectionEyebrow>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pickerRow}
              >
                {PLAYER_ARCHETYPES.map((a, i) => (
                  <Pressable
                    key={a.name}
                    onPress={() => setArchIdx(i)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: i === archIdx }}
                    style={[styles.pick, i === archIdx && styles.pickOn]}
                  >
                    <Text style={[styles.pickText, i === archIdx && styles.pickTextOn]}>
                      {a.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </Card>

            {/* The theater */}
            {selected && (
              <Card entering={cardEnter(1)}>
                <Row gap={space.sm} style={{ justifyContent: 'space-between' }}>
                  <SectionEyebrow icon="film-outline">Motion comparison</SectionEyebrow>
                  <Text style={styles.frameCounter}>
                    {Math.round(pos * (frameCount - 1)) + 1}/{frameCount}
                  </Text>
                </Row>
                <View style={{ alignItems: 'center', marginTop: space.sm }}>
                  <FormMotionStage
                    user={selected.seq}
                    reference={reference}
                    pos={pos}
                    hand={hand}
                    phase={phase}
                    width={stageW}
                    height={stageH}
                    accessibilityLabel={`Your shooting motion at the ${phase} phase beside a synthesized ${archetype.name} reference form`}
                  />
                </View>

                {/* Scrub track. */}
                <View
                  style={styles.track}
                  onLayout={(e) => {
                    trackWidthRef.current = e.nativeEvent.layout.width;
                  }}
                  onStartShouldSetResponder={() => true}
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={(e) => {
                    setPlaying(false);
                    seekFromEvent(e);
                  }}
                  onResponderMove={seekFromEvent}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Scrub the shooting motion"
                  accessibilityValue={{ now: Math.round(pos * 100), min: 0, max: 100 }}
                >
                  <View style={styles.trackFill} />
                  <View style={[styles.trackProgress, { width: `${pos * 100}%` }]} />
                  <View style={[styles.trackThumb, { left: `${pos * 100}%` }]} />
                </View>

                {/* Transport: reduced-motion → frame stepper; else play/slow-mo. */}
                {reducedMotion ? (
                  <Row gap={space.md} style={styles.transport}>
                    <Pressable
                      onPress={() => stepFrame(-1)}
                      accessibilityRole="button"
                      accessibilityLabel="Previous frame"
                      style={styles.stepBtn}
                    >
                      <Ionicons name="play-back" size={18} color={color.text} />
                    </Pressable>
                    <Text style={styles.phaseInline}>{phase}</Text>
                    <Pressable
                      onPress={() => stepFrame(1)}
                      accessibilityRole="button"
                      accessibilityLabel="Next frame"
                      style={styles.stepBtn}
                    >
                      <Ionicons name="play-forward" size={18} color={color.text} />
                    </Pressable>
                  </Row>
                ) : (
                  <Row gap={space.md} style={styles.transport}>
                    <Pressable
                      onPress={() => {
                        lastTs.current = 0;
                        setPlaying((p) => !p);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={playing ? 'Pause' : 'Play'}
                      style={styles.playBtn}
                    >
                      <Ionicons
                        name={playing ? 'pause' : 'play'}
                        size={20}
                        color={color.onAccent}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => setSlowMo((s) => !s)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: slowMo }}
                      accessibilityLabel="Toggle quarter-speed slow motion"
                      style={[styles.slowBtn, slowMo && styles.slowBtnOn]}
                    >
                      <Text style={[styles.slowText, slowMo && styles.slowTextOn]}>0.25×</Text>
                    </Pressable>
                    <Text style={styles.phaseInline}>{phase}</Text>
                  </Row>
                )}

                <Text style={styles.caption}>
                  Your motion (leather) versus a {archetype.name} reference (chalk, dashed),
                  size-normalized so only the FORM differs. Depth is illustrated with limb
                  layering and shadow — this is a 2D motion comparison, not a 3D capture.
                </Text>
              </Card>
            )}

            {/* Reference form notes */}
            <Card entering={cardEnter(2)}>
              <SectionEyebrow icon="information-circle-outline">
                {`${archetype.name} — the form`}
              </SectionEyebrow>
              <Row gap={space.sm} style={{ marginTop: space.xs, flexWrap: 'wrap' }}>
                <Chip label={archetype.style} tone="accent" />
                <Chip label={archetype.motion} />
                <Chip label={`release ~${archetype.releaseHeightM.toFixed(1)}m`} />
              </Row>
              <Text style={styles.body}>{archetype.mechanics}</Text>
              <Text style={styles.legalCaption}>
                Reference skeleton is SYNTHESIZED from this player's published mechanics
                (release angle, tempo, dip depth, release height) — an idealized coaching
                illustration, not player motion-capture.
              </Text>
            </Card>

            {/* Posture-fix cue cards */}
            <Card entering={cardEnter(3)}>
              <SectionEyebrow icon="construct-outline">Fix your posture</SectionEyebrow>
              {cues.length === 0 ? (
                <Text style={styles.body}>
                  Your motion tracks this reference closely — nothing stands out to correct.
                  Try a different archetype to compare against another style.
                </Text>
              ) : (
                cues.map((cue, i) => (
                  <View
                    key={cue.id}
                    style={[styles.cueItem, i > 0 && styles.cueDivider]}
                  >
                    <Row gap={space.sm} style={{ alignItems: 'center' }}>
                      <View style={styles.cueBadge}>
                        <Text style={styles.cueBadgeText}>{i + 1}</Text>
                      </View>
                      <Text style={[styles.cueJoint, { flex: 1 }]}>{cue.joint}</Text>
                      <View style={styles.cuePhase}>
                        <Text style={styles.cuePhaseText}>{cue.phase}</Text>
                      </View>
                    </Row>
                    <Text style={styles.cueText}>{cue.cue}</Text>
                    <Row gap={space.xs} style={{ alignItems: 'flex-start' }}>
                      <Ionicons
                        name="basketball-outline"
                        size={13}
                        color={color.accent}
                        style={{ marginTop: 3 }}
                      />
                      <Text style={[styles.cueDrill, { flex: 1 }]}>Drill: {cue.drill}</Text>
                    </Row>
                  </View>
                ))
              )}
            </Card>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  header: {
    marginBottom: space.sm,
  },
  kicker: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  eyebrowRow: {
    marginBottom: space.sm,
    marginTop: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  pickerRow: {
    gap: space.sm,
    paddingVertical: 2,
    paddingRight: space.sm,
  },
  pick: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  pickOn: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  pickText: {
    ...type.caption,
    color: color.textDim,
  },
  pickTextOn: {
    color: color.accent,
  },
  frameCounter: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 28,
    marginTop: space.md,
    justifyContent: 'center',
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.surfaceRaised,
  },
  trackProgress: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.accent,
  },
  trackThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.bg,
  },
  transport: {
    marginTop: space.md,
    alignItems: 'center',
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slowBtn: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  slowBtnOn: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  slowText: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  slowTextOn: {
    color: color.accent,
  },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseInline: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  legalCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
    fontStyle: 'italic',
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  cueItem: {
    marginTop: space.md,
    gap: space.xs,
  },
  cueDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: space.md,
  },
  cueBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cueBadgeText: {
    fontFamily: font.display,
    fontSize: 13,
    lineHeight: 16,
    color: color.accent,
  },
  cueJoint: {
    ...type.heading,
    color: color.text,
  },
  cuePhase: {
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  cuePhaseText: {
    ...type.micro,
    color: color.textDim,
    letterSpacing: 0.6,
  },
  cueText: {
    ...type.body,
    color: color.textDim,
  },
  cueDrill: {
    ...type.body,
    color: color.text,
  },
});
