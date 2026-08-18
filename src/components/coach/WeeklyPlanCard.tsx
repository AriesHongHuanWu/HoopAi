/**
 * WeeklyPlanCard — "This week's plan": the coach as a training partner. The
 * top few drillable findings, each with its fix and the exact drill to groove
 * it, numbered as a checklist. Turns diagnosis into a week of work.
 *
 * Extracted 1:1 from coach.tsx. The one router push it owns is the typed
 * object push to /modes carrying {drill, level} — the drill deep link Train
 * already understands.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type Animated from 'react-native-reanimated';

import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Chip, Row } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
import type { WeeklyAssignment } from '@/core/coachEngine';
import { getDrill } from '@/core/drills';
import { LEVEL_LABEL, type DrillLevel } from '@/core/drillProgression';

export function WeeklyPlanCard({
  plan,
  levels,
  entering,
}: {
  plan: readonly WeeklyAssignment[];
  /** Per-drill progression: current level + the coach's level prescription. */
  levels: Partial<Record<string, { level: DrillLevel; prescription: string }>>;
  entering?: ComponentProps<typeof Animated.View>['entering'];
}) {
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="barbell-outline" style={styles.eyebrow}>
        This week&apos;s plan
      </SectionEyebrow>
      <Text style={styles.planLede}>
        {`Your top ${plan.length} ${plan.length === 1 ? 'fix' : 'fixes'}, each with a drill to groove it.`}
      </Text>
      <View style={styles.planList}>
        {plan.map((item, i) => {
          const drill = getDrill(item.drillId);
          const lv = levels[item.drillId];
          return (
            <View key={item.finding.id} style={styles.planItem}>
              <View style={styles.planNum}>
                <Text style={styles.planNumText}>{i + 1}</Text>
              </View>
              <View style={styles.planBody}>
                <Text style={styles.assignTitle}>{item.finding.title}</Text>
                <Text style={styles.body}>{item.finding.prescription}</Text>
                {lv != null && (
                  <>
                    <Row gap={space.sm} style={styles.planLevelRow}>
                      <Chip
                        label={`LEVEL ${lv.level} · ${LEVEL_LABEL[lv.level].toUpperCase()}`}
                        tone={lv.level > 1 ? 'accent' : 'default'}
                        compact
                      />
                    </Row>
                    <Text style={styles.planLevelRx}>{lv.prescription}</Text>
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Practice ${drill.title} at level ${lv?.level ?? 1} in Train`}
                  onPress={() =>
                    router.push({
                      pathname: '/modes',
                      params: { drill: item.drillId, level: String(lv?.level ?? 1) },
                    })
                  }
                  style={({ pressed }) => [styles.planDrill, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="basketball" size={14} color={color.accent} />
                  <Text style={styles.planDrillText}>{`Practice: ${drill.title}`}</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  assignTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.xs,
  },
  planLede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.md,
  },
  planList: {
    gap: space.md,
  },
  planItem: {
    flexDirection: 'row',
    gap: space.sm,
  },
  planNum: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  planNumText: {
    ...type.bodyMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  planBody: {
    flex: 1,
    minWidth: 0,
  },
  planLevelRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  planLevelRx: {
    ...type.caption,
    color: color.textDim,
    marginTop: 4,
  },
  planDrill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space.sm,
  },
  planDrillText: {
    ...type.caption,
    color: color.accent,
    fontFamily: font.bodyMedium,
  },
});
