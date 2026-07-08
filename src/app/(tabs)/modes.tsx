/**
 * Mode picker — choose how you want to play before opening the camera.
 *
 * Every mode reads like a game cartridge: its Ionicons mark in an accent-tinted
 * badge, name, tagline inked in the mode's own hue, two-line rules, a
 * rules-at-a-glance chip row and a bold START affordance (the whole card is the
 * button). Cards rise in with a reduced-motion-aware stagger. Picking one arms
 * the mode store and routes to /session/setup; the previously picked mode wears
 * a solid PICKED tag + accent border so it is unmistakable.
 *
 * Ghost Challenge is the one cartridge that needs a source: tapping it expands
 * an inline picker of the last five sessions with enough makes to race
 * (GHOST_MIN_MAKES); choosing one derives the ghost timeline from that
 * session's persisted shots and starts the mode. With no eligible session the
 * card is disabled with the reason inked where the rules normally sit.
 */
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';

import { NavTileRow } from '@/components/NavTiles';
import { ProBadge } from '@/components/ProBadge';
import {
  DRILL_IDENTITY,
  MODE_IDENTITY,
  type DrillIdentity,
  type ModeIdentity,
} from '@/components/modes/modeIdentity';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { DRILLS, type Drill } from '@/core/drills';
import {
  GAME_MODES,
  GHOST_MIN_MAKES,
  deriveGhostConfig,
  type GameModeDef,
  type GhostConfig,
} from '@/core/gameModes';
import { PRO_FEATURES } from '@/core/premium';
import { listSessions, sessionShots, type SessionSummaryRow } from '@/data/db';
import { useMode } from '@/state/modeStore';
import { useSettings } from '@/state/settingsStore';

