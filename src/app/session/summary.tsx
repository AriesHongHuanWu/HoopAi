/**
 * Post-session summary — the broadcast box-score moment: SummaryHero strip
 * (MAKES | FG% | PTS + one-shot celebration chip) up top, replay/reel media
 * row, the full SessionRecap under a "Box score" eyebrow, and a grouped
 * action stack (analysis / share / primary Done).
 *
 * Data source: the live session store when a session just ended
 * (phase === 'ended'); otherwise falls back to the database via the ?id=
 * search param so the screen also works after a reload / deep link.
 */
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native';

import { ReelEntryButton } from '@/components/ReelEntryButton';
import { shareSessionCard } from '@/components/ShareCard';
import { FramePickerModal } from '@/components/FramePickerModal';
import { sessionMomentSec } from '@/core/shareFrame';
import {
  persistSessionLabel,
  SessionRecap,
  SessionTitle,
  UndoSnackbar,
  useSessionRecord,
  useUndoableCorrection,
} from '@/components/ShotList';
import { CoachMarks, useCoachMarks, type CoachStep } from '@/components/coach/CoachMarks';
import { PersonalBestBanner } from '@/components/PersonalBestBanner';
import { SummaryHero } from '@/components/SummaryHero';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import { detectNewBests, type CareerBests } from '@/core/achievements';
import type { ResolvedShot, ShotOutcome, ShotValue } from '@/core/types';
import { careerBests } from '@/data/db';
import { saveSessionVideo } from '@/data/videoLibrary';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

