/**
 * History — list of past sessions as cards: date up top, FG% as the big
 * numeral, makes/attempts meta and a mini pip row of the actual shot
 * sequence. Tapping a card opens the full session detail at /history/[id];
 * long-pressing offers delete (which also removes the local recording).
 * The empty state draws the signature shot arc waiting for its first make.
 */
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Circle, DashPathEffect, Line, Path, vec } from '@shopify/react-native-skia';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import {
  BackPill,
  PipRow,
  formatSessionDate,
  formatSessionTime,
} from '@/components/ShotList';
import {
  Card,
  Chip,
  Eyebrow,
  PillButton,
  Row,
  Screen,
  StatNumber,
} from '@/components/ui';
import { color, font, motion, radius, space, touch, type } from '@/constants/tokens';
import { exportCsv, sessionsToCsv } from '@/core/csvExport';
import { getModeDef } from '@/core/gameModes';
import type { ShotOutcome } from '@/core/types';
import { deleteSession, listSessions, sessionShots, type SessionSummaryRow } from '@/data/db';
import { deleteLocalVideo } from '@/data/videoLibrary';

interface HistoryItem {
  row: SessionSummaryRow;
  /** Shot outcome sequence for the mini pip row. */
  pips: ShotOutcome[];
}

/**
 * Small emoji + name chip for a session played under a game mode. `null`
 * modeId (Free Play / pre-v4 rows) renders nothing so plain sessions keep
 * their existing card shape.
 */
function ModeChip({ modeId }: { modeId: string | null }) {
  if (modeId == null || modeId === 'free') return null;
  let def;
  try {
    def = getModeDef(modeId as Parameters<typeof getModeDef>[0]);
  } catch {
    return null;
  }
  return (
    <View style={styles.modeChip}>
      <Text style={styles.modeChipEmoji}>{def.emoji}</Text>
      <Text style={styles.modeChipLabel}>{def.name}</Text>
    </View>
  );
}

const EMPTY_ILLO_H = 120;

/** Empty state — a dashed shot arc waiting on its first session. */
function EmptyArc() {
  const [w, setW] = useState(0);
  const h = EMPTY_ILLO_H;
  const rimX = w * 0.82;
  const rimY = h * 0.36;
  const path = `M ${w * 0.08} ${h - 18} Q ${w * 0.45} ${-h * 0.28} ${rimX} ${rimY - 10}`;
  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={{ height: h }}
      importantForAccessibility="no-hide-descendants"
    >
      {w > 0 && (
        <Canvas style={{ width: w, height: h }}>
          <Line p1={vec(space.sm, h - 12)} p2={vec(w - space.sm, h - 12)} color={color.border} strokeWidth={2} />
          <Path path={path} style="stroke" strokeWidth={2.5} color={color.accent} opacity={0.5}>
            <DashPathEffect intervals={[1, 9]} />
          </Path>
          <Circle cx={rimX} cy={rimY} r={9} style="stroke" color={color.textDim} strokeWidth={3} />
          <Line p1={vec(rimX + 15, rimY - 24)} p2={vec(rimX + 15, rimY + 9)} color={color.textDim} strokeWidth={3} />
        </Canvas>
      )}
    </View>
  );
}

/** Cascade step between session cards (ms), capped so long lists stay snappy. */
const STAGGER_MS = 40;
const STAGGER_CAP = 8;

