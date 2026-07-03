/**
 * Session detail — loads one persisted session + its shots from the database
 * and renders the same hero/chart/list composition as the post-session
 * summary (shared SessionRecap). Corrections persist via updateShotOutcome
 * with an optimistic local flip.
 */
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  BackPill,
  SessionRecap,
  formatSessionDate,
  formatSessionTime,
  useSessionRecord,
} from '@/components/ShotList';
import { Card, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const parsed = typeof id === 'string' ? Number(id) : Number.NaN;
  const sessionId = Number.isInteger(parsed) ? parsed : null;
  const record = useSessionRecord(sessionId);
  const session = record.session;

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
        <Card>
          <Text style={styles.heading}>Session not found</Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            This session may have been deleted. Head back to your history.
          </Text>
        </Card>
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
          <View style={{ marginTop: space.lg }}>
            <SessionRecap
              shots={record.shots}
              stats={record.stats}
              onCorrect={record.correct}
              videoPath={session.videoPath}
              keepMode={session.keepMode}
            />
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
});
