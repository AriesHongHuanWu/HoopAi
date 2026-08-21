/**
 * CourtHeatmap — a stylized half-court split into 9 zones (left/center/right ×
 * far/mid/near), each color-graded by field-goal %: cold red → warm orange →
 * hot green, with intensity scaling by volume so a busy hot spot glows. Empty
 * zones sit faint. Pure presentational — it renders a {@link Heatmap} from
 * src/core/heatmap.ts. Plain RN Views (no Skia) so it's layout-safe.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, palette, radius, space, type } from '@/constants/tokens';
import { cellLabel, type Heatmap, type HeatBand, type HeatZone } from '@/core/heatmap';

const ZONES: HeatZone[] = ['left', 'center', 'right'];
// Rows render far (top, out at the arc) → near (bottom, at the rim).
const BANDS: HeatBand[] = ['far', 'mid', 'near'];

/** Hex → "r,g,b" so the tier fills are BUILT from the palette (the previous
 *  cold tier had drifted off token brick, and empty cells sat on pure white
 *  instead of chalk). */
function rgbOf(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

const HOT_RGB = rgbOf(palette.swish);
const WARM_RGB = rgbOf(palette.leather);
const COLD_RGB = rgbOf(palette.brick);
const EMPTY_FILL = `rgba(${rgbOf(palette.chalk)},0.035)`;

/** Zone fill by FG% (3 tiers) with intensity scaling by attempts. */
function heatFill(fgPct: number, attempts: number): string {
  if (attempts === 0) return EMPTY_FILL;
  const a = 0.18 + 0.5 * Math.min(1, attempts / 8);
  if (fgPct >= 0.55) return `rgba(${HOT_RGB},${a})`; // hot — swish green
  if (fgPct >= 0.4) return `rgba(${WARM_RGB},${a})`; // warm — accent orange
  return `rgba(${COLD_RGB},${a})`; // cold — brick red
}

export function CourtHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const find = (zone: HeatZone, band: HeatBand) =>
    heatmap.cells.find((c) => c.zone === zone && c.band === band)!;

  return (
    <View>
      <View style={styles.court} accessibilityLabel="Shooting heat map by court zone">
        {BANDS.map((band) => (
          <View key={band} style={styles.row}>
            {ZONES.map((zone) => {
              const cell = find(zone, band);
              return (
                <View
                  key={zone}
                  style={[styles.cell, { backgroundColor: heatFill(cell.fgPct, cell.attempts) }]}
                  accessible
                  accessibilityLabel={
                    cell.attempts > 0
                      ? `${cellLabel(cell)}: ${Math.round(cell.fgPct * 100)} percent on ${cell.attempts} attempts`
                      : `${cellLabel(cell)}: no attempts`
                  }
                >
                  <Text style={styles.cellPct}>
                    {cell.attempts > 0 ? `${Math.round(cell.fgPct * 100)}%` : '—'}
                  </Text>
                  {cell.attempts > 0 && (
                    <Text style={styles.cellN}>{`${cell.makes}/${cell.attempts}`}</Text>
                  )}
                </View>
              );
            })}
          </View>
        ))}
        {/* Rim marker at the baseline (near band). */}
        <View style={styles.rimRow}>
          <View style={styles.rim} />
        </View>
      </View>

      {(heatmap.best || heatmap.worst) && (
        <View style={styles.callouts}>
          {heatmap.best && (
            <Text style={styles.calloutHot}>
              {`🔥 Hot: ${cellLabel(heatmap.best)} (${Math.round(heatmap.best.fgPct * 100)}%)`}
            </Text>
          )}
          {heatmap.worst && heatmap.worst !== heatmap.best && (
            <Text style={styles.calloutCold}>
              {`❄️ Work on: ${cellLabel(heatmap.worst)} (${Math.round(heatmap.worst.fgPct * 100)}%)`}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  court: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 4,
  },
  cell: {
    flex: 1,
    aspectRatio: 1.4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  cellPct: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  cellN: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  rimRow: {
    alignItems: 'center',
    marginTop: 2,
  },
  rim: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  callouts: {
    marginTop: space.md,
    gap: space.xs,
  },
  calloutHot: {
    ...type.caption,
    color: color.make,
  },
  calloutCold: {
    ...type.caption,
    color: color.textDim,
  },
});