export default function HistoryScreen() {
  const reducedMotion = useReducedMotion();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  /** Selected tag chip filter; null = show every session (no filter active). */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const confirmDelete = useCallback((row: SessionSummaryRow) => {
    Alert.alert(
      'Delete this session?',
      'Its shots and stats are removed and the recording is deleted from the app. Videos already saved to Photos stay in Photos.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (row.videoPath != null) await deleteLocalVideo(row.videoPath);
              await deleteSession(row.id);
              setItems((prev) =>
                prev == null ? prev : prev.filter((i) => i.row.id !== row.id),
              );
            })();
          },
        },
      ],
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const rows = await listSessions(30);
        const pips = await Promise.all(
          rows.map((r) =>
            sessionShots(r.id).then((shots) => shots.map((s) => s.outcome)),
          ),
        );
        if (!alive) return;
        setItems(rows.map((row, i) => ({ row, pips: pips[i] ?? [] })));
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  /** Distinct, non-empty tags across every loaded session, in first-seen order. */
  const distinctTags = useMemo(() => {
    if (items == null) return [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const { row } of items) {
      const tag = row.label.trim();
      if (tag.length > 0 && !seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    return tags;
  }, [items]);

  // A tag filter can go stale once its only session is deleted or retagged.
  useEffect(() => {
    if (tagFilter != null && !distinctTags.includes(tagFilter)) {
      setTagFilter(null);
    }
  }, [distinctTags, tagFilter]);

  const visibleItems = useMemo(() => {
    if (items == null) return null;
    if (tagFilter == null) return items;
    return items.filter(({ row }) => row.label.trim() === tagFilter);
  }, [items, tagFilter]);

  const onExportCsv = () => {
    if (exporting || visibleItems == null || visibleItems.length === 0) return;
    setExporting(true);
    setExportFailed(false);
    const csv = sessionsToCsv(visibleItems.map((i) => i.row));
    void exportCsv(csv, 'hoopilot-sessions.csv').then((ok) => {
      setExporting(false);
      if (!ok) setExportFailed(true);
    });
  };

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Your sessions</Eyebrow>
      <Text style={styles.title}>History</Text>

      {items !== null && distinctTags.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tagFilterScroll}
          contentContainerStyle={styles.tagFilterRow}
          accessibilityLabel="Filter sessions by tag"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: tagFilter == null }}
            accessibilityLabel="All sessions"
            onPress={() => setTagFilter(null)}
            style={({ pressed }) => [
              styles.filterChip,
              tagFilter == null && styles.filterChipSelected,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.filterChipLabel, tagFilter == null && styles.filterChipLabelSelected]}>
              All
            </Text>
          </Pressable>
          {distinctTags.map((tag) => {
            const selected = tagFilter === tag;
            return (
              <Pressable
                key={tag}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Filter by tag ${tag}`}
                onPress={() => setTagFilter(selected ? null : tag)}
                style={({ pressed }) => [
                  styles.filterChip,
                  selected && styles.filterChipSelected,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={[styles.filterChipLabel, selected && styles.filterChipLabelSelected]}
                  numberOfLines={1}
                >
                  {tag}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {items === null ? (
        <Card>
          <Text style={styles.dim}>Loading sessions…</Text>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyArc />
          <Text style={[styles.heading, { marginTop: space.md }]}>
            No sessions yet
          </Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Finish your first tracked session and it will show up here with
            makes, misses and shot angles.
          </Text>
          <PillButton
            label="Start a session"
            onPress={() => router.replace('/')}
            style={{ marginTop: space.lg }}
          />
        </Card>
      ) : visibleItems != null && visibleItems.length === 0 ? (
        <Card>
          <Text style={styles.heading}>No sessions with this tag</Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Clear the filter to see every session again.
          </Text>
          <PillButton
            variant="ghost"
            label="Clear filter"
            onPress={() => setTagFilter(null)}
            style={{ marginTop: space.lg, alignSelf: 'flex-start' }}
          />
        </Card>
      ) : (
        <View style={{ gap: space.md }}>
          {(visibleItems ?? []).map(({ row, pips }, index) => {
            const makes = row.makes ?? 0;
            const fg = Math.round(row.fgPct * 100);
            const hasVideo = row.videoPath != null;
            const modeName =
              row.modeId != null && row.modeId !== 'free'
                ? (() => {
                    try {
                      return getModeDef(row.modeId as Parameters<typeof getModeDef>[0]).name;
                    } catch {
                      return null;
                    }
                  })()
                : null;
            const tag = row.label.trim();
            const card = (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Session on ${formatSessionDate(row.startedAt)}${modeName != null ? `, ${modeName}` : ''}, ${makes} of ${row.attempts} makes, ${fg} percent field goals${hasVideo ? ', has replay video' : ''}${tag.length > 0 ? `, tagged ${tag}` : ''}`}
                accessibilityHint="Opens the session detail. Long press to delete."
                onPress={() =>
                  router.push({
                    pathname: '/history/[id]',
                    params: { id: String(row.id) },
                  })
                }
                onLongPress={() => confirmDelete(row)}
                style={({ pressed }) => pressed && { opacity: 0.8 }}
              >
                <Card>
                  <Row style={styles.cardHeader} gap={space.lg}>
                    <View style={styles.cardInfo}>
                      <Text style={styles.heading}>
                        {formatSessionDate(row.startedAt)}
                      </Text>
                      <Row gap={space.sm}>
                        <Text style={styles.caption}>
                          {formatSessionTime(row.startedAt)}
                        </Text>
                        {hasVideo && (
                          <View style={styles.videoBadge} importantForAccessibility="no">
                            <Ionicons name="play" size={9} color={color.accent} />
                          </View>
                        )}
                        <ModeChip modeId={row.modeId} />
                      </Row>
                      <Row gap={space.xs} style={styles.statLine}>
                        <Text style={styles.makesNum}>{makes}</Text>
                        <Text style={styles.attemptsNum}>/{row.attempts}</Text>
                        <Text style={styles.statWord}>
                          {makes === 1 ? 'MAKE' : 'MAKES'}
                        </Text>
                      </Row>
                      {tag.length > 0 && (
                        <View style={{ marginTop: space.sm, alignSelf: 'flex-start' }}>
                          <Chip label={tag} />
                        </View>
                      )}
                    </View>
                    <Row gap={space.sm}>
                      <StatNumber value={`${fg}%`} size="medium" label="FG" />
                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={color.textFaint}
                        importantForAccessibility="no"
                      />
                    </Row>
                  </Row>
                  {pips.length > 0 && (
                    <View style={styles.pipStrip}>
                      <PipRow outcomes={pips} size={10} max={24} />
                    </View>
                  )}
                </Card>
              </Pressable>
            );
            return reducedMotion ? (
              <View key={row.id}>{card}</View>
            ) : (
              <Animated.View
                key={row.id}
                entering={FadeInDown.duration(motion.standard).delay(
                  Math.min(index, STAGGER_CAP) * STAGGER_MS,
                )}
              >
                {card}
              </Animated.View>
            );
          })}
        </View>
      )}

      {items !== null && items.length > 0 && (
        <View style={{ marginTop: space.xl, alignItems: 'center', gap: space.sm }}>
          {exportFailed && <Chip label="Couldn't export — try again" tone="unsure" />}
          <Row gap={space.md}>
            <PillButton
              variant="ghost"
              label={
                exporting
                  ? 'Exporting…'
                  : tagFilter != null
                    ? 'Export CSV (filtered)'
                    : 'Export CSV'
              }
              onPress={onExportCsv}
              disabled={exporting || visibleItems == null || visibleItems.length === 0}
            />
            <PillButton
              variant="ghost"
              label="View trends"
              onPress={() => router.push('/trends')}
            />
          </Row>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  cardHeader: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  statLine: {
    marginTop: space.sm,
    alignItems: 'baseline',
  },
  makesNum: {
    fontFamily: font.display,
    fontSize: 22,
    lineHeight: 26,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  attemptsNum: {
    fontFamily: font.displayMedium,
    fontSize: 22,
    lineHeight: 26,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  statWord: {
    ...type.micro,
    color: color.textFaint,
    marginLeft: 2,
  },
  videoBadge: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: color.accentTint,
  },
  pipStrip: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.xs,
    borderRadius: radius.sm,
    backgroundColor: color.accentTint,
  },
  modeChipEmoji: {
    fontSize: 11,
  },
  modeChipLabel: {
    ...type.micro,
    color: color.accent,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  tagFilterScroll: {
    marginBottom: space.md,
    flexGrow: 0,
  },
  tagFilterRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingRight: space.lg,
  },
  filterChip: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    maxWidth: 180,
  },
  filterChipSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  filterChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  filterChipLabelSelected: {
    color: color.accent,
  },
});
