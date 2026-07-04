/**
 * Analyze — run the detector over a clean video from the user's library.
 *
 * This is the VERIFICATION screen: no camera, no screen-filming, no live
 * pipeline. The user picks a clip they already trust, we sample ~30 evenly
 * spaced frames, feed each one through the EXACT same preprocessing + model
 * the live path uses (see src/camera/detectImage.ts), and draw the resulting
 * boxes back over the frame. If the detector really works on real footage,
 * you see the ball/rim boxes track here — proof the model is doing something,
 * decoupled from all the live camera/tracking machinery.
 *
 * Pipeline: pick (expo-image-picker) → sample (expo-video-thumbnails) →
 * detect (detectImageToBoxes, JS thread) → scrub + overlay.
 *
 * The frame image is shown CENTER-CROPPED to a square to match the model's
 * input geometry (detectImageToBoxes center-crops to a square then resizes to
 * 640), so a box at normalized (x,y,w,h) maps to on-screen pixels by a plain
 * multiply against the square's rendered side length.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { ErrorBoundary } from '../../components/ErrorBoundary';
import { BackPill } from '../../components/ShotList';
import { Card, Eyebrow, EmptyState, PillButton, Row, Screen } from '../../components/ui';
import { color, radius, space, touch, type } from '../../constants/tokens';
import {
  loadDetector,
  detectImageToBoxes,
  type DetBox,
} from '../../camera/detectImage';
import type { TensorflowModel } from 'react-native-fast-tflite';

/** Target number of frames sampled across the whole clip. */
const TARGET_FRAMES = 30;
/**
 * Fallback clip length (ms) when the picker doesn't report a duration. Assets
 * from some Android content providers come back with duration null/0; we still
 * want to sample *something*, so spread frames across a nominal 10 s window.
 */
const FALLBACK_DURATION_MS = 10_000;
/** Thumbnail JPEG quality — we only feed these to the model + a small preview. */
const THUMB_QUALITY = 0.7;

/** Per-class overlay colors (spec): ball=accent, rim=make, in-basket=3pt, person=info. */
const CLASS_COLOR: Record<DetBox['cls'], string> = {
  ball: color.accent,
  rim: color.make,
  ball_in_basket: color.threePt,
  person: color.info,
};

const CLASS_LABEL: Record<DetBox['cls'], string> = {
  ball: 'BALL',
  rim: 'RIM',
  ball_in_basket: 'IN BASKET',
  person: 'PERSON',
};

/** One sampled frame + whatever the detector found on it. */
interface FrameResult {
  uri: string;
  /** Frame timestamp in the clip, ms (for the scrubber caption). */
  timeMs: number;
  boxes: DetBox[];
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'sampling'; done: number; total: number }
  | { kind: 'detecting'; done: number; total: number }
  | { kind: 'done'; frames: FrameResult[] }
  | { kind: 'error'; message: string };

/**
 * Wrapped in its own {@link ErrorBoundary} (mirrors src/app/session/live.tsx):
 * frame decode, Skia/native image work and the tflite delegate can all throw
 * on device, and a crash here should show a local recovery card rather than
 * unwinding the whole nav tree. The root boundary still catches anything that
 * escapes.
 */
export default function AnalyzeScreenBoundary() {
  return (
    <ErrorBoundary>
      <AnalyzeScreen />
    </ErrorBoundary>
  );
}

