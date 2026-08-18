/**
 * BodyDirectionCard — the product's headline promise on screen:
 * BODY DATA SETS THE STYLE DIRECTION, SHOT DATA SETS THE DISTANCE.
 *
 * WHY this card exists as its own component rather than more coach.tsx:
 * the two halves of the promise fail INDEPENDENTLY (a profile with no logged
 * shots, or a shot log with no measurements), and each failure has to render
 * as an honest partial state rather than a fabricated number. Keeping that
 * branching in one presentational component means the coach tab can mount it
 * unconditionally — including before the user has tracked a single session —
 * without the screen re-deriving what "not enough yet" means.
 *
 * ┌─ HONESTY (this is a product requirement, not a style note) ──────────────┐
 * │ • Confidence is printed VERBATIM from styleDirection().confidence, whose  │
 * │   type is 'low' | 'medium' — there is no 'high', so this card must never  │
 * │   coin one, and must never dress the direction up as a personalised plan. │
 * │ • The DISTANCE band comes only from rangeFromShots() over the user's OWN  │
 * │   logged shots. When the core returns null we say which half is missing;  │
 * │   we never interpolate a band off the body match (that is exactly the     │
 * │   invention the core refuses to make).                                    │
 * │ • Height missing ⇒ no direction at all: the card becomes an invitation to │
 * │   fill in the profile, not a guess from position or experience.           │
 * │ • The caption names the source: a handful of published pro measurements,  │
 * │   hand-labelled — not a model trained on the user.                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The distance half is derived here from the shots the coach tab already
 * loaded (no extra queries): the median of the shots that carry a METRIC
 * distance, and make% per distance band via {@link buildHeatmap}, so the band
 * definition is the same one the heat map and the coach engine already use.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, type ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Chip, PillButton, Row, StatNumber } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import {
  RANGE_MIN_ATTEMPTS,
  bodyPlan,
  type BodyPlan,
} from '@/core/bodyArchetype';
import { buildHeatmap } from '@/core/heatmap';
import type { ResolvedShot } from '@/core/types';
import { ageFromBirthYear, useProfile } from '@/state/profileStore';
import { haptic } from '@/utils/haptics';

type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * One sentence that must survive every redesign: it is the difference between
 * "a direction from published measurements" and an implied personal model.
 */
export const BODY_DIRECTION_CAPTION =
  'A direction, not a diagnosis: your frame is compared against a handful of ' +
  'published pro measurements and a hand-labelled style grid. Nothing here is ' +
  'trained on you, and no camera can tell how you shoot from a body shape.';

/** Shot-side inputs for rangeFromShots, plus the attempt count for the copy. */
export interface ShotRangeInput {
  medianDistanceM: number | null;
  makePctByBand: { band: string; pct: number; attempts: number }[];
}

/** Median of a non-empty numeric list, else null. Pure. */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Derive the DISTANCE-half inputs from the user's own shots.
 *
 * Only shots the pinhole estimator actually ranged carry `distanceM`, so the
 * median is over that subset and is null when no shot was ranged — which is
 * precisely when rangeFromShots refuses, and precisely when this card should
 * say "direction only" instead of printing a number.
 */
export function rangeInputFromShots(shots: readonly ResolvedShot[]): ShotRangeInput {
  const distances: number[] = [];
  for (const s of shots) {
    if (s.outcome !== 'make' && s.outcome !== 'miss') continue; // unsure never counts
    const d = s.distanceM;
    if (d != null && Number.isFinite(d) && d > 0) distances.push(d);
  }

  // Band make% reuses the app-wide near/mid/far split (buildHeatmap) so this
  // card can never disagree with the heat map about where a shot came from.
  const heat = buildHeatmap(shots);
  const tally = new Map<string, { makes: number; attempts: number }>();
  for (const cell of heat.cells) {
    const acc = tally.get(cell.band) ?? { makes: 0, attempts: 0 };
    acc.makes += cell.makes;
    acc.attempts += cell.attempts;
    tally.set(cell.band, acc);
  }
  const makePctByBand = [...tally.entries()]
    .filter(([, v]) => v.attempts > 0)
    .map(([band, v]) => ({ band, pct: (v.makes / v.attempts) * 100, attempts: v.attempts }));

  return { medianDistanceM: medianOf(distances), makePctByBand };
}

/** Total placed, decided attempts behind the band data (for honest copy). */
function attemptsOf(input: ShotRangeInput): number {
  return input.makePctByBand.reduce((n, b) => n + b.attempts, 0);
}

/**
 * Why the distance half is absent, in the user's own numbers. Never a guess at
 * a band — the whole point is that this half stays blank until it is earned.
 */
function distanceGapCopy(input: ShotRangeInput): string {
  const attempts = attemptsOf(input);
  if (input.medianDistanceM == null) {
    return (
      'Distance half: none of your logged shots carry a measured distance yet, ' +
      'so there is no honest practice band to recommend — the direction above ' +
      'stands on its own.'
    );
  }
  return (
    `Distance half: ${attempts} of ${RANGE_MIN_ATTEMPTS} logged attempts so far. ` +
    'Log a few more and this card adds the practice-distance band from your own shots.'
  );
}

