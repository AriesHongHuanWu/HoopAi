/**
 * CalibrationHealthCard — the trust surface for the three calibration rituals
 * (rim lock / court tap / FT anchor), rendered on session setup and in
 * Settings. All copy and status logic come from the pure model in
 * src/core/calibrationGuide.ts so every surface tells the same truth.
 *
 * Honesty rule: registrations are per-camera-pose and never persisted, so
 * this card only ever shows 'active' for the CURRENT session's registration;
 * past calibrations appear as receipts. FT calibration state is
 * pipeline-internal (it lives inside ShotPipeline, no reactive store) — these
 * off-session surfaces only show FT receipts, so hasFtCal is always false.
 */
import { type ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Card, Chip, Eyebrow, PillButton, Row } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
import { buildCalibrationHealth, type HealthItem } from '@/core/calibrationGuide';
import { useCourtCalibration } from '@/state/courtCalibrationStore';
import { useSettings } from '@/state/settingsStore';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Glyph identity per ritual — mirrors the calibration guide screen. */
const ITEM_ICON: Record<HealthItem['key'], IconName> = {
  rim: 'scan-outline',
  court: 'map-outline',
  ft: 'locate-outline',
};

/** Spoken status for the composed accessibility summary. */
const STATUS_SPOKEN: Record<HealthItem['status'], string> = {
  active: 'active',
  idle: 'not set',
};

function StatusChip({ status }: { status: HealthItem['status'] }) {
  if (status === 'active') return <Chip label="ACTIVE" tone="make" compact />;
  return <Chip label="NOT SET" tone="default" compact />;
}

export function CalibrationHealthCard({
  variant,
  onOpenGuide,
  entering,
  bare,
}: {
  variant: 'setup' | 'settings';
  /** Navigate to /calibration-guide — the caller owns routing. */
  onOpenGuide: () => void;
  /** Optional reanimated entering animation, forwarded to the wrapping Card. */
  entering?: ComponentProps<typeof Card>['entering'];
  /**
   * Render content without the Card wrapper or Eyebrow — Settings mounts it
   * inside its own Card + SectionHeader.
   */
  bare?: boolean;
}) {
  const registration = useCourtCalibration((s) => s.registration);
  const reprojErrM = useCourtCalibration((s) => s.reprojectionErrorM);
  const lastCourtCal = useSettings((s) => s.lastCourtCalSummary);
  const lastFtCal = useSettings((s) => s.lastFtCalSummary);

  // Date.now() per render is fine here — it only feeds day-granularity
  // receipt labels, and the selectors above re-render on any store change.
  const health = buildCalibrationHealth({
    hasRegistration: registration != null,
    reprojectionErrorM: reprojErrM,
    hasFtCal: false,
    lastCourtCal,
    lastFtCal,
    nowMs: Date.now(),
  });

  const hint =
    variant === 'setup'
      ? 'You calibrate live, after the rim locks.'
      : 'To calibrate: start a session, lock the rim, then hit Calibrate.';

  // One summary utterance for the item list. The group carries the label so
  // the guide button below stays individually focusable (an accessible ROOT
  // would swallow it for screen readers).
  const summaryLabel = `Calibration health. ${health.items
    .map((item) => `${item.title}: ${STATUS_SPOKEN[item.status]}`)
    .join('. ')}.`;

  const content = (
    <View>
      {bare !== true && <Eyebrow>Calibration</Eyebrow>}
      <View accessible accessibilityLabel={summaryLabel} style={styles.items}>
        {health.items.map((item) => (
          <Row key={item.key} gap={space.md} style={styles.itemRow}>
            <View style={styles.iconBubble}>
              <Ionicons name={ITEM_ICON[item.key]} size={14} color={color.accent} />
            </View>
            <View style={styles.itemBody}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.itemDetail}>{item.detail}</Text>
              <Text style={styles.itemBenefit}>{item.benefit}</Text>
            </View>
            <StatusChip status={item.status} />
          </Row>
        ))}
      </View>
      <Row gap={space.xs} style={styles.footerRow}>
        <Ionicons name="shield-checkmark-outline" size={12} color={color.textDim} />
        <Text style={styles.footerText}>{health.footer}</Text>
      </Row>
      <Row gap={space.md} style={styles.actionsRow}>
        <PillButton label="How to calibrate" variant="ghost" icon="school" onPress={onOpenGuide} />
        <Text style={styles.hint}>{hint}</Text>
      </Row>
    </View>
  );

  if (bare === true) return content;
  return <Card entering={entering}>{content}</Card>;
}

const styles = StyleSheet.create({
  items: {
    gap: space.sm,
  },
  itemRow: {
    // Multi-line middle column — top-align the bubble and status chip.
    alignItems: 'flex-start',
    backgroundColor: color.bg,
    borderRadius: radius.md,
    padding: space.md,
  },
  iconBubble: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemBody: {
    flex: 1,
  },
  itemTitle: {
    ...type.body,
    // 600 weight via the loaded semibold face — RN fontWeight does not
    // synthesize weights for these static Google fonts.
    fontFamily: font.bodySemiBold,
    color: color.text,
  },
  itemDetail: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
  },
  itemBenefit: {
    ...type.micro,
    color: color.textDim,
    opacity: 0.8,
    marginTop: space.xs,
  },
  footerRow: {
    marginTop: space.md,
    alignItems: 'flex-start',
  },
  footerText: {
    ...type.micro,
    color: color.textDim,
    flex: 1,
  },
  actionsRow: {
    marginTop: space.md,
  },
  hint: {
    ...type.micro,
    color: color.textFaint,
    flex: 1,
  },
});
