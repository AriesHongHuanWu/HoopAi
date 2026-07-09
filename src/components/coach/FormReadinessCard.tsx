/**
 * FormReadinessCard — how much of the shot window carries pose (form) data,
 * and what to do about it: enable Form Analysis, improve coverage, or open
 * the Form Studio once coverage is solid.
 *
 * Presentational only: readiness comes from formReadiness()
 * (src/core/coachInsights.ts); navigation is injected as callbacks so this
 * component never touches the router. Copy stays within the 2D-capture
 * honesty line — MoveNet reads mechanics from a single camera, nothing more.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, PillButton, Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import type { FormReadiness } from '@/core/coachInsights';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Local replica of coach.tsx's SectionEyebrow (the screen doesn't export it). */
function SectionEyebrow({ icon, children }: { icon: IconName; children: string }) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

type LevelContent = {
  fill: string;
  body: string;
  ctaLabel: string;
  ctaIcon?: IconName;
  ctaVariant: 'primary' | 'ghost';
  action: 'settings' | 'formstudio';
};

function levelContent(r: FormReadiness): LevelContent {
  switch (r.level) {
    case 'off':
      return {
        fill: color.textFaint,
        body: 'The coach is reading your ball flight only. Turn on Form Analysis and it can watch your mechanics too — elbow, knees, release, follow-through.',
        ctaLabel: 'Enable in Settings',
        ctaIcon: 'settings-outline',
        ctaVariant: 'primary',
        action: 'settings',
      };
    case 'sparse':
      return {
        fill: color.accent,
        body: `Form data is coming in but thin (${Math.round(r.posePct * 100)}% of shots). Keep Form Analysis on and stay fully in frame — form coaching and regression alerts sharpen as coverage grows.`,
        ctaLabel: 'Open Settings',
        ctaVariant: 'ghost',
        action: 'settings',
      };
    case 'ready':
      return {
        fill: color.make,
        body: 'Solid coverage — the coach can watch your mechanics across weeks and will flag form slips against your own baseline.',
        ctaLabel: 'Open Form Studio',
        ctaIcon: 'body',
        ctaVariant: 'ghost',
        action: 'formstudio',
      };
  }
}

export function FormReadinessCard({
  readiness,
  onOpenSettings,
  onOpenFormStudio,
  entering,
}: {
  readiness: FormReadiness;
  onOpenSettings: () => void;
  onOpenFormStudio: () => void;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  const content = levelContent(readiness);
  const coverage =
    readiness.total === 0
      ? 'No tracked shots yet'
      : `${readiness.withPose} of ${readiness.total} shots carry form data`;

  return (
    <Card entering={entering}>
      <SectionEyebrow icon="body-outline">Form coaching readiness</SectionEyebrow>

      {/* Meter + copy read as one a11y block; the CTA stays focusable below. */}
      <View accessible accessibilityLabel={`Form coaching readiness: ${coverage}. ${content.body}`}>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              {
                width: `${Math.round(readiness.posePct * 100)}%`,
                backgroundColor: content.fill,
              },
            ]}
          />
        </View>
        <Text style={styles.coverage}>{coverage}</Text>
        <Text style={styles.body}>{content.body}</Text>
      </View>

      <PillButton
        label={content.ctaLabel}
        icon={content.ctaIcon}
        variant={content.ctaVariant}
        onPress={content.action === 'settings' ? onOpenSettings : onOpenFormStudio}
        style={styles.cta}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
    marginTop: space.xs,
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  coverage: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    marginTop: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.md,
  },
  cta: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
});
