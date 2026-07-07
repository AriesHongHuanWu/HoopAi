/**
 * Session detail — loads one persisted session + its shots from the database
 * and renders the same hero/chart/list composition as the post-session
 * summary (shared SessionRecap). Corrections persist via updateShotOutcome
 * with an optimistic local flip. Below the recap: a "vs previous session"
 * comparison (against the next older session with shots) and the entry-angle
 * histogram.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { shareSessionCard } from '@/components/ShareCard';
import { FramePickerModal } from '@/components/FramePickerModal';
import { sessionMomentSec } from '@/core/shareFrame';
import {
  BackPill,
  SessionRecap,
  UndoSnackbar,
  formatSessionDate,
  formatSessionTime,
  useSessionRecord,
  useUndoableCorrection,
} from '@/components/ShotList';
import {
  AngleHistogram,
  decidedEntryAngles,
} from '@/components/charts/AngleHistogram';
import { CompareBars } from '@/components/charts/CompareBars';
import { ReelEntryButton } from '@/components/ReelEntryButton';
import { Card, Chip, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import { getModeDef, type ModeState } from '@/core/gameModes';
import type { SessionStats } from '@/core/types';
import { listSessions, sessionStatsFromDb, updateSessionLabel } from '@/data/db';

/**
 * Inline tag editor — a small pill near the session title. Tap to reveal a
 * text field; submit/blur commits the trimmed tag via `onChange` (caller
 * persists). Distinct from the date title above it: this is the free-text
 * label used for filtering History and CSV export, not a rename of the
 * session itself.
 */
