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
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EngineDebug } from '../../camera/useShotEngine';
import { color, radius, space, type } from '../../constants/tokens';

/** Fields worth a re-render — a static frame between detections shouldn't
 * force React to redraw the panel 4x/second. */
function debugChanged(a: EngineDebug, b: EngineDebug): boolean {
  return (
    a.frames !== b.frames ||
    a.maxScore !== b.maxScore ||
    a.detCount !== b.detCount ||
    a.delegate !== b.delegate ||
    a.modelLoaded !== b.modelLoaded ||
    a.modelError !== b.modelError ||
    a.mode !== b.mode ||
    a.outputLen !== b.outputLen ||
    a.layout !== b.layout ||
    a.inputMin !== b.inputMin ||
    a.inputMax !== b.inputMax
  );
}

export function DebugPanel({ debug }: { debug: SharedValue<EngineDebug> }) {
  const [d, setD] = useState<EngineDebug>(debug.value);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  useEffect(() => {
    const id = setInterval(() => {
      const next = debug.value;
      setD((prev) => (debugChanged(prev, next) ? { ...next } : prev));
    }, 250);
    return () => clearInterval(id);
  }, [debug]);

  // maxScore ~0 across frames => bad input/model. Good detections raise it.
  const scoreColor = d.maxScore > 0.3 ? color.make : d.maxScore > 0.05 ? color.unsure : color.miss;
  const inputOk = d.inputMax > 0.1 && d.inputMax <= 1.6; // ~0..1 expected
  const running = d.frames > 0;

  const placement = isLandscape
    ? { top: insets.top + space.sm, right: insets.right + space.sm }
    : { top: Math.max(54, insets.top + space.sm), left: insets.left + space.sm };

  return (
    <View style={[styles.wrap, placement]} pointerEvents="none">
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
      <Row k="output" v={`${d.outputLen} · ${d.layout}`} />
      <Row k="maxScore" v={d.maxScore.toFixed(3)} vc={scoreColor} />
      <Row k="dets" v={String(d.detCount)} vc={d.detCount > 0 ? color.make : color.textDim} />
      <Row k="input" v={`${d.inputMin.toFixed(2)}..${d.inputMax.toFixed(2)}`} vc={inputOk ? color.text : color.miss} />
      <Row k="pixels" v={`${d.nonZeroPct}% nz`} vc={d.nonZeroPct > 5 ? color.make : color.miss} />
      <Row k="buf" v={`${Math.round(d.bufBytes / 1024)} KB`} vc={d.bufBytes > 0 ? color.text : color.miss} />
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
    minWidth: 168,
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
  },
  err: {
    ...type.micro,
    color: color.miss,
    marginTop: 4,
    maxWidth: 220,
  },
});
