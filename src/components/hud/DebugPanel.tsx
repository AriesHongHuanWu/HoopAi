/**
 * On-screen detector diagnostics. The camera->model bridge can't be verified
 * without a device, so this panel surfaces the raw facts (model loaded, frames
 * processed, output tensor shape/layout, max score, detection count, input
 * range) right on the live view so we can pinpoint an on-device ML bug.
 *
 * Reads the engine's debug SharedValue by polling on the JS thread at ~4 Hz
 * (cheap; avoids a per-frame React re-render).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { EngineDebug } from '../../camera/useShotEngine';
import { color, radius, space, type } from '../../constants/tokens';

export function DebugPanel({ debug }: { debug: SharedValue<EngineDebug> }) {
  const [d, setD] = useState<EngineDebug>(debug.value);
  useEffect(() => {
    const id = setInterval(() => setD({ ...debug.value }), 250);
    return () => clearInterval(id);
  }, [debug]);

  // maxScore ~0 across frames => bad input/model. Good detections raise it.
  const scoreColor = d.maxScore > 0.3 ? color.make : d.maxScore > 0.05 ? color.unsure : color.miss;
  const inputOk = d.inputMax > 0.1 && d.inputMax <= 1.6; // ~0..1 expected
  const running = d.frames > 0;

  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.title}>DETECT DEBUG</Text>
      <Row k="mode" v={d.mode} vc={d.mode === 'camera' ? color.make : color.unsure} />
      <Row k="model" v={d.modelLoaded ? 'loaded' : 'NOT loaded (demo)'} vc={d.modelLoaded ? color.make : color.miss} />
      <Row k="frames" v={String(d.frames)} vc={running ? color.text : color.miss} />
      <Row k="output" v={`${d.outputLen} · ${d.layout}`} />
      <Row k="maxScore" v={d.maxScore.toFixed(3)} vc={scoreColor} />
      <Row k="dets" v={String(d.detCount)} vc={d.detCount > 0 ? color.make : color.textDim} />
      <Row k="input" v={`${d.inputMin.toFixed(2)}..${d.inputMax.toFixed(2)}`} vc={inputOk ? color.text : color.miss} />
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
    top: 54,
    left: 10,
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
});
