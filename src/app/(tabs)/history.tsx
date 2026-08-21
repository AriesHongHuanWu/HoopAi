/**
 * Data tab — list of past sessions as cards: date up top, FG% as the big
 * numeral, makes/attempts meta and a mini pip row of the actual shot
 * sequence. Tapping a card opens the full session detail at /history/[id];
 * long-pressing offers delete (which also removes the local recording).
 * The empty state draws the signature shot arc waiting for its first make.
 *
 * The H1 is the TAB WORD ("Data"), not "History": the bottom bar says Data, so
 * the screen it opens has to say Data back or the label never becomes muscle
 * memory. What the tab actually holds — history, trends, records — moves into
 * the lede, where it doubles as a map of the sub-nav tiles right below it.
 *
 * ONE route to Trends. The tile in the sub-nav row is it; the screen used to
 * ALSO offer a "View trends" pill at the very bottom, which taught nothing
 * except that the app has two of everything.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { useCardStagger } from '@/components/motion';
// Concrete paths, not the '@/components/motion' barrel: several suites mock
// the barrel down to the symbols they assert on, and a barrel import would
// resolve to undefined under those doubles (the SegmentedTabs idiom).
import { PressScale } from '@/components/motion/PressScale';
import { useSkeletonExit } from '@/components/motion/stagger';
import { SectionEyebrow } from '@/components/ScreenHeader';
import {
  PipRow,
  formatSessionDate,
  formatSessionTime,
} from '@/components/ShotList';
import { ModeMark } from '@/components/modes/modeIdentity';
import { NavTileRow } from '@/components/NavTiles';
import {
  Card,
  Chip,
  EmptyState,
  Eyebrow,
  PillButton,
  Row,
  Screen,
  SkeletonCard,
  StatNumber,
} from '@/components/ui';
import { color, font, layout, motion, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';
import { exportCsv, sessionsToCsv } from '@/core/csvExport';
import { getModeDef } from '@/core/gameModes';
import type { ShotOutcome } from '@/core/types';
import {
  deleteSession,
  lifetimeTotals,
  listSessions,
  listVisibleSessions,
  sessionShots,
  type SessionSummaryRow,
} from '@/data/db';
import { deleteLocalVideo } from '@/data/videoLibrary';

interface HistoryItem {
  row: SessionSummaryRow;
  /** Shot outcome sequence for the mini pip row. */
  pips: ShotOutcome[];
}

/**
 * Small mark + name chip for a session played under a game mode. Uses the
 * shared Ionicons ModeMark so History speaks the same visual identity as the
 * picker/banner/complete sheet (not the legacy catalog emoji). `null` modeId
 * (Free Play / pre-v4 rows) renders nothing so plain sessions keep their
 * existing card shape.
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
      <ModeMark modeId={def.id} size={14} />
      <Text style={styles.modeChipLabel}>{def.name}</Text>
    </View>
  );
}

/** Stagger index cap so long histories don't tail-lag. */
const STAGGER_CAP = 8;

/** Sessions fetched per page — the old hard ceiling, now just the step. */
const PAGE_SIZE = 30;

/**
 * Loading skeletons are DELAYED by a beat: SQLite usually answers well inside
 * this window, so most opens go straight from tab switch to content with no
 * placeholder flash — only genuinely slow loads earn the skeletons. (It also
 * keeps the Skia-backed skeleton out of the first synchronous frame, which
 * suites that stub the Skia canvas never render.)
 */
const SKELETON_DELAY_MS = 150;

/**
 * Session-list reflow grammar (shared disclosure motion): tag-filter switches,
 * deletes and "Show older sessions" appends slide the surviving cards into
 * place instead of hard-jumping. Collapse/removal stays instant by design —
 * no exiting animation anywhere on this screen.
 */
const listReflow = LinearTransition.duration(motion.quick).reduceMotion(ReduceMotion.System);

/**
 * History reads through listVisibleSessions — the free-tier retention
 * enforcement point db.ts documents. During beta the cap is null, so this is
 * exactly listSessions and testers keep their full visible history. Some
 * long-standing suites stub '@/data/db' down to listSessions alone; fall back
 * so the screen still renders under those doubles (the barrel-vs-concrete
 * import in components/ui.tsx is the precedent for coding around known
 * partial stubs).
 */
const fetchHistoryPage: typeof listSessions = (limit) =>
  typeof listVisibleSessions === 'function' ? listVisibleSessions(limit) : listSessions(limit);

/** Career totals for the Records preview tile — same partial-stub guard. */
const fetchLifetimeTotals = (): Promise<Awaited<ReturnType<typeof lifetimeTotals>> | null> =>
  typeof lifetimeTotals === 'function' ? lifetimeTotals() : Promise.resolve(null);

