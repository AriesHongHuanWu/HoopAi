/**
 * Shot list + the shared session-recap kit.
 *
 * The session summary (src/app/session/summary.tsx) and the history detail
 * screen (src/app/history/[id].tsx) render the exact same composition, so the
 * shared pieces live here rather than in a duplicate route:
 *
 * - ShotList     — FlatList of shots with one-tap outcome correction.
 * - PipRow       — wrapping W/L pip row of make/miss/unsure markers.
 * - SessionRecap — hero FG% under the arc, stat cards, shot chart,
 *                  highlights plan and the shot list.
 * - useSessionRecord — loads a persisted session + shots from the db and
 *                  exposes an optimistic outcome-correction callback.
 * - BackPill / date + clock formatters — small shared screen chrome.
 */
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { HeroArcStat, ShotChart } from '@/components/charts/ShotChart';
import {
  Card,
  Chip,
  Eyebrow,
  MakeMissDot,
  PillButton,
  Row,
  StatNumber,
} from '@/components/ui';
import { color, motion, space, touch, type } from '@/constants/tokens';
import { planClips } from '@/core/clipPlanner';
import { FORM } from '@/core/config';
import { recomputeStats } from '@/core/stats';
import type { ResolvedShot, SessionStats, ShotOutcome } from '@/core/types';
import {
  getSession,
  sessionShots,
  shotFromRow,
  updateShotOutcome,
  type SessionRow,
  type ShotRow as DbShotRow,
} from '@/data/db';

