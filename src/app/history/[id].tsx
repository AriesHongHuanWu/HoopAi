/**
 * Session detail — loads one persisted session + its shots from the database
 * and renders the same hero/chart/list composition as the post-session
 * summary (shared SessionRecap). Corrections persist via updateShotOutcome
 * with an optimistic local flip. Below the recap: a "vs previous session"
 * comparison (against the next older session with shots) and the entry-angle
 * histogram.
 */
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  BackPill,
  SessionRecap,
  formatSessionDate,
  formatSessionTime,
  useSessionRecord,
} from '@/components/ShotList';
import {
  AngleHistogram,
  decidedEntryAngles,
} from '@/components/charts/AngleHistogram';
import { CompareBars } from '@/components/charts/CompareBars';
import { Card, Chip, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import { getModeDef, type ModeState } from '@/core/gameModes';
import type { SessionStats } from '@/core/types';
import { listSessions, sessionStatsFromDb } from '@/data/db';

interface PreviousSession {
  startedAt: number;
  stats: SessionStats;
}

/**
 * Mode breakdown card — a quiet, non-celebratory read of the ModeState
 * snapshot persisted at session end (see SessionRow.modeResultJson). Mirrors
 * ModeComplete's headline logic but scoped to History, since ModeComplete is
 * a one-shot celebration sheet, not something to embed in a scrollable detail
 * screen.
 */
function ModeBreakdownCard({ modeId, resultJson }: { modeId: string; resultJson: string | null }) {
  let def;
  try {
    def = getModeDef(modeId as Parameters<typeof getModeDef>[0]);
  } catch {
    return null;
  }
  if (modeId === 'free') return null;

  let mode: ModeState | null = null;
  if (resultJson != null) {
    try {
      mode = JSON.parse(resultJson) as ModeState;
    } catch {
      mode = null;
    }
  }

  return (
    <Card>
      <Eyebrow>Game mode</Eyebrow>
      <Row gap={space.sm}>
        <Text style={styles.modeEmoji}>{def.emoji}</Text>
        <Text style={styles.heading}>{def.name}</Text>
      </Row>
      {mode != null && (
        <View style={{ marginTop: space.md, gap: space.sm }}>
          <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
            <Chip label={`Score ${mode.score}`} tone="accent" />
            {mode.letters != null && mode.letters.length > 0 && (
              <Chip label={mode.letters} tone="unsure" />
            )}
            {mode.bestStreak != null && (
              <Chip label={`Best streak ${mode.bestStreak}`} />
            )}
            {mode.done && <Chip label="Complete" tone="make" />}
          </Row>
          {mode.spots != null && mode.spots.length > 0 && (
            <View style={{ gap: space.xs, marginTop: space.xs }}>
              {mode.spots.map((s) => (
                <Row key={s.label} style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dim}>{s.label}</Text>
                  <Text style={styles.compareMeta}>
                    {s.attempts > 0 ? `${s.makes}/${s.attempts}` : '—'}
                  </Text>
                </Row>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const parsed = typeof id === 'string' ? Number(id) : Number.NaN;
  const sessionId = Number.isInteger(parsed) ? parsed : null;
  const record = useSessionRecord(sessionId);
  const session = record.session;

  /**
   * The next older session that actually has shots, for the comparison card.
   * undefined = still loading, null = none found (card skipped either way).
   */
  const [prev, setPrev] = useState<PreviousSession | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setPrev(undefined);
    if (session == null) return;
    const { id: currentId, startedAt } = session;
    void (async () => {
      // listSessions is ordered newest-first, so the first older match wins.
      const rows = await listSessions(200);
      const candidate = rows.find(
        (r) =>
          r.id !== currentId &&
          r.attempts > 0 &&
          (r.startedAt < startedAt ||
            (r.startedAt === startedAt && r.id < currentId)),
      );
      if (candidate == null) {
        if (alive) setPrev(null);
        return;
      }
      const stats = await sessionStatsFromDb(candidate.id);
      if (alive) setPrev({ startedAt: candidate.startedAt, stats });
    })();
    return () => {
      alive = false;
    };
  }, [session]);

  const entryAngles = useMemo(
    () => decidedEntryAngles(record.shots),
    [record.shots],
  );

  const meta =
    session != null
      ? session.endedAt != null
        ? `${formatSessionTime(session.startedAt)} · ${Math.max(
            1,
            Math.round((session.endedAt - session.startedAt) / 60000),
          )} min`
        : formatSessionTime(session.startedAt)
      : null;

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Session</Eyebrow>

      {!record.loaded ? (
        <Text style={styles.dim}>Loading session…</Text>
      ) : session == null ? (
        <ErrorCard
          title="Session not found"
          body="This session may have been deleted. Head back to your history."
        />
      ) : (
        <View>
          <Text style={styles.title}>
            {formatSessionDate(session.startedAt)}
          </Text>
          {meta != null && <Text style={styles.meta}>{meta}</Text>}
          {session.videoPath != null && (
            <PillButton
              label="Watch replay"
              onPress={() => router.push(`/video/${session.id}`)}
              style={{ marginTop: space.lg }}
            />
          )}
          {session.modeId != null && (
            <View style={{ marginTop: space.lg }}>
              <ModeBreakdownCard modeId={session.modeId} resultJson={session.modeResultJson} />
            </View>
          )}
          <View style={{ marginTop: space.lg }}>
            <SessionRecap
              shots={record.shots}
              stats={record.stats}
              onCorrect={record.correct}
              onCorrectValue={record.correctValue}
              videoPath={session.videoPath}
              keepMode={session.keepMode}
            />
          </View>
          <View style={{ marginTop: space.lg, gap: space.lg }}>
            {prev != null && (
              <Card>
                <Eyebrow>Vs previous session</Eyebrow>
                <Text style={styles.compareMeta}>
                  Compared with {formatSessionDate(prev.startedAt)}
                </Text>
                <CompareBars current={record.stats} previous={prev.stats} />
              </Card>
            )}
            <Card>
              <Eyebrow>Entry angles</Eyebrow>
              <AngleHistogram angles={entryAngles} />
            </Card>
          </View>
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
  meta: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  compareMeta: {
    ...type.caption,
    color: color.textFaint,
    marginTop: -space.xs,
    marginBottom: space.md,
  },
  modeEmoji: {
    fontSize: 20,
  },
});
