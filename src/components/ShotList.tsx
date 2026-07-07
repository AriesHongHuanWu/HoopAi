/**
 * Shot list + the shared session-recap kit.
 *
 * The session summary (src/app/session/summary.tsx) and the history detail
 * screen (src/app/history/[id].tsx) render the exact same composition, so the
 * shared pieces live here rather than in a duplicate route:
 *
 * - ShotList     — FlatList of shots with one-tap outcome correction,
 *                  per-shot evidence receipts and swipe-to-correct rows
 *                  (swipe right = make, left = miss).
 * - PipRow       — wrapping W/L pip row of make/miss/unsure markers.
 * - SessionRecap — hero FG% under the arc, stat cards, shot chart,
 *                  highlights plan and the shot list.
 * - useSessionRecord — loads a persisted session + shots from the db and
 *                  exposes an optimistic outcome-correction callback.
 * - useUndoableCorrection / UndoSnackbar — wraps a correction callback with
 *                  a ~4 s undo window; screens render the snackbar OUTSIDE
 *                  their scroll view so it stays pinned to the bottom.
 * - BackPill / date + clock formatters — small shared screen chrome.
 */
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeInDown, FadeOutDown, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HeroArcStat, ShotChart } from '@/components/charts/ShotChart';
import { FormReportCard } from '@/components/FormReport';
import {
  Card,
  Chip,
  Eyebrow,
  MakeMissDot,
  PillButton,
  Row,
  StatNumber,
} from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { planClips } from '@/core/clipPlanner';
import { FORM } from '@/core/config';
import {
  correctionMessage,
  correctionRevert,
  EVIDENCE_CHANNELS,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
} from '@/core/evidence';
import { recomputeStats } from '@/core/stats';
import type { ResolvedShot, SessionStats, ShotOutcome, ShotValue } from '@/core/types';
import * as db from '@/data/db';
import {
  getSession,
  sessionShots,
  shotFromRow,
  updateShotOutcome,
  updateShotValue,
  type SessionRow,
  type ShotRow as DbShotRow,
} from '@/data/db';
import { useSettings } from '@/state/settingsStore';

/**
 * Optional label-rename persistence. The shots/sessions data layer is owned
 * elsewhere and may not export updateSessionLabel yet — resolve it at runtime
 * so renames persist automatically once the function lands.
 */
const updateSessionLabel = (
  db as {
    updateSessionLabel?: (sessionId: number, label: string) => Promise<void>;
  }
).updateSessionLabel;

/**
 * Persist a session rename when the data layer supports it. Safe no-op (with
 * the optimistic UI already applied) when updateSessionLabel doesn't exist.
 */
export function persistSessionLabel(sessionId: number, label: string): void {
  if (updateSessionLabel) void updateSessionLabel(sessionId, label);
}

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
// SessionTitle — tap-to-rename inline session label
// ---------------------------------------------------------------------------

/**
 * Session name as a tappable title. Tap → inline TextInput; submit or blur
 * commits the trimmed name via `onRename` (caller persists). Empty label
 * shows a placeholder invitation instead.
 */
