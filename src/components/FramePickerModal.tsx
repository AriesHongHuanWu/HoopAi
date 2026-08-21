/**
 * FramePickerModal — pick the "shooting moment" still from the session video to
 * use as a share-card background. Samples ~24 frames across the clip (reusing
 * expo-video-thumbnails, same as the Test AI screen), opens ON the auto-detected
 * moment, and lets the user scrub a filmstrip. Returns the chosen frame's uri.
 *
 * Presented as a full-screen overlay over the summary/history screen — a
 * SheetScrim (the one overlay grammar), mounted inline so both the entrance
 * and the exit play. Never throws: a clip that can't be sampled shows a
 * friendly message + "Skip photo".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { SheetScrim } from './motion/SheetScrim';
import { Card, PillButton, Row } from './ui';
import { color, radius, space, type } from '../constants/tokens';
import { haptic } from '../utils/haptics';

const FRAME_COUNT = 24;
const THUMB_QUALITY = 0.6;
const FALLBACK_DURATION_MS = 10_000;

interface Frame {
  uri: string;
  timeMs: number;
}

export function FramePickerModal({
  videoPath,
  durationSec,
  initialTimeSec,
  onPick,
  onCancel,
}: {
  videoPath: string;
  /** Clip duration (s); <= 0 / non-finite falls back to a nominal window. */
  durationSec: number;
  /** Where to open the scrubber (s into the clip) — the shooting moment. */
  initialTimeSec: number;
  onPick: (uri: string) => void;
  onCancel: () => void;
}) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const clipMs = useMemo(
    () => (Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : FALLBACK_DURATION_MS),
    [durationSec],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Sample frames on mount, then pick the one nearest the shooting moment.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const times: number[] = [];
      for (let i = 0; i < FRAME_COUNT; i++) {
        times.push(Math.min(clipMs - 1, Math.round(((i + 0.5) / FRAME_COUNT) * clipMs)));
      }
      const out: Frame[] = [];
      for (const t of times) {
        if (!alive) return;
        try {
          const thumb = await VideoThumbnails.getThumbnailAsync(videoPath, {
            time: t,
            quality: THUMB_QUALITY,
          });
          out.push({ uri: thumb.uri, timeMs: t });
        } catch {
          // Skip an unreadable timestamp.
        }
      }
      if (!alive || !mounted.current) return;
      if (out.length === 0) {
        setFailed(true);
        return;
      }
      // Open on the frame closest to the shooting moment.
      const target = initialTimeSec * 1000;
      let nearest = 0;
      let bestD = Infinity;
      for (let i = 0; i < out.length; i++) {
        const d = Math.abs(out[i]!.timeMs - target);
        if (d < bestD) {
          bestD = d;
          nearest = i;
        }
      }
      setFrames(out);
      setIndex(nearest);
    })();
    return () => {
      alive = false;
    };
  }, [videoPath, clipMs, initialTimeSec]);

  const current = frames?.[Math.max(0, Math.min(index, frames.length - 1))];

  return (
    // No onDismiss: the sheet keeps its explicit "Skip photo" exit — an
    // outside tap has never dismissed this picker, and a silent dismiss would
    // skip the onCancel → format-sheet handoff the callers rely on.
    <SheetScrim align="center" panelStyle={styles.panel}>
      <Card>
        <Text style={styles.title}>Pick your moment</Text>
        <Text style={styles.sub}>
          Choose the frame from your session to feature behind your stats.
        </Text>

        {failed ? (
          <View style={styles.loading}>
            <Text style={styles.dim}>Couldn&apos;t read frames from this clip.</Text>
          </View>
        ) : frames == null ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.accent} />
            <Text style={styles.dim}>Grabbing frames…</Text>
          </View>
        ) : (
          <>
            <View style={styles.preview}>
              {current != null && (
                <Image source={{ uri: current.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              )}
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
            >
              {frames.map((f, i) => (
                <Pressable
                  key={f.uri}
                  onPress={() => {
                    // Tick only when the tap changes the selection (the
                    // SelectableChip grammar); re-tapping the frame is silent.
                    if (i !== index) haptic.selection();
                    setIndex(i);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Frame ${i + 1} of ${frames.length}`}
                  accessibilityState={{ selected: i === index }}
                  style={({ pressed }) => [
                    styles.thumb,
                    i === index && styles.thumbSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Image source={{ uri: f.uri }} style={styles.thumbImg} resizeMode="cover" />
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        <Row gap={space.md} style={styles.actions}>
          <PillButton
            label="Skip photo"
            variant="ghost"
            onPress={onCancel}
            style={styles.btn}
          />
          <PillButton
            label="Use this frame"
            onPress={() => current != null && onPick(current.uri)}
            disabled={current == null}
            style={styles.btn}
          />
        </Row>
      </Card>
    </SheetScrim>
  );
}

const styles = StyleSheet.create({
  /** Panel slot: centered, capped — SheetScrim owns the scrim + motion. */
  panel: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  title: {
    ...type.heading,
    color: color.text,
  },
  sub: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.lg,
  },
  loading: {
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  preview: {
    width: '100%',
    aspectRatio: 4 / 5,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignSelf: 'center',
    maxHeight: 380,
  },
  strip: {
    gap: space.sm,
    paddingVertical: space.md,
  },
  thumb: {
    width: 60,
    height: 75,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: color.border,
    backgroundColor: '#000',
  },
  thumbSelected: {
    borderColor: color.accent,
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  actions: {
    marginTop: space.sm,
  },
  btn: {
    flex: 1,
  },
});