/** How many recent raceable sessions the ghost card offers. */
const GHOST_SOURCE_LIMIT = 5;

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
  const selectMode = useMode((s) => s.selectMode);
  const selectDrill = useMode((s) => s.selectDrill);
  const activeMode = useMode((s) => s.activeMode);
  /** The active drill id when a drill is the picked mode (else undefined). */
  const activeDrillId = activeMode?.config?.drill?.id;
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const reducedMotion = useReducedMotion();
  const [proOpen, setProOpen] = useState(false);
  const hasProModes = GAME_MODES.some((m) => m.id !== 'free');

  // Ghost Challenge sources: the last few sessions with enough makes to race.
  // null = still loading (the card stays tappable and shows a loading row).
  const [ghostSources, setGhostSources] = useState<SessionSummaryRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    void listSessions(50).then((rows) => {
      if (!alive) return;
      setGhostSources(
        rows.filter((r) => (r.makes ?? 0) >= GHOST_MIN_MAKES).slice(0, GHOST_SOURCE_LIMIT),
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  const startGhost = (cfg: GhostConfig) => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    selectMode('ghost', { ghost: cfg });
    router.push('/session/setup');
  };

  // Entrance stagger: header first, then cards rise one by one. Under reduced
  // motion the delays collapse so nothing appears to lag.
  const enter = (i: number) =>
    FadeInDown.delay(reducedMotion ? 0 : 60 + i * 50)
      .duration(motion.standard)
      .reduceMotion(ReduceMotion.System);

  const pick = (id: GameModeDef['id']) => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    selectMode(id);
    router.push('/session/setup');
  };

  const pickDrill = (drill: Drill) => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    selectDrill(drill.id);
    router.push('/session/setup');
  };

  return (
    <Screen scroll>
      <Animated.View
        entering={FadeIn.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      >
        <Eyebrow>Choose a mode</Eyebrow>
        <Text style={styles.title}>How do you want to play?</Text>
        <Text style={styles.lede}>
          Every mode runs on the same automatic make/miss tracking — pick a game and prop your
          phone up.
        </Text>
      </Animated.View>

      <View style={styles.tools}>
        <NavTileRow
          eyebrow="TRAINING TOOLS"
          tiles={[
            {
              icon: 'basketball-outline',
              label: 'Scoreboard',
              hint: 'Track a live head-to-head score',
              onPress: () => router.push('/scoreboard'),
            },
            {
              icon: 'fitness',
              label: 'Jump Lab',
              hint: 'Measure and train your vertical',
              onPress: () => router.push('/jump'),
            },
          ]}
        />
        <NavTileRow
          tiles={[
            {
              icon: 'body',
              label: 'Form Studio',
              hint: 'Compare your shooting form to NBA archetypes',
              onPress: () => router.push('/formstudio'),
            },
            {
              icon: 'scan-outline',
              label: 'Video Check',
              hint: 'Run the detector on a video from your library',
              onPress: () => router.push('/session/analyze'),
            },
          ]}
        />
      </View>

      <View style={styles.list}>
        {GAME_MODES.map((mode, i) => (
          <Animated.View key={mode.id} entering={enter(i)}>
            {mode.id === 'ghost' ? (
              <GhostModeCard
                mode={mode}
                identity={MODE_IDENTITY[mode.id]}
                selected={activeMode?.modeId === mode.id}
                sources={ghostSources}
                hapticsEnabled={hapticsEnabled}
                onStart={startGhost}
              />
            ) : (
              <ModeCard
                mode={mode}
                identity={MODE_IDENTITY[mode.id]}
                selected={activeMode?.modeId === mode.id}
                onPress={() => pick(mode.id)}
              />
            )}
          </Animated.View>
        ))}
      </View>

      {/* DRILLS — structured HomeCourt-style workouts. They run as spot shooting
          under the hood but read as their own cartridges here. */}
      <View style={styles.drillSection}>
        <Eyebrow>Drills</Eyebrow>
        <Text style={styles.sectionTitle}>Structured shooting workouts</Text>
        <Text style={styles.sectionLede}>
          Guided spot-by-spot routines with make goals — the live view maps your next spot as
          you go.
        </Text>
        <View style={styles.list}>
          {DRILLS.map((drill, i) => (
            <Animated.View key={drill.id} entering={enter(GAME_MODES.length + i)}>
              <DrillCard
                drill={drill}
                identity={DRILL_IDENTITY[drill.id]}
                selected={activeDrillId === drill.id}
                onPress={() => pickDrill(drill)}
              />
            </Animated.View>
          ))}
        </View>
      </View>

      {hasProModes && (
        <View style={styles.proSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            accessibilityState={{ expanded: proOpen }}
            onPress={() => {
              if (hapticsEnabled) void Haptics.selectionAsync();
              setProOpen((v) => !v);
            }}
            style={({ pressed }) => [styles.proLink, pressed && { opacity: 0.7 }]}
          >
            <ProBadge />
            <Text style={styles.proLinkText}>
              {proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            </Text>
            <Text style={styles.proChevron}>{proOpen ? '︿' : '﹀'}</Text>
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

function ModeCard({
  mode,
  identity,
  selected,
  onPress,
}: {
  mode: GameModeDef;
  identity: ModeIdentity;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${mode.name}. ${mode.tagline}`}
      accessibilityHint={mode.rules}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: identity.accent }],
        pressed && styles.cardPressed,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      {/* The mode's mark — glyph on its own accent-tinted badge. */}
      <View
        style={[
          styles.iconBadge,
          { borderColor: identity.accent, backgroundColor: identity.tint },
        ]}
      >
        <Ionicons name={identity.icon} size={24} color={identity.accent} />
      </View>

      <View style={styles.cardBody}>
        <Row style={styles.cardHead} gap={space.sm}>
          <Text style={styles.name} numberOfLines={1}>
            {mode.name}
          </Text>
          <Row gap={space.xs}>
            {mode.id !== 'free' && <ProBadge />}
            {selected && (
              <View style={[styles.selectedTag, { backgroundColor: identity.accent }]}>
                <Text style={styles.selectedTagText}>✓ PICKED</Text>
              </View>
            )}
          </Row>
        </Row>
        <Text style={[styles.tagline, { color: identity.accent }]}>{mode.tagline}</Text>
        <Text style={styles.rules} numberOfLines={2}>
          {mode.rules}
        </Text>

        {/* Rules at a glance + bold Start (the whole card is the button). */}
        <Row gap={space.sm} style={styles.footRow}>
          <Row gap={space.xs} style={styles.glanceRow}>
            {identity.glance.map((g) => (
              <View key={g} style={styles.glanceChip}>
                <Text style={styles.glanceText}>{g.toUpperCase()}</Text>
              </View>
            ))}
          </Row>
          <View style={[styles.startPill, { backgroundColor: identity.accent }]}>
            <Ionicons name="play" size={11} color={color.onAccent} />
            <Text style={styles.startText}>START</Text>
          </View>
        </Row>
      </View>
    </Pressable>
  );
}

/**
 * Drill cartridge — same card anatomy as {@link ModeCard} (icon badge, name,
 * tagline, two-line rules, glance chips + START), but drawn from the drill
 * catalog + {@link DRILL_IDENTITY}. Tapping starts the drill (which runs as the
 * spotShooting mode) and routes to setup.
 */
function DrillCard({
  drill,
  identity,
  selected,
  onPress,
}: {
  drill: Drill;
  identity: DrillIdentity;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${drill.title} drill. ${drill.tagline}`}
      accessibilityHint={drill.rules}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: identity.accent }],
        pressed && styles.cardPressed,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      <View
        style={[
          styles.iconBadge,
          { borderColor: identity.accent, backgroundColor: identity.tint },
        ]}
      >
        <Ionicons
          name={drill.icon as ComponentProps<typeof Ionicons>['name']}
          size={24}
          color={identity.accent}
        />
      </View>

      <View style={styles.cardBody}>
        <Row style={styles.cardHead} gap={space.sm}>
          <Text style={styles.name} numberOfLines={1}>
            {drill.title}
          </Text>
          <Row gap={space.xs}>
            <ProBadge />
            {selected && (
              <View style={[styles.selectedTag, { backgroundColor: identity.accent }]}>
                <Text style={styles.selectedTagText}>✓ PICKED</Text>
              </View>
            )}
          </Row>
        </Row>
        <Text style={[styles.tagline, { color: identity.accent }]}>{drill.tagline}</Text>
        <Text style={styles.rules} numberOfLines={2}>
          {drill.rules}
        </Text>

        <Row gap={space.sm} style={styles.footRow}>
          <Row gap={space.xs} style={styles.glanceRow}>
            {identity.glance.map((g) => (
              <View key={g} style={styles.glanceChip}>
                <Text style={styles.glanceText}>{g.toUpperCase()}</Text>
              </View>
            ))}
          </Row>
          <View style={[styles.startPill, { backgroundColor: identity.accent }]}>
            <Ionicons name="play" size={11} color={color.onAccent} />
            <Text style={styles.startText}>START</Text>
          </View>
        </Row>
      </View>
    </Pressable>
  );
}

/**
 * Ghost Challenge cartridge. Same card anatomy as {@link ModeCard}, but the
 * card press expands an inline picker of raceable past sessions instead of
 * starting immediately — a ghost needs a source run. Disabled (with the reason
 * inked in place of the rules) when no past session has enough makes.
 */
function GhostModeCard({
  mode,
  identity,
  selected,
  sources,
  hapticsEnabled,
  onStart,
}: {
  mode: GameModeDef;
  identity: ModeIdentity;
  selected: boolean;
  /** Eligible source sessions; null while loading. */
  sources: SessionSummaryRow[] | null;
  hapticsEnabled: boolean;
  onStart: (cfg: GhostConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const disabled = sources != null && sources.length === 0;
  const disabledReason = `Finish a session with ${GHOST_MIN_MAKES}+ tracked makes first — your recent runs will appear here to race.`;

  const toggle = () => {
    if (disabled) return;
    if (hapticsEnabled) void Haptics.selectionAsync();
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
    <Pressable
      onPress={toggle}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${mode.name}. ${mode.tagline}`}
      accessibilityHint={disabled ? disabledReason : `${mode.rules} Opens a list of past sessions to race.`}
      accessibilityState={{ selected, disabled, expanded: open }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: identity.accent }],
        pressed && !disabled && styles.cardPressed,
        pressed && !disabled && { transform: [{ scale: 0.985 }] },
        disabled && styles.cardDisabled,
      ]}
    >
      <View
        style={[
          styles.iconBadge,
          { borderColor: identity.accent, backgroundColor: identity.tint },
        ]}
      >
        <Ionicons name={identity.icon} size={24} color={identity.accent} />
      </View>

      <View style={styles.cardBody}>
        <Row style={styles.cardHead} gap={space.sm}>
          <Text style={styles.name} numberOfLines={1}>
            {mode.name}
          </Text>
          <Row gap={space.xs}>
            <ProBadge />
            {selected && (
              <View style={[styles.selectedTag, { backgroundColor: identity.accent }]}>
                <Text style={styles.selectedTagText}>✓ PICKED</Text>
              </View>
            )}
          </Row>
        </Row>
        <Text style={[styles.tagline, { color: identity.accent }]}>{mode.tagline}</Text>
        <Text style={styles.rules} numberOfLines={disabled ? 3 : 2}>
          {disabled ? disabledReason : mode.rules}
        </Text>

        {/* Rules at a glance + the pick affordance (the card expands). */}
        <Row gap={space.sm} style={styles.footRow}>
          <Row gap={space.xs} style={styles.glanceRow}>
            {identity.glance.map((g) => (
              <View key={g} style={styles.glanceChip}>
                <Text style={styles.glanceText}>{g.toUpperCase()}</Text>
              </View>
            ))}
          </Row>
          {!disabled && (
            <View style={[styles.startPill, { backgroundColor: identity.accent }]}>
              <Ionicons name={open ? 'chevron-up' : 'play'} size={11} color={color.onAccent} />
              <Text style={styles.startText}>{open ? 'HIDE RUNS' : 'PICK A RUN'}</Text>
            </View>
          )}
        </Row>

        {/* Inline source picker: the last few raceable sessions. */}
        {open && !disabled && (
          <View style={styles.ghostList}>
            {sources == null ? (
              <Text style={styles.ghostLoading}>Loading recent sessions…</Text>
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
                      <Text style={[styles.ghostRowGo, { color: identity.accent }]}>LOADING…</Text>
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
      </View>
    </Pressable>
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
  list: {
    gap: space.md,
  },
  tools: {
    gap: space.md,
    marginTop: space.lg,
    marginBottom: space.xl,
  },
  card: {
    flexDirection: 'row',
    gap: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  cardSelected: {
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  cardDisabled: {
    opacity: 0.55,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardHead: {
    justifyContent: 'space-between',
  },
  name: {
    ...type.heading,
    color: color.text,
    flexShrink: 1,
  },
  selectedTag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  selectedTagText: {
    ...type.micro,
    color: color.onAccent,
  },
  tagline: {
    ...type.bodyMedium,
    marginTop: 2,
  },
  rules: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  footRow: {
    marginTop: space.md,
    justifyContent: 'space-between',
  },
  glanceRow: {
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  glanceChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
  },
  glanceText: {
    ...type.micro,
    color: color.textFaint,
  },
  startPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  startText: {
    ...type.micro,
    color: color.onAccent,
  },
  // --- Ghost source picker (inline, inside the ghost cartridge) -----------
  ghostList: {
    marginTop: space.md,
    gap: space.sm,
  },
  ghostLoading: {
    ...type.caption,
    color: color.textFaint,
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
  drillSection: {
    marginTop: space.xl,
  },
  sectionTitle: {
    ...type.heading,
    color: color.text,
    marginTop: space.xs,
  },
  sectionLede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.lg,
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
  proChevron: {
    ...type.caption,
    color: color.textFaint,
  },
  proCard: {
    marginTop: space.md,
  },
  proCardNote: {
    ...type.body,
    color: color.textDim,
    marginBottom: space.md,
  },
  proFeatureList: {
    gap: space.md,
  },
  proFeatureRow: {
    gap: 2,
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
