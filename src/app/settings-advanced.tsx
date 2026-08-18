/**
 * Advanced detection & diagnostics — the Debug-gated detector internals,
 * pushed from Settings > Detection ("Advanced detection & diagnostics" row).
 *
 * WHY A SEPARATE SCREEN: the Detection card had grown a 14-toggle debug block
 * that buried the two make-suppressing guards ordinary users DO need (those
 * stay on the main Settings page — see the comment there). Everything here is
 * store-backed and reversible; the row that pushes here only renders while
 * Debug mode is on, and this screen keeps its BackPill because it is pushed
 * over the tab bar — it is not a tab root.
 *
 * The row components (ToggleRow / SelectChip / OptionRow / ActionRow) mirror
 * settings.tsx. Route files export only their route (repo convention), and
 * ui.tsx is read-only, so the mirrors live here rather than being imported
 * from a sibling route.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { BackPill } from '@/components/ShotList';
import { ScreenHeader, SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Row, Screen } from '@/components/ui';
import { color, iconSize, layout, radius, space, touch, type } from '@/constants/tokens';
import {
  HARD_EXAMPLE_EXPORT_LIMIT,
  countHardExamples,
  exportHardExamples,
} from '@/data/hardExamples';
import { useCardStagger } from '@/components/motion';
import { haptic } from '@/utils/haptics';
import { useSettings, type DetectionRate } from '@/state/settingsStore';

const DETECTION_RATE_OPTIONS: { value: DetectionRate; label: string; blurb: string }[] = [
  { value: 'auto', label: 'Auto · recommended', blurb: 'Smooth tracking on every supported phone.' },
  { value: 'battery', label: 'Battery saver', blurb: 'Cooler phone, longer sessions.' },
  { value: 'max', label: 'Maximum', blurb: 'Newest phones only.' },
];

/** Selection tick — the haptic util gates on the user's Haptics setting. */
function tick() {
  haptic.selection();
}

/** Human copy for the measured device tier, from the last on-device benchmark. */
function benchmarkSummary(bench: { delegate: string; ms: number } | null): string {
  if (bench == null) return 'Run a session once to benchmark this phone.';
  const tier = bench.ms <= AUTO_PRECISE_MAX_MS ? 'Precise recommended' : 'Standard recommended';
  return `Your phone: ${bench.delegate} · ${bench.ms}ms — ${tier}`;
}

/** Mirrors AUTO_PRECISE_MAX_MS in src/camera/useShotEngine.ts (auto step-down budget). */
const AUTO_PRECISE_MAX_MS = 55;

/** Ionicons glyph name — section eyebrows, chip checks, chevrons. */
type IconName = ComponentProps<typeof Ionicons>['name'];

function ToggleRow({
  label,
  description,
  detail,
  value,
  disabled,
  experimental,
  onValueChange,
}: {
  label: string;
  /** ONE honest sentence — the full story lives behind `detail`. */
  description?: string;
  /** Collapsed long-form copy behind a "More" disclosure. Never deleted. */
  detail?: string;
  value: boolean;
  disabled?: boolean;
  /** Renders a flask badge so pre-release features read as a class. */
  experimental?: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Row style={[styles.settingRow, disabled === true && styles.disabled]} gap={space.lg}>
      <View style={styles.settingText}>
        <View style={styles.labelRow}>
          <Text style={styles.settingLabel}>{label}</Text>
          {experimental === true && (
            <View style={styles.flaskBadge}>
              <Ionicons name="flask" size={10} color={color.unsure} />
              <Text style={styles.flaskBadgeLabel}>Experimental</Text>
            </View>
          )}
        </View>
        {description != null && <Text style={styles.settingDesc}>{description}</Text>}
        {detail != null && (
          <>
            {expanded && <Text style={styles.settingDesc}>{detail}</Text>}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? `Less about ${label}` : `More about ${label}`}
              accessibilityState={{ expanded }}
              hitSlop={space.sm}
              onPress={() => setExpanded((v) => !v)}
            >
              <Text style={styles.moreLink}>{expanded ? 'Less' : 'More'}</Text>
            </Pressable>
          </>
        )}
      </View>
      <Switch
        accessibilityLabel={experimental === true ? `${label} (experimental)` : label}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled === true}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: color.border, true: color.accent }}
        thumbColor={color.text}
        ios_backgroundColor={color.border}
      />
    </Row>
  );
}

