/**
 * Home dashboard — the app's face.
 *
 * Giant Start CTA (the one daily action), last-session recap from SQLite,
 * quiet links to history and trends. Redirects to /onboarding on first
 * launch; the root layout guarantees the settings store is hydrated before
 * this screen renders, so the check is flash-free.
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Card, Eyebrow, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import { listSessions, type SessionSummaryRow } from '@/data/db';
import { useMode } from '@/state/modeStore';
import { useSettings } from '@/state/settingsStore';

const HERO_HEIGHT = 176;

function formatSessionDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Decorative shot arc over the hero CTA — the signature motif. */
function HeroArc({ width }: { width: number }) {
  if (width <= 0) return null;
  // Quadratic arc from just off the bottom-left up toward a "rim" at right.
  const rimX = width - 44;
  const rimY = HERO_HEIGHT * 0.42;
  const path = `M -24 ${HERO_HEIGHT + 24} Q ${width * 0.36} ${-HERO_HEIGHT * 0.6} ${rimX} ${rimY}`;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={{ width, height: HERO_HEIGHT }}>
        <Path path={path} style="stroke" strokeWidth={3} color={color.onAccent} opacity={0.24} />
        <Circle cx={rimX} cy={rimY} r={7} color={color.onAccent} opacity={0.32} />
      </Canvas>
    </View>
  );
}