export default function HistoryScreen() {
  // Canonical card cascade (undefined under reduced motion — static render).
  const enter = useCardStagger({ durationMs: motion.standard });
  // The one skeleton dissolve: placeholders fade under the arriving cards
  // instead of hard-cutting (undefined under reduced motion — plain swap).
  const skeletonExit = useSkeletonExit();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  /** How many sessions the list currently asks for (+PAGE_SIZE per "older" tap). */
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  /** True when the last fetch filled its limit — older sessions may exist. */
  const [hasMore, setHasMore] = useState(false);
  /** Career makes for the Records preview tile (null until loaded). */
  const [careerMakes, setCareerMakes] = useState<number | null>(null);
  /** Skeleton gate — see SKELETON_DELAY_MS. */
  const [showSkeleton, setShowSkeleton] = useState(false);
  /** Selected tag chip filter; null = show every session (no filter active). */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const confirmDelete = useCallback((row: SessionSummaryRow) => {
    // Destructive intent gets the warning tick (settings-gated gateway).
    haptic.warning();
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
        const rows = await fetchHistoryPage(pageLimit);
        // Pips power the mini shot strips AND the unsure chips. Capped to the
        // first page: the per-session sessionShots read is the N+1 hazard of
        // deep paging, and the newest cards are the ones scanned at pip level.
        const pipRows = rows.slice(0, PAGE_SIZE);
        const pips = await Promise.all(
          pipRows.map((r) =>
            sessionShots(r.id).then((shots) => shots.map((s) => s.outcome)),
          ),
        );
        if (!alive) return;
        setItems(rows.map((row, i) => ({ row, pips: pips[i] ?? [] })));
        // A short page means the well is dry — hide the "older" pill.
        setHasMore(rows.length >= pageLimit);
      })();
      return () => {
        alive = false;
      };
    }, [pageLimit]),
  );

  // Career makes for the Records preview tile — one aggregate query per focus.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void fetchLifetimeTotals().then((t) => {
        if (alive && t != null) setCareerMakes(t.makes);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  // Skeleton delay — armed only while the list is still unloaded; the cleanup
  // disarms it the moment data lands, so a fast load never flashes skeletons.
  useEffect(() => {
    if (items !== null) return;
    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [items]);

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

  // Preview lines for the sub-nav tiles: real numbers already on hand (the
  // loaded rows / one lifetime aggregate), never projections. Undefined until
  // data lands — the rich tile simply renders without its second line.
  const latestFg =
    items != null && items.length > 0 ? Math.round(items[0].row.fgPct * 100) : null;
  const prevFg =
    items != null && items.length > 1 ? Math.round(items[1].row.fgPct * 100) : null;
  const trendsPreview =
    latestFg != null
      ? `Latest FG ${latestFg}%${
          prevFg != null
            ? latestFg === prevFg
              ? ' · even vs last'
              : ` · ${latestFg > prevFg ? '+' : ''}${latestFg - prevFg} vs last`
            : ''
        }`
      : undefined;
  const recordsPreview = careerMakes != null ? `${careerMakes} career makes` : undefined;

  return (
    <Screen scroll>
      <Eyebrow>Your sessions</Eyebrow>
      <Text style={styles.title}>Data</Text>
      {/* Text-diet trim; must keep matching /trends and records/i (pinned by
          tabIaCategorisation — the lede maps the sub-nav tiles below it). */}
      <Text style={styles.lede}>
        Session history below — trends and records one tap away.
      </Text>

      <View style={styles.subNav}>
        {/* Rich tiles: each destination previews its own headline number. */}
        <NavTileRow
          eyebrow="EXPLORE"
          variant="rich"
          tiles={[
            {
              icon: 'trending-up',
              label: 'Trends',
              hint: 'See your FG% and volume over time',
              description: trendsPreview,
              onPress: () => router.push('/trends'),
            },
            {
              icon: 'trophy-outline',
              label: 'Records',
              hint: 'Your lifetime records and badges',
              description: recordsPreview,
              onPress: () => router.push('/records'),
            },
          ]}
        />
      </View>

      {/* Section kicker over the log — the tag filter and every session card
          (and the skeletons/empty cards while loading) sit under it, so the
          list is never an orphan and every state keeps the same anatomy. */}
      <SectionEyebrow icon="time-outline" style={styles.sectionKicker}>
        Session log
      </SectionEyebrow>

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
            onPress={() => {
              haptic.selection();
              setTagFilter(null);
            }}
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
                onPress={() => {
                  haptic.selection();
                  setTagFilter(selected ? null : tag);
                }}
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
        // One loading language — the shape of the session cards that are
        // arriving. Gated behind a short delay (see SKELETON_DELAY_MS).
        showSkeleton ? (
          // Skeletons dissolve under the arriving cards (see useSkeletonExit);
          // the Screen container stays mounted, so the exit actually plays.
          <Animated.View exiting={skeletonExit} style={{ gap: layout.cardGap }}>
            <SkeletonCard lines={3} />
            <SkeletonCard lines={3} />
          </Animated.View>
        ) : null
      ) : items.length === 0 ? (
        <EmptyState
          illustration="arc"
          title="No sessions yet"
          body="Finish your first tracked session and it lands here."
          actionLabel="Start a session"
          onAction={() => router.replace('/')}
        />
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
        // listReflow on the container (and each card below) so filter/delete/
        // append changes glide instead of snapping — see the const's comment.
        <Animated.View style={{ gap: layout.cardGap }} layout={listReflow}>
          {(visibleItems ?? []).map(({ row, pips }, index) => {
            const makes = row.makes ?? 0;
            const fg = Math.round(row.fgPct * 100);
            const hasVideo = row.videoPath != null;
            // Honesty surface: unsure shots, derived from the outcome pips the
            // card already fetched (zero extra queries). Pips are capped to
            // the first page, so deep-paged rows show no chip rather than a
            // guessed zero.
            const unsure = pips.filter((o) => o === 'unsure').length;
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
              // PressScale (concrete path — see the import note) replaces the
              // raw pressed-opacity Pressable: same spring + gated tick as
              // every other card press in the app.
              <PressScale
                accessibilityLabel={`Session on ${formatSessionDate(row.startedAt)}${modeName != null ? `, ${modeName}` : ''}, ${makes} of ${row.attempts} makes, ${fg} percent field goals${unsure > 0 ? `, ${unsure} unsure` : ''}${hasVideo ? ', has replay video' : ''}${tag.length > 0 ? `, tagged ${tag}` : ''}`}
                haptic="selection"
                onPress={() =>
                  router.push({
                    pathname: '/history/[id]',
                    params: {
                      id: String(row.id),
                      // Card-to-detail continuity: the SAME persisted row
                      // values this card renders ride the push, so the detail
                      // opens on the numbers just read — never a projection.
                      startedAt: String(row.startedAt),
                      fg: String(fg),
                      makes: String(makes),
                      attempts: String(row.attempts),
                      tag,
                      // The unsure count rides too, so the detail's preview
                      // carries the integrity line instead of showing a bare
                      // FG% for a beat. Sent ONLY when the pips are in hand:
                      // past the first page they are not fetched, and an
                      // absent count must never be reported as zero. Without
                      // it the detail falls back to its plain skeleton.
                      ...(pips.length > 0 ? { unsure: String(unsure) } : null),
                    },
                  })
                }
                onLongPress={() => confirmDelete(row)}
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
                      {/* Unsure chip — the count is already in the card's
                          accessibility label; the visual chip is the sighted
                          reader's copy of the same honesty line. */}
                      {unsure > 0 && (
                        <View importantForAccessibility="no-hide-descendants">
                          <Chip label={`${unsure} unsure`} tone="unsure" />
                        </View>
                      )}
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
              </PressScale>
            );
            return (
              <Animated.View
                key={row.id}
                entering={enter(Math.min(index, STAGGER_CAP))}
                layout={listReflow}
              >
                {card}
              </Animated.View>
            );
          })}
          {/* Incremental paging — the list used to dead-end at a fixed 30.
              Hidden once a fetch comes back short (no older sessions left). */}
          {hasMore && (
            <PillButton
              variant="ghost"
              label="Show older sessions"
              onPress={() => setPageLimit((limit) => limit + PAGE_SIZE)}
            />
          )}
        </Animated.View>
      )}

      {items !== null && items.length > 0 && (
        <View style={{ marginTop: space.xl, alignItems: 'center', gap: space.sm }}>
          {exportFailed && <Chip label="Couldn't export — try again" tone="unsure" />}
          {/* Export only. The "View trends" pill that used to sit beside it was
              the second route to /trends on one screen — the Trends tile at the
              top of this screen is the one that stays, because it sits with
              Records where a reader looks for "where else can I go". */}
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
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
  },
  /** Same lede rhythm as the Train tab, so both tab roots open identically. */
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.lg,
  },
  subNav: {
    marginBottom: space.xl,
  },
  /** SectionEyebrow leaves margins to the call site (screens own rhythm). */
  sectionKicker: {
    marginBottom: space.md,
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
  // Both spread type.statSmall (the smallest broadcast numeral) instead of
  // re-declaring font.display 22/26 — the ladder, never an invented size.
  makesNum: {
    ...type.statSmall,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  attemptsNum: {
    ...type.statSmall,
    fontFamily: font.displayMedium,
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
    // One elevation scale: a plain boundary is a hairline; borderWidth 1 is
    // reserved for hierarchy and identity rings.
    borderWidth: StyleSheet.hairlineWidth,
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
