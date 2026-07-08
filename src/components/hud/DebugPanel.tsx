/**
 * On-screen detector diagnostics. The camera->model bridge can't be verified
 * without a device, so this panel surfaces the raw facts (model loaded, frames
 * processed, output tensor shape/layout, max score, detection count, input
 * range) right on the live view so we can pinpoint an on-device ML bug.
 *
 * Reads the engine's debug SharedValue by polling on the JS thread at ~4 Hz
 * (cheap; avoids a per-frame React re-render).
 *
 * Placement is safe-area aware in both orientations: portrait keeps the panel
 * top-left under the status bar; landscape docks it top-right (clear of the
 * notch/Dynamic Island and of the stat strip, which owns the left column).
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import type { SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EngineDebug, OverlayState } from '../../camera/useShotEngine';
import { resolvedTuning } from '../../camera/deviceTuning';
import { color, radius, space, type } from '../../constants/tokens';
import { classifyLight } from '../../core/lightProfile';
import { tierLabel } from '../../core/deviceProfile';
import { useSettings } from '../../state/settingsStore';

/**
 * Build a compact, paste-able diagnostics dump so a tester can send back the
 * exact on-device numbers (device tier, model rung, delegate, fps, ball
 * detection health) — the ground truth that turns "I think the XR does X"
 * into a real number to tune the device tiers against.
 */
