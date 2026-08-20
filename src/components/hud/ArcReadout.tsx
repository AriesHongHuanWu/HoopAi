/**
 * ArcReadout — live entry/release-angle chip over the camera feed.
 *
 * HONESTY: every number here derives from the loose-R²-gated VISUAL flight fit
 * (OverlayState.fullArc) — a display aid, never evidence. The chip states
 * measured degrees and arc-SHAPE words only ('IDEAL' / 'FLAT' / 'STEEP'); it
 * never says make/miss/on-target and never renders red (green/amber only —
 * red would read as a judgment). The receipt/summary shows the FSM's
 * persisted entryAngleDeg; this readout is coaching color, not the record.
 *
 * Cadence: polls overlay.value on a 200 ms interval — the sanctioned 5 Hz
 * pattern (rimCountdown poll in live.tsx, usePlacementGrade) — NEVER
 * per-frame React state on the live screen. The functional setState bails
 * when the rounded display values and visibility are unchanged, so steady
 * flight causes zero re-renders.
 *
 * Mounted by TrajectoryOverlay inside its pointerEvents='none' absolute-fill
 * wrapper; this chip positions itself (absolute, bottom-centered) and keeps
 * pointerEvents='none' so it can never eat a live-screen touch.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOut, useReducedMotion } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import type { OverlayState } from '../../camera/useShotEngine';
import { color, font, motion, space, type } from '../../constants/tokens';
import {
  arcQuality,
  entryAngleDegFromFlat,
  releaseAngleDegFromFlat,
  type ArcQuality,
} from './arcHudGeometry';
import { HudChip } from './HudChip';

/** 5 Hz poll — same cadence as the rimCountdown poll in live.tsx. */
export const ARC_READOUT_POLL_MS = 200;
/** How long the last measured values linger after the shot resolves. */
export const ARC_READOUT_LINGER_MS = 1500;

/** One 5 Hz reading of the overlay, before linger/bail-out is applied. */
export interface ArcReadoutSample {
  /** Entry angle at the rim plane (deg below horizontal), null when unmeasured. */
  entry: number | null;
  /** Release angle (deg above horizontal), null when the arc shows no ascent. */
  rel: number | null;
  q: ArcQuality | null;
  /** True while the chip should be fed FRESH values (SHOT_LIVE + measured entry). */
  live: boolean;
}

/** What the chip actually renders; `visible` includes the post-shot linger. */
export interface ArcReadoutState {
  entry: number | null;
  rel: number | null;
  q: ArcQuality | null;
  visible: boolean;
}

/**
 * Read one sample off the overlay. Entry needs a locked rim plane and a
 * confident global arc (>= 5 points, matching apexOfFlatArc's minimum);
 * release only needs the arc itself.
 */
export function readArcSample(o: OverlayState): ArcReadoutSample {
  const entry =
    o.rim != null && o.fullArc.length >= 10 ? entryAngleDegFromFlat(o.fullArc, o.rim.y) : null;
  const rel = releaseAngleDegFromFlat(o.fullArc);
  return { entry, rel, q: arcQuality(entry), live: o.phase === 'SHOT_LIVE' && entry != null };
}

function sameRounded(a: number | null, b: number | null): boolean {
  return (a == null ? null : Math.round(a)) === (b == null ? null : Math.round(b));
}

/**
 * Fold a sample into the display state. A dead sample (post-shot linger)
 * keeps the LAST measured values on screen; the previous object is returned
 * untouched when nothing the user can see changed (rounded degrees, quality,
 * visibility), which is the re-render bail-out.
 */
export function mergeArcReadoutState(
  prev: ArcReadoutState,
  sample: ArcReadoutSample,
  visible: boolean,
): ArcReadoutState {
  const entry = sample.live ? sample.entry : prev.entry;
  const rel = sample.live ? sample.rel : prev.rel;
  const q = sample.live ? sample.q : prev.q;
  if (
    prev.visible === visible &&
    prev.q === q &&
    sameRounded(prev.entry, entry) &&
    sameRounded(prev.rel, rel)
  ) {
    return prev;
  }
  return { entry, rel, q, visible };
}

/** On-chip quality words — shape language only, never an outcome. */
const QUALITY_WORD: Record<ArcQuality, string> = {
  ideal: 'IDEAL',
  flat: 'FLAT',
  steep: 'STEEP',
};

const QUALITY_PHRASE: Record<ArcQuality, string> = {
  ideal: 'ideal',
  flat: 'a bit flat',
  steep: 'a bit steep',
};

export function arcReadoutA11yLabel(entry: number, q: ArcQuality, rel: number | null): string {
  const release = rel != null ? `, release ${Math.round(rel)} degrees` : '';
  return `Arc ${Math.round(entry)} degrees, ${QUALITY_PHRASE[q]}${release}`;
}

const EMPTY_READOUT: ArcReadoutState = { entry: null, rel: null, q: null, visible: false };

export function ArcReadout({
  overlay,
}: {
  overlay: SharedValue<OverlayState>;
}): React.JSX.Element | null {
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<ArcReadoutState>(EMPTY_READOUT);
  // Wall clock is fine here (UI-side React, not core/replay code): it only
  // times the cosmetic linger fade, never a shot decision.
  const lastVisibleAtMs = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const sample = readArcSample(overlay.value);
      const now = Date.now();
      if (sample.live) lastVisibleAtMs.current = now;
      const visible =
        sample.live ||
        (lastVisibleAtMs.current != null &&
          now - lastVisibleAtMs.current <= ARC_READOUT_LINGER_MS);
      setState((prev) => mergeArcReadoutState(prev, sample, visible));
    }, ARC_READOUT_POLL_MS);
    return () => clearInterval(id);
  }, [overlay]);

  if (!state.visible || state.entry == null || state.q == null) return null;

  const tint = state.q === 'ideal' ? color.make : color.unsure;
  return (
    <Animated.View
      pointerEvents="none"
      entering={reducedMotion ? undefined : FadeInUp.duration(motion.quick)}
      exiting={reducedMotion ? undefined : FadeOut.duration(motion.standard)}
      style={styles.wrap}
    >
      {/* NO accessibilityLiveRegion — ShotFlash owns live announcements. */}
      <HudChip
        tone="default"
        accessible
        accessibilityLabel={arcReadoutA11yLabel(state.entry, state.q, state.rel)}
      >
        {/* Single row, no flexible children — HudChip clips overflow (the FT-chip bug). */}
        <View style={styles.row}>
          <Text style={styles.eyebrow}>ARC</Text>
          <Text style={[styles.value, { color: tint }]}>{`${Math.round(state.entry)}°`}</Text>
          <Text style={[styles.quality, { color: tint }]}>{QUALITY_WORD[state.q]}</Text>
          {state.rel != null && (
            <>
              <Text style={styles.secondary}>{' · '}</Text>
              <Text style={styles.secondary}>{`REL ${Math.round(state.rel)}°`}</Text>
            </>
          )}
        </View>
      </HudChip>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    // Clears the live screen's bottom bar (BOTTOM_BAR_CLEARANCE = 56) + margin.
    bottom: 120,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  eyebrow: {
    ...type.micro,
    fontFamily: font.bodySemiBold,
    letterSpacing: 1,
    color: color.textDim,
  },
  /** Scoreboard voice for the degree number — display face at title size. */
  value: {
    ...type.title,
  },
  quality: {
    ...type.micro,
    fontFamily: font.bodySemiBold,
    letterSpacing: 1,
  },
  secondary: {
    ...type.micro,
    fontFamily: font.bodySemiBold,
    letterSpacing: 1,
    color: color.textDim,
  },
});
