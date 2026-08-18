/**
 * Mode picker — the Train tab, laid out as a sectioned catalog.
 *
 * Sections render in MODE_SECTIONS order (copy lives in core, not here):
 *   1. QUICK START — a recommendation hero (recommendFromSessions over the
 *      same listSessions(50) rows the ghost picker already fetches) plus Free
 *      Play, always one tap away.
 *   2. GAMES — the seven non-free modes as compact ModeCatalogCard rows;
 *      collapsible.
 *   3. CHALLENGES — this week's goal set (WeeklyChallengeCard) plus the
 *      friend-board entry. See the CHALLENGES block below for why this screen
 *      shows the week but never awards it.
 *   4. DRILLS — the drill catalog, same card anatomy; collapsible. A coach
 *      deep link always re-expands this section so a prescription is visible.
 *   5. TRAINING TOOLS — the nav tiles (Scoreboard / Jump Lab / Form Studio /
 *      Video Check).
 *   6. PRO — the "what does Pro unlock?" disclosure.
 *
 * Picking any card arms the mode store and routes to /session/setup. Ghost
 * Challenge is the one cartridge that needs a source: tapping it expands an
 * inline picker of the last five sessions with enough makes to race
 * (GHOST_MIN_MAKES); choosing one derives the ghost timeline from that
 * session's persisted shots and starts the mode. With no eligible session the
 * card is disabled with the reason inked where the tagline normally sits.
 *
 * The H1 is the TAB WORD ("Train"), not a friendly question: the bottom bar
 * says Train, so the screen it opens has to say Train back or the label never
 * becomes muscle memory. The friendly line lives on as the lede.
 */
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { LEADERBOARD_TILE, NavTileRow } from '@/components/NavTiles';
import { WeeklyChallengeCard } from '@/components/WeeklyChallengeCard';
import { ProBadge } from '@/components/ProBadge';
import { ModeCatalogCard } from '@/components/modes/ModeCatalogCard';
import { ModeSectionHeader } from '@/components/modes/ModeSectionHeader';
import { ToolCard } from '@/components/modes/ToolCard';
import { RecommendedHero } from '@/components/modes/RecommendedHero';
import {
  DRILL_IDENTITY,
  MODE_IDENTITY,
  type ModeIdentity,
} from '@/components/modes/modeIdentity';
import { Shimmer, useCardStagger } from '@/components/motion';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, iconSize, motion, radius, space, touch, type } from '@/constants/tokens';
import { levelOfGoals, type DrillLevel } from '@/core/drillProgression';
import { DRILLS, type Drill, type DrillId } from '@/core/drills';
import {
  GAME_MODES,
  GHOST_MIN_MAKES,
  deriveGhostConfig,
  type GameModeDef,
  type GhostConfig,
} from '@/core/gameModes';
import { MODE_SECTIONS, gameSectionModes } from '@/core/modeCatalogSections';
import {
  recommendFromSessions,
  recommendationReason,
  type ModeRecommendation,
} from '@/core/modeRecommendation';
import { PRO_FEATURES } from '@/core/premium';
import {
  emptyWeekAggregate,
  isoWeekKey,
  pickWeeklyChallenges,
  type WeekAggregate,
} from '@/core/weeklyChallenges';
import { listSessions, sessionShots, type SessionSummaryRow } from '@/data/db';
import { loadWeekAggregate } from '@/state/challengeStore';
import { useMode } from '@/state/modeStore';
import { haptic } from '@/utils/haptics';

/** How many recent raceable sessions the ghost card offers. */
const GHOST_SOURCE_LIMIT = 5;

// Section copy lives in core (modeCatalogSections.ts) so the taxonomy is
// testable pure TS; this screen only renders it.
const quickStartSection = MODE_SECTIONS.find((s) => s.id === 'quickStart')!;
const gamesSection = MODE_SECTIONS.find((s) => s.id === 'games')!;
const challengesSection = MODE_SECTIONS.find((s) => s.id === 'challenges')!;
const drillsSection = MODE_SECTIONS.find((s) => s.id === 'drills')!;
const toolsSection = MODE_SECTIONS.find((s) => s.id === 'tools')!;

