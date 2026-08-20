/**
 * CourtCalibrationOverlay — the "tap the court" ritual, drawn over the live
 * (static, tripod-mounted) camera, as a guided walkthrough. The user taps five
 * known court landmarks; a mini half-court diagram highlights the CURRENT one
 * with per-landmark copy (calibrationGuide.ts), placed markers can be tapped to
 * re-place that exact landmark, and near-coincident taps warn immediately.
 * Each tap is inverted through the SAME analysis↔view mapping the HUD/tap-to-
 * set-rim already use (mapViewToAnalysis), paired with the landmark's real
 * court coordinate, and — once all five are in — solved into a homography that
 * gives corner-accurate, placement-agnostic 2/3 (see courtCalibration.ts).
 * A successful commit shows a quality receipt (reprojection-error tier) before
 * handing control back via onDone.
 *
 * Self-contained + strictly additive: it renders only when a calibration
 * session is active (or its own success receipt is up), captures its own taps,
 * and never alters the detection flow. All logic lives in the pure, tested
 * engines; this is the surface.
 *
 * NOTE: camera UI — verify on device (tap accuracy, marker re-place, banner
 * placement, success card).
 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { closePair, landmarkGuide, qualityLabel, qualityTier } from '@/core/calibrationGuide';
import { missingLandmarks, type CalibrationReject } from '@/core/courtCalibration';
import { courtLandmarks, type CourtSpec } from '@/core/courtModel';
import { useCourtCalibration } from '@/state/courtCalibrationStore';
import type { Mapping } from './overlayMapping';
import { mapViewToAnalysis } from './overlayMapping';

/** Two taps closer than this (VIEW px) trigger the coincident-tap warning. */
const CLOSE_TAP_VIEW_PX = 28;
/** Mini half-court diagram footprint, dp. */
const DIAGRAM_W = 132;
const DIAGRAM_H = 92;
/** Diagram dot sizes: the landmark being placed vs everything else. */
const DOT_CURRENT = 12;
const DOT = 8;
/** Placed-marker visuals stay 22dp; the pressable box is 32dp (+hitSlop). */
const MARKER_SIZE = 22;
const MARKER_HIT = 32;

function rejectMessage(reason: CalibrationReject): string {
  switch (reason) {
    case 'high-error':
      return "Those taps don't line up as one court — redo any that look off.";
    case 'degenerate':
      return 'Tap four well-spread points, not a straight line.';
    case 'incomplete':
      return 'Tap all the points first.';
  }
}