export function SessionTitle({
  label,
  onRename,
  placeholder = 'Name this session',
}: {
  label: string;
  onRename: (label: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== label) onRename(next);
  };

  if (editing) {
    return (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        autoFocus
        maxLength={60}
        returnKeyType="done"
        placeholder={placeholder}
        placeholderTextColor={color.textFaint}
        accessibilityLabel="Session name"
        selectionColor={color.accent}
        style={styles.titleInput}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        label.length > 0 ? `Session name: ${label}. Rename` : 'Name this session'
      }
      accessibilityHint="Opens a text field to rename this session"
      onPress={() => {
        void Haptics.selectionAsync();
        setDraft(label);
        setEditing(true);
      }}
      style={({ pressed }) => [styles.titleWrap, pressed && { opacity: 0.7 }]}
    >
      <Text
        style={[styles.titleText, label.length === 0 && styles.titlePlaceholder]}
        numberOfLines={1}
      >
        {label.length > 0 ? label : placeholder}
      </Text>
      <Text style={styles.titleEditHint}>EDIT</Text>
    </Pressable>
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

/**
 * ValuePill — a shot's estimated point value. A 2 reads quiet (chalk on
 * surface); a 3 gets the downtown-gold ring so threes pop in a scan. When
 * `onFlip` is provided it becomes a one-tap 2↔3 toggle (44pt target).
 */
function ValuePill({
  value,
  distanceRimWidths,
  onFlip,
}: {
  value: ShotValue;
  distanceRimWidths?: number;
  onFlip?: (next: ShotValue) => void;
}) {
  const is3 = value === 3;
  const rw =
    distanceRimWidths != null && distanceRimWidths > 0
      ? `~${distanceRimWidths.toFixed(1)}rw`
      : null;
  const body = (
    <View style={[styles.valuePill, is3 ? styles.valuePill3 : styles.valuePill2]}>
      <Text style={[styles.valuePillNum, is3 && styles.valuePillNum3]}>{value}</Text>
      <Text style={[styles.valuePillUnit, is3 && styles.valuePillUnit3]}>PT</Text>
    </View>
  );
  if (onFlip == null) {
    return (
      <View
        style={styles.valueWrap}
        accessible
        accessibilityLabel={is3 ? 'Three pointer' : 'Two pointer'}
      >
        {body}
        {rw != null && <Text style={styles.valueRw}>{rw}</Text>}
      </View>
    );
  }
  const next: ShotValue = is3 ? 2 : 3;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onFlip(next);
      }}
      accessibilityRole="button"
      accessibilityLabel={
        is3 ? 'Three pointer. Change to two.' : 'Two pointer. Change to three.'
      }
      accessibilityHint="Toggles this shot between a 2 and a 3"
      hitSlop={12}
      style={styles.valueWrap}
    >
      {body}
      {rw != null && <Text style={styles.valueRw}>{rw}</Text>}
    </Pressable>
  );
}

/**
 * SignalReceipts — the per-shot evidence row ("shows its work"). One tiny
 * chip per fusion channel (geo/net/cls): green check when the signal said
 * make, red x when it said miss, dim "—" when the channel had no data that
 * shot; plus a rim-bounce chip. The verdict dot above is never shown without
 * this receipt, so a user can always see WHY the app called it.
 */
function SignalReceipts({ shot }: { shot: ResolvedShot }) {
  return (
    <View
      accessible
      accessibilityLabel={evidenceSummary(shot.signals, shot.rimBounce)}
      style={styles.receiptRow}
    >
      {EVIDENCE_CHANNELS.map((c) => {
        const value = shot.signals[c.key];
        return (
          <Chip
            key={c.key}
            compact
            tone={evidenceTone(value)}
            label={`${evidenceGlyph(value)} ${c.label}`}
          />
        );
      })}
      {shot.rimBounce && <Chip compact tone="unsure" label="RIM BOUNCE" />}
    </View>
  );
}

/**
 * SwipeUnderlay — the outcome revealed behind a row mid-swipe. Width fixes
 * the Swipeable open distance; color + shape (dot/X) match MakeMissDot so the
 * gesture target is readable without color vision.
 */
function SwipeUnderlay({ outcome }: { outcome: 'make' | 'miss' }) {
  const isMake = outcome === 'make';
  return (
    <View
      style={[
        styles.swipeUnderlay,
        isMake ? styles.swipeUnderlayMake : styles.swipeUnderlayMiss,
      ]}
    >
      <MakeMissDot outcome={outcome} size={12} />
      <Text
        style={[
          styles.swipeUnderlayLabel,
          { color: isMake ? color.make : color.miss },
        ]}
      >
        {isMake ? 'MAKE' : 'MISS'}
      </Text>
    </View>
  );
}