/** Short single-choice chip (mirrors settings.tsx SelectChip). */
function SelectChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.selectChip,
        selected && styles.selectChipSelected,
        pressed && !selected && styles.selectChipPressed,
        pressed && selected && { opacity: 0.82 },
      ]}
    >
      {selected && <Ionicons name="checkmark" size={iconSize.sm} color={color.accent} />}
      <Text style={[styles.selectChipLabel, selected && styles.selectChipLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Radio row with a one-line blurb per choice (mirrors settings.tsx OptionRow). */
function OptionRow({
  label,
  blurb,
  selected,
  onPress,
}: {
  label: string;
  blurb: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={blurb}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && { backgroundColor: color.surfaceRaised },
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{blurb}</Text>
      </View>
      <View style={[styles.radioOuter, selected && { borderColor: color.accent }]}>
        {selected && <View style={styles.radioInner} />}
      </View>
    </Pressable>
  );
}

/** Tappable row for a one-shot action (mirrors settings.tsx ActionRow). */
function ActionRow({
  label,
  description,
  disabled,
  onPress,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled === true}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && { backgroundColor: color.surfaceRaised },
        disabled === true && styles.disabled,
      ]}
    >
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDesc}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={iconSize.lg} color={color.textFaint} />
    </Pressable>
  );
}

/** Card section header — accent eyebrow with a leading glyph. */
function SectionHeaderRow({ icon, children }: { icon: IconName; children: string }) {
  return <SectionEyebrow icon={icon} style={styles.sectionEyebrow}>{children}</SectionEyebrow>;
}

