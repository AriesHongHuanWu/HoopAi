/**
 * Form Studio 3D — the estimated-reconstruction theater.
 *
 * Takes a shot's persisted 2D FormSequence, lifts it to an ESTIMATED 3D
 * skeleton (anthropometric single-view lift, src/core/pose3d/lift.ts) and lets
 * the user orbit it, scrub the motion, freeze at the estimated release and
 * compare against a synthesized NBA reference form lifted through the SAME
 * pipeline — or against a second shot of their own, side by side under one
 * shared camera and one shared scrub.
 *
 * Camera: the screen OWNS the orbit camera (FormStage3D runs controlled via
 * camera/onCameraChange) so presets (FRONT/SIDE/TOP/RESET) can tween to clean
 * angles, a slow auto-orbit can showcase the motion, and both compare stages
 * stay locked to the same viewpoint. Any user gesture on a stage cancels the
 * tween and the auto-orbit — the user always wins. Under reduced motion the
 * presets snap instantly and the ORBIT control is hidden entirely.
 *
 * HONESTY: depth here is INFERRED from body proportions, never measured — the
 * screen says so up front, surfaces the lift's depth confidence through the
 * app-wide confidence language (core/evidence.ts), prefixes shaky angles with
 * "≈" (including the in-scene release callouts), captions the wrist trail as
 * pose-derived (not ball tracking) and refuses to render at all when the lift
 * can't stand behind its output. COCO-17 has no hand keypoints, so we ship
 * FOREARM TILT and say why. The shared still re-renders the scene offscreen
 * (never screenshots) so the ESTIMATED stamp is baked into the export.
 *
 * Works on the LIVE session (no param) or any HISTORY session (?sid=<rowId>),
 * mirroring Form Studio; ?shot=<shotId> preselects a shot. Strictly read-only
 * visualization: nothing flows back into the pipeline, stores or db (the only
 * write is markTutorialSeen via useCoachMarks).
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
import FormStage3D, { type StageCallout } from '@/components/charts/FormStage3D';
import { CoachMarks, useCoachMarks, type CoachStep } from '@/components/coach/CoachMarks';
import { shareStage3DStill, type Stage3DStillData } from '@/components/share/Stage3DStill';
import { Card, Chip, EmptyState, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import { sessionShots, shotFromRow } from '@/data/db';
import { confidenceLabel, confidenceLevel } from '@/core/evidence';
import { decodeSequence, type DecodedFrame } from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceReleaseFrame, referenceSequence } from '@/core/nbaReferenceForms';
import { forearmTiltDeg, frameAngles, releaseReadouts, type AngleReading } from '@/core/pose3d/angles3d';
import {
  DEFAULT_CAMERA,
  autoOrbitStep,
  presetCamera,
  tweenCamera,
  type CameraPresetId,
  type OrbitCamera,
} from '@/core/pose3d/camera3d';
import { liftSequence } from '@/core/pose3d/lift';
import type { FormSequence, PoseKeypointName, ResolvedShot, ShootingHand } from '@/core/types';
import { haptic } from '@/utils/haptics';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** A shot that carries a decodable form sequence, plus a display label. */
interface Studio3DShot {
  shot: ResolvedShot;
  seq: FormSequence;
  decoded: DecodedFrame[];
  label: string;
}

/** Preset tween duration; reduced motion skips the tween and snaps. */
const PRESET_TWEEN_MS = 400;

/** Camera preset pills, in display order. RESET returns to the default view. */
const CAMERA_PRESETS: readonly { id: CameraPresetId; label: string; a11y: string }[] = [
  { id: 'front', label: 'FRONT', a11y: 'Front camera angle' },
  { id: 'side', label: 'SIDE', a11y: 'Side camera angle, shooting arm toward you' },
  { id: 'top', label: 'TOP', a11y: 'Top-down camera angle' },
  { id: 'default', label: 'RESET', a11y: 'Reset camera' },
];