/** A directive list (play / avoid), icon + text so it is never colour alone. */
function DirectiveList({
  label,
  items,
  icon,
  tint,
}: {
  label: string;
  items: readonly string[];
  icon: IconName;
  tint: string;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.listBlock}>
      <Text style={styles.listLabel}>{label}</Text>
      {items.map((item, i) => (
        <Row key={i} gap={space.sm} style={styles.listRow}>
          <Ionicons name={icon} size={16} color={tint} style={styles.listIcon} />
          <Text style={styles.listText}>{item}</Text>
        </Row>
      ))}
    </View>
  );
}

/** The earned practice band, or the honest line saying which half is missing. */
function DistanceHalf({ plan, input }: { plan: BodyPlan; input: ShotRangeInput }) {
  if (plan.range == null) {
    return (
      <View style={styles.rangeBlock}>
        <Text style={styles.rangeMissing}>{distanceGapCopy(input)}</Text>
      </View>
    );
  }
  const [lo, hi] = plan.range.recommendedBandM;
  return (
    <View style={styles.rangeBlock}>
      <StatNumber
        value={`${lo}–${hi} m`}
        label="practice band (your shots)"
        size="medium"
        tint={color.accent}
      />
      <Text style={styles.rangeRationale}>{plan.range.rationale}</Text>
    </View>
  );
}

export interface BodyDirectionCardProps {
  /** Shots the screen already loaded — the DISTANCE half is derived from these. */
  shots: readonly ResolvedShot[];
  entering?: ComponentProps<typeof Card>['entering'];
}

export function BodyDirectionCard({ shots, entering }: BodyDirectionCardProps) {
  const heightCm = useProfile((s) => s.heightCm);
  const wingspanCm = useProfile((s) => s.wingspanCm);
  const weightKg = useProfile((s) => s.weightKg);
  const birthYear = useProfile((s) => s.birthYear);

  const rangeInput = useMemo(() => rangeInputFromShots(shots), [shots]);
  const plan = useMemo(
    () =>
      bodyPlan(
        { heightCm, wingspanCm, weightKg, ageYears: ageFromBirthYear(birthYear) },
        rangeInput,
      ),
    [heightCm, wingspanCm, weightKg, birthYear, rangeInput],
  );

  const openProfile = () => {
    haptic.selection();
    router.push('/profile');
  };

  // No usable height ⇒ the core refuses a direction. Invite, never guess.
  if (plan.direction == null) {
    return (
      <Card entering={entering}>
        <SectionEyebrow icon="body-outline" style={styles.eyebrow}>
          Body sets the direction
        </SectionEyebrow>
        <Text style={styles.inviteTitle} accessibilityRole="header">
          Add your height to unlock your play-style direction
        </Text>
        <Text style={styles.body}>
          Your height and wingspan decide which shots your frame actually supports — the camera
          cannot read that, so it comes from your profile. Both stay on this phone.
        </Text>
        <Text style={styles.summary}>{plan.summary}</Text>
        {plan.range != null && <DistanceHalf plan={plan} input={rangeInput} />}
        <PillButton
          label="Add height & wingspan"
          icon="body-outline"
          variant="ghost"
          onPress={openProfile}
          style={styles.inviteBtn}
        />
        <Text style={styles.caption}>{BODY_DIRECTION_CAPTION}</Text>
      </Card>
    );
  }

  const d = plan.direction;
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="body-outline" style={styles.eyebrow}>
        Body sets the direction
      </SectionEyebrow>

      <Row style={styles.head} gap={space.md}>
        <View style={styles.headText}>
          <Text style={styles.label} numberOfLines={2}>
            {d.label}
          </Text>
          <Text style={styles.archetype}>Closest measured frame: {d.archetype}</Text>
        </View>
        {/* Verbatim from the core: 'low' | 'medium' — never a word of our own. */}
        <Chip
          label={`${d.confidence} confidence`}
          tone={d.confidence === 'medium' ? 'accent' : 'default'}
        />
      </Row>

      <Text style={styles.body}>{d.blurb}</Text>

      <DirectiveList label="PLAY TO THIS" items={d.play} icon="checkmark-circle" tint={color.make} />
      <DirectiveList label="DON'T CHASE" items={d.avoid} icon="close-circle" tint={color.miss} />

      <DistanceHalf plan={plan} input={rangeInput} />

      <Text style={styles.summary}>{plan.summary}</Text>
      <Text style={styles.caption}>{BODY_DIRECTION_CAPTION}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },
  head: {
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  headText: {
    flex: 1,
  },
  label: {
    ...type.heading,
    color: color.text,
  },
  archetype: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.xs,
  },
  inviteTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.sm,
  },
  inviteBtn: {
    marginTop: space.lg,
  },
  body: {
    ...type.body,
    color: color.textDim,
  },
  listBlock: {
    marginTop: space.lg,
  },
  listLabel: {
    ...type.micro,
    color: color.textFaint,
    marginBottom: space.sm,
  },
  listRow: {
    alignItems: 'flex-start',
    marginBottom: space.sm,
  },
  listIcon: {
    marginTop: 2,
  },
  listText: {
    ...type.body,
    color: color.textDim,
    flex: 1,
  },
  rangeBlock: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  rangeRationale: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.sm,
  },
  rangeMissing: {
    ...type.caption,
    color: color.textDim,
  },
  summary: {
    ...type.body,
    color: color.text,
    marginTop: space.lg,
  },
  caption: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.md,
  },
});