export default function SettingsAdvancedScreen() {
  const detectorModel = useSettings((s) => s.detectorModel);
  const detectionRate = useSettings((s) => s.detectionRate);
  const perfMode = useSettings((s) => s.perfMode);
  const detectorEngine = useSettings((s) => s.detectorEngine);
  const detectorAccel = useSettings((s) => s.detectorAccel);
  const lastBenchmark = useSettings((s) => s.lastBenchmark);
  const roiZoom = useSettings((s) => s.roiZoom);
  const depthVeto = useSettings((s) => s.depthVeto);
  const reappearance = useSettings((s) => s.reappearance);
  const motionAssist = useSettings((s) => s.motionAssist);
  const metric23 = useSettings((s) => s.metric23);
  const nanoV2 = useSettings((s) => s.nanoV2);
  const useFlightArc = useSettings((s) => s.useFlightArc);
  const multiBallGuard = useSettings((s) => s.multiBallGuard);
  const rimGuard = useSettings((s) => s.rimGuard);
  const trackerRescue = useSettings((s) => s.trackerRescue);
  const adaptiveThermal = useSettings((s) => s.adaptiveThermal);
  const lensCheck = useSettings((s) => s.lensCheck);
  const set = useSettings((s) => s.set);

  // Staggered card entrance — the same choreography as the main Settings page.
  const enter = useCardStagger();

  // Correction flywheel ("Improve detection" block): live count of exportable
  // hard examples + a transient caption when an export can't run.
  const [hardExampleCount, setHardExampleCount] = useState<number | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const exportNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Count once on mount — corrections happen on other screens, so the number
  // is stable while this screen is open.
  useEffect(() => {
    let alive = true;
    void countHardExamples().then((n) => {
      if (alive) setHardExampleCount(n);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Clear the pending notice timer on unmount.
  useEffect(
    () => () => {
      if (exportNoticeTimer.current != null) clearTimeout(exportNoticeTimer.current);
    },
    [],
  );

  const runHardExampleExport = async () => {
    tick();
    const result = await exportHardExamples();
    if (!result.ok && result.count > 0) {
      // Collected fine but the share sheet never opened — worth a caption.
      // (ok:false with count 0 can't happen here; the row is disabled at 0.)
      setExportNotice("Couldn't open the share sheet — try again.");
      if (exportNoticeTimer.current != null) clearTimeout(exportNoticeTimer.current);
      exportNoticeTimer.current = setTimeout(() => setExportNotice(null), 3000);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>
        <ScreenHeader
          title="Advanced detection"
          lede="Benchmark, detector internals and diagnostics. Defaults are tuned for your phone — change one thing at a time."
        />

        {/* Model & engine */}
        <Card entering={enter(0)}>
          <SectionHeaderRow icon="hardware-chip">Model & engine</SectionHeaderRow>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Device benchmark</Text>
            <Text style={styles.settingDesc}>{benchmarkSummary(lastBenchmark)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detector model</Text>
            <Text style={styles.settingDesc}>
              Auto measures your phone at start and picks the best fit —
              precise on recent phones, standard on older ones. You can also
              pin one manually.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="Auto · recommended"
              selected={detectorModel === 'auto'}
              onPress={() => {
                tick();
                set('detectorModel', 'auto');
              }}
            />
            <SelectChip
              label="Standard · fast"
              selected={detectorModel === 'standard'}
              onPress={() => {
                tick();
                set('detectorModel', 'standard');
              }}
            />
            <SelectChip
              label="Precise · accurate"
              selected={detectorModel === 'precise'}
              onPress={() => {
                tick();
                set('detectorModel', 'precise');
              }}
            />
          </View>
          <Text style={styles.tierCaption}>
            Standard: every iPhone since XR · Precise: iPhone 13 and newer recommended.
          </Text>
          <Text style={styles.tierCaption}>
            These Standard/Precise tiers apply only to the YOLO11 fallback below.
          </Text>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detector engine</Text>
            <Text style={styles.settingDesc}>
              YOLOX is the default — an Apache-licensed detector the iPhone GPU
              runs directly for faster, steadier boxes and a clean licence. YOLO11
              is the older fallback (and the Detector model / Performance settings
              apply to it). Switch anytime.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="YOLOX · default"
              selected={detectorEngine === 'yolox'}
              onPress={() => {
                tick();
                set('detectorEngine', 'yolox');
              }}
            />
            <SelectChip
              label="YOLO11 · fallback"
              selected={detectorEngine === 'yolo'}
              onPress={() => {
                tick();
                set('detectorEngine', 'yolo');
              }}
            />
          </View>
          {detectorEngine === 'yolox' && (
            <>
              <View style={styles.divider} />
              <View style={styles.settingText}>
                <Text style={styles.settingLabel}>YOLOX accelerator</Text>
                <Text style={styles.settingDesc}>
                  CPU is the most accurate (it's what the Test AI screen uses) and
                  runs YOLOX in real time on most phones. GPU is faster but can make
                  the boxes less accurate on some devices. If live tracking looks
                  worse than Test AI, use CPU; if it feels laggy, try GPU. The
                  debug overlay shows the live fps during a session.
                </Text>
              </View>
              <View style={styles.chipWrap}>
                <SelectChip
                  label="CPU · accurate"
                  selected={detectorAccel === 'cpu'}
                  onPress={() => {
                    tick();
                    set('detectorAccel', 'cpu');
                  }}
                />
                <SelectChip
                  label="GPU · faster"
                  selected={detectorAccel === 'gpu'}
                  onPress={() => {
                    tick();
                    set('detectorAccel', 'gpu');
                  }}
                />
              </View>
            </>
          )}
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Performance</Text>
            <Text style={styles.settingDesc}>
              Input resolution — the biggest accuracy/speed lever. Quality feeds
              the detector a larger image so the small, fast BALL is seen in ~2×
              more frames (YOLOX 640) — best for tracking the ball, but slower.
              Speed is lighter and faster (YOLOX 416) with a hit on a tiny/far
              ball. If the ball keeps getting missed, use Quality.
            </Text>
          </View>
          <View style={styles.chipWrap}>
            <SelectChip
              label="Quality · best ball"
              selected={perfMode === 'quality'}
              onPress={() => {
                tick();
                set('perfMode', 'quality');
              }}
            />
            <SelectChip
              label="Speed · faster"
              selected={perfMode === 'speed'}
              onPress={() => {
                tick();
                set('perfMode', 'speed');
              }}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Detection rate</Text>
            <Text style={styles.settingDesc}>
              How often each camera frame is analyzed. Lower rates save battery.
            </Text>
          </View>
          {DETECTION_RATE_OPTIONS.map((opt, i) => (
            <View key={opt.value}>
              {i > 0 && <View style={styles.divider} />}
              <OptionRow
                label={opt.label}
                blurb={opt.blurb}
                selected={detectionRate === opt.value}
                onPress={() => {
                  tick();
                  set('detectionRate', opt.value);
                }}
              />
            </View>
          ))}
        </Card>

        {/* Tracking & rescue */}
        <Card entering={enter(1)}>
          <SectionHeaderRow icon="analytics">Tracking & rescue</SectionHeaderRow>
          <ToggleRow
            label="Full-flight tracking"
            description="Tracks the ball across its WHOLE flight with one fitted parabola — it only recovers real detections and can't invent a make."
            detail="Fits one parabola over the WHOLE shot so the ball keeps being tracked across its entire flight — from the release, under the basket, all the way to the rim — not just near the hoop. On by default; it only recovers real ball detections along the physics path and can't invent a make. Turn off only if a specific phone misbehaves."
            value={useFlightArc}
            onValueChange={(v) => {
              tick();
              set('useFlightArc', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="nano-v2 detector"
            experimental
            description="A noisier small-ball model for the Nano rung — finds the ball in more frames but can flash phantom boxes, so it runs a higher confidence bar."
            detail="An aggressive small-ball model for the fast (Nano) rung. Finds a small or fast ball in more frames, but is noisier — it can flash phantom boxes on ceiling lights, rafters or a background hoop, so it runs with a higher confidence bar to hold those back. OFF uses the cleaner conservative model. Only affects the Nano rung (slow phones / Speed); the Tiny model is unchanged. Reloads the detector when toggled."
            value={nanoV2}
            onValueChange={(v) => {
              tick();
              set('nanoV2', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Metric 2/3 distance"
            experimental
            description="Uses the rim's real size (0.45m) and height (3.05m) as a ruler to compute your TRUE shooting distance in meters for the 2/3-point call, instead of the rough on-screen estimate. Falls back automatically when the camera angle can't support it. A successful FT-line calibration on the live screen switches this path on for that session even with this toggle off."
            value={metric23}
            onValueChange={(v) => {
              tick();
              set('metric23', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Parallax guard (optical-illusion)"
            description="Uses your ball's real size vs the rim's to catch a ball that crosses the rim line while flying IN FRONT of (or behind) the hoop — the airball that 'looks like it went in' — instead of counting it as a make. Veto-only: it can cancel a fake make, never invent one, and stays silent beyond its verified range (~1m separation up to ~6m; needs the right Ball size set in Player). ON by default; when it overturns a shot the receipt shows an 'IN FRONT' tag. Takes effect at the next rim lock."
            value={depthVeto}
            onValueChange={(v) => {
              tick();
              set('depthVeto', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Ghost-swish rescue"
            description="When the ball disappears into the net and reappears below the rim on the same flight path, count the make it implies — but only when the net motion or the in-basket detector agrees, so it can never invent a make. Recovers clean swishes the net swallows. ON by default; hardened against rim-bounces and putback fakes."
            value={reappearance}
            onValueChange={(v) => {
              tick();
              set('reappearance', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Rim zoom"
            experimental
            description="When the ball is missed near the basket, re-run the detector on a magnified crop of the rim to recover it at the make/miss moment. Self-limiting — only fires during a shot, only when needed, and only on phones fast enough. Watch the 'roi zoom' row in the debug overlay to see it working."
            value={roiZoom}
            onValueChange={(v) => {
              tick();
              set('roiZoom', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Motion assist"
            experimental
            description="When the detector loses the ball mid-flight, use frame-to-frame motion to keep following the strongest mover. Can mistake other movement for the ball — leave off unless testing."
            value={motionAssist}
            onValueChange={(v) => {
              tick();
              set('motionAssist', v);
            }}
          />
        </Card>

        {/* Detection guards — suppression/advisory-only safety nets. None of
            them can ever create a make call; each toggle is an escape hatch.
            The two MAKE-SUPPRESSING guards (rattle-out, late bounce-out) stay
            on the main Settings page on purpose — see the comment there. */}
        <Card entering={enter(2)}>
          <SectionHeaderRow icon="shield-checkmark">Detection guards</SectionHeaderRow>
          <ToggleRow
            label="Multi-ball guard"
            description="Pause new shot detection while several balls are in the air. Prevents false calls during warmups."
            value={multiBallGuard}
            onValueChange={(v) => {
              tick();
              set('multiBallGuard', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Rim bump guard"
            description="Re-settle the rim quickly after camera bumps and hold judgment while the rim is uncertain."
            value={rimGuard}
            onValueChange={(v) => {
              tick();
              set('rimGuard', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Track rescue"
            description="Recovers a ball the detector keeps seeing but the tracker won’t start on (raised-gate models only). Detection-side only — never changes make/miss judging."
            value={trackerRescue}
            onValueChange={(v) => {
              tick();
              set('trackerRescue', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Thermal auto-throttle"
            description="Ease off detection when the phone runs hot, instead of stuttering."
            value={adaptiveThermal}
            onValueChange={(v) => {
              tick();
              set('adaptiveThermal', v);
            }}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Lens check"
            description="Warn before a session if glare or a smudged lens may hurt tracking."
            value={lensCheck}
            onValueChange={(v) => {
              tick();
              set('lensCheck', v);
            }}
          />
        </Card>

        {/* Correction flywheel — fully manual, opt-in, one tap. */}
        <Card entering={enter(3)}>
          <SectionHeaderRow icon="trending-up">Improve detection</SectionHeaderRow>
          <View style={styles.settingText}>
            <Text style={styles.settingDesc}>
              Export a manifest of your corrected and unsure shots — the exact
              clips the AI got wrong — to help train better models. Video stays
              on your phone; the export is a text manifest.
            </Text>
          </View>
          <ActionRow
            // Displayed count is capped at the export limit — advertising an
            // uncapped total the export would then silently truncate reads
            // as a bug to the user doing us the favor.
            label={`Export hard examples (${Math.min(
              hardExampleCount ?? 0,
              HARD_EXAMPLE_EXPORT_LIMIT,
            )} available)`}
            description="Opens the share sheet with a JSON manifest of shot timings. No video is attached or uploaded."
            disabled={hardExampleCount == null || hardExampleCount === 0}
            onPress={() => void runHardExampleExport()}
          />
          {exportNotice != null && <Text style={styles.exportNotice}>{exportNotice}</Text>}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  header: {
    marginBottom: space.sm,
  },
  sectionEyebrow: {
    marginBottom: space.sm,
  },
  settingRow: {
    minHeight: touch.minTarget,
    justifyContent: 'space-between',
  },
  settingText: {
    flex: 1,
    gap: space.xs,
    paddingVertical: space.xs,
  },
  settingLabel: {
    ...type.heading,
    color: color.text,
  },
  settingDesc: {
    ...type.body,
    color: color.textDim,
  },
  /** The "More"/"Less" disclosure under a compressed toggle description. */
  moreLink: {
    ...type.bodyMedium,
    color: color.accent,
  },
  tierCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  flaskBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: color.unsureTint,
  },
  flaskBadgeLabel: {
    ...type.micro,
    color: color.unsure,
    textTransform: 'uppercase',
  },
  /** Transient failure caption under the hard-example export row. */
  exportNotice: {
    ...type.caption,
    color: color.unsure,
    marginTop: space.sm,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.md,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  selectChip: {
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  selectChipSelected: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  selectChipPressed: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.textFaint,
  },
  selectChipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  selectChipLabelSelected: {
    color: color.accent,
  },
  optionRow: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.sm,
    // Inset the pressed wash so it clears the card edge without moving text.
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  disabled: {
    opacity: 0.4,
  },
});
