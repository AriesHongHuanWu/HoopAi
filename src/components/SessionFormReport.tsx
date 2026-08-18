/**
 * SessionFormReport — the automatic "shot of the session" form breakdown.
 *
 * WHY this component exists: every deep-analysis surface in the app (Form
 * Studio, Shot Lab) makes the user pick a shot first, so the analysis only
 * ever happens when somebody goes looking for it. The promise here is that the
 * session ENDS and a complete report is already on screen, on a made shot the
 * pipeline can actually read — picked by {@link pickShotOfSession}, never by
 * chance and never by "the last one".
 *
 * WHY the user can still swap: the automatic pick optimises for how much the
 * analysis can measure, which is not always the rep the shooter cares about.
 * So the pick is a DEFAULT, and every other analysable make sits one tap away
 * in the strip. Swapping re-runs the same analysis on the chosen shot — the
 * card never mixes one shot's metrics with another's cues.
 *
 * ┌─ HONESTY (a product requirement here, not a style note) ─────────────────┐
 * │ • Nothing is rendered from an absent measurement. When no made shot can   │
 * │   be analysed the card says which piece was missing, in the picker's own  │
 * │   words — form analysis off, no make, or a pose capture too thin to read. │
 * │ • The one-line verdict is derived from what the engines returned; when    │
 * │   neither the tip engine nor the posture engine flagged anything, it says │
 * │   exactly that instead of inventing a fix.                                │
 * │ • The reference skeleton is SYNTHESIZED from published mechanics, not     │
 * │   motion capture, and the archetype is labelled as MATCHED only when      │
 * │   shotLab actually matched it from the user's own shots.                  │
 * │ • This is 2D pose data. The card never claims a 3D or depth measurement.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * All pose maths is borrowed, never re-implemented: analysability from
 * src/core/shotOfSession.ts, metrics + cue rows from FormReport.tsx, posture
 * cues from src/core/postureFix.ts against src/core/nbaReferenceForms.ts.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FormReportCard } from '@/components/FormReport';
import type { EnteringProp } from '@/components/motion';
import { Card, Chip, EmptyState, Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { posturePlan, type PostureCue } from '@/core/postureFix';
import { matchArchetype } from '@/core/shotLab';
import {
  describeCandidate,
  pickShotOfSession,
  rankMadeShots,
  type ShotPickCandidate,
} from '@/core/shotOfSession';
import type { CoachingTip, ResolvedShot } from '@/core/types';
import { useSettings } from '@/state/settingsStore';
import { haptic } from '@/utils/haptics';

type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * The sentence that must survive any redesign of this card: it is the line
 * between "compared against published mechanics" and an implied capture of a
 * real player's body.
 */
export const SESSION_FORM_REFERENCE_CAPTION =
  'The reference form is synthesized from this player’s published mechanics ' +
  '(release angle, tempo, dip depth, release height) — an idealized coaching ' +
  'illustration, not motion capture. Your side is 2D pose data, so these are ' +
  'angle differences in the camera plane, not a 3D measurement.';

// ---------------------------------------------------------------------------
// Derived copy
// ---------------------------------------------------------------------------

/** The headline cue FormReportCard leads with (severity 3, else the first). */
function headlineTip(tips: readonly CoachingTip[]): CoachingTip | null {
  return tips.find((t) => t.severity === 3) ?? tips[0] ?? null;
}

/**
 * One line the user can act on, built ONLY from what the engines returned.
 *
 * Order matters: the tip engine reads the shot's own measured metrics against
 * their ideal bands, so it outranks the posture engine, which compares the
 * motion to a reference the user never claimed to be copying. With neither
 * saying anything, the honest verdict is that nothing stood out — not a
 * manufactured fix.
 */