export function CourtCalibrationOverlay({
  mapping,
  onDone,
}: {
  /** Analysis↔view mapping snapshot for the current (static) camera. */
  mapping: Mapping;
  /** Called when the ritual is confirmed or cancelled. */
  onDone: () => void;
}) {
  const session = useCourtCalibration((s) => s.session);
  const placeTap = useCourtCalibration((s) => s.placeTap);
  const removeTap = useCourtCalibration((s) => s.removeTap);
  const commit = useCourtCalibration((s) => s.commit);
  const cancel = useCourtCalibration((s) => s.cancel);
  const [error, setError] = useState<string | null>(null);
  /** Reprojection error of a just-committed solve — drives the success card. */
  const [successErrM, setSuccessErrM] = useState<number | null>(null);
  /** Spec of the committed session ("Redo taps" restarts the same rulebook). */
  const committedSpec = useRef<CourtSpec | null>(null);

  // Post-commit receipt. The session is already null here (commit clears it),
  // so this branch must come before the no-session bailout.
  if (successErrM != null) {
    const tier = qualityTier(successErrM);
    const handleRedo = () => {
      // Restart the ritual with the same rulebook. The registration from the
      // rough commit stays ACTIVE meanwhile — a redo commit replaces it and a
      // cancel keeps it (store semantics).
      const spec = committedSpec.current;
      if (spec) useCourtCalibration.getState().begin(spec);
      setSuccessErrM(null);
    };
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={styles.banner} pointerEvents="box-none">
          <View style={styles.card}>
            <Text style={[styles.eyebrow, styles.eyebrowSuccess]}>COURT LOCKED</Text>
            <Text style={styles.instruction}>{qualityLabel(tier)}</Text>
            <Text style={styles.successBody}>
              Corner 3s now score off your real court. Re-aim or moving the camera clears it.
            </Text>
            <View style={styles.controls}>
              {tier === 'rough' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Redo taps"
                  onPress={handleRedo}
                  style={({ pressed }) => [styles.ctrl, pressed && styles.ctrlPressed]}
                >
                  <Ionicons name="refresh" size={16} color={color.text} />
                  <Text style={styles.ctrlText}>Redo taps</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Done"
                onPress={() => {
                  setSuccessErrM(null);
                  onDone();
                }}
                style={({ pressed }) => [styles.ctrl, styles.ctrlPrimary, pressed && styles.ctrlPressed]}
              >
                <Ionicons name="checkmark" size={16} color={color.onAccent} />
                <Text style={[styles.ctrlText, styles.ctrlTextPrimary]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }

  if (!session) return null;

  const landmarks = courtLandmarks(session.spec);
  const labelOf = (id: string) => landmarks.find((l) => l.id === id)?.label ?? id;
  const guide = landmarkGuide(session.spec);
  const missing = missingLandmarks(session);
  const currentId = missing[0] ?? null;
  const placed = session.taps;
  const total = placed.length + missing.length;
  const placedIds = new Set(placed.map((t) => t.landmarkId));
  const entry = currentId ? guide.find((g) => g.id === currentId) : undefined;

  const handleTap = (vx: number, vy: number) => {
    if (!currentId) return;
    const a = mapViewToAnalysis(mapping, vx, vy);
    if (!a) return;
    placeTap(currentId, a);
    // Tap sanity in VIEW px, including the tap just placed (store state is
    // stale in this closure). Near-coincident landmarks predict a degenerate
    // or high-error solve. WARNING only — it never blocks Confirm; the
    // engine's reprojection gate at commit is the real judge.
    const points = [...placed, { landmarkId: currentId, image: a }].map((t) => ({
      id: t.landmarkId,
      x: t.image.x * mapping.scale + mapping.ox,
      y: t.image.y * mapping.scale + mapping.oy,
    }));
    const pair = closePair(points, CLOSE_TAP_VIEW_PX);
    setError(
      pair
        ? `Those two taps are nearly on top of each other — ${labelOf(pair[0])} and ${labelOf(pair[1])} should be far apart.`
        : null,
    );
  };

  const handleUndo = () => {
    const last = placed[placed.length - 1];
    if (last) removeTap(last.landmarkId);
    setError(null);
  };

  const handleConfirm = () => {
    // session.spec vanishes on a successful commit (the store nulls the
    // session) — capture it first so "Redo taps" can restart the same rules.
    const spec = session.spec;
    const r = commit();
    if (r.ok) {
      committedSpec.current = spec;
      setError(null);
      setSuccessErrM(r.reprojectionErrorM);
    } else {
      setError(rejectMessage(r.reason));
    }
  };

  const handleCancel = () => {
    cancel();
    onDone();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Full-screen tap catcher (only claims taps while placing landmarks). */}
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={currentId ? `Tap ${labelOf(currentId)}` : 'All points placed'}
        onPress={(e) => handleTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      />

      {/* Placed markers, drawn at their view positions. Tapping one removes
          just that landmark — canonical order in missingLandmarks makes it the
          next to place, so the diagram highlight follows automatically. */}
      {placed.map((t, i) => {
        const vx = t.image.x * mapping.scale + mapping.ox;
        const vy = t.image.y * mapping.scale + mapping.oy;
        return (
          <Pressable
            key={t.landmarkId}
            accessibilityRole="button"
            accessibilityLabel={`Re-place ${labelOf(t.landmarkId)}`}
            hitSlop={6}
            onPress={() => {
              removeTap(t.landmarkId);
              setError(null);
            }}
            style={[styles.markerHit, { left: vx - MARKER_HIT / 2, top: vy - MARKER_HIT / 2 }]}
          >
            <View style={styles.marker}>
              <Text style={styles.markerNum}>{i + 1}</Text>
            </View>
          </Pressable>
        );
      })}

      {/* Instruction banner + controls (above the tap catcher). */}
      <View style={styles.banner} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.eyebrow}>{`CALIBRATE COURT · ${placed.length}/${total}`}</Text>

          {/* Mini half-court diagram — decorative (the copy carries the info).
              Baseline at the BOTTOM, matching landmarkGuide's pos convention. */}
          <View style={styles.diagram} accessible={false} pointerEvents="none">
            <View style={styles.diagramCourt}>
              <View style={styles.diagramArc} />
              {guide.map((g) => {
                const isCurrent = g.id === currentId;
                const size = isCurrent ? DOT_CURRENT : DOT;
                return (
                  <View
                    key={g.id}
                    style={[
                      styles.dot,
                      {
                        width: size,
                        height: size,
                        borderRadius: size / 2,
                        left: g.pos.x * (DIAGRAM_W - size),
                        bottom: g.pos.y * (DIAGRAM_H - size),
                      },
                      isCurrent
                        ? styles.dotCurrent
                        : placedIds.has(g.id)
                          ? styles.dotPlaced
                          : styles.dotPending,
                    ]}
                  />
                );
              })}
            </View>
          </View>

          <Text style={styles.instruction}>
            {entry ? entry.title : 'Everything placed — confirm your court.'}
          </Text>
          {entry != null && <Text style={styles.instructionBody}>{entry.instruction}</Text>}
          {entry != null && (
            <View style={styles.tipRow}>
              <Ionicons name="bulb-outline" size={12} color={color.textDim} />
              <Text style={styles.tip}>{entry.tip}</Text>
            </View>
          )}
          {error != null && <Text style={styles.error}>{error}</Text>}
          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Undo last point"
              onPress={handleUndo}
              disabled={placed.length === 0}
              style={({ pressed }) => [styles.ctrl, pressed && styles.ctrlPressed, placed.length === 0 && styles.ctrlDisabled]}
            >
              <Ionicons name="arrow-undo" size={16} color={color.text} />
              <Text style={styles.ctrlText}>Undo</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel calibration"
              onPress={handleCancel}
              style={({ pressed }) => [styles.ctrl, pressed && styles.ctrlPressed]}
            >
              <Ionicons name="close" size={16} color={color.textDim} />
              <Text style={styles.ctrlText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm court"
              onPress={handleConfirm}
              disabled={currentId != null}
              style={({ pressed }) => [
                styles.ctrl,
                styles.ctrlPrimary,
                pressed && styles.ctrlPressed,
                currentId != null && styles.ctrlDisabled,
              ]}
            >
              <Ionicons name="checkmark" size={16} color={color.onAccent} />
              <Text style={[styles.ctrlText, styles.ctrlTextPrimary]}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  markerHit: {
    position: 'absolute',
    width: MARKER_HIT,
    height: MARKER_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.onAccent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerNum: {
    ...type.micro,
    color: color.onAccent,
    fontVariant: ['tabular-nums'],
  },
  banner: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
    alignItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    padding: space.lg,
    gap: space.sm,
  },
  eyebrow: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1,
  },
  eyebrowSuccess: {
    color: color.make,
  },
  diagram: {
    alignSelf: 'center',
  },
  diagramCourt: {
    width: DIAGRAM_W,
    height: DIAGRAM_H,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
  },
  // 3-point arc hint: a half-ellipse rising from the baseline (bottom edge).
  diagramArc: {
    position: 'absolute',
    bottom: 0,
    left: '15%',
    width: '70%',
    aspectRatio: 1 / 0.55,
    borderTopLeftRadius: radius.pill,
    borderTopRightRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: color.hudGlassBorder,
  },
  dot: {
    position: 'absolute',
  },
  dotCurrent: {
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.onAccent,
  },
  dotPlaced: {
    backgroundColor: color.make,
    opacity: 0.9,
  },
  dotPending: {
    backgroundColor: color.textDim,
    opacity: 0.4,
  },
  instruction: {
    ...type.heading,
    color: color.text,
  },
  instructionBody: {
    ...type.caption,
    color: color.text,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tip: {
    ...type.caption,
    color: color.textDim,
    flex: 1,
  },
  successBody: {
    ...type.caption,
    color: color.textDim,
  },
  error: {
    ...type.caption,
    color: color.miss,
  },
  controls: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.xs,
  },
  ctrl: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    backgroundColor: color.hudGlass,
  },
  ctrlPrimary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  ctrlPressed: {
    opacity: 0.7,
  },
  ctrlDisabled: {
    opacity: 0.4,
  },
  ctrlText: {
    ...type.caption,
    color: color.text,
  },
  ctrlTextPrimary: {
    color: color.onAccent,
  },
});