/** The Games section catalog: every mode except 'free', catalog order. */
const GAME_SECTION_MODES = gameSectionModes();

/** Free Play — GAME_MODES[0] by catalog contract; lives in Quick start. */
const FREE_DEF = GAME_MODES[0];

/**
 * GAMES grid split: every non-ghost game tiles up 2-across; Ghost keeps the
 * one full-width row beneath the grid (its inline source picker needs the
 * width). The ghost lookup cannot miss — 'ghost' is in the catalog contract.
 */
const TILE_MODES = GAME_SECTION_MODES.filter((m) => m.id !== 'ghost');
const GHOST_DEF = GAME_SECTION_MODES.find((m) => m.id === 'ghost')!;

/** Chunk the tile catalog into rows of two for the cartridge grid. */
function pairRows<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}
const TILE_ROWS = pairRows(TILE_MODES);

/**
 * Height of the QUICK START hero skeleton — matches RecommendedHero's resting
 * height (2×lg padding + eyebrow 16 + name 22+4 + tagline 21+2 + reason 16+4
 * + foot 12+23 ≈ 152) so the shelf below does not jump when the hero lands.
 */
const HERO_SKELETON_HEIGHT = 152;

/** Player-facing name for a ghost source session: its tag, else its date. */
function ghostSourceTitle(row: SessionSummaryRow): string {
  const label = row.label.trim();
  if (label.length > 0) return label;
  const d = new Date(row.startedAt);
  return `${d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export default function ModePickerScreen() {
  // Hero skeleton width: Screen's scroll content = window minus 2×lg padding.
  const contentW = useWindowDimensions().width - space.lg * 2;
  const selectMode = useMode((s) => s.selectMode);
  const selectDrill = useMode((s) => s.selectDrill);
  const activeMode = useMode((s) => s.activeMode);
  /** The active drill id when a drill is the picked mode (else undefined). */
  const activeDrillId = activeMode?.config?.drill?.id;
  const [proOpen, setProOpen] = useState(false);
  const hasProModes = GAME_MODES.some((m) => m.id !== 'free');

  // Collapse state is in-memory ONLY — deliberately not persisted; persisting
  // it would require a settingsStore version bump for a preference nobody
  // asked to keep across launches.
  const [collapsed, setCollapsed] = useState<{ games: boolean; drills: boolean }>({
    games: false,
    drills: false,
  });
  const [reco, setReco] = useState<ModeRecommendation | null>(null);

  // Deep-link preselect from Coach's Corner ("Practice at level N"): arm the
  // drill at the prescribed level once per param value. The ref guard keeps
  // tab revisits (params persist on tab roots) from re-arming the mode — it
  // keys on drill AND level so next week's "same drill, level 3" prescription
  // still re-arms.
  const params = useLocalSearchParams<{ drill?: string; level?: string }>();
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    const id = params.drill;
    const key = `${params.drill}:${params.level}`;
    if (!id || consumed.current === key) return;
    if (!DRILLS.some((d) => d.id === id)) return;
    consumed.current = key;
    const n = Number(params.level);
    const level: DrillLevel = n === 2 || n === 3 ? (n as DrillLevel) : 1;
    selectDrill(id as DrillId, level);
    // A coach prescription must always be visible — re-expand Drills.
    setCollapsed((s) => ({ ...s, drills: false }));
  }, [params.drill, params.level, selectDrill]);

  // One eager listSessions(50) feeds BOTH the ghost picker and the Quick-start
  // recommendation (SessionSummaryRow structurally satisfies
  // RecommendationInputRow — startedAt/modeId/modeResultJson are all present).
  // null = still loading (the ghost card stays tappable, shows a loading row).
  const [ghostSources, setGhostSources] = useState<SessionSummaryRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    void listSessions(50).then((rows) => {
      if (!alive) return;
      setGhostSources(
        rows.filter((r) => (r.makes ?? 0) >= GHOST_MIN_MAKES).slice(0, GHOST_SOURCE_LIMIT),
      );
      setReco(recommendFromSessions(rows, Date.now()));
    });
    return () => {
      alive = false;
    };
  }, []);

  // --- CHALLENGES section data ------------------------------------------
  // READ-ONLY on purpose. Home (app/(tabs)/index.tsx) owns awardWeekly: it is
  // the single writer of the points ledger, gated on challengeStore hydration.
  // A second screen awarding the same week key could double-credit a goal the
  // moment both are mounted, so Train only ever DISPLAYS the week — every
  // number on the card still comes from the same loadWeekAggregate() read.
  const [weekKey, setWeekKey] = useState(() => isoWeekKey(Date.now()));
  const [weekAgg, setWeekAgg] = useState<WeekAggregate>(emptyWeekAggregate);
  // useFocusEffect, not useEffect: the bars have to be current after a session
  // finishes and the user taps back into Train, and the week key has to roll
  // over on a Monday the app stayed open through.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setWeekKey(isoWeekKey(Date.now()));
      loadWeekAggregate()
        .then((agg) => {
          if (alive) setWeekAgg(agg);
        })
        .catch(() => {
          // Honest fallback (same as Home's): an unreadable week shows true
          // zeros rather than stale numbers from a previous focus.
          if (alive) setWeekAgg(emptyWeekAggregate());
        });
      return () => {
        alive = false;
      };
    }, []),
  );
  /** This week's three — deterministic for the week key, stable until Monday. */
  const weeklyChallengeSet = useMemo(() => pickWeeklyChallenges(weekKey), [weekKey]);

  const startGhost = (cfg: GhostConfig) => {
    haptic.impactLight();
    selectMode('ghost', { ghost: cfg });
    router.push('/session/setup');
  };

  // Entrance stagger: i is the LOCAL index within each section, capped at 8 so
  // long lists don't lag their tails. useCardStagger returns undefined under
  // reduced motion (cards render still — Card's optional entering contract).
  const stagger = useCardStagger({ baseDelayMs: 60, stepMs: 50, durationMs: motion.standard });
  const enter = (i: number) => stagger(Math.min(i, 8));

  const pick = (id: GameModeDef['id']) => {
    haptic.impactLight();
    selectMode(id);
    router.push('/session/setup');
  };

  const pickDrill = (drill: Drill) => {
    haptic.impactLight();
    // Preserve an armed level: the coach deep link above arms the drill at a
    // prescribed level, and the start tap lands here — re-selecting without it
    // would silently downgrade the prescription to Level 1. The level is
    // inferred from the armed goals (levelOfGoals — same recovery History
    // uses), and selectDrill still re-inits fresh progress at that level.
    const armedGoals =
      activeDrillId === drill.id ? activeMode?.config?.drill?.goals : undefined;
    selectDrill(drill.id, armedGoals != null ? levelOfGoals(drill.id, armedGoals) : undefined);
    router.push('/session/setup');
  };

  /** Arm the recommended mode/drill and route to setup — one tap. */
  const startReco = () => {
    if (reco == null) return;
    haptic.impactLight();
    if (reco.kind === 'mode') {
      selectMode(reco.modeId);
    } else {
      selectDrill(
        reco.drillId,
        reco.goals != null ? levelOfGoals(reco.drillId, reco.goals) : undefined,
      );
    }
    router.push('/session/setup');
  };

  const toggleSection = (id: 'games' | 'drills') => {
    haptic.selection();
    setCollapsed((s) => ({ ...s, [id]: !s[id] }));
  };

  // Resolve the recommendation to its catalog identity/copy. The recommender
  // only ever returns catalog ids (unknown ids are filtered inside), so the
  // finds cannot miss.
  let hero: {
    icon: ComponentProps<typeof Ionicons>['name'];
    name: string;
    tagline: string;
    accent: string;
    tint: string;
    edge: string;
    selected: boolean;
  } | null = null;
  if (reco != null) {
    if (reco.kind === 'mode') {
      const def = GAME_MODES.find((m) => m.id === reco.modeId)!;
      const identity = MODE_IDENTITY[reco.modeId];
      hero = {
        icon: identity.icon,
        name: def.name,
        tagline: def.tagline,
        accent: identity.accent,
        tint: identity.tint,
        edge: identity.edge,
        // Armed-mode check mirrors the Games cards: a drill armed on top of
        // spotShooting must not light a plain-mode hero as PICKED.
        selected: activeMode?.modeId === reco.modeId && activeMode?.config?.drill == null,
      };
    } else {
      const drill = DRILLS.find((d) => d.id === reco.drillId)!;
      const identity = DRILL_IDENTITY[reco.drillId];
      hero = {
        icon: drill.icon as ComponentProps<typeof Ionicons>['name'],
        name: drill.title,
        tagline: drill.tagline,
        accent: identity.accent,
        tint: identity.tint,
        edge: identity.edge,
        selected: activeDrillId === reco.drillId,
      };
    }
  }

  return (
    <Screen scroll>
      <Animated.View
        entering={FadeIn.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      >
        <Eyebrow>Choose a mode</Eyebrow>
        {/* H1 == the tab word. The old H1 ("How do you want to play?") is the
            first half of the lede now, so the friendly voice survives without
            costing the tab bar its label. */}
        <Text style={styles.title}>Train</Text>
        <Text style={styles.lede}>
          How do you want to play? Every mode runs on the same automatic make/miss tracking —
          pick a game and prop your phone up.
        </Text>
      </Animated.View>

      {/* QUICK START — the hero slot is ALWAYS occupied: a Shimmer skeleton
          while the session read is in flight (kills the layout jump on every
          visit), then the recommendation hero — or, for a new player with no
          history to recommend from, Free Play promoted into the hero. */}
      <ModeSectionHeader title={quickStartSection.title} />
      <View style={styles.sectionList}>
        {ghostSources == null ? (
          <Animated.View entering={enter(0)}>
            <Shimmer width={contentW} height={HERO_SKELETON_HEIGHT} radius={radius.lg} />
          </Animated.View>
        ) : hero != null && reco != null ? (
          <Animated.View entering={enter(0)}>
            <RecommendedHero
              icon={hero.icon}
              name={hero.name}
              tagline={hero.tagline}
              accent={hero.accent}
              tint={hero.tint}
              edge={hero.edge}
              reason={recommendationReason(reco)}
              selected={hero.selected}
              onPress={startReco}
            />
          </Animated.View>
        ) : (
          // New player (<2 plays → reco == null): Free Play IS the hero. The
          // 'starter' variant renders no reason line at all — there is no
          // session history to cite, and inventing one is forbidden.
          <Animated.View entering={enter(0)}>
            <RecommendedHero
              variant="starter"
              icon={MODE_IDENTITY.free.icon}
              name={FREE_DEF.name}
              tagline={FREE_DEF.tagline}
              accent={MODE_IDENTITY.free.accent}
              tint={MODE_IDENTITY.free.tint}
              edge={MODE_IDENTITY.free.edge}
              selected={activeMode?.modeId === 'free'}
              onPress={() => pick('free')}
            />
          </Animated.View>
        )}
        {/* Free Play compact row — hidden only once Free Play IS the hero
            (rendered while loading so a returning player's shelf holds
            still; a recommendation landing changes nothing below it). */}
        {(ghostSources == null || reco != null) && (
          <Animated.View entering={enter(1)}>
            <ModeCatalogCard
              icon={MODE_IDENTITY.free.icon}
              name={FREE_DEF.name}
              tagline={FREE_DEF.tagline}
              accent={MODE_IDENTITY.free.accent}
              tint={MODE_IDENTITY.free.tint}
              glance={MODE_IDENTITY.free.glance}
              showProBadge={false}
              selected={activeMode?.modeId === 'free'}
              accessibilityHint={FREE_DEF.rules}
              onPress={() => pick('free')}
            />
          </Animated.View>
        )}
      </View>

      {/* GAMES — the seven non-free modes; collapsible. */}
      <View style={styles.sectionGap}>
        <ModeSectionHeader
          title={gamesSection.title}
          count={GAME_SECTION_MODES.length}
          lede={gamesSection.lede}
          collapsed={collapsed.games}
          onToggle={() => toggleSection('games')}
        />
        {!collapsed.games && (
          <Animated.View
            entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}
            style={styles.sectionList}
          >
            {/* 2-column cartridge grid — every game except Ghost. Saves the
                section ~200px over the old full-width rows. */}
            {TILE_ROWS.map((pair, rowIdx) => (
              <Animated.View
                key={pair.map((m) => m.id).join('+')}
                entering={enter(rowIdx)}
                style={styles.tileRow}
              >
                {pair.map((m) => {
                  // PICKED guard: drills run as modeId 'spotShooting', so an
                  // armed DRILL must not light the Spot Shooting tile.
                  const isSelected =
                    activeMode?.modeId === m.id &&
                    (m.id !== 'spotShooting' || activeMode?.config?.drill == null);
                  return (
                    <ModeCatalogCard
                      key={m.id}
                      variant="tile"
                      icon={MODE_IDENTITY[m.id].icon}
                      name={m.name}
                      tagline={m.tagline}
                      accent={MODE_IDENTITY[m.id].accent}
                      tint={MODE_IDENTITY[m.id].tint}
                      glance={MODE_IDENTITY[m.id].glance}
                      showProBadge
                      selected={isSelected}
                      accessibilityHint={m.rules}
                      onPress={() => pick(m.id)}
                    />
                  );
                })}
                {pair.length === 1 && <View style={styles.tileSpacer} />}
              </Animated.View>
            ))}
            {/* Ghost keeps the one full-width row — the inline source picker
                needs the width. */}
            <Animated.View key={GHOST_DEF.id} entering={enter(TILE_ROWS.length)}>
              <GhostCatalogCard
                mode={GHOST_DEF}
                identity={MODE_IDENTITY[GHOST_DEF.id]}
                selected={activeMode?.modeId === GHOST_DEF.id}
                sources={ghostSources}
                onStart={startGhost}
              />
            </Animated.View>
          </Animated.View>
        )}
      </View>

      {/* CHALLENGES — the one section where "challenge" means a scored goal:
          this week's set, and the friend board you can send a score to. The
          card is display-only here (see the CHALLENGES data block above); the
          leaderboard tile is placed EXPLICITLY rather than injected by
          NavTileRow, so no copy edit can delete the app's only social entry
          point. */}
      <View style={styles.sectionGap}>
        <ModeSectionHeader
          title={challengesSection.title}
          lede={challengesSection.lede}
        />
        <View style={styles.sectionList}>
          <WeeklyChallengeCard
            challenges={weeklyChallengeSet}
            agg={weekAgg}
            entering={enter(0)}
          />
          <Animated.View entering={enter(1)}>
            <NavTileRow tiles={[LEADERBOARD_TILE]} />
          </Animated.View>
        </View>
      </View>

      {/* DRILLS — structured HomeCourt-style workouts. They run as spot
          shooting under the hood but read as their own cartridges here. */}
      <View style={styles.sectionGap}>
        <ModeSectionHeader
          title={drillsSection.title}
          count={DRILLS.length}
          lede={drillsSection.lede}
          collapsed={collapsed.drills}
          onToggle={() => toggleSection('drills')}
        />
        {!collapsed.drills && (
          <Animated.View
            entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}
            style={styles.sectionList}
          >
            {DRILLS.map((drill, i) => (
              <Animated.View key={drill.id} entering={enter(i)}>
                <ModeCatalogCard
                  icon={drill.icon as ComponentProps<typeof Ionicons>['name']}
                  name={drill.title}
                  tagline={drill.tagline}
                  accent={DRILL_IDENTITY[drill.id].accent}
                  tint={DRILL_IDENTITY[drill.id].tint}
                  glance={DRILL_IDENTITY[drill.id].glance}
                  showProBadge
                  selected={activeDrillId === drill.id}
                  accessibilityHint={drill.rules}
                  onPress={() => pickDrill(drill)}
                />
              </Animated.View>
            ))}
          </Animated.View>
        )}
      </View>

      {/* TRAINING TOOLS — 2-column ToolCard entry cards with the one-line
          hint made VISIBLE (the old NavTiles hid it in the a11y tree). The
          Leaderboard NavTile stays in CHALLENGES above — this section never
          renders NavTileRow. */}
      <View style={styles.sectionGap}>
        <ModeSectionHeader title={toolsSection.title} />
        <View style={styles.sectionList}>
          <View style={styles.tileRow}>
            <ToolCard
              icon="basketball-outline"
              label="Scoreboard"
              hint="Track a live head-to-head score"
              onPress={() => router.push('/scoreboard')}
            />
            <ToolCard
              icon="fitness"
              label="Jump Lab"
              hint="Measure and train your vertical"
              onPress={() => router.push('/jump')}
            />
          </View>
          <View style={styles.tileRow}>
            <ToolCard
              icon="body"
              label="Form Studio"
              hint="Compare your shooting form to NBA archetypes"
              onPress={() => router.push('/formstudio')}
            />
            <ToolCard
              icon="scan-outline"
              label="Video Check"
              hint="Run the detector on a video from your library"
              onPress={() => router.push('/session/analyze')}
            />
          </View>
        </View>
      </View>

      {hasProModes && (
        <View style={styles.proSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            accessibilityState={{ expanded: proOpen }}
            onPress={() => {
              haptic.selection();
              setProOpen((v) => !v);
            }}
            style={({ pressed }) => [styles.proLink, pressed && { opacity: 0.7 }]}
          >
            <ProBadge />
            <Text style={styles.proLinkText}>
              {proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            </Text>
            <Ionicons
              name={proOpen ? 'chevron-up' : 'chevron-down'}
              size={iconSize.md}
              color={color.textFaint}
            />
          </Pressable>
          {proOpen && (
            <Animated.View entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}>
              <Card style={styles.proCard}>
                <Text style={styles.proCardNote}>
                  Everything below is unlocked and free during beta. This is what stays part of
                  Hoopilot Pro after launch.
                </Text>
                <View style={styles.proFeatureList}>
                  {PRO_FEATURES.map((f) => (
                    <View key={f.id} style={styles.proFeatureRow}>
                      <Text style={styles.proFeatureName}>{f.name}</Text>
                      <Text style={styles.proFeatureBlurb}>{f.blurb}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </Animated.View>
          )}
        </View>
      )}
    </Screen>
  );
}

/**
 * Ghost Challenge as a compact catalog card. Same anatomy as every other
 * ModeCatalogCard row, but the card press expands an inline picker of raceable
 * past sessions instead of starting immediately — a ghost needs a source run.
 * Disabled (with the reason inked in place of the tagline, and read in full by
 * the accessibility hint) when no past session has enough makes.
 */
function GhostCatalogCard({
  mode,
  identity,
  selected,
  sources,
  onStart,
}: {
  mode: GameModeDef;
  identity: ModeIdentity;
  selected: boolean;
  /** Eligible source sessions; null while loading. */
  sources: SessionSummaryRow[] | null;
  onStart: (cfg: GhostConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  // Skeleton row width: window minus the screen (lg) and card (md) padding.
  const ghostRowW = useWindowDimensions().width - space.lg * 2 - space.md * 2;
  const disabled = sources != null && sources.length === 0;
  const disabledReason = `Finish a session with ${GHOST_MIN_MAKES}+ tracked makes first — your recent runs will appear here to race.`;

  const toggle = () => {
    if (disabled) return;
    haptic.selection();
    setOpen((v) => !v);
  };

  const start = async (row: SessionSummaryRow) => {
    if (busyId != null) return;
    setBusyId(row.id);
    setRowError(null);
    const shots = await sessionShots(row.id);
    const cfg = deriveGhostConfig(shots, {
      sourceSessionId: row.id,
      sourceLabel: ghostSourceTitle(row),
    });
    setBusyId(null);
    if (cfg == null) {
      setRowError('That session has no usable shot timeline — try another run.');
      return;
    }
    onStart(cfg);
  };

  return (
    <ModeCatalogCard
      icon={identity.icon}
      name={mode.name}
      tagline={disabled ? disabledReason : mode.tagline}
      accent={identity.accent}
      tint={identity.tint}
      selected={selected}
      showProBadge
      disabled={disabled}
      glance={identity.glance}
      rightIcon={open ? 'chevron-up' : 'chevron-down'}
      accessibilityHint={
        disabled ? disabledReason : `${mode.rules} Opens a list of past sessions to race.`
      }
      onPress={toggle}
    >
      {/* Inline source picker: the last few raceable sessions. */}
      {open && !disabled && (
        <View style={styles.ghostList}>
          {sources == null ? (
            // Two skeletons shaped like the real ghostRow (48px, radius.md) —
            // the app's one loading language, no dim placeholder text.
            <>
              <Shimmer width={ghostRowW} height={touch.minTarget} radius={radius.md} />
              <Shimmer width={ghostRowW} height={touch.minTarget} radius={radius.md} />
            </>
          ) : (
            sources.map((s) => {
              const title = ghostSourceTitle(s);
              const fgPct = Math.round(s.fgPct * 100);
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Race ${title}: ${s.makes} makes, ${fgPct} percent field goals`}
                  accessibilityState={{ busy: busyId === s.id }}
                  disabled={busyId != null}
                  onPress={() => void start(s)}
                  style={({ pressed }) => [
                    styles.ghostRow,
                    pressed && styles.ghostRowPressed,
                    busyId === s.id && { borderColor: identity.accent },
                  ]}
                >
                  <View style={styles.ghostRowBody}>
                    <Text style={styles.ghostRowTitle} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={styles.ghostRowSub} numberOfLines={1}>
                      {s.makes} makes · {fgPct}% FG
                    </Text>
                  </View>
                  {busyId === s.id ? (
                    // Shimmer sweep in place of the RACE affordance while the
                    // shot timeline loads.
                    <Shimmer width={56} height={14} radius={radius.sm} />
                  ) : (
                    <Row gap={space.xs}>
                      <Text style={[styles.ghostRowGo, { color: identity.accent }]}>RACE</Text>
                      <Ionicons name="chevron-forward" size={13} color={identity.accent} />
                    </Row>
                  )}
                </Pressable>
              );
            })
          )}
          {rowError != null && (
            <Text accessibilityLiveRegion="polite" style={styles.ghostError}>
              {rowError}
            </Text>
          )}
        </View>
      )}
    </ModeCatalogCard>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.xl,
  },
  /** Space between sections. */
  sectionGap: {
    marginTop: space.xl,
  },
  /** Space between a section header and its cards, and between cards. */
  sectionList: {
    marginTop: space.md,
    gap: space.md,
  },
  /** One 2-up grid row (GAMES cartridges, TRAINING TOOLS cards). */
  tileRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  /** Keeps a lone tile at half width when the catalog count is odd. */
  tileSpacer: {
    flex: 1,
  },
  // --- Ghost source picker (inline, inside the ghost cartridge) -----------
  ghostList: {
    marginTop: space.md,
    gap: space.sm,
  },
  ghostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: touch.minTarget,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  ghostRowPressed: {
    backgroundColor: color.surface,
  },
  ghostRowBody: {
    flex: 1,
    minWidth: 0,
  },
  ghostRowTitle: {
    ...type.bodyMedium,
    color: color.text,
  },
  ghostRowSub: {
    ...type.caption,
    color: color.textDim,
    marginTop: 1,
  },
  ghostRowGo: {
    ...type.micro,
  },
  ghostError: {
    ...type.caption,
    color: color.miss,
  },
  proSection: {
    marginTop: space.xl,
  },
  proLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'center',
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
  },
  proLinkText: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  proCard: {
    marginTop: space.md,
  },
  proFeatureList: {
    gap: space.md,
  },
  proFeatureRow: {
    gap: 2,
  },
  proCardNote: {
    ...type.body,
    color: color.textDim,
    marginBottom: space.md,
  },
  proFeatureName: {
    ...type.bodyMedium,
    color: color.text,
  },
  proFeatureBlurb: {
    ...type.body,
    color: color.textDim,
  },
});