export function verdictLine(
  shot: ResolvedShot,
  tips: readonly CoachingTip[],
  cues: readonly PostureCue[],
  isAutoPick: boolean,
): string {
  // "Most analysable make" is a claim about the PICKER's choice — it must not
  // survive onto a shot the user swapped to by hand.
  const lead = isAutoPick
    ? `Shot ${shot.id} is the most analysable make of this session`
    : `Shot ${shot.id}`;
  const tip = headlineTip(tips);
  if (tip != null) {
    return `${lead} — repeat it, and change one thing: ${tip.title.toLowerCase()}.`;
  }
  const cue = cues[0];
  if (cue != null) {
    // Careful wording: an empty tip list means nothing was FLAGGED, which is
    // not the same as "every metric was measured and good".
    return `${lead} — nothing in its measured metrics was flagged; the widest gap against the reference form is your ${cue.joint.toLowerCase()} at the ${cue.phase.toLowerCase()} phase.`;
  }
  return `${lead} — nothing measurable stood out to fix on this rep.`;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function SectionEyebrow({ icon, children }: { icon: IconName; children: string }) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

/**
 * The swap strip. Rendered only when there is something to swap TO, so a
 * single-make session does not show a one-item picker pretending to be a
 * choice.
 */
function AlternativesStrip({
  candidates,
  selectedId,
  onSelect,
}: {
  candidates: readonly ShotPickCandidate[];
  selectedId: number;
  onSelect: (id: number) => void;
}) {
  return (
    <View style={styles.stripWrap}>
      <SectionEyebrow icon="albums-outline">Analyse another make</SectionEyebrow>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {candidates.map((c) => {
          const on = c.shot.id === selectedId;
          return (
            <Pressable
              key={c.shot.id}
              onPress={() => {
                haptic.selection();
                onSelect(c.shot.id);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Analyse shot ${c.shot.id}, ${c.usableFrames} pose frames tracked`}
              style={[styles.pick, on && styles.pickOn]}
            >
              <Text style={[styles.pickText, on && styles.pickTextOn]}>{`Shot ${c.shot.id}`}</Text>
              <Text style={[styles.pickSub, on && styles.pickSubOn]}>
                {`${c.usableFrames} frames`}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function CueItem({ cue, index }: { cue: PostureCue; index: number }) {
  return (
    <View style={[styles.cueItem, index > 0 && styles.cueDivider]}>
      <Row gap={space.sm}>
        <View style={styles.cueBadge}>
          <Text style={styles.cueBadgeText}>{index + 1}</Text>
        </View>
        <Text style={[styles.cueJoint, { flex: 1 }]}>{cue.joint}</Text>
        <View style={styles.cuePhase}>
          <Text style={styles.cuePhaseText}>{cue.phase}</Text>
        </View>
      </Row>
      <Text style={styles.cueText}>{cue.cue}</Text>
      <Row gap={space.xs} style={{ alignItems: 'flex-start' }}>
        <Ionicons
          name="basketball-outline"
          size={13}
          color={color.accent}
          style={{ marginTop: 3 }}
        />
        <Text style={[styles.cueDrill, { flex: 1 }]}>{`Drill: ${cue.drill}`}</Text>
      </Row>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SessionFormReport
// ---------------------------------------------------------------------------

export interface SessionFormReportProps {
  /** Every shot in the session — makes, misses and unsure alike. */
  shots: readonly ResolvedShot[];
  /**
   * Optional entrance for the leading card, so a screen can hand this block
   * one slot of its own useCardStagger ladder.
   */
  entering?: EnteringProp;
}

export function SessionFormReport({ shots, entering }: SessionFormReportProps) {
  const formAnalysisOn = useSettings((s) => s.formAnalysis);

  // The picker is the source of truth for pick / order / reason. The candidate
  // list is taken alongside it because the strip and the analysis need each
  // shot's DECODED sequence and its frame counts, which `ranked` (plain shots)
  // cannot carry. Both calls decode the session's sequences and both are
  // memoized on `shots`, so that cost lands once per change to the shot list,
  // never per render.
  const { pick, ranked, reason } = useMemo(() => pickShotOfSession(shots), [shots]);
  const candidates = useMemo(() => rankMadeShots(shots), [shots]);
  const usableCandidates = useMemo(
    () => candidates.filter((c) => c.usable && ranked.some((r) => r.id === c.shot.id)),
    [candidates, ranked],
  );

  // The pick is only the DEFAULT: a manual choice wins until the session's
  // shots change out from under it (correction, re-check), at which point the
  // automatic pick takes over again rather than pointing at a stale id.
  const [chosenId, setChosenId] = useState<number | null>(null);
  const selected = useMemo<ShotPickCandidate | null>(() => {
    const manual = usableCandidates.find((c) => c.shot.id === chosenId);
    if (manual != null) return manual;
    return usableCandidates.find((c) => c.shot.id === pick?.id) ?? null;
  }, [usableCandidates, chosenId, pick]);

  // Archetype to compare against. matchArchetype refuses without enough
  // measured shots, and that refusal is surfaced rather than hidden behind a
  // default that would read as "we matched you to this player".
  const match = useMemo(() => matchArchetype(shots)[0] ?? null, [shots]);
  const archetype: PlayerArchetype = match?.player ?? PLAYER_ARCHETYPES[0]!;

  const cues = useMemo<PostureCue[]>(() => {
    if (selected == null) return [];
    return posturePlan(selected.sequence, referenceSequence(archetype, selected.hand), selected.hand);
  }, [selected, archetype]);

  // ---- Honest empty states ----------------------------------------------
  // Note the ORDER: a session recorded with form analysis ON still renders its
  // report when the setting is off TODAY (history sessions), so the settings
  // nudge only appears when there is genuinely nothing to show.
  if (selected == null) {
    if (!formAnalysisOn) {
      return (
        <EmptyState
          title="Form analysis is off"
          body={`Shot of the session needs the pose model running while you shoot. Turn on Shooting form analysis in Settings › Coaching, then track a session side-on with your whole body in frame. ${reason}`}
          actionLabel="Open Settings"
          onAction={() => {
            haptic.selection();
            router.push('/settings');
          }}
        />
      );
    }
    // Two remaining shapes of nothing, told apart by cheap facts about the
    // session (no pose maths repeated — the numbers still come from `reason`).
    const madeCount = shots.filter((s) => s.outcome === 'make').length;
    return (
      <EmptyState
        title={madeCount === 0 ? 'No made shot to break down' : 'No usable pose capture'}
        body={reason}
      />
    );
  }

  const report = selected.shot.form;
  if (report == null) {
    // Unreachable by construction (a candidate is only usable when it carried
    // a sequence, which lives inside form) — but rendering a report from an
    // absent one is the exact failure this card exists to avoid.
    return <EmptyState title="No usable pose capture" body={reason} />;
  }

  const isAutoPick = selected.shot.id === pick?.id;
  const whyThis = isAutoPick ? reason : `You chose this one. ${describeCandidate(selected)}`;

  return (
    <View style={styles.stack}>
      <Card entering={entering}>
        <SectionEyebrow icon="ribbon-outline">Shot of the session</SectionEyebrow>
        <Text style={styles.title} accessibilityRole="header">
          {`Shot ${selected.shot.id}`}
        </Text>
        <Text style={styles.verdict}>
          {verdictLine(selected.shot, report.tips, cues, isAutoPick)}
        </Text>
        <Row gap={space.xs} style={styles.chipRow}>
          <Chip label="Made" tone="make" />
          <Chip label={`${selected.usableFrames} pose frames`} />
          <Chip label={`${Math.round(selected.coverage * 100)}% keypoints`} />
        </Row>
        <Text style={styles.why} accessibilityLabel={`Why this shot: ${whyThis}`}>
          {whyThis}
        </Text>
        {usableCandidates.length > 1 && (
          <AlternativesStrip
            candidates={usableCandidates}
            selectedId={selected.shot.id}
            onSelect={setChosenId}
          />
        )}
      </Card>

      {/* Metrics + the "fix this first" callout — the existing per-shot report
          card, reused verbatim so one shot reads identically everywhere. */}
      <FormReportCard report={report} />

      <Card>
        <SectionEyebrow icon="construct-outline">Posture vs the reference</SectionEyebrow>
        <Row gap={space.xs} style={styles.chipRow}>
          <Chip label={archetype.name} tone="accent" />
          <Chip label={archetype.motion} />
        </Row>
        <Text style={styles.matchLine}>
          {match != null
            ? `Matched from your own shots: ${match.similarity}% similar to ${archetype.name}.`
            : `Not enough measured shots to match you to an archetype yet — comparing against ${archetype.name} as a baseline.`}
        </Text>
        {cues.length === 0 ? (
          <Text style={styles.body}>
            {`Your motion tracks the ${archetype.name} reference closely on every angle we could measure — nothing stands out to correct on this rep.`}
          </Text>
        ) : (
          cues.map((cue, i) => <CueItem key={cue.id} cue={cue} index={i} />)
        )}
      </Card>

      <Card>
        <SectionEyebrow icon="copy-outline">{`What to copy from ${archetype.name}`}</SectionEyebrow>
        <Text style={styles.body}>{archetype.mechanics}</Text>
        {archetype.whatToCopy.map((line) => (
          <Row key={line} gap={space.xs} style={styles.copyRow}>
            <Ionicons
              name="checkmark-circle-outline"
              size={14}
              color={color.make}
              style={{ marginTop: 3 }}
            />
            <Text style={[styles.copyText, { flex: 1 }]}>{line}</Text>
          </Row>
        ))}
        {archetype.idiosyncratic.length > 0 && (
          <>
            {/* Literal string, not an HTML entity: RN Text renders raw text. */}
            <Text style={styles.copyEyebrow}>{"DOESN'T TRANSFER"}</Text>
            {archetype.idiosyncratic.map((line) => (
              <Row key={line} gap={space.xs} style={styles.copyRow}>
                <Ionicons
                  name="close-circle-outline"
                  size={14}
                  color={color.textFaint}
                  style={{ marginTop: 3 }}
                />
                <Text style={[styles.copyTextDim, { flex: 1 }]}>{line}</Text>
              </Row>
            ))}
          </>
        )}
        <Text style={styles.caption}>{SESSION_FORM_REFERENCE_CAPTION}</Text>
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  stack: {
    gap: space.md,
  },
  eyebrowRow: {
    marginBottom: space.xs,
  },
  eyebrowText: {
    ...type.micro,
    color: color.accent,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  verdict: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  chipRow: {
    flexWrap: 'wrap',
    marginTop: space.sm,
  },
  why: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  matchLine: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
  },
  stripWrap: {
    marginTop: space.lg,
  },
  strip: {
    flexDirection: 'row',
    gap: space.sm,
    paddingVertical: 2,
  },
  pick: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
  },
  pickOn: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  pickText: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  pickTextOn: {
    color: color.text,
  },
  pickSub: {
    ...type.micro,
    color: color.textFaint,
  },
  pickSubOn: {
    color: color.accent,
  },
  cueItem: {
    marginTop: space.md,
    gap: space.xs,
  },
  cueDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: space.md,
  },
  cueBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentTint,
  },
  cueBadgeText: {
    ...type.micro,
    color: color.accent,
  },
  cueJoint: {
    ...type.bodyMedium,
    color: color.text,
  },
  cuePhase: {
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
  },
  cuePhaseText: {
    ...type.micro,
    color: color.textFaint,
  },
  cueText: {
    ...type.body,
    color: color.textDim,
  },
  cueDrill: {
    ...type.caption,
    color: color.textFaint,
  },
  copyRow: {
    alignItems: 'flex-start',
    marginTop: space.sm,
  },
  copyText: {
    ...type.body,
    color: color.textDim,
  },
  copyTextDim: {
    ...type.caption,
    color: color.textFaint,
  },
  copyEyebrow: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.md,
  },
  caption: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.md,
    lineHeight: 15,
  },
});
