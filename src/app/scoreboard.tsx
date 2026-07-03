/**
 * Scoreboard — standalone two-team tap-to-score screen for pickup games.
 *
 * Fully self-contained: does not read or touch the camera/detection session
 * (src/state/sessionStore.ts) or anything under src/core shot-tracking. State
 * lives in src/state/scoreboardStore.ts, persisted across launches.
 *
 * Layout: portrait stacks Home / center controls / Away top to bottom;
 * landscape places the two huge score numerals side by side with the center
 * column (clock, period, leading-by, swap, reset) between them so it reads
 * well propped up courtside.
 */
import * as Haptics from 'expo-haptics';
import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { BackPill } from '@/components/ShotList';
import { GameClock } from '@/components/scoreboard/GameClock';
import { TeamPanel } from '@/components/scoreboard/TeamPanel';
import { Chip, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import { useSettings } from '@/state/settingsStore';
import { useScoreboard } from '@/state/scoreboardStore';

function tick() {
  if (useSettings.getState().hapticsEnabled) void Haptics.selectionAsync();
}

function leadingByLabel(homeName: string, awayName: string, homeScore: number, awayScore: number): string {
  const diff = homeScore - awayScore;
  if (diff === 0) return 'Tied';
  const leader = diff > 0 ? homeName : awayName;
  return `${leader.toUpperCase()} +${Math.abs(diff)}`;
}

export default function ScoreboardScreen() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

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
    tick();
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
            if (useSettings.getState().hapticsEnabled) {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
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
          tick();
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
            tick();
            swapSides();
          }}
          style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityButtonPressed]}
        >
          <Text style={styles.utilityGlyph}>{'⇄'}</Text>
          <Text style={styles.utilityLabel}>SWAP</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset game"
          accessibilityHint="Clears both scores and the period after a confirmation"
          onPress={confirmAndReset}
          style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityButtonPressed]}
        >
          <Text style={[styles.utilityGlyph, { color: color.miss }]}>{'↺'}</Text>
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
        tick();
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
        tick();
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
          <View style={styles.landscapeTeam}>{homePanel}</View>
          {centerColumn}
          <View style={styles.landscapeTeam}>{awayPanel}</View>
        </View>
      ) : (
        <View style={styles.portraitBody}>
          {homePanel}
          {centerColumn}
          {awayPanel}
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
    gap: space.xl,
    paddingBottom: space.xl,
  },
  landscapeBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
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
    borderWidth: 1,
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
  utilityGlyph: {
    ...type.heading,
    color: color.textDim,
  },
  utilityLabel: {
    ...type.micro,
    color: color.textFaint,
  },
});