/**
 * First-open walkthrough. Honesty leads: the first step says this is an
 * estimate, not a scan, before any control is taught. All steps center (no
 * targetRect) — the content lives in a ScrollView, so measured rects would
 * drift out from under the highlight.
 */
const FORM3D_STEPS: CoachStep[] = [
  {
    title: 'An estimate, not a scan',
    text: 'This scene is rebuilt from one camera. Depth is inferred from body proportions — solid joints are trusted, hollow rings are estimated.',
  },
  {
    title: 'Orbit the shot',
    text: 'Drag to spin, pinch to zoom. FRONT, SIDE, and TOP jump to clean angles; ORBIT slowly circles for you.',
  },
  {
    title: 'Scrub and freeze',
    text: 'Drag the track or press play. RELEASE snaps to the estimated moment the ball leaves your hand, with angle tags right on the skeleton.',
  },
  {
    title: 'Compare two shots',
    text: 'Overlay a synthesized NBA ghost, or put two of your own shots side by side. References are synthesized from published mechanics — not motion capture.',
  },
];

/** Readout value: null → em-dash; shaky depth (c < medium) → "≈" prefix. */
function angleText(r: AngleReading | null): string {
  if (r == null) return '—';
  const v = Math.round(r.deg);
  return r.c < 0.55 ? `≈${v}°` : `${v}°`;
}

/** One column of the AT RELEASE card: value, label, optional secondary line. */
function ReadoutColumn({
  label,
  a11yName,
  reading,
  refReading,
  secondaryPrefix = 'ghost',
}: {
  label: string;
  /** Human metric name for the accessibility sentence, e.g. "Elbow angle". */
  a11yName: string;
  reading: AngleReading | null;
  refReading: AngleReading | null;
  /** Label for the secondary line: "ghost" (default) or "B" while comparing. */
  secondaryPrefix?: string;
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
        <Text style={styles.readoutGhost}>
          {secondaryPrefix} {Math.round(refReading.deg)}°
        </Text>
      )}
    </View>
  );
}