function AnalyzeScreen() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [index, setIndex] = useState(0);

  // The detector is loaded once and reused across every analysis run. It's held
  // in a ref (loading is a side effect, not render state) with an in-flight
  // guard so overlapping picks don't spawn two loads.
  const modelRef = useRef<TensorflowModel | null>(null);
  const modelLoadRef = useRef<Promise<TensorflowModel | null> | null>(null);
  // Bumped on every new pick so a slow previous run can detect it's stale and
  // stop writing progress/results over the newer one.
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ensureModel = useCallback(async (): Promise<TensorflowModel | null> => {
    if (modelRef.current != null) return modelRef.current;
    if (modelLoadRef.current == null) {
      modelLoadRef.current = loadDetector();
    }
    const m = await modelLoadRef.current;
    modelRef.current = m;
    return m;
  }, []);

  const runAnalysis = useCallback(
    async (videoUri: string, durationMs: number) => {
      const runId = ++runIdRef.current;
      const isStale = () => runId !== runIdRef.current || !mountedRef.current;

      // Guard: a 0/negative/NaN duration would collapse every sample to t=0.
      const clipMs =
        Number.isFinite(durationMs) && durationMs > 0 ? durationMs : FALLBACK_DURATION_MS;

      // Space frames evenly. Nudge off the exact endpoints (0 and duration) —
      // the very first/last frame of a clip is often black or a decode edge
      // case on some codecs. Sampling at (i + 0.5)/N keeps them interior.
      const total = TARGET_FRAMES;
      const times: number[] = [];
      for (let i = 0; i < total; i++) {
        times.push(Math.min(clipMs - 1, Math.round(((i + 0.5) / total) * clipMs)));
      }

      // --- Phase 1: sample frames -------------------------------------------
      setPhase({ kind: 'sampling', done: 0, total });
      const frames: FrameResult[] = [];
      for (let i = 0; i < times.length; i++) {
        if (isStale()) return;
        try {
          const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, {
            time: times[i]!,
            quality: THUMB_QUALITY,
          });
          frames.push({ uri: thumb.uri, timeMs: times[i]!, boxes: [] });
        } catch {
          // A single unreadable timestamp shouldn't sink the whole run — skip it.
        }
        if (isStale()) return;
        setPhase({ kind: 'sampling', done: i + 1, total });
      }

      if (frames.length === 0) {
        setPhase({
          kind: 'error',
          message: "Couldn't read any frames from this video. Try a different clip.",
        });
        return;
      }

      // --- Phase 2: load model + detect -------------------------------------
      setPhase({ kind: 'detecting', done: 0, total: frames.length });
      let model: TensorflowModel | null;
      try {
        model = await ensureModel();
      } catch {
        model = null;
      }
      if (isStale()) return;
      if (model == null) {
        setPhase({
          kind: 'error',
          message:
            "The detection model couldn't be loaded on this device. It needs a development or production build (it can't run in Expo Go).",
        });
        return;
      }

      for (let i = 0; i < frames.length; i++) {
        if (isStale()) return;
        try {
          frames[i]!.boxes = await detectImageToBoxes(frames[i]!.uri, model);
        } catch {
          // Leave this frame's boxes empty; a decode/inference hiccup on one
          // frame shouldn't abort verification of the rest.
          frames[i]!.boxes = [];
        }
        if (isStale()) return;
        setPhase({ kind: 'detecting', done: i + 1, total: frames.length });
      }

      if (isStale()) return;
      setIndex(0);
      setPhase({ kind: 'done', frames });
    },
    [ensureModel],
  );

  const pick = useCallback(async () => {
    // Media-library permission (iOS/Android). Best-effort: on some Android
    // setups the system photo picker needs no grant, so a denied status still
    // lets launchImageLibraryAsync fall back to the OS picker — we try anyway.
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== ImagePicker.PermissionStatus.GRANTED && perm.canAskAgain === false) {
        // Hard-denied: still attempt the picker (system picker may not need it),
        // but don't block here.
      }
    } catch {
      // Permission API unavailable — proceed to the picker regardless.
    }

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        // SDK 57: string-array media types. 'videos' selects video assets.
        mediaTypes: ['videos'],
        allowsMultipleSelection: false,
        quality: 1,
      });
    } catch {
      setPhase({
        kind: 'error',
        message: "Couldn't open your video library. Check the app's Photos permission and try again.",
      });
      return;
    }

    if (result.canceled || result.assets == null || result.assets.length === 0) return;
    const asset = result.assets[0]!;
    void runAnalysis(asset.uri, asset.duration ?? 0);
  }, [runAnalysis]);

  // ----- Render by phase ----------------------------------------------------

  if (phase.kind === 'done') {
    return (
      <ResultsView
        frames={phase.frames}
        index={index}
        onIndexChange={setIndex}
        onPickAnother={() => void pick()}
      />
    );
  }

  return (
    <Screen scroll>
      <Row style={styles.backRow}>
        <BackPill />
      </Row>
      <Eyebrow>Verify detection</Eyebrow>
      <Text style={styles.title}>Test the detector on a clip</Text>
      <Text style={styles.lede}>
        Pick a basketball video from your library. We sample {TARGET_FRAMES} frames across it and
        run the on-device detector on each — clean input, no camera, no filming the screen. You see
        exactly what the model finds.
      </Text>

      <Card style={styles.card}>
        <Text style={styles.cardHeading}>How it reads</Text>
        <Row style={styles.legendWrap}>
          {(Object.keys(CLASS_COLOR) as DetBox['cls'][]).map((cls) => (
            <Row key={cls} gap={space.sm} style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: CLASS_COLOR[cls] }]} />
              <Text style={styles.legendLabel}>{CLASS_LABEL[cls]}</Text>
            </Row>
          ))}
        </Row>
      </Card>

      {phase.kind === 'error' && (
        <View style={styles.card}>
          <EmptyState
            title="Analysis stopped"
            body={phase.message}
            actionLabel="Try another video"
            onAction={() => void pick()}
          />
        </View>
      )}

      {(phase.kind === 'sampling' || phase.kind === 'detecting') && (
        <Card style={styles.card}>
          <Row gap={space.md}>
            <ActivityIndicator color={color.accent} />
            <View style={styles.progressBody}>
              <Text style={styles.progressLabel}>
                {phase.kind === 'sampling' ? 'Sampling frames' : 'Analyzing frames'}
              </Text>
              <Text
                style={styles.progressCount}
                accessibilityLiveRegion="polite"
                accessibilityLabel={`${phase.kind === 'sampling' ? 'Sampling' : 'Analyzing'} frame ${phase.done} of ${phase.total}`}
              >
                {phase.done}/{phase.total}
              </Text>
            </View>
          </Row>
          <ProgressBar value={phase.done} max={phase.total} />
        </Card>
      )}

      {phase.kind !== 'sampling' && phase.kind !== 'detecting' && (
        <PillButton label="Pick a video" onPress={() => void pick()} style={styles.cta} />
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Results — square frame preview with overlaid boxes + a scrubber.
// ---------------------------------------------------------------------------

function ResultsView({
  frames,
  index,
  onIndexChange,
  onPickAnother,
}: {
  frames: FrameResult[];
  index: number;
  onIndexChange: (i: number) => void;
  onPickAnother: () => void;
}) {
  const { width } = useWindowDimensions();
  // The square preview: full content width, capped so it never dominates a
  // tablet / landscape viewport.
  const squareSize = Math.min(width - space.lg * 2, 520);

  const n = frames.length;
  const safeIndex = Math.max(0, Math.min(index, n - 1));
  const current = frames[safeIndex]!;

  // Header stats: how many frames each key class appeared in.
  const stats = useMemo(() => {
    let ball = 0;
    let rim = 0;
    for (const f of frames) {
      if (f.boxes.some((b) => b.cls === 'ball' || b.cls === 'ball_in_basket')) ball++;
      if (f.boxes.some((b) => b.cls === 'rim')) rim++;
    }
    return { ball, rim };
  }, [frames]);

  return (
    <Screen scroll>
      <Row style={styles.backRow}>
        <BackPill />
      </Row>
      <Eyebrow>Detection results</Eyebrow>
      <Text style={styles.title}>What the model found</Text>

      {/* Header stats */}
      <Row style={styles.statRow} gap={space.sm}>
        <StatPill label="BALL" value={`${stats.ball}/${n}`} tint={color.accent} />
        <StatPill label="RIM" value={`${stats.rim}/${n}`} tint={color.make} />
      </Row>

      {/* Square preview + overlay */}
      <View style={[styles.previewWrap, { width: squareSize, height: squareSize }]}>
        <FramePreview
          key={current.uri}
          uri={current.uri}
          boxes={current.boxes}
          size={squareSize}
        />
      </View>

      {/* Per-frame caption */}
      <Row style={styles.frameCaption} gap={space.sm}>
        <Text style={styles.frameIndex}>
          Frame {safeIndex + 1} / {n}
        </Text>
        <Text style={styles.frameTime}>{formatMs(current.timeMs)}</Text>
        <View style={styles.frameCaptionSpacer} />
        <Text style={styles.frameHits}>
          {current.boxes.length === 0
            ? 'no detections'
            : `${current.boxes.length} box${current.boxes.length === 1 ? '' : 'es'}`}
        </Text>
      </Row>

      {/* Chips for this frame's classes */}
      {current.boxes.length > 0 && (
        <Row style={styles.chipRow} gap={space.sm}>
          {classCounts(current.boxes).map(([cls, count]) => (
            <View key={cls} style={[styles.detChip, { borderColor: CLASS_COLOR[cls] }]}>
              <View style={[styles.detChipDot, { backgroundColor: CLASS_COLOR[cls] }]} />
              <Text style={styles.detChipLabel}>
                {CLASS_LABEL[cls]}
                {count > 1 ? ` ×${count}` : ''}
              </Text>
            </View>
          ))}
        </Row>
      )}

      {/* Scrubber — a horizontal filmstrip of frame thumbnails to jump between. */}
      <Eyebrow>Scrub frames</Eyebrow>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stripContent}
        style={styles.strip}
      >
        {frames.map((f, i) => {
          const selected = i === safeIndex;
          const hasBall = f.boxes.some((b) => b.cls === 'ball' || b.cls === 'ball_in_basket');
          const hasRim = f.boxes.some((b) => b.cls === 'rim');
          return (
            <Pressable
              key={f.uri}
              onPress={() => onIndexChange(i)}
              accessibilityRole="button"
              accessibilityLabel={`Frame ${i + 1}, ${f.boxes.length} detections`}
              accessibilityState={{ selected }}
              style={[styles.thumb, selected && styles.thumbSelected]}
            >
              <Image source={{ uri: f.uri }} style={styles.thumbImage} resizeMode="cover" />
              {/* Detection markers so you can find the "good" frames without
                  opening every one. */}
              <View style={styles.thumbMarkers} pointerEvents="none">
                {hasBall && (
                  <View style={[styles.thumbDot, { backgroundColor: color.accent }]} />
                )}
                {hasRim && <View style={[styles.thumbDot, { backgroundColor: color.make }]} />}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <PillButton label="Pick another video" onPress={onPickAnother} style={styles.cta} />
    </Screen>
  );
}

/**
 * The square frame preview with boxes drawn as absolutely-positioned Views.
 *
 * Why plain Views over Skia here: the boxes are static per frame (no per-frame
 * animation to justify a canvas), and RN Views give us free crisp borders +
 * text labels that always sit above the image. The image itself is rendered
 * with resizeMode:'cover' inside a SQUARE container, which reproduces the
 * detector's center-crop-to-square: the shorter side fills the square and the
 * longer side is clipped equally on both ends — the same geometry the model
 * saw. So a normalized box maps to on-screen px by a straight multiply.
 */
function FramePreview({ uri, boxes, size }: { uri: string; boxes: DetBox[]; size: number }) {
  return (
    <View style={styles.previewInner}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      {boxes.map((b, i) => {
        const left = b.x * size;
        const top = b.y * size;
        const w = b.w * size;
        const h = b.h * size;
        const c = CLASS_COLOR[b.cls];
        // Clamp the label so it stays on-screen when a box hugs the top edge.
        const labelBelow = top < 18;
        return (
          <View
            key={`${b.cls}-${i}`}
            pointerEvents="none"
            style={[
              styles.box,
              {
                left,
                top,
                width: Math.max(2, w),
                height: Math.max(2, h),
                borderColor: c,
              },
            ]}
          >
            <View
              style={[
                styles.boxLabel,
                { backgroundColor: c },
                labelBelow ? styles.boxLabelBelow : styles.boxLabelAbove,
              ]}
            >
              <Text style={styles.boxLabelText} numberOfLines={1}>
                {CLASS_LABEL[b.cls]} {Math.round(b.score * 100)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <View style={styles.progressTrack} accessibilityRole="progressbar">
      <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
    </View>
  );
}

function StatPill({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <View style={styles.statPill}>
      <View style={[styles.statPillDot, { backgroundColor: tint }]} />
      <Text style={styles.statPillValue}>{value}</Text>
      <Text style={styles.statPillLabel}>{label}</Text>
    </View>
  );
}

/** Count boxes per class for a frame, most-common first, for the chip row. */
function classCounts(boxes: DetBox[]): [DetBox['cls'], number][] {
  const m = new Map<DetBox['cls'], number>();
  for (const b of boxes) m.set(b.cls, (m.get(b.cls) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function formatMs(ms: number): string {
  const totalSec = ms / 1000;
  const mm = Math.floor(totalSec / 60);
  const ss = Math.floor(totalSec % 60);
  const t = `${ss}`.padStart(2, '0');
  return `${mm}:${t}`;
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  backRow: {
    marginBottom: space.md,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.xl,
  },
  card: {
    marginBottom: space.lg,
  },
  cardHeading: {
    ...type.heading,
    color: color.text,
    marginBottom: space.md,
  },
  legendWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  legendItem: {
    marginRight: space.md,
  },
  legendSwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
  },
  legendLabel: {
    ...type.caption,
    color: color.textDim,
  },
  progressBody: {
    flex: 1,
  },
  progressLabel: {
    ...type.heading,
    color: color.text,
  },
  progressCount: {
    ...type.body,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  progressTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    marginTop: space.lg,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  cta: {
    marginTop: space.sm,
    marginBottom: space.xl,
  },

  // --- results ---
  statRow: {
    marginTop: space.lg,
    marginBottom: space.lg,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  statPillDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statPillValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  statPillLabel: {
    ...type.caption,
    color: color.textFaint,
  },
  previewWrap: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  previewInner: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 3,
  },
  boxLabel: {
    position: 'absolute',
    left: -2,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    maxWidth: 140,
  },
  boxLabelAbove: {
    bottom: '100%',
    marginBottom: 2,
  },
  boxLabelBelow: {
    top: '100%',
    marginTop: 2,
  },
  boxLabelText: {
    ...type.micro,
    color: color.onAccent,
    fontVariant: ['tabular-nums'],
  },
  frameCaption: {
    marginTop: space.md,
    marginBottom: space.md,
  },
  frameIndex: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  frameTime: {
    ...type.body,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  frameCaptionSpacer: {
    flex: 1,
  },
  frameHits: {
    ...type.caption,
    color: color.textFaint,
  },
  chipRow: {
    flexWrap: 'wrap',
    marginBottom: space.lg,
  },
  detChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: space.md,
  },
  detChipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  detChipLabel: {
    ...type.caption,
    color: color.text,
  },
  strip: {
    marginTop: space.sm,
    marginBottom: space.xl,
  },
  stripContent: {
    gap: space.sm,
    paddingVertical: space.xs,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: color.border,
    backgroundColor: '#000',
  },
  thumbSelected: {
    borderColor: color.accent,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbMarkers: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    gap: 3,
  },
  thumbDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.5)',
  },
});
