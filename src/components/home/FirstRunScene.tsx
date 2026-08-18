/**
 * FirstRunScene — Home's first-run storefront (lastSession === null).
 *
 * A static ArcReveal frame of the signature shot arc, with ghost ball
 * positions dotted along the flight path into a translucent ghost rim at the
 * arc's end, and ONE line of copy. Replaces the old plain-text EmptyState so
 * the very first Home already speaks the app's arc language.
 *
 * HONESTY: purely decorative and forward-looking — the copy promises what
 * will land here AFTER the first session and never implies any detection has
 * already happened. No numbers, no fabricated stats, no fake activity.
 *
 * MOTION: none. ArcReveal renders its finished frame (animate={false}) and
 * the dotted path + rim are static JS-built Skia primitives computed once on
 * the JS thread from the same arcMotif geometry — ZERO worklets (the
 * fx/particles crash precedent).
 */
import { Canvas, Circle, Oval } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ArcReveal, arcMotif } from '@/components/motion';
import { color, space, type } from '@/constants/tokens';

/** Scene canvas height — a touch shorter than the hero so it reads as a coda. */
const SCENE_H = 150;
/** Ghost ball positions along the flight path (quadratic t values). */
const GHOST_TS = [0.12, 0.3, 0.48, 0.66, 0.84] as const;
/** Ghost ball dot radius, px. */
const GHOST_R = 4;
/** Ghost rim ellipse (a hoop seen at an angle) around the motif's rim point. */
const RIM_W = 44;
const RIM_H = 14;
/** Rim drop below the arc's end point, px. */
const RIM_DROP = 6;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

const COPY =
  'Prop your phone up — your makes, misses and FG% land here after your first session.';

export function FirstRunScene({ width }: { width: number }) {
  // The SAME canonical motif ArcReveal draws underneath — one geometry, so
  // the ghost balls sit exactly on the revealed arc. JS thread only.
  const { ghosts, rim } = useMemo(() => {
    if (width <= 0) return { ghosts: [], rim: { x: 0, y: 0 } };
    const motif = arcMotif(width, SCENE_H);
    return { ghosts: GHOST_TS.map((t) => motif.pointAt(t)), rim: motif.p1 };
  }, [width]);

  if (width <= 0) return null;

  return (
    <View accessible accessibilityLabel={COPY}>
      <View style={styles.scene} pointerEvents="none">
        {/* The finished arc, no draw-in — the scene is a still, not a demo. */}
        <ArcReveal width={width} height={SCENE_H} animate={false} dot={false} />
        <Canvas style={[absoluteFill, { width, height: SCENE_H }]}>
          {ghosts.map((p, i) => (
            <Circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={GHOST_R}
              color={color.accent}
              // The ball "arrives": each ghost position a little more present.
              opacity={0.14 + i * 0.09}
            />
          ))}
          {/* Ghost rim: a translucent hoop waiting under the arc's end. */}
          <Oval
            x={rim.x - RIM_W / 2}
            y={rim.y + RIM_DROP}
            width={RIM_W}
            height={RIM_H}
            style="stroke"
            strokeWidth={2}
            color={color.text}
            opacity={0.3}
          />
        </Canvas>
      </View>
      <Text style={styles.copy}>{COPY}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scene: {
    height: SCENE_H,
  },
  copy: {
    ...type.body,
    color: color.textDim,
    textAlign: 'center',
    marginTop: space.md,
  },
});