function TagField({
  tag,
  onChange,
}: {
  tag: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== tag) onChange(next);
  };

  if (editing) {
    return (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        autoFocus
        maxLength={40}
        returnKeyType="done"
        placeholder="Add a tag"
        placeholderTextColor={color.textFaint}
        accessibilityLabel="Session tag"
        selectionColor={color.accent}
        style={styles.tagInput}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tag.length > 0 ? `Tag: ${tag}. Edit tag` : 'Add a tag'}
      accessibilityHint="Opens a text field to edit this session's tag"
      onPress={() => {
        void Haptics.selectionAsync();
        setDraft(tag);
        setEditing(true);
      }}
      style={({ pressed }) => [styles.tagPill, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.tagText} numberOfLines={1}>
        {tag.length > 0 ? tag : 'Add a tag'}
      </Text>
    </Pressable>
  );
}

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
            {mode.ghost != null && <Chip label={`Ghost ${mode.ghost.finalGhostMakes}`} />}
            {mode.ghost?.result != null && (
              <Chip
                label={
                  mode.ghost.result === 'win'
                    ? `Won by ${mode.ghost.finalMargin ?? 0}`
                    : mode.ghost.result === 'loss'
                      ? `Lost by ${-(mode.ghost.finalMargin ?? 0)}`
                      : 'Tied'
                }
                tone={
                  mode.ghost.result === 'win'
                    ? 'make'
                    : mode.ghost.result === 'loss'
                      ? 'miss'
                      : 'unsure'
                }
              />
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
  // Corrections (tap or swipe) run through the persisted-record pathway with
  // the shared ~4 s undo window; the snackbar renders outside the ScrollView.
  const undoable = useUndoableCorrection(record.correct);

  // Tag: optimistic local override on top of the persisted label so the
  // pill updates immediately; persists via updateSessionLabel (never throws).
  const [tagOverride, setTagOverride] = useState<string | null>(null);
  const tag = tagOverride ?? (session?.label ?? '');
  const onTagChange = (next: string) => {
    setTagOverride(next);
    if (sessionId != null) void updateSessionLabel(sessionId, next);
  };

  // Re-share a past session as a branded card. Mirrors the summary screen:
  // disabled while the offscreen snapshot renders, a quiet chip on failure
  // (shareSessionCard never throws).
  const [sharing, setSharing] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [pickingFrame, setPickingFrame] = useState(false);

  const recStartSec = session?.recordingStartSec ?? null;
  const durationSec =
    session?.endedAt != null && session?.startedAt != null
      ? (session.endedAt - session.startedAt) / 1000
      : 0;
  const canPickFrame = session?.videoPath != null && recStartSec != null;
  const initialMomentSec =
    recStartSec != null ? (sessionMomentSec(record.shots, recStartSec, durationSec) ?? 0) : 0;

  const doShare = (backgroundUri?: string) => {
    if (session == null) return;
    setSharing(true);
    setShareFailed(false);
    void shareSessionCard({
      stats: record.stats,
      shots: record.shots,
      label: tag.trim() !== '' ? tag : 'Shooting session',
      dateMs: session.startedAt,
      backgroundUri,
    }).then((ok) => {
      setSharing(false);
      if (!ok) setShareFailed(true);
    });
  };
  const onShareCard = () => {
    if (sharing || pickingFrame || session == null) return;
    if (canPickFrame) setPickingFrame(true);
    else doShare();
  };

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
    <>
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
          {meta != null && (
            <Row gap={space.xs} style={styles.metaRow}>
              <Ionicons
                name="time-outline"
                size={12}
                color={color.textFaint}
                importantForAccessibility="no"
              />
              <Text style={styles.meta}>{meta}</Text>
            </Row>
          )}
          <View style={{ marginTop: space.sm }}>
            <TagField tag={tag} onChange={onTagChange} />
          </View>
          {shareFailed && (
            <View style={{ marginTop: space.md }}>
              <Chip label="Couldn't share — try again" tone="unsure" />
            </View>
          )}
          <PillButton
            label="Shot Lab — deep analysis"
            icon="flask"
            onPress={() =>
              router.push({ pathname: '/shotlab', params: { sid: String(session.id) } })
            }
            disabled={record.shots.length === 0}
            style={{ marginTop: space.lg }}
          />
          <PillButton
            variant="ghost"
            label={sharing ? 'Preparing…' : 'Share card'}
            icon="share-social"
            onPress={onShareCard}
            disabled={sharing || record.shots.length === 0}
            style={{ marginTop: space.md }}
          />
          {session.videoPath != null && (
            <Row gap={space.md} style={{ marginTop: space.lg }}>
              <PillButton
                label="Watch replay"
                icon="play"
                onPress={() => router.push(`/video/${session.id}`)}
                style={{ flex: 1 }}
              />
              <ReelEntryButton sessionId={session.id} variant="ghost" style={{ flex: 1 }} />
            </Row>
          )}
          {session.modeId != null && (
            <View style={{ marginTop: space.lg }}>
              <ModeBreakdownCard modeId={session.modeId} resultJson={session.modeResultJson} />
            </View>
          )}
          <View style={styles.recapSection}>
            <SessionRecap
              shots={record.shots}
              stats={record.stats}
              onCorrect={undoable.correct}
              onCorrectValue={record.correctValue}
              videoPath={session.videoPath}
              keepMode={session.keepMode}
            />
          </View>
          <View style={styles.analysisSection}>
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
    <UndoSnackbar pending={undoable.pending} onUndo={undoable.undo} />
    {pickingFrame && session?.videoPath != null && (
      <FramePickerModal
        videoPath={session.videoPath}
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
    </>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
  },
  metaRow: {
    marginTop: space.xs,
  },
  meta: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  // Section rhythm: the recap and analysis blocks each open with a hairline
  // rule + generous top padding so the detail reads in broadcast "segments"
  // (header / recap / deeper analysis), matching the summary screen's beat.
  recapSection: {
    marginTop: space.xl,
    paddingTop: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  analysisSection: {
    marginTop: space.xl,
    paddingTop: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    gap: space.lg,
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
  tagPill: {
    alignSelf: 'flex-start',
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
  },
  tagText: {
    ...type.caption,
    color: color.textDim,
  },
  tagInput: {
    ...type.caption,
    color: color.text,
    minHeight: touch.minTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.accent,
  },
});
