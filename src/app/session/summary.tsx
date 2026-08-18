/**
 * Post-session summary — the broadcast box-score moment: SummaryHero strip
 * (MAKES | FG% | PTS + one-shot celebration chip) up top, replay/reel media
 * row, the full SessionRecap under a "Box score" eyebrow, and a grouped
 * action stack (analysis / share / primary Done).
 *
 * Motion: top-level sections enter with the canonical card stagger
 * (useCardStagger — returns undefined under system reduced-motion, so Views
 * render statically), and a new personal best fires a one-shot Confetti
 * burst overlaid on the whole screen. The burst is presentation only: it is
 * keyed on sessionId (once per mount per session), pointerEvents-none, and
 * renders nothing under reduced motion — PersonalBestBanner remains the
 * always-on carrier of the record. UndoSnackbar, modals and CoachMarks are
 * deliberately NOT staggered.
 *
 * Data source: the live session store when a session just ended
 * (phase === 'ended'); otherwise falls back to the database via the ?id=
 * search param so the screen also works after a reload / deep link.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import Animated from 'react-native-reanimated';

import { ReelEntryButton } from '@/components/ReelEntryButton';
import { shareSessionCard, sessionCardData, type CardFormat } from '@/components/ShareCard';
import { FramePickerModal } from '@/components/FramePickerModal';
import { FormatPicker } from '@/components/share/FormatPicker';
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
import { CourtHeatmap } from '@/components/charts/CourtHeatmap';
import { CourtPlacementMap } from '@/components/charts/CourtPlacementMap';
import { HintChip } from '@/components/hud/HintChip';
import { Confetti, useCardStagger } from '@/components/motion';
import { PersonalBestBanner } from '@/components/PersonalBestBanner';
import { RecheckPanel } from '@/components/RecheckPanel';
import { buildHeatmap } from '@/core/heatmap';
import { FIBA_COURT } from '@/core/courtModel';
import { SummaryHero, isPerfectSession } from '@/components/SummaryHero';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import { detectNewBests, type CareerBests } from '@/core/achievements';
import { levelOfGoals } from '@/core/drillProgression';
import type { ModeState } from '@/core/gameModes';
import { todayMakes } from '@/core/goals';
import { detectMilestones, type Milestone } from '@/core/milestones';
import type { ResolvedShot, ShotOutcome, ShotValue } from '@/core/types';
import { careerBests, getSession, lifetimeTotals, listSessions } from '@/data/db';
import { saveSessionVideo } from '@/data/videoLibrary';
import { useMode } from '@/state/modeStore';
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
  const dailyGoal = useSettings((s) => s.dailyGoalMakes);
  // One-shot "how detection works" nudge flag (settingsStore v7).
  // how-it-works.tsx flips it on mount, so the nudge disappears after a
  // single visit — no local state.
  const explainerSeen = useSettings((s) => s.detectionExplainerSeen);

  // Canonical section entrance stagger (undefined under reduced motion).
  const enter = useCardStagger();
  // Personal-best confetti mounts once per screen mount, then unmounts on
  // completion. Corrections that re-derive newBests can never re-fire it.
  const [confettiOn, setConfettiOn] = useState(true);

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
  // Career milestones crossed by THIS session (100th make, 25th session, …).
  // lifetimeTotals() includes the just-saved session, so makesAfter/sessionsAfter
  // are the post-session totals; detectMilestones derives the "before" and only
  // fires a genuine crossing. Fetched once (storeMode) like the PB baseline.
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const msFetched = useRef(false);
  useEffect(() => {
    if (!storeMode || msFetched.current) return;
    msFetched.current = true;
    void lifetimeTotals()
      .then((tot) => {
        setMilestones(
          detectMilestones({
            makesAfter: tot.makes,
            makesGained: stats.makes,
            sessionsAfter: tot.sessions,
          }),
        );
      })
      .catch(() => {});
  }, [storeMode, stats.makes]);

  // RUN IT BACK — recover the finished game's final ModeState so the restart
  // can re-arm the same mode/drill. DB mode parses the already-loaded row;
  // storeMode does a one-shot fetch of the just-persisted row (endSession
  // awaits finish() before navigating here, so it exists). Any parse failure
  // stays null, which honestly degrades the restart to free play.
  const [prevMode, setPrevMode] = useState<ModeState | null>(null);
  useEffect(() => {
    const json = record.session?.modeResultJson;
    if (json == null) return;
    try {
      setPrevMode(JSON.parse(json) as ModeState);
    } catch {}
  }, [record.session]);
  const modeFetched = useRef(false);
  useEffect(() => {
    if (!storeMode || liveSessionId == null || modeFetched.current) return;
    modeFetched.current = true;
    void getSession(liveSessionId).then((row) => {
      try {
        if (row?.modeResultJson) setPrevMode(JSON.parse(row.modeResultJson) as ModeState);
      } catch {}
    });
  }, [storeMode, liveSessionId]);

  // DAILY GOAL — closes the loop the live GoalChip opens. One-shot fetch,
  // just-ended sessions only. The session is already persisted (endSession
  // awaits finish() before navigating here), so today's total honestly
  // includes tonight — plain todayMakes, no exclusion needed.
  const [goalMade, setGoalMade] = useState<number | null>(null);
  const goalFetched = useRef(false);
  useEffect(() => {
    if (!storeMode || dailyGoal <= 0 || goalFetched.current) return;
    goalFetched.current = true;
    void listSessions(100)
      .then((rows) => setGoalMade(todayMakes(rows, Date.now())))
      .catch(() => {});
  }, [storeMode, dailyGoal]);

  const newBests = useMemo(() => {
    if (!storeMode || pbBaseline == null) return [];
    const bests = detectNewBests(stats, pbBaseline);
    // A perfect session already earns SummaryHero's PERFECT NIGHT chip, and a
    // perfect night IS the career-best FG% — the bestFgPct banner line would
    // celebrate the identical fact directly under the chip. Keep the other
    // record kinds (most makes / best streak); only the duplicate is dropped.
    return isPerfectSession(stats)
      ? bests.filter((pb) => pb.kind !== 'bestFgPct')
      : bests;
  }, [storeMode, pbBaseline, stats]);

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

  // Offline re-check (RecheckPanel): unsure, uncorrected shots the second
  // pass could still decide; verdicts come back through the same correction
  // pathway with corrected=false (machine re-read, not a user edit).
  const unsureCount = useMemo(
    () => shots.filter((s) => s.outcome === 'unsure' && s.corrected !== true).length,
    [shots],
  );
  // Shot map: where you shot from this session (zone × distance). Live-session
  // shots carry the distance estimate, so the full 3-band court map lights up.
  const heatmap = useMemo(() => buildHeatmap(shots), [shots]);
  // Court placement map: real positions, shown only when a calibration mapped
  // shots this session (each carries courtPos). The payoff of "tap the court".
  const courtPlaced = useMemo(() => shots.filter((s) => s.courtPos != null).length, [shots]);
  const onRecheckVerdict = useCallback(
    (shotIndex: number, outcome: 'make' | 'miss') => {
      const shot = shots.find((s) => s.id === shotIndex);
      if (shot) applyCorrection(shot, outcome, false);
    },
    [shots, applyCorrection],
  );

  const onCorrectValue = (shot: ResolvedShot, value: ShotValue) => {
    if (storeMode) correctShotValue(shot.id, value);
    else record.correctValue(shot, value);
  };

  const onDone = () => {
    resetToIdle();
    router.replace('/');
  };

  // Restart with the same setup — mirrors home quickStart ((tabs)/index.tsx)
  // and live.tsx replayMode: reset session state, re-arm the same mode/drill,
  // then jump to live with the persisted orientation (recordVideo/keepMode
  // flow from persisted settings automatically — that IS "same setup").
  const runItBack = useCallback(() => {
    const mode = prevMode;
    resetToIdle();
    const m = useMode.getState();
    const drill = mode?.config?.drill;
    if (drill != null) {
      // A structured drill rides inside spotShooting — re-init via its own
      // builder so variable spots/goals rebuild, at the SAME level the run was
      // played at (recovered from the persisted goals — "same setup" includes
      // the level). getDrill throws on a stale/unknown persisted DrillId
      // (levelOfGoals reads the catalog too), so fall back to free play.
      try {
        m.selectDrill(drill.id, levelOfGoals(drill.id, drill.goals));
      } catch {
        m.reset();
      }
    } else if (mode != null && mode.config?.ghost == null) {
      m.selectMode(mode.modeId, mode.config ?? undefined);
    } else {
      // Free play — or a Ghost race, whose persisted timeline was stripped at
      // endSession; an empty timeline can't be honestly re-raced, so fall back.
      m.reset();
    }
    useSession.getState().beginSetup();
    // replace (not push): a back-gesture from pre-lock live must never pop
    // onto this now-reset summary.
    router.replace(`/session/live?orient=${useSettings.getState().lastOrient}`);
  }, [prevMode, resetToIdle]);

  // Share-card generation: disabled while the snapshot renders; failure shows
  // a quiet chip (shareSessionCard itself never throws).
  const [sharing, setSharing] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [pickingFrame, setPickingFrame] = useState(false);
  // Format sheet: after the frame is chosen (or skipped) the user picks a
  // layout. `pendingBg` carries the chosen background into the format step.
  const [pickingFormat, setPickingFormat] = useState(false);
  const [pendingBg, setPendingBg] = useState<string | undefined>(undefined);

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

  const dateMs = storeMode
    ? (startedAtMs ?? Date.now())
    : (record.session?.startedAt ?? Date.now());

  // Actually render + share the card, optionally with a chosen shot-frame photo
  // and a chosen layout (defaults to the single-tap 'story').
  const doShare = (backgroundUri?: string, format: CardFormat = 'story') => {
    setSharing(true);
    setShareFailed(false);
    void shareSessionCard({
      stats,
      shots,
      label: label.trim() !== '' ? label : 'Shooting session',
      dateMs,
      backgroundUri,
      format,
    }).then((ok) => {
      setSharing(false);
      if (!ok) setShareFailed(true);
    });
  };

  // Primary tap: single-tap default. Recorded sessions get the frame picker
  // (which then offers layouts); otherwise the format sheet opens straight away.
  const onShareCard = () => {
    if (sharing || pickingFrame || pickingFormat) return;
    if (canPickFrame) setPickingFrame(true);
    else {
      setPendingBg(undefined);
      setPickingFormat(true);
    }
  };

  // Card data for the format sheet's live mini previews (mirrors shareSessionCard).
  const shareData = useMemo(
    () =>
      sessionCardData({
        stats,
        shots,
        label: label.trim() !== '' ? label : 'Shooting session',
        dateMs,
      }),
    [stats, shots, label, dateMs],
  );

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
      // HONESTY: corrections rewrite the outcome only — signalsJson is never
      // touched and nothing retrains (see core/evidence.ts). Never claim
      // corrections improve detection.
      text: 'Swipe a shot right to mark a make, left for a miss — or tap to correct it, including 2-point vs. 3-point. Corrections are yours: always labeled EDITED, never used to re-judge anything.',
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
        <Card>
          <Text style={styles.dim}>Loading session…</Text>
        </Card>
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
          <Animated.View entering={enter(0)}>
            <SummaryHero stats={stats} style={styles.hero} />
          </Animated.View>
          {/* Block 1 — goal line + milestone share one stagger slot. The PB
              banner below stays unwrapped: it carries its own hero-synced
              entrance (and is the reduced-motion carrier for the confetti). */}
          {storeMode && dailyGoal > 0 && goalMade != null && (
            <Animated.View
              entering={enter(1)}
              style={styles.goalLineWrap}
              accessibilityLabel={`Daily goal: ${goalMade} of ${dailyGoal} makes today`}
            >
              {goalMade >= dailyGoal ? (
                <Chip
                  label={`Daily goal hit — ${goalMade}/${dailyGoal} makes today`}
                  tone="make"
                />
              ) : (
                <Text style={styles.goalLine}>
                  {`Daily goal · ${goalMade}/${dailyGoal} — ${dailyGoal - goalMade} to go`}
                </Text>
              )}
            </Animated.View>
          )}
          {milestones.length > 0 && (
            <Animated.View entering={enter(1)} style={styles.milestoneBanner}>
              <View style={styles.milestoneIcon}>
                <Ionicons
                  name={milestones[0]!.icon as React.ComponentProps<typeof Ionicons>['name']}
                  size={20}
                  color={color.threePt}
                />
              </View>
              <View style={styles.milestoneText}>
                <Text style={styles.milestoneEyebrow}>MILESTONE UNLOCKED</Text>
                <Text style={styles.milestoneBlurb}>{milestones[0]!.blurb}</Text>
                {milestones.length > 1 && (
                  <Text style={styles.milestoneMore}>
                    {`+${milestones.length - 1} more milestone${
                      milestones.length - 1 === 1 ? '' : 's'
                    } this session`}
                  </Text>
                )}
              </View>
            </Animated.View>
          )}
          {newBests.length > 0 && (
            <PersonalBestBanner bests={newBests} style={styles.pbBanner} />
          )}
          {videoPath != null && sessionId != null && (
            <Animated.View entering={enter(2)} style={styles.mediaSection}>
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
              {/* One-time honesty hint above the re-check region: UNSURE never
                  flips on its own, and corrections train nothing. HintChip
                  persists its own seen-flag and renders null afterwards. */}
              {unsureCount > 0 && (
                <HintChip
                  hintKey="unsureSummary"
                  text="UNSURE stays unsure until you say otherwise — honest receipts only. Swipe to correct; it's labeled, and it trains nothing."
                  actionLabel="How calls are made"
                  onAction={() => router.push('/how-it-works')}
                  style={{ marginTop: space.md }}
                />
              )}
              {recordingStartSec != null && (
                <RecheckPanel
                  sessionId={sessionId}
                  unsureCount={unsureCount}
                  onVerdict={onRecheckVerdict}
                  unsureShotIndexes={shots
                    .filter((s) => s.outcome === 'unsure' && s.corrected !== true)
                    .map((s) => s.id)}
                  onManualCorrect={(shotIndex, outcome) => {
                    const s = shots.find((x) => x.id === shotIndex);
                    // No third arg: corrected defaults to true — a hand edit
                    // earns the Edited badge, unlike machine re-reads above.
                    if (s) applyCorrection(s, outcome);
                  }}
                  style={{ marginTop: space.md }}
                />
              )}
            </Animated.View>
          )}
          {heatmap.totalAttempts >= 4 && (
            <Animated.View entering={enter(3)} style={styles.heatSection}>
              <Eyebrow>Shot map</Eyebrow>
              <View style={styles.heatCard}>
                <CourtHeatmap heatmap={heatmap} />
              </View>
            </Animated.View>
          )}
          {courtPlaced >= 3 && (
            <Animated.View entering={enter(4)} style={styles.heatSection}>
              <Eyebrow>Court map · calibrated</Eyebrow>
              <View style={styles.heatCard}>
                <CourtPlacementMap shots={shots} spec={FIBA_COURT} />
              </View>
            </Animated.View>
          )}
          <Animated.View entering={enter(5)}>
            <Eyebrow>Box score</Eyebrow>
            <SessionRecap
              shots={shots}
              stats={stats}
              onCorrect={onCorrect}
              onCorrectValue={onCorrectValue}
              videoPath={videoPath}
              keepMode={keepMode}
            />
          </Animated.View>
          {shareFailed && (
            <View style={{ marginTop: space.lg }}>
              <Chip label="Couldn't share — try again" tone="unsure" />
            </View>
          )}
          <Animated.View entering={enter(6)} style={styles.actionsSection}>
            <Eyebrow>Next up</Eyebrow>
            {/* First-summary explainer nudge — how-it-works.tsx flips the
                persisted flag on mount, so this row retires itself after one
                visit (from anywhere); the Settings entry remains. */}
            {!explainerSeen && (
              <>
                <Text style={styles.explainerCaption}>
                  First session? See exactly how makes, misses and UNSURE get decided.
                </Text>
                <PillButton
                  variant="ghost"
                  label="How every call is made"
                  icon="receipt-outline"
                  onPress={() => router.push('/how-it-works')}
                  style={styles.explainerButton}
                />
              </>
            )}
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
                // dismissTo, NOT push: this screen is a ROOT-STACK route that
                // sits ABOVE the Tabs navigator, so push() stacks a SECOND tabs
                // instance on top of the summary and Back drops the user right
                // back into the session they just finished. dismissTo pops to
                // the tabs instance that is already mounted.
                onPress={() => router.dismissTo('/history')}
                style={{ flex: 1 }}
              />
            </Row>
            <PillButton
              variant="ghost"
              label="Run it back"
              icon="refresh"
              onPress={runItBack}
              style={{ marginTop: space.md }}
            />
            <PillButton
              label="Done"
              icon="checkmark"
              onPress={onDone}
              style={{ marginTop: space.md }}
            />
          </Animated.View>
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
          setPendingBg(uri);
          setPickingFormat(true);
        }}
        onCancel={() => {
          setPickingFrame(false);
          setPendingBg(undefined);
          setPickingFormat(true);
        }}
      />
    )}
    {pickingFormat && (
      <FormatPicker
        data={{ ...shareData, backgroundUri: pendingBg }}
        initial="story"
        onPick={(format) => {
          setPickingFormat(false);
          doShare(pendingBg, format);
        }}
        onCancel={() => {
          setPickingFormat(false);
          setPendingBg(undefined);
        }}
      />
    )}
    {/* Personal-best confetti — LAST child so it z-sits above everything.
        One burst per screen mount per session (trigger keyed on sessionId;
        confettiOn never resets, so re-renders/corrections can't replay it).
        pointerEvents-none inside Confetti keeps every button tappable during
        the burst; under reduced motion Confetti renders null and the
        PersonalBestBanner above carries the record on its own. */}
    {newBests.length > 0 && confettiOn && (
      <Confetti
        trigger={sessionId ?? 0}
        seed={(sessionId ?? 1) as number}
        style={styles.confetti}
        onDone={() => setConfettiOn(false)}
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
  /** Daily-goal result line: same tuck-up rhythm as pbBanner under the hero. */
  goalLineWrap: {
    marginTop: -space.md,
    marginBottom: space.xl,
  },
  goalLine: {
    ...type.caption,
    color: color.textDim,
  },
  // Career-milestone banner: a gold "moment" tucked under the hero, above PBs.
  milestoneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: -space.md,
    marginBottom: space.xl,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: 14,
    backgroundColor: color.threePtTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.threePt,
  },
  milestoneIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  milestoneText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  milestoneEyebrow: {
    ...type.micro,
    color: color.threePt,
    letterSpacing: 1.2,
  },
  milestoneBlurb: {
    ...type.bodyMedium,
    color: color.text,
  },
  milestoneMore: {
    ...type.caption,
    color: color.textDim,
    marginTop: 1,
  },
  mediaSection: {
    marginBottom: space.xl,
  },
  heatSection: {
    marginBottom: space.xl,
  },
  heatCard: {
    marginTop: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  actionsSection: {
    marginTop: space.xl,
  },
  /** First-summary explainer nudge: one-line caption over its ghost CTA. */
  explainerCaption: {
    ...type.micro,
    color: color.textDim,
    marginBottom: space.sm,
  },
  explainerButton: {
    marginBottom: space.md,
  },
  /** Full-screen confetti overlay (RN 0.86 has no absoluteFillObject). */
  confetti: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
