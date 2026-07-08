/**
 * CourtCalibrationOverlay — the "tap the court" ritual, drawn over the live
 * (static, tripod-mounted) camera. The user taps five known court landmarks;
 * each tap is inverted through the SAME analysis↔view mapping the HUD/tap-to-
 * set-rim already use (mapViewToAnalysis), paired with the landmark's real
 * court coordinate, and — once all five are in — solved into a homography that
 * gives corner-accurate, placement-agnostic 2/3 (see courtCalibration.ts).
 *
 * Self-contained + strictly additive: it renders only when a calibration
 * session is active, captures its own taps, and never alters the detection
 * flow. All logic lives in the pure, tested engine; this is the surface.
 *
 * NOTE: camera UI — verify on device (tap accuracy, banner placement).
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { missingLandmarks, type CalibrationReject } from '@/core/courtCalibration';
import { courtLandmarks } from '@/core/courtModel';
import { useCourtCalibration } from '@/state/courtCalibrationStore';
import type { Mapping } from './overlayMapping';
import { mapViewToAnalysis } from './overlayMapping';

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

  if (!session) return null;

  const landmarks = courtLandmarks(session.spec);
  const labelOf = (id: string) => landmarks.find((l) => l.id === id)?.label ?? id;
  const missing = missingLandmarks(session);
  const currentId = missing[0] ?? null;
  const placed = session.taps;
  const total = placed.length + missing.length;

  const handleTap = (vx: number, vy: number) => {
    if (!currentId) return;
    const a = mapViewToAnalysis(mapping, vx, vy);
    if (!a) return;
    placeTap(currentId, a);
    setError(null);
  };

  const handleUndo = () => {
    const last = placed[placed.length - 1];
    if (last) removeTap(last.landmarkId);
    setError(null);
  };

  const handleConfirm = () => {
    const r = commit();
    if (r.ok) onDone();
    else setError(rejectMessage(r.reason));
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

      {/* Placed markers, drawn at their view positions. */}
      {placed.map((t, i) => {
        const vx = t.image.x * mapping.scale + mapping.ox;
        const vy = t.image.y * mapping.scale + mapping.oy;
        return (
          <View key={t.landmarkId} pointerEvents="none" style={[styles.marker, { left: vx - 11, top: vy - 11 }]}>
            <Text style={styles.markerNum}>{i + 1}</Text>
          </View>
        );
      })}

      {/* Instruction banner + controls (above the tap catcher). */}
      <View style={styles.banner} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.eyebrow}>{`CALIBRATE COURT · ${placed.length}/${total}`}</Text>
          <Text style={styles.instruction}>
            {currentId ? labelOf(currentId) : 'Everything placed — confirm your court.'}
          </Text>
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
  marker: {
    position: 'absolute',
    width: 22,
    height: 22,
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
  instruction: {
    ...type.heading,
    color: color.text,
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
