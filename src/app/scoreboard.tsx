/**
 * Scoreboard — standalone two-team tap-to-score screen for pickup games,
 * styled as a broadcast scorebug (two surface panels with team-tinted rules
 * and giant tabular numerals around a clock/period center column).
 *
 * Fully self-contained: does not read or touch the camera/detection session
 * (src/state/sessionStore.ts) or anything under src/core shot-tracking. State
 * lives in src/state/scoreboardStore.ts, persisted across launches.
 *
 * Layout: portrait stacks Home / center controls / Away top to bottom;
 * landscape places the two scorebug panels side by side with the center
 * column (clock, period, leading-by, swap, reset) between them so it reads
 * like a real scoreboard propped up courtside. Panels cascade in through the
 * canonical card stagger (useCardStagger — static under reduced motion).
 *
 * The whole scorebug is the screen's single hero composition — not a card
 * stack — so it carries no SectionEyebrow headers; each panel already names
 * itself (HOME/AWAY tags inside TeamPanel, PERIOD in the center column).
 */
import { Ionicons } from '@expo/vector-icons';
import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import { GameClock } from '@/components/scoreboard/GameClock';
import { TeamPanel } from '@/components/scoreboard/TeamPanel';
import { useCardStagger } from '@/components/motion';
import { Chip, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';
import { useScoreboard } from '@/state/scoreboardStore';

function leadingByLabel(homeName: string, awayName: string, homeScore: number, awayScore: number): string {
  const diff = homeScore - awayScore;
  if (diff === 0) return 'Tied';
  const leader = diff > 0 ? homeName : awayName;
  return `${leader.toUpperCase()} +${Math.abs(diff)}`;
}

export default function ScoreboardScreen() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  // Canonical entrance (motion sweep): the hand-rolled FadeInDown ladder is
  // gone — useCardStagger owns step/duration and the reduced-motion gate.
  const enter = useCardStagger();

  const homeName = useScoreboard((s) => s.homeName);
  const awayName = useScoreboard((s) => s.awayName);
  const homeScore = useScoreboard((s) => s.homeScore);
  const awayScore = useScoreboard((s) => s.awayScore);
  const period = useScoreboard((s) => s.period);
  const scoreAction = useScoreboard((s) => s.score);
  const setName = useScoreboard((s) => s.setName);
  const nextPeriod = useScoreboard((s) => s.nextPeriod);
  const swapSides = useScoreboard((s) => s.swapSides);
  const resetGame = useScoreboard((s) => s.reset);

  const confirmAndReset = () => {
    haptic.selection();
    Alert.alert(
      'Reset the game?',
      'Both scores and the period go back to the start. Team names are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            resetGame();
            haptic.success();
          },
        },
      ],
    );
  };

  const centerColumn = (
    <View style={styles.centerColumn}>
      <GameClock />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Period ${period}. Tap to advance to the next period`}
        onPress={() => {
          haptic.selection();
          nextPeriod();
        }}
        style={({ pressed }) => [styles.periodChip, pressed && styles.periodChipPressed]}
      >
        <Text style={styles.periodLabel}>PERIOD</Text>
        <Text style={styles.periodValue}>{period}</Text>
      </Pressable>

      <View accessibilityLabel={leadingByLabel(homeName, awayName, homeScore, awayScore)}>
        <Chip
          label={leadingByLabel(homeName, awayName, homeScore, awayScore)}
          tone={homeScore === awayScore ? 'default' : 'accent'}
        />
      </View>

      <View style={styles.utilityRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Swap sides"
          accessibilityHint="Swaps home and away team names and scores"
          onPress={() => {
            haptic.selection();
            swapSides();
          }}
          style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityButtonPressed]}
        >
          <Ionicons name="swap-horizontal" size={20} color={color.textDim} />
          <Text style={styles.utilityLabel}>SWAP</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset game"
          accessibilityHint="Clears both scores and the period after a confirmation"
          onPress={confirmAndReset}
          style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityButtonPressed]}
        >
          <Ionicons name="refresh-outline" size={20} color={color.miss} />
          <Text style={[styles.utilityLabel, { color: color.miss }]}>RESET</Text>
        </Pressable>
      </View>
    </View>
  );

  const homePanel = (
    <TeamPanel
      teamLabel="Home"
      name={homeName}
      score={homeScore}
      tint={color.accent}
      onRename={(name) => setName('home', name)}
      onAdd={(delta) => {
        haptic.selection();
        scoreAction('home', delta);
      }}
    />
  );
  const awayPanel = (
    <TeamPanel
      teamLabel="Away"
      name={awayName}
      score={awayScore}
      tint={color.info}
      onRename={(name) => setName('away', name)}
      onAdd={(delta) => {
        haptic.selection();
        scoreAction('away', delta);
      }}
    />
  );

  return (
    <Screen padded={!isLandscape} style={isLandscape && styles.landscapeScreen}>
      <View style={[styles.header, isLandscape && styles.headerLandscape]}>
        <BackPill />
        {!isLandscape && (
          <Text style={styles.title} accessibilityRole="header">
            Scoreboard
          </Text>
        )}
      </View>

      {isLandscape ? (
        <View style={styles.landscapeBody}>
          <Animated.View entering={enter(0)} style={styles.landscapeTeam}>
            {homePanel}
          </Animated.View>
          <Animated.View entering={enter(1)}>{centerColumn}</Animated.View>
          <Animated.View entering={enter(2)} style={styles.landscapeTeam}>
            {awayPanel}
          </Animated.View>
        </View>
      ) : (
        <View style={styles.portraitBody}>
          <Animated.View entering={enter(0)} style={styles.portraitPanel}>
            {homePanel}
          </Animated.View>
          <Animated.View entering={enter(1)}>{centerColumn}</Animated.View>
          <Animated.View entering={enter(2)} style={styles.portraitPanel}>
            {awayPanel}
          </Animated.View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: space.sm,
  },
  headerLandscape: {
    position: 'absolute',
    top: space.md,
    left: space.lg,
    zIndex: 1,
    marginBottom: 0,
  },
  landscapeScreen: {
    paddingHorizontal: space.md,
  },
  title: {
    ...type.title,
    color: color.text,
    marginTop: space.sm,
  },
  portraitBody: {
    flex: 1,
    justifyContent: 'space-evenly',
    gap: space.lg,
    paddingBottom: space.xl,
  },
  portraitPanel: {
    flex: 1,
  },
  landscapeBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.md,
  },
  landscapeTeam: {
    flex: 1,
  },
  centerColumn: {
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
  },
  periodChip: {
    minHeight: touch.minTarget,
    minWidth: touch.minTarget * 2,
    borderRadius: radius.md,
    // Plain boundary — hairline; borderWidth 1 is reserved for hierarchy.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
    gap: 2,
  },
  periodChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  periodLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  periodValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  utilityRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.xs,
  },
  utilityButton: {
    minWidth: touch.minTarget,
    minHeight: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  utilityButtonPressed: {
    backgroundColor: color.surfaceRaised,
  },
  utilityLabel: {
    ...type.micro,
    color: color.textFaint,
  },
});
