/**
 * Form Studio 3D — the estimated-reconstruction theater.
 *
 * Takes a shot's persisted 2D FormSequence, lifts it to an ESTIMATED 3D
 * skeleton (anthropometric single-view lift, src/core/pose3d/lift.ts) and lets
 * the user orbit it, scrub the motion, freeze at the estimated release and
 * compare against a synthesized NBA reference form lifted through the SAME
 * pipeline.
 *
 * HONESTY: depth here is INFERRED from body proportions, never measured — the
 * screen says so up front, surfaces the lift's depth confidence through the
 * app-wide confidence language (core/evidence.ts), prefixes shaky angles with
 * "≈" and refuses to render at all when the lift can't stand behind its
 * output. COCO-17 has no hand keypoints, so we ship FOREARM TILT and say why.
 *
 * Works on the LIVE session (no param) or any HISTORY session (?sid=<rowId>),
 * mirroring Form Studio; ?shot=<shotId> preselects a shot. Strictly read-only
 * visualization: nothing flows back into the pipeline, stores or db.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import FormStage3D from '@/components/charts/FormStage3D';
import { Card, Chip, EmptyState, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import { sessionShots, shotFromRow } from '@/data/db';
import { confidenceLabel, confidenceLevel } from '@/core/evidence';
import { decodeSequence, type DecodedFrame } from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceReleaseFrame, referenceSequence } from '@/core/nbaReferenceForms';
import { forearmTiltDeg, frameAngles, releaseReadouts, type AngleReading } from '@/core/pose3d/angles3d';
import { liftSequence } from '@/core/pose3d/lift';
import type { FormSequence, ResolvedShot, ShootingHand } from '@/core/types';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** A shot that carries a decodable form sequence, plus a display label. */
interface Studio3DShot {
  shot: ResolvedShot;
  seq: FormSequence;
  decoded: DecodedFrame[];
  label: string;
}

/** Readout value: null → em-dash; shaky depth (c < medium) → "≈" prefix. */
function angleText(r: AngleReading | null): string {
  if (r == null) return '—';
  const v = Math.round(r.deg);
  return r.c < 0.55 ? `≈${v}°` : `${v}°`;
}

/** One column of the AT RELEASE card: value, label, optional ghost line. */
function ReadoutColumn({
  label,
  a11yName,
  reading,
  refReading,
}: {
  label: string;
  /** Human metric name for the accessibility sentence, e.g. "Elbow angle". */
  a11yName: string;
  reading: AngleReading | null;
  refReading: AngleReading | null;
}) {
  const a11y =
    reading == null
      ? `${a11yName} at release unavailable`
      : `${a11yName} at release, estimated ${Math.round(reading.deg)} degrees${
          reading.c < 0.55 ? ', low depth confidence' : ''
        }`;
  return (
    <View style={styles.readoutCol} accessible accessibilityLabel={a11y}>
      <Text style={styles.readoutValue}>{angleText(reading)}</Text>
      <Text style={styles.readoutLabel}>{label}</Text>
      {refReading != null && (
        <Text style={styles.readoutGhost}>ghost {Math.round(refReading.deg)}°</Text>
      )}
    </View>
  );
}