const ShotListItem = React.memo(function ShotListItem({
  shot,
  onCorrect,
  onCorrectValue,
}: {
  shot: ResolvedShot;
  onCorrect?: (shot: ResolvedShot, outcome: ShotOutcome) => void;
  onCorrectValue?: (shot: ResolvedShot, value: ShotValue) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const swipeRef = useRef<SwipeableMethods>(null);
  const correct = (outcome: ShotOutcome) => {
    void Haptics.selectionAsync();
    onCorrect?.(shot, outcome);
  };
  const flipTo: ShotOutcome | null =
    shot.outcome === 'make' ? 'miss' : shot.outcome === 'miss' ? 'make' : null;
  const value: ShotValue = shot.shotValue === 3 ? 3 : 2;
  const hasForm = shot.form != null;
  const rowContent = (
    <View>
      <View style={styles.row}>
        <View style={styles.rowDot}>
          <MakeMissDot outcome={shot.outcome} />
        </View>
        <View style={styles.rowBody}>
          <Row>
            <Text style={styles.rowTitle}>Shot {shot.id}</Text>
            <ValuePill
              value={value}
              distanceRimWidths={shot.distanceRimWidths}
              onFlip={
                onCorrectValue ? (next) => onCorrectValue(shot, next) : undefined
              }
            />
            {shot.corrected === true && <Chip label="Edited" tone="accent" />}
            {shot.outcome === 'unsure' && shot.corrected !== true && (
              <Chip label="Review" tone="unsure" />
            )}
          </Row>
          <SignalReceipts shot={shot} />
          {(shot.entryAngleDeg != null || shot.releaseAngleDeg != null || hasForm) && (
            <Row gap={space.xs} style={{ flexWrap: 'wrap' }}>
              {shot.entryAngleDeg != null && (
                <Chip label={`${Math.round(shot.entryAngleDeg)}° entry`} />
              )}
              {shot.releaseAngleDeg != null && (
                <Chip label={`${Math.round(shot.releaseAngleDeg)}° release`} />
              )}
              {hasForm && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={formOpen ? 'Hide form report' : 'Show form report'}
                  accessibilityHint="Toggles this shot's pose-based form analysis"
                  hitSlop={8}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setFormOpen((v) => !v);
                  }}
                  style={styles.formChipTouch}
                >
                  <Chip label={formOpen ? 'Form ▲' : 'Form ▼'} tone="accent" />
                </Pressable>
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
      {hasForm && formOpen && (
        <View style={styles.formWrap}>
          <FormReportCard report={shot.form!} />
        </View>
      )}
    </View>
  );

  // Read-only lists (no correction callback) skip the gesture wrapper.
  if (onCorrect == null) return rowContent;

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={() => <SwipeUnderlay outcome="make" />}
      renderRightActions={() => <SwipeUnderlay outcome="miss" />}
      onSwipeableWillOpen={(direction) => {
        // ReanimatedSwipeable reports the SWIPE direction (not the legacy
        // "panel side"): swipe right reveals the make underlay, left = miss.
        const next: ShotOutcome =
          direction === SwipeDirection.RIGHT ? 'make' : 'miss';
        // Snap shut immediately — the row never rests open; the correction
        // (and its undo snackbar) is the feedback.
        swipeRef.current?.close();
        if (shot.outcome !== next) correct(next);
      }}
      // The open/close springs honor the OS reduce-motion setting; the drag
      // itself is direct manipulation and stays.
      animationOptions={{ reduceMotion: ReduceMotion.System }}
      // Opaque row background so the underlay only shows in the revealed gap.
      childrenContainerStyle={styles.swipeChildren}
    >
      {rowContent}
    </ReanimatedSwipeable>
  );
});

export function ShotList({
  shots,
  onCorrect,
  onCorrectValue,
}: {
  shots: readonly ResolvedShot[];
  /** One-tap correction: called with the shot and its NEW outcome. */
  onCorrect?: (shot: ResolvedShot, outcome: ShotOutcome) => void;
  /** One-tap 2↔3 correction: called with the shot and its NEW point value. */
  onCorrectValue?: (shot: ResolvedShot, value: ShotValue) => void;
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
        <ShotListItem
          shot={item}
          onCorrect={onCorrect}
          onCorrectValue={onCorrectValue}
        />
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
  // User-tunable clip window (Settings > Video). Recomputing from the current
  // setting keeps the plan live — tweak the window, revisit, new plan.
  const preRollSec = useSettings((s) => s.clipPreRollSec);
  const postRollSec = useSettings((s) => s.clipPostRollSec);
  const clips = useMemo(() => {
    if (keepMode === 'none' || shots.length === 0) return [];
    const sessionDurationSec =
      shots[shots.length - 1].tResolved + postRollSec + 3;
    return planClips(shots, {
      keep: keepMode as 'makes' | 'all' | 'decided',
      preRollSec,
      postRollSec,
      sessionDurationSec,
    });
  }, [shots, keepMode, preRollSec, postRollSec]);

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
        Watch highlights in the replay player.
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
  /** One-tap 2↔3 correction: called with the shot and its NEW point value. */
  onCorrectValue?: (shot: ResolvedShot, value: ShotValue) => void;
  /** Session recording path; the highlights plan card shows when set. */
  videoPath?: string | null;
  /** Clip keep mode ('makes' | 'decided' | 'all' | 'none'). */
  keepMode?: string;
}

export function SessionRecap({
  shots,
  stats,
  onCorrect,
  onCorrectValue,
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
          caption={`${stats.points} PTS · ${stats.makes}/${stats.attempts} FG`}
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
          <Eyebrow>Scoring</Eyebrow>
          <Row gap={space.md} style={{ alignItems: 'stretch', marginTop: space.xs }}>
            <View style={styles.splitCol}>
              <Row gap={space.sm} style={{ alignItems: 'baseline' }}>
                <Text style={styles.splitTag}>2PT</Text>
                <Text style={styles.splitMade}>
                  {stats.twoPtMakes}
                  <Text style={styles.splitOf}>/{stats.twoPtAttempts}</Text>
                </Text>
              </Row>
              <Text style={styles.splitPct}>
                {stats.twoPtAttempts > 0
                  ? `${Math.round(stats.twoPtPct * 100)}%`
                  : '—'}
              </Text>
            </View>
            <View style={styles.splitDivide} />
            <View style={styles.splitCol}>
              <Row gap={space.sm} style={{ alignItems: 'baseline' }}>
                <Text style={[styles.splitTag, styles.splitTagGold]}>3PT</Text>
                <Text style={[styles.splitMade, styles.splitMadeGold]}>
                  {stats.threePtMakes}
                  <Text style={styles.splitOfGold}>/{stats.threePtAttempts}</Text>
                </Text>
              </Row>
              <Text style={[styles.splitPct, styles.splitPctGold]}>
                {stats.threePtAttempts > 0
                  ? `${Math.round(stats.threePtPct * 100)}%`
                  : '—'}
              </Text>
            </View>
          </Row>
        </Card>

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
          <ShotList
            shots={shots}
            onCorrect={onCorrect}
            onCorrectValue={onCorrectValue}
          />
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
  /**
   * Optimistic correction: flips locally, persists via updateShotOutcome.
   * `corrected` (default true) stamps the user-edited flag; the undo path
   * passes the shot's pre-correction flag back to restore it exactly.
   */
  correct: (shot: ResolvedShot, outcome: ShotOutcome, corrected?: boolean) => void;
  /**
   * 2↔3 correction for a persisted shot. Applied optimistically (points +
   * splits recompute immediately) and persisted via updateShotValue, mirroring
   * `correct`.
   */
  correctValue: (shot: ResolvedShot, value: ShotValue) => void;
}

export function useSessionRecord(sessionId: number | null): SessionRecord {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [rows, setRows] = useState<DbShotRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** shotIndex → overridden point value (in-memory; not persisted). */
  const [valueOverrides, setValueOverrides] = useState<Record<number, ShotValue>>({});

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setSession(null);
    setRows([]);
    setValueOverrides({});
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

  const shots = useMemo(
    () =>
      rows.map((r) => {
        const shot = shotFromRow(r);
        const override = valueOverrides[r.shotIndex];
        return override != null
          ? { ...shot, shotValue: override, corrected: true }
          : shot;
      }),
    [rows, valueOverrides],
  );
  const stats = useMemo(() => recomputeStats(shots), [shots]);

  // No `rows` dependency: both callbacks resolve the target row from the
  // functional setState updater, so their identity stays stable across row
  // updates instead of being recreated on every correction (which would force
  // every ShotListItem's memo to bust, not just the corrected one).
  const correct = useCallback(
    (shot: ResolvedShot, outcome: ShotOutcome, corrected: boolean = true) => {
      setRows((prev) => {
        const row = prev.find((r) => r.shotIndex === shot.id);
        if (!row) return prev;
        void updateShotOutcome(row.id, outcome, corrected);
        return prev.map((r) =>
          r.id === row.id ? { ...r, outcome, corrected: corrected ? 1 : 0 } : r,
        );
      });
    },
    [],
  );

  const correctValue = useCallback((shot: ResolvedShot, value: ShotValue) => {
    setRows((prev) => {
      const row = prev.find((r) => r.shotIndex === shot.id);
      if (row) void updateShotValue(row.id, value);
      return prev;
    });
    setValueOverrides((prev) => ({ ...prev, [shot.id]: value }));
  }, []);

  return { session, shots, stats, loaded, correct, correctValue };
}

// ---------------------------------------------------------------------------
// useUndoableCorrection + UndoSnackbar — a ~4 s undo window on corrections
// ---------------------------------------------------------------------------

/** How long the undo snackbar stays up after a correction. */
const UNDO_WINDOW_MS = 4000;

export interface PendingCorrection {
  /** PRE-correction snapshot — undo restores its outcome + corrected flag. */
  shot: ResolvedShot;
  /** The outcome the user just applied. */
  outcome: ShotOutcome;
}

export interface UndoableCorrection {
  /** Wrapped correction callback for SessionRecap/ShotList `onCorrect`. */
  correct: (shot: ResolvedShot, outcome: ShotOutcome) => void;
  /** The correction currently offered for undo (drives UndoSnackbar). */
  pending: PendingCorrection | null;
  /** Revert the pending correction through the same pathway it was applied. */
  undo: () => void;
}

/**
 * Wraps a correction-apply callback (store or db pathway — both take an
 * optional `corrected` flag) with undo bookkeeping: every applied correction
 * arms a {@link UNDO_WINDOW_MS} window during which `undo` re-applies the
 * shot's pre-correction outcome AND corrected flag, so an undone first edit
 * leaves no stale "Edited" badge. A second correction replaces the pending
 * one (only the latest is undoable).
 */
export function useUndoableCorrection(
  apply: (shot: ResolvedShot, outcome: ShotOutcome, corrected?: boolean) => void,
): UndoableCorrection {
  const [pending, setPending] = useState<PendingCorrection | null>(null);
  // Ref mirror so `undo` reads the latest pending without re-running effects
  // (and without side effects inside a setState updater).
  const pendingRef = useRef<PendingCorrection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  // Clear the timer on unmount so a late fire never touches unmounted state.
  useEffect(() => disarm, [disarm]);

  const correct = useCallback(
    (shot: ResolvedShot, outcome: ShotOutcome) => {
      // Swiping in the already-recorded direction changes nothing — don't
      // stamp `corrected` or flash an undo bar for a no-op.
      if (shot.outcome === outcome) return;
      apply(shot, outcome);
      disarm();
      pendingRef.current = { shot, outcome };
      setPending(pendingRef.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        pendingRef.current = null;
        setPending(null);
      }, UNDO_WINDOW_MS);
    },
    [apply, disarm],
  );

  const undo = useCallback(() => {
    const p = pendingRef.current;
    disarm();
    pendingRef.current = null;
    setPending(null);
    if (p != null) {
      const revert = correctionRevert(p.shot);
      apply(p.shot, revert.outcome, revert.corrected);
    }
  }, [apply, disarm]);

  return { correct, pending, undo };
}

/**
 * UndoSnackbar — bottom-pinned "Shot N marked a make · UNDO" bar. Render it
 * OUTSIDE the screen's ScrollView (absolute positioning inside scroll content
 * would scroll away with it). Auto-dismisses via useUndoableCorrection's
 * timer; entering/exiting honor the OS reduce-motion setting.
 */
export function UndoSnackbar({
  pending,
  onUndo,
}: {
  pending: PendingCorrection | null;
  onUndo: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (pending == null) return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      accessibilityLiveRegion="polite"
      style={[styles.snackbar, { bottom: insets.bottom + space.lg }]}
    >
      {pending.outcome !== 'unsure' && (
        <MakeMissDot outcome={pending.outcome} size={12} />
      )}
      <Text style={styles.snackbarText} numberOfLines={1}>
        {correctionMessage(pending.shot.id, pending.outcome)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Undo correction"
        hitSlop={8}
        onPress={onUndo}
        style={({ pressed }) => [styles.snackbarUndo, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.snackbarUndoText}>UNDO</Text>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  backPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: touch.minTarget,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  titleText: {
    ...type.title,
    color: color.text,
    flexShrink: 1,
  },
  titlePlaceholder: {
    color: color.textFaint,
  },
  titleEditHint: {
    ...type.micro,
    color: color.textFaint,
  },
  titleInput: {
    ...type.title,
    color: color.text,
    minHeight: touch.minTarget,
    paddingVertical: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.accent,
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
  receiptRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
  },

  // Swipe-to-correct (underlay revealed behind the translating row)
  swipeChildren: {
    backgroundColor: color.bg,
  },
  swipeUnderlay: {
    width: 110,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  swipeUnderlayMake: {
    backgroundColor: color.makeTint,
  },
  swipeUnderlayMiss: {
    backgroundColor: color.missTint,
  },
  swipeUnderlayLabel: {
    ...type.caption,
    letterSpacing: 1,
  },

  // Undo snackbar (absolutely positioned by the host screen's safe area)
  snackbar: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
  },
  snackbarText: {
    ...type.bodyMedium,
    color: color.text,
    flex: 1,
  },
  snackbarUndo: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  snackbarUndoText: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1,
  },
  formChipTouch: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
  },
  formWrap: {
    paddingBottom: space.md,
    paddingLeft: 20 + space.md,
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

  // Value pill (2/3 badge + optional tap-to-flip)
  valueWrap: {
    alignItems: 'center',
    gap: 1,
  },
  valuePill: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    minHeight: 22,
    justifyContent: 'center',
  },
  valuePill2: {
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
  },
  valuePill3: {
    borderColor: color.threePt,
    backgroundColor: color.threePtTint,
  },
  valuePillNum: {
    ...type.caption,
    fontFamily: type.heading.fontFamily,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  valuePillNum3: {
    color: color.threePt,
  },
  valuePillUnit: {
    ...type.micro,
    color: color.textFaint,
  },
  valuePillUnit3: {
    color: 'rgba(242, 193, 78, 0.7)',
  },
  valueRw: {
    ...type.micro,
    fontSize: 9,
    color: color.textFaint,
  },

  // Scoring split card (2PT / 3PT)
  splitCol: {
    flex: 1,
    gap: space.xs,
  },
  splitDivide: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.border,
  },
  splitTag: {
    ...type.micro,
    color: color.textDim,
  },
  splitTagGold: {
    color: color.threePt,
  },
  splitMade: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  splitMadeGold: {
    color: color.threePt,
  },
  splitOf: {
    ...type.body,
    color: color.textFaint,
  },
  splitOfGold: {
    ...type.body,
    color: 'rgba(242, 193, 78, 0.6)',
  },
  splitPct: {
    ...type.caption,
    color: color.textDim,
  },
  splitPctGold: {
    color: 'rgba(242, 193, 78, 0.85)',
  },
});