// ---------------------------------------------------------------------------
// Formatters (no date lib — manual formatting)
// ---------------------------------------------------------------------------

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Thu, Jul 3" — year appended only when it isn't the current year. */
export function formatSessionDate(ms: number): string {
  const d = new Date(ms);
  const year =
    d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

/** "2:05 PM". */
export function formatSessionTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const suffix = h < 12 ? 'AM' : 'PM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

/** Seconds → "m:ss" clock string for clip windows. */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// BackPill — back affordance for screens (global headers are hidden)
// ---------------------------------------------------------------------------

export function BackPill() {
  if (!router.canGoBack()) return null;
  return (
    <PillButton
      variant="ghost"
      label="‹ Back"
      onPress={() => router.back()}
      style={styles.backPill}
    />
  );
}

// ---------------------------------------------------------------------------
// PipRow — W/L sequence of make/miss/unsure markers, wraps
// ---------------------------------------------------------------------------

export function PipRow({
  outcomes,
  size = 12,
  max = 60,
  style,
}: {
  outcomes: readonly ShotOutcome[];
  size?: number;
  /** Cap on rendered pips; overflow collapses into "+N". */
  max?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (outcomes.length === 0) return null;
  const shown = outcomes.slice(0, max);
  const extra = outcomes.length - shown.length;
  const makes = outcomes.filter((o) => o === 'make').length;
  const misses = outcomes.filter((o) => o === 'miss').length;
  const unsure = outcomes.length - makes - misses;
  const label =
    `Shot sequence: ${makes} makes, ${misses} misses` +
    (unsure > 0 ? `, ${unsure} unsure` : '');
  return (
    <View accessible accessibilityLabel={label} style={[styles.pipRow, style]}>
      {shown.map((o, i) => (
        <MakeMissDot key={i} outcome={o} size={size} />
      ))}
      {extra > 0 && <Text style={styles.pipMore}>+{extra}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ShotList
// ---------------------------------------------------------------------------

function Separator() {
  return <View style={styles.separator} />;
}

function ShotListItem({
  shot,
  onCorrect,
}: {
  shot: ResolvedShot;
  onCorrect?: (shot: ResolvedShot, outcome: ShotOutcome) => void;
}) {
  const correct = (outcome: ShotOutcome) => {
    void Haptics.selectionAsync();
    onCorrect?.(shot, outcome);
  };
  const flipTo: ShotOutcome | null =
    shot.outcome === 'make' ? 'miss' : shot.outcome === 'miss' ? 'make' : null;
  return (
    <View style={styles.row}>
      <View style={styles.rowDot}>
        <MakeMissDot outcome={shot.outcome} />
      </View>
      <View style={styles.rowBody}>
        <Row>
          <Text style={styles.rowTitle}>Shot {shot.id}</Text>
          {shot.corrected === true && <Chip label="Edited" tone="accent" />}
        </Row>
        {(shot.entryAngleDeg != null || shot.releaseAngleDeg != null) && (
          <Row gap={space.xs} style={{ flexWrap: 'wrap' }}>
            {shot.entryAngleDeg != null && (
              <Chip label={`${Math.round(shot.entryAngleDeg)}° entry`} />
            )}
            {shot.releaseAngleDeg != null && (
              <Chip label={`${Math.round(shot.releaseAngleDeg)}° release`} />
            )}
          </Row>
        )}
      </View>
      {onCorrect != null &&
        (flipTo != null ? (
          <PillButton
            variant="ghost"
            label={flipTo === 'make' ? 'Change to make' : 'Change to miss'}
            onPress={() => correct(flipTo)}
            style={styles.correctBtn}
          />
        ) : (
          <View style={{ gap: space.xs }}>
            <PillButton
              variant="ghost"
              label="Make"
              onPress={() => correct('make')}
              style={styles.correctBtn}
            />
            <PillButton
              variant="ghost"
              label="Miss"
              onPress={() => correct('miss')}
              style={styles.correctBtn}
            />
          </View>
        ))}
    </View>
  );
}

export function ShotList({
  shots,
  onCorrect,
}: {
  shots: readonly ResolvedShot[];
  /** One-tap correction: called with the shot and its NEW outcome. */
  onCorrect?: (shot: ResolvedShot, outcome: ShotOutcome) => void;
}) {
  if (shots.length === 0) {
    return <Text style={styles.empty}>No shots recorded.</Text>;
  }
  return (
    <FlatList
      data={shots}
      keyExtractor={(s) => String(s.id)}
      scrollEnabled={false}
      renderItem={({ item }) => (
        <ShotListItem shot={item} onCorrect={onCorrect} />
      )}
      ItemSeparatorComponent={Separator}
    />
  );
}

// ---------------------------------------------------------------------------
// Highlights plan card (clip windows from planClips; export is Phase 2)
// ---------------------------------------------------------------------------

const KEEP_LABELS: Record<string, string> = {
  makes: 'makes only',
  decided: 'makes and misses',
  all: 'every shot',
};

function HighlightsCard({
  shots,
  keepMode,
}: {
  shots: readonly ResolvedShot[];
  keepMode: string;
}) {
  const clips = useMemo(() => {
    if (keepMode === 'none' || shots.length === 0) return [];
    const sessionDurationSec = shots[shots.length - 1].tResolved + 5;
    return planClips(shots, {
      keep: keepMode as 'makes' | 'all' | 'decided',
      sessionDurationSec,
    });
  }, [shots, keepMode]);

  return (
    <Card>
      <Eyebrow>Highlights plan</Eyebrow>
      {keepMode === 'none' ? (
        <Text style={styles.bodyDim}>
          Clip keeping was off for this session, so no highlights are planned.
        </Text>
      ) : clips.length === 0 ? (
        <Text style={styles.bodyDim}>
          No shots match your clip setting ({KEEP_LABELS[keepMode] ?? keepMode})
          this session.
        </Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {clips.map((c) => (
            <Row
              key={`${c.shotId}-${c.startSec}`}
              style={{ justifyContent: 'space-between' }}
            >
              <Text style={styles.clipText}>
                Shot {c.shotId} — {formatClock(c.startSec)}–
                {formatClock(c.endSec)}
              </Text>
              <Chip
                label={
                  c.outcome === 'make'
                    ? 'Make'
                    : c.outcome === 'miss'
                      ? 'Miss'
                      : 'Unsure'
                }
                tone={c.outcome}
              />
            </Row>
          ))}
        </View>
      )}
      <Text style={styles.footnote}>
        Clip export lands in the next update — the full video is saved.
      </Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SessionRecap — the shared hero/cards/chart/list composition
// ---------------------------------------------------------------------------

function consistencyLine(std: number | null): string {
  if (std == null) return 'Not enough angle data yet — keep shooting.';
  if (std <= 3) return 'Locked in — your arc barely changes shot to shot.';
  if (std <= 6) return 'Solid — just a little wobble in your arc.';
  return 'Your arc varies a lot — groove one consistent release.';
}

export interface SessionRecapProps {
  shots: readonly ResolvedShot[];
  stats: SessionStats;
  /** One-tap correction: called with the shot and its NEW outcome. */
  onCorrect?: (shot: ResolvedShot, outcome: ShotOutcome) => void;
  /** Session recording path; the highlights plan card shows when set. */
  videoPath?: string | null;
  /** Clip keep mode ('makes' | 'decided' | 'all' | 'none'). */
  keepMode?: string;
}

export function SessionRecap({
  shots,
  stats,
  onCorrect,
  videoPath,
  keepMode = 'makes',
}: SessionRecapProps) {
  const fgValue =
    stats.attempts > 0 ? `${Math.round(stats.fgPct * 100)}%` : '—';
  const avgEntry = stats.avgEntryAngleDeg;
  const entryInBand =
    avgEntry != null &&
    avgEntry >= FORM.entryAngle.min &&
    avgEntry <= FORM.entryAngle.max;
  const entryHint =
    avgEntry == null
      ? 'No entry-angle data this session.'
      : entryInBand
        ? 'Right in the money zone.'
        : avgEntry < FORM.entryAngle.min
          ? 'A bit flat — add some arc.'
          : 'A bit steep — soften your arc.';

  return (
    <View style={{ gap: space.lg }}>
      <Animated.View entering={FadeInDown.duration(motion.standard)}>
        <HeroArcStat
          value={fgValue}
          caption={`MAKES ${stats.makes} · ATTEMPTS ${stats.attempts}`}
        />
        <PipRow
          outcomes={shots.map((s) => s.outcome)}
          style={{ justifyContent: 'center', marginTop: space.sm }}
        />
      </Animated.View>

      <Animated.View
        entering={FadeInDown.duration(motion.standard).delay(90)}
        style={{ gap: space.lg }}
      >
        <Row gap={space.md} style={{ alignItems: 'stretch' }}>
          <Card style={{ flex: 1 }}>
            <Eyebrow>Best streak</Eyebrow>
            <StatNumber
              value={String(stats.bestStreak)}
              size="medium"
              label="makes in a row"
              style={{ alignItems: 'flex-start' }}
            />
            {stats.bestStreak >= 3 && (
              <View style={{ marginTop: space.sm }}>
                <Chip label="Heater" tone="accent" />
              </View>
            )}
          </Card>
          <Card style={{ flex: 1 }}>
            <Eyebrow>Entry angle</Eyebrow>
            <StatNumber
              value={avgEntry != null ? `${Math.round(avgEntry)}°` : '—'}
              size="medium"
              label="average"
              style={{ alignItems: 'flex-start' }}
            />
            {entryInBand && (
              <View style={{ marginTop: space.sm }}>
                <Chip
                  label={`Optimal ${FORM.entryAngle.min}–${FORM.entryAngle.max}°`}
                  tone="make"
                />
              </View>
            )}
          </Card>
        </Row>

        <Card>
          <Eyebrow>Consistency</Eyebrow>
          <Row gap={space.lg}>
            <StatNumber
              value={
                stats.entryAngleStdDeg != null
                  ? `±${stats.entryAngleStdDeg.toFixed(1)}°`
                  : '—'
              }
              size="medium"
              style={{ alignItems: 'flex-start' }}
            />
            <Text style={styles.consistencyText}>
              {consistencyLine(stats.entryAngleStdDeg)}
            </Text>
          </Row>
          {avgEntry != null && (
            <Text style={styles.cardCaption}>{entryHint}</Text>
          )}
        </Card>

        <Card>
          <Eyebrow>Shot chart</Eyebrow>
          <ShotChart shots={shots} />
        </Card>

        {videoPath != null && (
          <HighlightsCard shots={shots} keepMode={keepMode} />
        )}

        <View>
          <Eyebrow>Shots</Eyebrow>
          <ShotList shots={shots} onCorrect={onCorrect} />
        </View>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// useSessionRecord — load a persisted session + optimistic corrections
// ---------------------------------------------------------------------------

export interface SessionRecord {
  session: SessionRow | null;
  shots: ResolvedShot[];
  stats: SessionStats;
  /** True once the initial load settled (even if the session was missing). */
  loaded: boolean;
  /** Optimistic correction: flips locally, persists via updateShotOutcome. */
  correct: (shot: ResolvedShot, outcome: ShotOutcome) => void;
}

export function useSessionRecord(sessionId: number | null): SessionRecord {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [rows, setRows] = useState<DbShotRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setSession(null);
    setRows([]);
    if (sessionId == null) {
      setLoaded(true);
      return;
    }
    void (async () => {
      const [s, r] = await Promise.all([
        getSession(sessionId),
        sessionShots(sessionId),
      ]);
      if (!alive) return;
      setSession(s);
      setRows(r);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const shots = useMemo(() => rows.map(shotFromRow), [rows]);
  const stats = useMemo(() => recomputeStats(shots), [shots]);

  const correct = useCallback(
    (shot: ResolvedShot, outcome: ShotOutcome) => {
      const row = rows.find((r) => r.shotIndex === shot.id);
      if (!row) return;
      void updateShotOutcome(row.id, outcome);
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, outcome, corrected: 1 } : r,
        ),
      );
    },
    [rows],
  );

  return { session, shots, stats, loaded, correct };
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  backPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
  },
  pipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
  },
  pipMore: {
    ...type.caption,
    color: color.textFaint,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    minHeight: touch.minTarget,
  },
  rowDot: {
    width: 20,
    alignItems: 'center',
  },
  rowBody: {
    flex: 1,
    gap: space.xs,
  },
  rowTitle: {
    ...type.bodyMedium,
    color: color.text,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
  },
  empty: {
    ...type.body,
    color: color.textDim,
  },
  correctBtn: {
    paddingHorizontal: space.lg,
  },
  bodyDim: {
    ...type.body,
    color: color.textDim,
  },
  clipText: {
    ...type.bodyMedium,
    color: color.text,
  },
  footnote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  cardCaption: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.sm,
  },
  consistencyText: {
    ...type.body,
    color: color.textDim,
    flex: 1,
  },
});