function buildDiagnostics(d: EngineDebug, rimAsp: number): string {
  const s = useSettings.getState();
  const { tier, detected } = resolvedTuning(s.deviceTierOverride, s.lastBenchmark?.ms ?? null);
  const dev = Device.modelName ?? Device.deviceName ?? 'unknown';
  const model = Device.modelId ?? '?';
  const tierLine =
    s.deviceTierOverride === 'auto'
      ? `auto -> ${tierLabel(tier)} (detected ${tierLabel(detected)})`
      : `${tierLabel(tier)} (manual)`;
  return [
    'HOOPILOT DIAG',
    `device: ${dev} (${model})`,
    `tier: ${tierLine}`,
    `engine: ${s.detectorEngine} ${s.perfMode} · accel ${s.detectorAccel} · rate ${s.detectionRate}`,
    `delegate: ${d.delegate}`,
    `speed: ${d.fps} fps · ${d.avgMs}ms avg`,
    `model: ${d.modelLoaded ? 'loaded' : 'DEMO'} · output ${d.outputLen} · ${d.layout}`,
    `ball: maxScore ${d.maxScore.toFixed(3)} · dets ${d.detCount}`,
    `input: ${d.inputMin.toFixed(2)}..${d.inputMax.toFixed(2)} · ${d.nonZeroPct}% nz`,
    `light: ${d.light > 0 ? `${d.light.toFixed(2)} ${classifyLight(d.light)}` : '--'}`,
    `rim aspect: ${rimAsp > 0 ? rimAsp.toFixed(2) : '--'}`,
    `roi: ${d.roiFrames > 0 ? `${d.roiHits}/${d.roiFrames} · ${d.roiAvgMs}ms` : 'idle'}`,
    `frames ${d.frames} · dropped ${d.dropped}`,
    d.modelError ? `error: ${d.modelError}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Fields worth a re-render — a static frame between detections shouldn't
 * force React to redraw the panel 4x/second. */
function debugChanged(a: EngineDebug, b: EngineDebug): boolean {
  return (
    a.frames !== b.frames ||
    a.dropped !== b.dropped ||
    // Compare the DISPLAYED precision of maxScore, not the raw float — a
    // jittering 4th decimal otherwise forces a re-render every tick.
    a.maxScore.toFixed(3) !== b.maxScore.toFixed(3) ||
    a.detCount !== b.detCount ||
    a.delegate !== b.delegate ||
    a.modelLoaded !== b.modelLoaded ||
    a.modelError !== b.modelError ||
    a.mode !== b.mode ||
    a.outputLen !== b.outputLen ||
    a.layout !== b.layout ||
    a.inputMin !== b.inputMin ||
    a.inputMax !== b.inputMax ||
    // Same displayed-precision compare as maxScore — the EMA'd luma jitters
    // in the 3rd decimal every frame.
    a.light.toFixed(2) !== b.light.toFixed(2) ||
    a.roiFrames !== b.roiFrames ||
    a.roiHits !== b.roiHits
  );
}

export function DebugPanel({
  debug,
  overlay,
}: {
  debug: SharedValue<EngineDebug>;
  /** Optional: read the locked rim box to show its aspect (camera-angle proxy). */
  overlay?: SharedValue<OverlayState>;
}) {
  const [d, setD] = useState<EngineDebug>(debug.value);
  // Rim box aspect (width/height) — a rough camera-angle read. 0 = no rim yet.
  const [rimAsp, setRimAsp] = useState(0);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  useEffect(() => {
    const id = setInterval(() => {
      const next = debug.value;
      setD((prev) => (debugChanged(prev, next) ? { ...next } : prev));
      const r = overlay?.value.rim;
      const a = r != null && r.height > 0 ? r.width / r.height : 0;
      setRimAsp((prev) => (Math.abs(prev - a) > 0.05 ? a : prev));
    }, 250);
    return () => clearInterval(id);
  }, [debug, overlay]);

  // maxScore ~0 across frames => bad input/model. Good detections raise it.
  const scoreColor = d.maxScore > 0.3 ? color.make : d.maxScore > 0.05 ? color.unsure : color.miss;
  const inputOk = d.inputMax > 0.1 && d.inputMax <= 1.6; // ~0..1 expected
  const running = d.frames > 0;

  const placement = isLandscape
    ? { top: insets.top + space.sm, right: insets.right + space.sm }
    : { top: Math.max(54, insets.top + space.sm), left: insets.left + space.sm };

  const onCopyDiag = () => {
    void Haptics.selectionAsync();
    void Share.share({ message: buildDiagnostics(d, rimAsp) }).catch(() => {});
  };

  return (
    // box-none: the panel itself + its text rows never capture touches (camera
    // taps pass through), but the copy-diagnostics button does.
    <View style={[styles.wrap, placement]} pointerEvents="box-none">
      <Text style={styles.title}>DETECT DEBUG</Text>
      <Row k="mode" v={d.mode} vc={d.mode === 'camera' ? color.make : color.unsure} />
      <Row k="model" v={d.modelLoaded ? 'loaded' : 'NOT loaded (demo)'} vc={d.modelLoaded ? color.make : color.miss} />
      <Row k="delegate" v={d.delegate} vc={d.delegate === 'cpu' ? color.unsure : color.text} />
      {d.modelError !== '' && (
        <Text style={styles.err} numberOfLines={4}>
          {d.modelError}
        </Text>
      )}
      <Row k="frames" v={String(d.frames)} vc={running ? color.text : color.miss} />
      <Row
        k="dropped"
        v={String(d.dropped)}
        vc={d.dropped > 0 && !running ? color.miss : color.textDim}
      />
      <Row k="output" v={`${d.outputLen} · ${d.layout}`} />
      <Row k="maxScore" v={d.maxScore.toFixed(3)} vc={scoreColor} />
      <Row k="dets" v={String(d.detCount)} vc={d.detCount > 0 ? color.make : color.textDim} />
      <Row k="rim asp" v={rimAsp > 0 ? rimAsp.toFixed(2) : '--'} vc={rimAsp > 0 ? color.text : color.textFaint} />
      <Row k="input" v={`${d.inputMin.toFixed(2)}..${d.inputMax.toFixed(2)}`} vc={inputOk ? color.text : color.miss} />
      <Row k="pixels" v={`${d.nonZeroPct}% nz`} vc={d.nonZeroPct > 5 ? color.make : color.miss} />
      <Row
        k="light"
        v={d.light > 0 ? `${d.light.toFixed(2)} · ${classifyLight(d.light)}` : '--'}
        vc={
          d.light <= 0
            ? color.textFaint
            : classifyLight(d.light) === 'bright'
              ? color.text
              : color.unsure
        }
      />
      <Row k="buf" v={`${Math.round(d.bufBytes / 1024)} KB`} vc={d.bufBytes > 0 ? color.text : color.miss} />
      <Row
        k="speed"
        v={`${d.fps} fps · ${d.avgMs}ms`}
        vc={d.fps >= 25 ? color.make : d.fps >= 12 ? color.unsure : color.miss}
      />
      <Row
        k="roi zoom"
        v={d.roiFrames > 0 ? `${d.roiHits}/${d.roiFrames} · ${d.roiAvgMs}ms` : 'idle'}
        vc={d.roiHits > 0 ? color.make : d.roiFrames > 0 ? color.unsure : color.textFaint}
      />
      <Pressable
        onPress={onCopyDiag}
        accessibilityRole="button"
        accessibilityLabel="Copy diagnostics"
        accessibilityHint="Shares this phone's detector numbers so you can send them for tuning"
        style={({ pressed }) => [styles.copyBtn, pressed && { backgroundColor: color.accentPressed }]}
      >
        <Text style={styles.copyText}>⧉ COPY DIAG</Text>
      </Pressable>
    </View>
  );
}

function Row({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.key}>{k}</Text>
      <Text style={[styles.val, vc ? { color: vc } : null]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    backgroundColor: 'rgba(10,9,9,0.82)',
    borderColor: color.hudGlassBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    // Fixed width (not minWidth): with a stable value column, the panel never
    // grows/shrinks as numbers change, so nothing under it shifts.
    width: 188,
  },
  title: {
    ...type.micro,
    color: color.accent,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  key: {
    ...type.micro,
    color: color.textFaint,
  },
  val: {
    ...type.micro,
    color: color.text,
    // Tabular figures keep every digit the same width, so the right-anchored
    // value column doesn't re-lay-out / shimmer as numbers tick 4x/sec (this
    // was the flicker). Fixed column width stops long strings widening the panel.
    fontVariant: ['tabular-nums'],
    minWidth: 92,
    textAlign: 'right',
  },
  err: {
    ...type.micro,
    color: color.miss,
    marginTop: 4,
    maxWidth: 220,
  },
  copyBtn: {
    marginTop: 6,
    alignSelf: 'stretch',
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: 5,
    alignItems: 'center',
  },
  copyText: {
    ...type.micro,
    color: color.onAccent,
    fontVariant: ['tabular-nums'],
  },
});