export default function FormStudio3DScreen() {
  const { sid, shot } = useLocalSearchParams<{ sid?: string; shot?: string }>();
  const reducedMotion = useReducedMotion();
  // Master switch (Settings › Video). The VIEW IN 3D entry button is hidden
  // when off, but this screen is also deep-linkable — so it gates itself:
  // no history fetch, no lift work, just the turned-off card below.
  const replay3d = useSettings((s) => s.replay3d);

  // Live-session shots (used when no sid param).
  const liveEntries = useSession((s) => s.shots);
  const liveShots = useMemo(() => liveEntries.map((e) => e.shot), [liveEntries]);

  // History-session shots (loaded async when sid is present).
  const [historyShots, setHistoryShots] = useState<ResolvedShot[] | null>(null);
  // A malformed ?sid (Number → NaN) is treated as NO sid: the screen falls
  // back to live-session shots instead of gating on a fetch that never runs.
  const historyId = sid != null && Number.isFinite(Number(sid)) ? Number(sid) : null;
  useEffect(() => {
    if (!replay3d || historyId == null) return;
    let alive = true;
    void sessionShots(historyId).then((rows) => {
      if (alive) setHistoryShots(rows.map(shotFromRow));
    });
    return () => {
      alive = false;
    };
  }, [historyId, replay3d]);

  const shots = historyId != null ? (historyShots ?? []) : liveShots;
  const loading = historyId != null && historyShots == null;

  // Shots whose sequence decodes to enough frames for a meaningful lift.
  const studioShots = useMemo<Studio3DShot[]>(() => {
    const out: Studio3DShot[] = [];
    for (const s of shots) {
      const seq = s.form?.sequence;
      if (!seq) continue;
      const decoded = decodeSequence(seq);
      if (decoded.length < 4) continue;
      out.push({ shot: s, seq, decoded, label: `Shot ${s.id} · ${s.outcome}` });
    }
    return out;
  }, [shots]);

  const [shotIdx, setShotIdx] = useState(0);
  const [archIdx, setArchIdx] = useState(0);
  const [ghostOn, setGhostOn] = useState(true);

  // Apply the ?shot preselection once, the first time shots are available.
  const shotParamApplied = useRef(false);
  useEffect(() => {
    if (shotParamApplied.current || studioShots.length === 0) return;
    shotParamApplied.current = true;
    if (shot == null) return;
    const want = Number(shot);
    const i = studioShots.findIndex((s) => s.shot.id === want);
    if (i >= 0) setShotIdx(i);
  }, [studioShots, shot]);
  // Keep selection in range if the underlying data changes.
  useEffect(() => {
    if (shotIdx >= studioShots.length) setShotIdx(0);
  }, [studioShots.length, shotIdx]);

  const selected = studioShots[Math.min(shotIdx, Math.max(0, studioShots.length - 1))] ?? null;
  // CRITICAL: the hand PERSISTED on the sequence — the shot may have been
  // recorded before the user changed the live Settings hand.
  const hand: ShootingHand = selected?.seq.hand ?? 'right';
  const archetype: PlayerArchetype = PLAYER_ARCHETYPES[archIdx] ?? PLAYER_ARCHETYPES[0]!;

  const lifted = useMemo(
    () => (replay3d && selected ? liftSequence(selected.decoded, hand) : null),
    [replay3d, selected, hand],
  );
  // Reference ghost goes through the SAME lift pipeline as the user — honest
  // and consistent (both skeletons carry the same estimation caveats).
  const refLifted = useMemo(
    () => (replay3d && ghostOn ? liftSequence(referenceSequence(archetype, hand), hand) : null),
    [replay3d, ghostOn, archetype, hand],
  );
  const readouts = useMemo(
    () => (lifted && selected ? releaseReadouts(lifted, selected.decoded, hand) : null),
    [lifted, selected, hand],
  );
  const refReadouts = useMemo(() => {
    if (!refLifted) return null;
    const f = Math.max(0, Math.min(referenceReleaseFrame(archetype), refLifted.frames.length - 1));
    const frame = refLifted.frames[f];
    if (!frame) return null;
    const { elbow, knee } = frameAngles(frame, hand);
    return { elbow, knee, forearmTilt: forearmTiltDeg(frame, hand) };
  }, [refLifted, archetype, hand]);

  // ---- Transport (scrub / play / slow-mo / release freeze) ---------------
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slowMo, setSlowMo] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef<number>(0);
  const durationSec = selected?.seq.durationSec || 1.2;

  // Autoplay loop (disabled under reduced motion). Advances `pos` in real
  // time over the sequence's captured duration; slow-mo is a true rate change.
  useEffect(() => {
    if (!playing || reducedMotion) return;
    const rate = slowMo ? 0.25 : 1;
    const step = (ts: number) => {
      if (lastTs.current === 0) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      setPos((p) => {
        const next = p + (dt / durationSec) * rate;
        return next >= 1 ? 0 : next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTs.current = 0;
    };
  }, [playing, slowMo, reducedMotion, durationSec]);

  // Pause playback whenever the selection changes so the new motion starts calm.
  useEffect(() => {
    setPlaying(false);
    setPos(0);
  }, [shotIdx]);

  const frameCount = selected ? selected.decoded.length : 1;
  const curFrame = Math.round(pos * (frameCount - 1));
  const atRelease = readouts != null && curFrame === readouts.frame;

  // Scrub track: tap/drag maps x → pos (RN responder system, no extra deps).
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
  const freezeAtRelease = () => {
    if (readouts == null || selected == null) return;
    setPlaying(false);
    setPos(readouts.frame / Math.max(1, selected.decoded.length - 1));
  };

  // Stage sizing: measured from the card's inner width (onLayout).
  const [stageW, setStageW] = useState(0);

  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  const depthLevel = lifted ? confidenceLevel(lifted.confidence) : null;

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>
        <View>
          <Text style={styles.title} accessibilityRole="header">
            FORM STUDIO 3D
          </Text>
          <Eyebrow>ESTIMATED 3D RECONSTRUCTION</Eyebrow>
        </View>

        {!replay3d ? (
          <EmptyState
            title="3D replay is turned off in Settings"
            body="This screen renders shot replays as a 3D scene, and 3D replay is off on this phone. Turn on 3D replay in Settings › Video, then come back."
            actionLabel="Back"
            onAction={() => router.back()}
          />
        ) : loading ? (
          <Row gap={space.sm} style={styles.loadingRow}>
            <ActivityIndicator color={color.accent} />
            <Text style={styles.dim}>Loading shots…</Text>
          </Row>
        ) : studioShots.length === 0 ? (
          <EmptyState
            title="No 3D-ready shots"
            body="Form Studio 3D needs a shot recorded with Shooting form analysis on (Settings › Coaching). Track a session with your full body in frame, then come back."
            actionLabel="Back"
            onAction={() => router.back()}
          />
        ) : (
          <>
            {/* Honesty banner — depth is inferred, and we say so up front. */}
            {lifted != null && (
              <Card entering={cardEnter(0)}>
                <Text style={styles.body}>
                  Built from one camera. Depth is inferred from body proportions, not
                  measured — treat angles as estimates.
                </Text>
                <View style={styles.honestyChip}>
                  <Chip
                    label={`DEPTH CONFIDENCE: ${confidenceLabel(depthLevel!).toUpperCase()}`}
                    tone={
                      depthLevel === 'high'
                        ? 'accent'
                        : depthLevel === 'medium'
                          ? 'unsure'
                          : 'default'
                    }
                  />
                </View>
              </Card>
            )}

            {/* Shot picker */}
            <Card entering={cardEnter(1)}>
              <Eyebrow>Pick a shot</Eyebrow>
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
            </Card>

            {selected != null && lifted != null && readouts != null ? (
              <>
                {/* The stage */}
                <Card entering={cardEnter(2)}>
                  <Row gap={space.sm} style={{ justifyContent: 'space-between' }}>
                    <Eyebrow>Orbit the estimate</Eyebrow>
                    <Text style={styles.frameCounter}>
                      {curFrame + 1}/{frameCount}
                    </Text>
                  </Row>
                  <View
                    style={styles.stageWrap}
                    onLayout={(e) => setStageW(Math.round(e.nativeEvent.layout.width))}
                  >
                    {stageW > 0 && (
                      <FormStage3D
                        user={lifted}
                        reference={refLifted}
                        pos={pos}
                        width={stageW}
                        height={Math.round(stageW * 1.1)}
                        accessibilityLabel={`Estimated 3D reconstruction of your shooting motion${
                          ghostOn ? ` beside a synthesized ${archetype.name} reference` : ''
                        }. Drag to orbit.`}
                      />
                    )}
                  </View>
                  <Text style={styles.stageCaption}>Drag to orbit · pinch to zoom</Text>

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
                        <Text style={[styles.slowText, slowMo && styles.slowTextOn]}>
                          0.25×
                        </Text>
                      </Pressable>
                    </Row>
                  )}

                  {/* Release freeze — snaps to the 2D-detected release frame. */}
                  <Row gap={space.sm} style={styles.releaseRow}>
                    <PillButton
                      label="RELEASE"
                      variant="ghost"
                      icon="flash-outline"
                      onPress={freezeAtRelease}
                    />
                    {atRelease && <Chip label="RELEASE (est.)" tone="accent" />}
                  </Row>
                </Card>

                {/* At-release readouts */}
                <Card entering={cardEnter(3)}>
                  <Eyebrow>AT RELEASE</Eyebrow>
                  <Row gap={space.md} style={styles.readoutRow}>
                    <ReadoutColumn
                      label="ELBOW"
                      a11yName="Elbow angle"
                      reading={readouts.elbow}
                      refReading={refReadouts?.elbow ?? null}
                    />
                    <ReadoutColumn
                      label="KNEE"
                      a11yName="Knee angle"
                      reading={readouts.knee}
                      refReading={refReadouts?.knee ?? null}
                    />
                    <ReadoutColumn
                      label="FOREARM TILT"
                      a11yName="Forearm tilt"
                      reading={readouts.forearmTilt}
                      refReading={refReadouts?.forearmTilt ?? null}
                    />
                  </Row>
                  <Text style={styles.footnote}>
                    Wrist flexion needs hand tracking the camera can't see — forearm tilt
                    is the honest proxy.
                  </Text>
                </Card>

                {/* Ghost controls */}
                <Card entering={cardEnter(4)}>
                  <Eyebrow>Compare against</Eyebrow>
                  <Pressable
                    onPress={() => setGhostOn((g) => !g)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: ghostOn }}
                    accessibilityLabel="Toggle the NBA ghost overlay"
                    style={[styles.pick, styles.ghostToggle, ghostOn && styles.pickOn]}
                  >
                    <Text style={[styles.pickText, ghostOn && styles.pickTextOn]}>
                      NBA GHOST
                    </Text>
                  </Pressable>
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
                  <Text style={styles.footnote}>
                    Reference forms are synthesized from published mechanics — not motion
                    capture.
                  </Text>
                </Card>
              </>
            ) : (
              /* Lift refused — honest fallback, never a made-up skeleton. */
              <ErrorCard
                title="3D unavailable for this shot"
                body="The camera view hid too much of the body to estimate depth honestly."
                retryLabel="OPEN 2D STUDIO"
                onRetry={() =>
                  router.push({ pathname: '/formstudio', params: sid != null ? { sid } : {} })
                }
              />
            )}
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
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.xs,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  loadingRow: {
    justifyContent: 'center',
    paddingVertical: space.xl,
  },
  body: {
    ...type.body,
    color: color.textDim,
  },
  honestyChip: {
    marginTop: space.md,
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
  ghostToggle: {
    alignSelf: 'flex-start',
    marginBottom: space.md,
  },
  frameCounter: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  stageWrap: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  stageCaption: {
    ...type.micro,
    color: color.textDim,
    textAlign: 'center',
    marginTop: space.sm,
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
  releaseRow: {
    marginTop: space.md,
    flexWrap: 'wrap',
  },
  readoutRow: {
    alignItems: 'flex-start',
    marginTop: space.xs,
  },
  readoutCol: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  readoutValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  readoutLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  readoutGhost: {
    ...type.micro,
    color: color.textDim,
  },
  footnote: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.md,
  },
});