export default function HomeScreen() {
  const onboardingDone = useSettings((s) => s.onboardingDone);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const { width } = useWindowDimensions();
  const contentWidth = width - space.lg * 2;

  // undefined = loading, null = no sessions yet.
  const [lastSession, setLastSession] = useState<SessionSummaryRow | null | undefined>(undefined);
  const [dbFailed, setDbFailed] = useState(false);

  // Reload whenever the dashboard regains focus (e.g. after a session ends).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listSessions(1)
        .then((rows) => {
          if (!alive) return;
          setLastSession(rows[0] ?? null);
          setDbFailed(false);
        })
        .catch(() => {
          if (!alive) return;
          setLastSession(null);
          setDbFailed(true);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  if (!onboardingDone) return <Redirect href="/onboarding" />;

  const startSession = () => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Quick-start is an open run — clear any mode picked in a past session so a
    // stale game HUD never leaks in. The mode picker is the path to a game.
    useMode.getState().reset();
    router.push('/session/setup');
  };

  return (
    <Screen scroll>
      <View style={styles.stack}>
        {/* Header: wordmark + settings */}
        <Row style={styles.header}>
          <Text style={styles.wordmark} accessibilityRole="header">
            HOOP <Text style={styles.wordmarkAccent}>AI</Text>
          </Text>
          <Link href="/settings" asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              hitSlop={space.sm}
              style={({ pressed }) => [styles.gearButton, pressed && styles.gearPressed]}
            >
              <Text style={styles.gearGlyph}>{'⚙︎'}</Text>
            </Pressable>
          </Link>
        </Row>

        {/* Hero Start CTA */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start session"
          accessibilityHint="Opens camera setup to track your shots"
          onPress={startSession}
          style={({ pressed }) => [
            styles.hero,
            { backgroundColor: pressed ? color.accentPressed : color.accent },
          ]}
        >
          <HeroArc width={contentWidth} />
          <Text style={styles.heroEyebrow}>READY WHEN YOU ARE</Text>
          <Text
            style={styles.heroLabel}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            START SESSION
          </Text>
          <Text style={styles.heroSub}>Point your phone at the hoop — we do the counting.</Text>
        </Pressable>

        {/* Choose a game mode */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose a mode"
          accessibilityHint="Pick a game like Around the World, Timed Challenge or HORSE"
          onPress={() => {
            if (hapticsEnabled) void Haptics.selectionAsync();
            router.push('/modes');
          }}
          style={({ pressed }) => [styles.modeRow, pressed && styles.modeRowPressed]}
        >
          <View style={styles.modeText}>
            <Text style={styles.modeTitle}>Choose a mode</Text>
            <Text style={styles.modeSub}>
              Around the World · Timed · 3-Point Contest · HORSE and more
            </Text>
          </View>
          <Text style={styles.modeChevron}>{'›'}</Text>
        </Pressable>

        {/* Last session */}
        {lastSession === undefined ? null : dbFailed ? (
          <Card>
            <Eyebrow>Last session</Eyebrow>
            <Text style={styles.emptyBody}>
              Couldn't load your sessions. Your stats are safe — try again after a restart.
            </Text>
          </Card>
        ) : lastSession ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Last session, ${formatSessionDate(lastSession.startedAt)}, ${
              lastSession.attempts
            } attempts, ${Math.round(lastSession.fgPct * 100)} percent field goals`}
            onPress={() => router.push(`/history/${lastSession.id}`)}
          >
            {({ pressed }) => (
              <Card style={pressed ? styles.cardPressed : undefined}>
                <Eyebrow>Last session</Eyebrow>
                <Row style={styles.sessionRow} gap={space.lg}>
                  <View style={styles.sessionInfo}>
                    <Text style={styles.sessionDate}>
                      {formatSessionDate(lastSession.startedAt)}
                    </Text>
                    <Text style={styles.sessionMeta}>
                      {lastSession.attempts > 0
                        ? `${lastSession.makes} makes · ${lastSession.attempts} attempts`
                        : 'No shots logged'}
                    </Text>
                  </View>
                  <StatNumber
                    size="medium"
                    value={`${Math.round(lastSession.fgPct * 100)}%`}
                    label="FG"
                  />
                </Row>
              </Card>
            )}
          </Pressable>
        ) : (
          <Card>
            <Eyebrow>First session</Eyebrow>
            <Text style={styles.emptyTitle}>Prop your phone up. We'll count every shot.</Text>
            <Text style={styles.emptyBody}>
              Makes, misses, streaks and FG% land here after your first run.
            </Text>
          </Card>
        )}

        {/* Quick links */}
        <Row gap={space.md}>
          <PillButton
            label="History"
            variant="ghost"
            onPress={() => router.push('/history')}
            style={styles.quickLink}
          />
          <PillButton
            label="Trends"
            variant="ghost"
            onPress={() => router.push('/trends')}
            style={styles.quickLink}
          />
        </Row>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.xl,
    paddingTop: space.md,
  },
  header: {
    justifyContent: 'space-between',
  },
  wordmark: {
    ...type.title,
    color: color.text,
  },
  wordmarkAccent: {
    color: color.accent,
  },
  gearButton: {
    width: touch.minTarget,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  gearPressed: {
    backgroundColor: color.surfaceRaised,
  },
  gearGlyph: {
    fontSize: type.title.fontSize,
    color: color.textDim,
  },
  hero: {
    minHeight: HERO_HEIGHT,
    borderRadius: radius.lg,
    padding: space.xl,
    justifyContent: 'flex-end',
    gap: space.xs,
    overflow: 'hidden',
  },
  heroEyebrow: {
    ...type.caption,
    color: color.onAccent,
    opacity: 0.7,
  },
  heroLabel: {
    ...type.statLarge,
    color: color.onAccent,
  },
  heroSub: {
    ...type.body,
    color: color.onAccent,
    opacity: 0.85,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    minHeight: touch.minTarget,
  },
  modeRowPressed: {
    backgroundColor: color.surfaceRaised,
  },
  modeText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  modeTitle: {
    ...type.heading,
    color: color.text,
  },
  modeSub: {
    ...type.body,
    color: color.textDim,
  },
  modeChevron: {
    ...type.title,
    color: color.accent,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  sessionRow: {
    justifyContent: 'space-between',
  },
  sessionInfo: {
    flex: 1,
    gap: space.xs,
  },
  sessionDate: {
    ...type.heading,
    color: color.text,
  },
  sessionMeta: {
    ...type.body,
    color: color.textDim,
  },
  emptyTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.xs,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
  quickLink: {
    flex: 1,
  },
});
