/**
 * Post-session summary — broadcast hero (FG% under the signature arc),
 * stat cards, shot chart, highlights plan and the full shot list with
 * one-tap corrections.
 *
 * Data source: the live session store when a session just ended
 * (phase === 'ended'); otherwise falls back to the database via the ?id=
 * search param so the screen also works after a reload / deep link.
 */
import { router, useLocalSearchParams } from 'expo-router';
import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';

import { SessionRecap, useSessionRecord } from '@/components/ShotList';
import { Card, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ResolvedShot, ShotOutcome, ShotValue } from '@/core/types';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

export default function SessionSummaryScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const phase = useSession((s) => s.phase);
  const entries = useSession((s) => s.shots);
  const storeStats = useSession((s) => s.stats);
  const recordingPath = useSession((s) => s.recordingPath);
  const correctShot = useSession((s) => s.correctShot);
  const correctShotValue = useSession((s) => s.correctShotValue);
  const resetToIdle = useSession((s) => s.resetToIdle);
  const keepSetting = useSettings((s) => s.keepMode);

  const storeMode = phase === 'ended';
  const paramId =
    typeof params.id === 'string' ? Number(params.id) : Number.NaN;
  const dbId = !storeMode && Number.isInteger(paramId) ? paramId : null;
  const record = useSessionRecord(dbId);

  const shots = useMemo<readonly ResolvedShot[]>(
    () => (storeMode ? entries.map((e) => e.shot) : record.shots),
    [storeMode, entries, record.shots],
  );
  const stats = storeMode ? storeStats : record.stats;
  const videoPath = storeMode
    ? recordingPath
    : (record.session?.videoPath ?? null);
  const keepMode = storeMode ? keepSetting : (record.session?.keepMode ?? 'makes');

  const onCorrect = (shot: ResolvedShot, outcome: ShotOutcome) => {
    if (storeMode) correctShot(shot.id, outcome);
    else record.correct(shot, outcome);
  };

  const onCorrectValue = (shot: ResolvedShot, value: ShotValue) => {
    if (storeMode) correctShotValue(shot.id, value);
    else record.correctValue(shot, value);
  };

  const onDone = () => {
    resetToIdle();
    router.replace('/');
  };

  const loading = !storeMode && dbId != null && !record.loaded;
  const empty =
    !storeMode && (dbId == null || (record.loaded && record.session == null));

  return (
    <Screen scroll>
      <Eyebrow>Session complete</Eyebrow>
      {loading ? (
        <Text style={styles.dim}>Loading session…</Text>
      ) : empty ? (
        <Card>
          <Text style={styles.heading}>No session to show</Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Track a session and your summary will land here.
          </Text>
          <PillButton
            label="Done"
            onPress={onDone}
            style={{ marginTop: space.lg }}
          />
        </Card>
      ) : (
        <>
          <SessionRecap
            shots={shots}
            stats={stats}
            onCorrect={onCorrect}
            onCorrectValue={onCorrectValue}
            videoPath={videoPath}
            keepMode={keepMode}
          />
          <Row gap={space.md} style={{ marginTop: space.xl }}>
            <PillButton label="Done" onPress={onDone} style={{ flex: 1 }} />
            <PillButton
              variant="ghost"
              label="View history"
              onPress={() => router.push('/history')}
              style={{ flex: 1 }}
            />
          </Row>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    ...type.heading,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
});