/** Compact selectable pill sharing the screen's pick styling. */
function StagePill({
  label,
  selected,
  onPress,
  a11yLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  a11yLabel?: string;
}) {
  return (
    <Pressable
      onPress={() => {
        // Every pill here TOGGLES or SWITCHES something — a selection tick on
        // each tap, through the settings-gated gateway.
        haptic.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.pick, selected && styles.pickOn, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.pickText, selected && styles.pickTextOn]}>{label}</Text>
    </Pressable>
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

  // ---- Side-by-side compare (shot B) --------------------------------------
  const [compareIdx, setCompareIdx] = useState<number | null>(null);
  // Keep the compare pick valid: drop it when it leaves range or collides
  // with the primary selection (same guard idiom as the shotIdx effect above).
  useEffect(() => {
    if (compareIdx != null && (compareIdx >= studioShots.length || compareIdx === shotIdx)) {
      setCompareIdx(null);
    }
  }, [studioShots.length, compareIdx, shotIdx]);

  const selectedB = compareIdx != null ? (studioShots[compareIdx] ?? null) : null;
  const handB: ShootingHand = selectedB?.seq.hand ?? 'right';
  const liftedB = useMemo(
    () => (replay3d && selectedB ? liftSequence(selectedB.decoded, handB) : null),
    [replay3d, selectedB, handB],
  );
  const readoutsB = useMemo(
    () => (liftedB && selectedB ? releaseReadouts(liftedB, selectedB.decoded, handB) : null),
    [liftedB, selectedB, handB],
  );
  const compareActive = selectedB != null && liftedB != null;

  // ---- Camera: shared orbit state, presets, tween, auto-orbit -------------
  const [cam, setCam] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const [activePreset, setActivePreset] = useState<CameraPresetId | null>('default');
  const [orbiting, setOrbiting] = useState(false);
  const [trailOn, setTrailOn] = useState(true);

  const tweenRaf = useRef<number | null>(null);
  const tweenStart = useRef(0);
  const tweenFrom = useRef<OrbitCamera>(DEFAULT_CAMERA);
  const tweenTarget = useRef<OrbitCamera>(DEFAULT_CAMERA);
  const cancelTween = () => {
    if (tweenRaf.current != null) {
      cancelAnimationFrame(tweenRaf.current);
      tweenRaf.current = null;
    }
  };
  // Cancel a mid-flight preset tween if the screen unmounts.
  useEffect(() => cancelTween, []);

  const animateToPreset = (id: CameraPresetId) => {
    setOrbiting(false);
    cancelTween();
    const target = presetCamera(id, hand);
    setActivePreset(id);
    // Reduced motion: no tween — snap straight to the preset.
    if (reducedMotion) {
      setCam(target);
      return;
    }
    tweenFrom.current = cam;
    tweenTarget.current = target;
    tweenStart.current = 0;
    const step = (ts: number) => {
      if (tweenStart.current === 0) tweenStart.current = ts;
      const t = (ts - tweenStart.current) / PRESET_TWEEN_MS;
      // tweenCamera returns the exact target at t >= 1, so arrival is precise.
      setCam(tweenCamera(tweenFrom.current, tweenTarget.current, t));
      if (t >= 1) {
        tweenRaf.current = null;
        return;
      }
      tweenRaf.current = requestAnimationFrame(step);
    };
    tweenRaf.current = requestAnimationFrame(step);
  };

  // User gestures own the camera (FormStage3D fires onCameraChange only from
  // real drags/pinches): kill any tween and the auto-orbit, drop the preset
  // highlight, then follow the gesture.
  const onStageCamera = (next: OrbitCamera) => {
    cancelTween();
    setOrbiting(false);
    setActivePreset(null);
    setCam(next);
  };

  const toggleOrbit = () => {
    cancelTween();
    // Yaw departs the preset the moment the orbit starts spinning.
    if (!orbiting) setActivePreset(null);
    setOrbiting((o) => !o);
  };

  // Auto-orbit loop — same rAF + lastTs idiom as the playback transport
  // below. Inert under reduced motion (and the ORBIT pill is hidden then).
  const orbitRaf = useRef<number | null>(null);
  const orbitLastTs = useRef(0);
  useEffect(() => {
    if (!orbiting || reducedMotion) return;
    const step = (ts: number) => {
      if (orbitLastTs.current === 0) orbitLastTs.current = ts;
      const dt = (ts - orbitLastTs.current) / 1000;
      orbitLastTs.current = ts;
      setCam((c) => autoOrbitStep(c, dt));
      orbitRaf.current = requestAnimationFrame(step);
    };
    orbitRaf.current = requestAnimationFrame(step);
    return () => {
      if (orbitRaf.current != null) cancelAnimationFrame(orbitRaf.current);
      orbitLastTs.current = 0;
    };
  }, [orbiting, reducedMotion]);

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

  // Pause playback (and the camera showcase spin) whenever the selection
  // changes so the new motion starts calm.
  useEffect(() => {
    setPlaying(false);
    setPos(0);
    setOrbiting(false);
  }, [shotIdx]);

  const frameCount = selected ? selected.decoded.length : 1;
  const curFrame = Math.round(pos * (frameCount - 1));
  const atRelease = readouts != null && curFrame === readouts.frame;

  // In-scene release callouts: only at the release frame, only when NOT
  // comparing, and only for readings that exist — angleText's "≈" prefix
  // carries low depth confidence right into the scene.
  const callouts = useMemo<StageCallout[]>(() => {
    if (!readouts || compareIdx != null || curFrame !== readouts.frame) return [];
    const side = hand === 'right' ? 'right' : 'left';
    const out: StageCallout[] = [];
    if (readouts.elbow) {
      out.push({ joint: `${side}_elbow` as PoseKeypointName, text: `ELBOW ${angleText(readouts.elbow)}` });
    }
    if (readouts.knee) {
      out.push({ joint: `${side}_knee` as PoseKeypointName, text: `KNEE ${angleText(readouts.knee)}` });
    }
    if (readouts.forearmTilt) {
      out.push({ joint: `${side}_wrist` as PoseKeypointName, text: `TILT ${angleText(readouts.forearmTilt)}` });
    }
    return out;
  }, [readouts, compareIdx, curFrame, hand]);

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
  // Compare mode: two half-width stages sharing the row (taller aspect so a
  // narrow stage still frames the full body).
  const stageWHalf = Math.max(0, Math.floor((stageW - space.sm) / 2));
  const stageHHalf = Math.round(stageWHalf * 1.4);

  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  const depthLevel = lifted ? confidenceLevel(lifted.confidence) : null;

  // ---- Share still (offscreen re-render, never a screenshot) --------------
  const [sharing, setSharing] = useState(false);
  const onShareStill = () => {
    if (sharing || selected == null || lifted == null || readouts == null || depthLevel == null) {
      return;
    }
    const data: Stage3DStillData = {
      user: lifted,
      reference: compareActive ? liftedB : ghostOn ? refLifted : null,
      refLabel: compareActive
        ? `SHOT B · ${selectedB!.shot.outcome.toUpperCase()}`
        : ghostOn && refLifted
          ? `GHOST · ${archetype.name.toUpperCase()}`
          : null,
      pos,
      camera: cam,
      hand,
      trail: trailOn,
      title: `SHOT ${selected.shot.id} · ${selected.shot.outcome.toUpperCase()}`,
      subtitle: atRelease
        ? `ELBOW ${angleText(readouts.elbow)} · KNEE ${angleText(readouts.knee)} · FOREARM TILT ${angleText(readouts.forearmTilt)}`
        : `FRAME ${curFrame + 1}/${frameCount}`,
      confidenceLine: `DEPTH CONFIDENCE: ${confidenceLabel(depthLevel).toUpperCase()}`,
    };
    setSharing(true);
    // shareStage3DStill never throws — .finally only restores the button.
    void shareStage3DStill(data).finally(() => setSharing(false));
  };

  // ---- First-open coach overlay -------------------------------------------
  // Never teach over the off/empty/loading states: steps stay empty (and the
  // hook stays invisible) until the stage actually has something to show.
  const ready = replay3d && !loading && studioShots.length > 0 && lifted != null;
  const coach = useCoachMarks('formstudio3d', ready ? FORM3D_STEPS : []);

  return (
    <View style={styles.root}>
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
              onAction={() => {
                // Deep-link guard: with no history (e.g. cold start on this
                // route) fall back to the tab home instead of throwing on
                // back() — same idiom as how-it-works.tsx.
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
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
              onAction={() => {
                // Deep-link guard (see the settings-off EmptyState above).
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
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
                    <StagePill
                      key={s.shot.id}
                      label={s.label}
                      selected={i === shotIdx}
                      onPress={() => setShotIdx(i)}
                    />
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

                    {/* Camera controls: presets, showcase orbit, wrist trail. */}
                    <Row gap={space.sm} style={styles.presetRow}>
                      {CAMERA_PRESETS.map((p) => (
                        <StagePill
                          key={p.id}
                          label={p.label}
                          selected={activePreset === p.id}
                          onPress={() => animateToPreset(p.id)}
                          a11yLabel={p.a11y}
                        />
                      ))}
                      {/* Auto-orbit is pure decoration motion — hidden entirely
                          under reduced motion (mirrors the transport's stepper
                          swap below). */}
                      {!reducedMotion && (
                        <StagePill
                          label="ORBIT"
                          selected={orbiting}
                          onPress={toggleOrbit}
                          a11yLabel="Toggle slow auto-orbit"
                        />
                      )}
                      <StagePill
                        label="TRAIL"
                        selected={trailOn}
                        onPress={() => setTrailOn((t) => !t)}
                        a11yLabel="Toggle the estimated wrist path"
                      />
                    </Row>

                    <View
                      style={styles.stageWrap}
                      onLayout={(e) => setStageW(Math.round(e.nativeEvent.layout.width))}
                    >
                      {stageW > 0 &&
                        (selectedB != null ? (
                          <>
                            <Row gap={space.sm} style={styles.compareTags}>
                              <Chip compact label={`A · ${selected.label}`} tone="accent" />
                              <Chip compact label={`B · ${selectedB.label}`} tone="default" />
                            </Row>
                            <Row gap={space.sm}>
                              <FormStage3D
                                user={lifted}
                                reference={null}
                                pos={pos}
                                width={stageWHalf}
                                height={stageHHalf}
                                camera={cam}
                                onCameraChange={onStageCamera}
                                trailHand={trailOn ? hand : null}
                                callouts={callouts}
                                accessibilityLabel="Estimated 3D reconstruction of shot A. Drag to orbit — both views share the camera."
                              />
                              {liftedB != null ? (
                                <FormStage3D
                                  user={liftedB}
                                  reference={null}
                                  pos={pos}
                                  width={stageWHalf}
                                  height={stageHHalf}
                                  camera={cam}
                                  onCameraChange={onStageCamera}
                                  trailHand={trailOn ? handB : null}
                                  accessibilityLabel="Estimated 3D reconstruction of shot B. Drag to orbit — both views share the camera."
                                />
                              ) : (
                                /* Honest refusal for shot B — never a made-up
                                   skeleton in the second slot. */
                                <View
                                  style={[
                                    styles.compareMissingBox,
                                    { width: stageWHalf, height: stageHHalf },
                                  ]}
                                >
                                  <Text style={styles.compareMissing}>
                                    3D unavailable for that shot — the camera hid too much of
                                    the body. Pick another.
                                  </Text>
                                </View>
                              )}
                            </Row>
                          </>
                        ) : (
                          <FormStage3D
                            user={lifted}
                            reference={compareActive ? null : refLifted}
                            pos={pos}
                            width={stageW}
                            height={Math.round(stageW * 1.1)}
                            camera={cam}
                            onCameraChange={onStageCamera}
                            trailHand={trailOn ? hand : null}
                            callouts={callouts}
                            accessibilityLabel={`Estimated 3D reconstruction of your shooting motion${
                              ghostOn ? ` beside a synthesized ${archetype.name} reference` : ''
                            }. Drag to orbit.`}
                          />
                        ))}
                    </View>
                    <Text style={styles.stageCaption}>Drag to orbit · pinch to zoom</Text>
                    {trailOn && (
                      <Text style={styles.stageCaption}>
                        Wrist path is estimated from pose — not ball tracking.
                      </Text>
                    )}

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
                        {/* Per-frame steppers: pressed feedback only. No
                            haptic — repeat-tap surfaces would buzz per frame. */}
                        <Pressable
                          onPress={() => stepFrame(-1)}
                          accessibilityRole="button"
                          accessibilityLabel="Previous frame"
                          style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}
                        >
                          <Ionicons name="play-back" size={18} color={color.text} />
                        </Pressable>
                        <Pressable
                          onPress={() => stepFrame(1)}
                          accessibilityRole="button"
                          accessibilityLabel="Next frame"
                          style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}
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
                          style={({ pressed }) => [styles.playBtn, pressed && { opacity: 0.85 }]}
                        >
                          <Ionicons
                            name={playing ? 'pause' : 'play'}
                            size={20}
                            color={color.onAccent}
                          />
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            haptic.selection();
                            setSlowMo((s) => !s);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: slowMo }}
                          accessibilityLabel="Toggle quarter-speed slow motion"
                          style={({ pressed }) => [
                            styles.slowBtn,
                            slowMo && styles.slowBtnOn,
                            pressed && { opacity: 0.7 },
                          ]}
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
                      <PillButton
                        label={sharing ? 'PREPARING…' : 'SHARE STILL'}
                        variant="ghost"
                        icon="share-outline"
                        disabled={sharing}
                        onPress={onShareStill}
                      />
                      {atRelease && <Chip label="RELEASE (est.)" tone="accent" />}
                    </Row>
                  </Card>

                  {/* At-release readouts. Secondary line: ghost — or shot B
                      while comparing (same estimated-values caveats). */}
                  <Card entering={cardEnter(3)}>
                    <Eyebrow>AT RELEASE</Eyebrow>
                    <Row gap={space.md} style={styles.readoutRow}>
                      <ReadoutColumn
                        label="ELBOW"
                        a11yName="Elbow angle"
                        reading={readouts.elbow}
                        refReading={
                          compareActive ? (readoutsB?.elbow ?? null) : (refReadouts?.elbow ?? null)
                        }
                        secondaryPrefix={compareActive ? 'B' : 'ghost'}
                      />
                      <ReadoutColumn
                        label="KNEE"
                        a11yName="Knee angle"
                        reading={readouts.knee}
                        refReading={
                          compareActive ? (readoutsB?.knee ?? null) : (refReadouts?.knee ?? null)
                        }
                        secondaryPrefix={compareActive ? 'B' : 'ghost'}
                      />
                      <ReadoutColumn
                        label="FOREARM TILT"
                        a11yName="Forearm tilt"
                        reading={readouts.forearmTilt}
                        refReading={
                          compareActive
                            ? (readoutsB?.forearmTilt ?? null)
                            : (refReadouts?.forearmTilt ?? null)
                        }
                        secondaryPrefix={compareActive ? 'B' : 'ghost'}
                      />
                    </Row>
                    <Text style={styles.footnote}>
                      Wrist flexion needs hand tracking the camera can't see — forearm tilt
                      is the honest proxy.
                    </Text>
                  </Card>

                  {/* Ghost controls — suppressed while comparing two shots. */}
                  <Card entering={cardEnter(4)}>
                    <Eyebrow>Compare against</Eyebrow>
                    {compareActive ? (
                      <Text style={styles.footnote}>
                        NBA ghost is hidden while comparing two shots side by side.
                      </Text>
                    ) : (
                      <>
                        <Pressable
                          onPress={() => {
                            haptic.selection();
                            setGhostOn((g) => !g);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: ghostOn }}
                          accessibilityLabel="Toggle the NBA ghost overlay"
                          style={({ pressed }) => [
                            styles.pick,
                            styles.ghostToggle,
                            ghostOn && styles.pickOn,
                            pressed && { opacity: 0.7 },
                          ]}
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
                            <StagePill
                              key={a.name}
                              label={a.name}
                              selected={i === archIdx}
                              onPress={() => setArchIdx(i)}
                            />
                          ))}
                        </ScrollView>
                        <Text style={styles.footnote}>
                          Reference forms are synthesized from published mechanics — not motion
                          capture.
                        </Text>
                      </>
                    )}
                  </Card>

                  {/* Side-by-side picker: shot B from the same studio list. */}
                  <Card entering={cardEnter(5)}>
                    <Eyebrow>SIDE BY SIDE</Eyebrow>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.pickerRow}
                    >
                      <StagePill
                        label="OFF"
                        selected={compareIdx == null}
                        onPress={() => setCompareIdx(null)}
                        a11yLabel="Turn off side-by-side compare"
                      />
                      {studioShots.map((s, i) =>
                        i === shotIdx ? null : (
                          <StagePill
                            key={s.shot.id}
                            label={s.label}
                            selected={i === compareIdx}
                            onPress={() => setCompareIdx(i)}
                            a11yLabel={`Compare against ${s.label}`}
                          />
                        ),
                      )}
                    </ScrollView>
                    <Text style={styles.footnote}>
                      Both shots are estimated reconstructions — one shared camera, one shared
                      scrub.
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
      {/* Coach overlay mounts as a sibling of <Screen> (same call-site shape
          as Home) so the scrim covers the whole screen, not the scroll area. */}
      {coach.visible && (
        <CoachMarks steps={coach.steps} onFinish={coach.finish} onSkip={coach.finish} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
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
  presetRow: {
    flexWrap: 'wrap',
    marginTop: space.sm,
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
  compareTags: {
    alignSelf: 'stretch',
    flexWrap: 'wrap',
    marginBottom: space.sm,
  },
  compareMissingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  compareMissing: {
    ...type.caption,
    color: color.textDim,
    textAlign: 'center',
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