export default function SessionSummaryScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const phase = useSession((s) => s.phase);
  const liveSessionId = useSession((s) => s.sessionId);
  const startedAtMs = useSession((s) => s.startedAtMs);
  const entries = useSession((s) => s.shots);
  const storeStats = useSession((s) => s.stats);
  const recordingPath = useSession((s) => s.recordingPath);
  const recordingStartSecStore = useSession((s) => s.recordingStartSec);
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

  // NEW PERSONAL BEST — only for a just-ended session (storeMode), ranked
  // against career maxima with this session's persisted rows excluded so the
  // baseline is honestly "before tonight". Fetched once; careerBests returns
  // null on any db failure, which simply keeps the banner away. Corrections
  // made on this screen re-run the pure detect against the same baseline.
  const [pbBaseline, setPbBaseline] = useState<CareerBests | null>(null);
  const pbFetched = useRef(false);
  useEffect(() => {
    if (!storeMode || pbFetched.current) return;
    pbFetched.current = true;
    void careerBests(liveSessionId ?? undefined).then((bests) => {
      setPbBaseline(bests);
    });
  }, [storeMode, liveSessionId]);
  const newBests = useMemo(
    () =>
      storeMode && pbBaseline != null ? detectNewBests(stats, pbBaseline) : [],
    [storeMode, pbBaseline, stats],
  );

  // Corrections route through the mode-appropriate pathway (live store vs.
  // persisted record), wrapped with the shared undo window. `corrected` is
  // forwarded so undo can restore the pre-correction edited flag exactly.
  const recordCorrect = record.correct;
  const applyCorrection = useCallback(
    (shot: ResolvedShot, outcome: ShotOutcome, corrected?: boolean) => {
      if (storeMode) correctShot(shot.id, outcome, corrected);
      else recordCorrect(shot, outcome, corrected);
    },
    [storeMode, correctShot, recordCorrect],
  );
  const undoable = useUndoableCorrection(applyCorrection);
  const onCorrect = undoable.correct;

  const onCorrectValue = (shot: ResolvedShot, value: ShotValue) => {
    if (storeMode) correctShotValue(shot.id, value);
    else record.correctValue(shot, value);
  };

  const onDone = () => {
    resetToIdle();
    router.replace('/');
  };

  // Share-card generation: disabled while the snapshot renders; failure shows
  // a quiet chip (shareSessionCard itself never throws).
  const [sharing, setSharing] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [pickingFrame, setPickingFrame] = useState(false);

  const recordingStartSec = storeMode
    ? recordingStartSecStore
    : (record.session?.recordingStartSec ?? null);
  // Best-effort clip duration for the frame sampler (getThumbnailAsync clamps to
  // the real video, so an approximate span is fine).
  const durationSec = storeMode
    ? startedAtMs != null
      ? (Date.now() - startedAtMs) / 1000
      : 0
    : record.session?.endedAt != null && record.session?.startedAt != null
      ? (record.session.endedAt - record.session.startedAt) / 1000
      : 0;
  const canPickFrame = videoPath != null && recordingStartSec != null;

  // Actually render + share the card, optionally with a chosen shot-frame photo.
  const doShare = (backgroundUri?: string) => {
    setSharing(true);
    setShareFailed(false);
    const dateMs = storeMode
      ? (startedAtMs ?? Date.now())
      : (record.session?.startedAt ?? Date.now());
    void shareSessionCard({
      stats,
      shots,
      label: label.trim() !== '' ? label : 'Shooting session',
      dateMs,
      backgroundUri,
    }).then((ok) => {
      setSharing(false);
      if (!ok) setShareFailed(true);
    });
  };

  const onShareCard = () => {
    if (sharing || pickingFrame) return;
    // If the session was recorded, let the user pick a shooting-moment frame to
    // feature behind their stats; otherwise share the plain coal card.
    if (canPickFrame) setPickingFrame(true);
    else doShare();
  };

  const initialMomentSec =
    recordingStartSec != null ? (sessionMomentSec(shots, recordingStartSec, durationSec) ?? 0) : 0;

  const loading = !storeMode && dbId != null && !record.loaded;
  const empty =
    !storeMode && (dbId == null || (record.loaded && record.session == null));

  // Coach marks: teach shot correction (in the shared ShotList below, so no
  // target rect — centered) and the replay button (owned here, so anchored).
  const replayRef = useRef<View>(null);
  const [replayRect, setReplayRect] = useState<LayoutRectangle | undefined>();
  const summarySteps: CoachStep[] = [
    {
      title: 'Fix a make, miss or 2/3',
      text: "Swipe a shot right to mark a make, left for a miss — or tap to correct it, including 2-point vs. 3-point. Every correction you make trains sharper detection for next time.",
    },
    {
      title: 'Watch the replay',
      text: 'Your recorded clips and highlight reel are one tap away — see the exact makes and misses the camera caught, in order.',
      targetRect: replayRect,
    },
  ];
  const coach = useCoachMarks('summary', summarySteps);

  return (
    <View style={styles.root}>
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
                    : "Couldn't save — check permissions"
                }
                tone={saveStatus === 'saved' ? 'make' : 'unsure'}
              />
            </View>
          )}
          <SummaryHero stats={stats} style={styles.hero} />
          {newBests.length > 0 && (
            <PersonalBestBanner bests={newBests} style={styles.pbBanner} />
          )}
          {videoPath != null && sessionId != null && (
            <View style={styles.mediaSection}>
              <Eyebrow>Watch it back</Eyebrow>
              <View ref={replayRef} onLayout={() => {
                replayRef.current?.measureInWindow((x, y, w, h) =>
                  setReplayRect({ x, y, width: w, height: h }),
                );
              }}>
                <Row gap={space.md}>
                  <PillButton
                    label="Watch replay"
                    icon="play"
                    onPress={() => router.push(`/video/${sessionId}`)}
                    style={{ flex: 1 }}
                  />
                  <ReelEntryButton sessionId={sessionId} variant="ghost" style={{ flex: 1 }} />
                </Row>
              </View>
            </View>
          )}
          <Eyebrow>Box score</Eyebrow>
          <SessionRecap
            shots={shots}
            stats={stats}
            onCorrect={onCorrect}
            onCorrectValue={onCorrectValue}
            videoPath={videoPath}
            keepMode={keepMode}
          />
          {shareFailed && (
            <View style={{ marginTop: space.lg }}>
              <Chip label="Couldn't share — try again" tone="unsure" />
            </View>
          )}
          <View style={styles.actionsSection}>
            <Eyebrow>Next up</Eyebrow>
            <PillButton
              variant="ghost"
              label="Shot Lab — deep analysis"
              icon="flask"
              onPress={() => router.push('/shotlab')}
              disabled={shots.length === 0}
            />
            <Row gap={space.md} style={{ marginTop: space.md }}>
              <PillButton
                variant="ghost"
                label={sharing ? 'Preparing…' : 'Share card'}
                icon="share-social"
                onPress={onShareCard}
                disabled={sharing || shots.length === 0}
                style={{ flex: 1 }}
              />
              <PillButton
                variant="ghost"
                label="View history"
                icon="time-outline"
                onPress={() => router.push('/history')}
                style={{ flex: 1 }}
              />
            </Row>
            <PillButton
              label="Done"
              icon="checkmark"
              onPress={onDone}
              style={{ marginTop: space.md }}
            />
          </View>
        </>
      )}
    </Screen>
    <UndoSnackbar pending={undoable.pending} onUndo={undoable.undo} />
    {!loading && !empty && coach.visible && (
      <CoachMarks steps={coach.steps} onFinish={coach.finish} onSkip={coach.finish} />
    )}
    {pickingFrame && videoPath != null && (
      <FramePickerModal
        videoPath={videoPath}
        durationSec={durationSec}
        initialTimeSec={initialMomentSec}
        onPick={(uri) => {
          setPickingFrame(false);
          doShare(uri);
        }}
        onCancel={() => {
          setPickingFrame(false);
          doShare();
        }}
      />
    )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  titleBlock: {
    marginBottom: space.sm,
  },
  saveChip: {
    marginBottom: space.md,
  },
  /** Box-score strip: breathing room off the title, section gap below. */
  hero: {
    marginTop: space.md,
    marginBottom: space.xl,
  },
  /**
   * PB banner tucks up toward the hero it celebrates (hero already carries a
   * full section gap below), then restores the section gap before media.
   */
  pbBanner: {
    marginTop: -space.md,
    marginBottom: space.xl,
  },
  mediaSection: {
    marginBottom: space.xl,
  },
  actionsSection: {
    marginTop: space.xl,
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
