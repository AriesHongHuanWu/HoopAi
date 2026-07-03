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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  persistSessionLabel,
  SessionRecap,
  SessionTitle,
  useSessionRecord,
} from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ResolvedShot, ShotOutcome, ShotValue } from '@/core/types';
import { saveSessionVideo } from '@/data/videoLibrary';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

export default function SessionSummaryScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const phase = useSession((s) => s.phase);
  const liveSessionId = useSession((s) => s.sessionId);
  const entries = useSession((s) => s.shots);
  const storeStats = useSession((s) => s.stats);
  const recordingPath = useSession((s) => s.recordingPath);
  const correctShot = useSession((s) => s.correctShot);
  const correctShotValue = useSession((s) => s.correctShotValue);
  const resetToIdle = useSession((s) => s.resetToIdle);
  const keepSetting = useSettings((s) => s.keepMode);
  const saveToPhotos = useSettings((s) => s.saveToPhotos);

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

  // Session label: optimistic local override on top of the persisted value.
  // persistSessionLabel writes through when the data layer supports it.
  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const sessionId = storeMode ? liveSessionId : (record.session?.id ?? null);

  // Auto-save the just-ended recording to Photos (once — the effect can
  // re-run on re-renders/param changes, so a ref guards the actual save).
  const saveFired = useRef(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  useEffect(() => {
    if (!storeMode || videoPath == null || !saveToPhotos || saveFired.current) return;
    saveFired.current = true;
    void saveSessionVideo(videoPath).then((ok) => {
      setSaveStatus(ok ? 'saved' : 'failed');
    });
  }, [storeMode, videoPath, saveToPhotos]);
  const label = labelOverride ?? (storeMode ? '' : (record.session?.label ?? ''));
  const onRename = (next: string) => {
    setLabelOverride(next);
    if (sessionId != null) persistSessionLabel(sessionId, next);
  };

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
          <View style={styles.titleBlock}>
            <SessionTitle label={label} onRename={onRename} />
          </View>
          {saveStatus !== 'idle' && (
            <View style={styles.saveChip}>
              <Chip
                label={
                  saveStatus === 'saved'
                    ? 'Saved to Photos'
                    : 'Couldn’t save — check permissions'
                }
                tone={saveStatus === 'saved' ? 'make' : 'unsure'}
              />
            </View>
          )}
          {videoPath != null && sessionId != null && (
            <PillButton
              label="Watch replay"
              onPress={() => router.push(`/video/${sessionId}`)}
              style={styles.replayButton}
            />
          )}
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
  titleBlock: {
    marginBottom: space.sm,
  },
  saveChip: {
    marginBottom: space.md,
  },
  replayButton: {
    marginBottom: space.lg,
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
