/**
 * Storage manager (Q06) — reclaim space by deleting session RECORDINGS while
 * keeping every stat.
 *
 * Sessions record an optional master video (SessionRow.videoPath). Those files
 * dwarf everything else on disk, and once a user has reviewed a session they
 * rarely need the replay again. This screen lists only the sessions that still
 * have a video on disk, shows each file's size and the running total, and lets
 * the user delete recordings one at a time or in a "older than 30 days" sweep.
 *
 * IMPORTANT: this only ever touches VIDEO FILES. Deleting a recording clears
 * that session's videoPath (so History stops offering a dead replay) but never
 * removes the session, its shots, angles or FG%. The copy says so plainly —
 * "stats are kept" — so nobody fears losing their history to free up space.
 *
 * File sizes come from expo-file-system's legacy getInfoAsync; a session whose
 * file has already vanished (saved-to-Photos-then-cleaned, OS purge) is simply
 * not listed. All filesystem/db calls are the never-throw helpers, so a failure
 * degrades to an empty list, not a crash.
 */
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill, formatSessionDate } from '@/components/ShotList';
import { Card, PillButton, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { clearSessionVideo, listSessions, type SessionSummaryRow } from '@/data/db';
import { deleteLocalVideo } from '@/data/videoLibrary';

/** How many sessions to scan for recordings. Generous — covers a full library. */
const SCAN_LIMIT = 500;
/** The bulk-cleanup age threshold, in days. */
const OLD_VIDEO_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ensure a file:// scheme (VisionCamera hands back bare paths). */
function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** One session that still has a recording on disk. */
interface VideoItem {
  row: SessionSummaryRow;
  /** Absolute path of the recording (non-null by construction). */
  videoPath: string;
  /** File size in bytes. */
  bytes: number;
}

/** Fire selection haptics when enabled (mirrors settings' tick()). */
async function tick() {
  void Haptics.selectionAsync();
}

/** Human-readable byte size — MB for anything a video-sized, GB past 1024. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return '<1 MB';
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Look up each recorded session's file size, dropping any whose file is gone.
 * Pure-ish IO helper — never throws (a failed stat just drops that session).
 */
async function loadVideoItems(): Promise<VideoItem[]> {
  const rows = await listSessions(SCAN_LIMIT);
  const withVideo = rows.filter((r) => r.videoPath != null && r.videoPath.length > 0);
  const items = await Promise.all(
    withVideo.map(async (row): Promise<VideoItem | null> => {
      const path = row.videoPath as string;
      try {
        // Legacy getInfoAsync always returns `size` for an existing file.
        const info = await FileSystem.getInfoAsync(toFileUri(path));
        if (!info.exists) return null;
        return { row, videoPath: path, bytes: info.size ?? 0 };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((i): i is VideoItem => i !== null);
}

export default function StorageScreen() {
  const reducedMotion = useReducedMotion();
  const [items, setItems] = useState<VideoItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    let alive = true;
    void (async () => {
      const next = await loadVideoItems();
      if (alive) setItems(next);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(refresh);

  const totalBytes = (items ?? []).reduce((sum, i) => sum + i.bytes, 0);
  const oldCount = (items ?? []).filter(
    (i) => Date.now() - i.row.startedAt > OLD_VIDEO_DAYS * DAY_MS,
  ).length;

  /** Delete one recording: remove the file, clear videoPath (stats untouched). */
  const removeOne = useCallback(async (item: VideoItem) => {
    await deleteLocalVideo(item.videoPath);
    await clearSessionVideo(item.row.id);
    setItems((prev) => (prev == null ? prev : prev.filter((i) => i.row.id !== item.row.id)));
  }, []);

  const confirmDeleteOne = useCallback(
    (item: VideoItem) => {
      Alert.alert(
        'Delete this recording?',
        'The video file is removed to free up space. Your stats for this session are kept — only the replay video goes.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void tick();
              void removeOne(item);
            },
          },
        ],
      );
    },
    [removeOne],
  );

  const confirmDeleteOld = useCallback(() => {
    if (items == null || oldCount === 0 || busy) return;
    Alert.alert(
      `Delete ${oldCount} recording${oldCount === 1 ? '' : 's'} older than ${OLD_VIDEO_DAYS} days?`,
      'Those video files are removed to free up space. All the sessions, shots and stats are kept — only the replay videos go.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              void tick();
              setBusy(true);
              const cutoff = Date.now() - OLD_VIDEO_DAYS * DAY_MS;
              const old = items.filter((i) => i.row.startedAt < cutoff);
              for (const item of old) {
                await deleteLocalVideo(item.videoPath);
                await clearSessionVideo(item.row.id);
              }
              setBusy(false);
              setItems((prev) =>
                prev == null ? prev : prev.filter((i) => i.row.startedAt >= cutoff),
              );
            })();
          },
        },
      ],
    );
  }, [items, oldCount, busy]);

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Text style={styles.title} accessibilityRole="header">
        Manage storage
      </Text>

      {/* Total header */}
      <Card>
        <Text style={styles.eyebrow}>VIDEO STORAGE USED</Text>
        <Text style={styles.total} accessibilityLabel={`${formatBytes(totalBytes)} of session recordings`}>
          {formatBytes(totalBytes)}
        </Text>
        <Text style={styles.dim}>
          {items == null
            ? 'Reading recordings…'
            : items.length === 0
              ? 'No session recordings on this phone.'
              : `${items.length} session recording${items.length === 1 ? '' : 's'}. Deleting a video keeps its stats — only the replay is removed.`}
        </Text>
        {items != null && oldCount > 0 && (
          <PillButton
            variant="ghost"
            label={busy ? 'Deleting…' : `Delete videos older than ${OLD_VIDEO_DAYS} days (${oldCount})`}
            onPress={confirmDeleteOld}
            disabled={busy}
            style={{ marginTop: space.lg, alignSelf: 'flex-start' }}
          />
        )}
      </Card>

      {/* Per-session recordings */}
      {items != null && items.length > 0 && (
        <View style={{ gap: space.md, marginTop: space.lg }}>
          {items.map((item, index) => {
            const row = (
              <Card>
                <Row style={styles.itemRow} gap={space.lg}>
                  <View style={styles.itemInfo}>
                    <Text style={styles.itemDate}>{formatSessionDate(item.row.startedAt)}</Text>
                    <Text style={styles.dim}>
                      {item.row.makes ?? 0}/{item.row.attempts} makes · {formatBytes(item.bytes)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete recording from ${formatSessionDate(item.row.startedAt)}`}
                    accessibilityHint="Removes the video file. Stats are kept."
                    onPress={() => confirmDeleteOne(item)}
                    disabled={busy}
                    style={({ pressed }) => [
                      styles.deleteBtn,
                      pressed && { backgroundColor: color.surfaceRaised },
                      busy && styles.disabled,
                    ]}
                  >
                    <Ionicons name="trash-outline" size={18} color={color.miss} />
                  </Pressable>
                </Row>
              </Card>
            );
            return reducedMotion ? (
              <View key={item.row.id}>{row}</View>
            ) : (
              <Animated.View
                key={item.row.id}
                entering={FadeInDown.duration(motion.standard).delay(Math.min(index, 8) * 40)}
              >
                {row}
              </Animated.View>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  eyebrow: {
    ...type.micro,
    color: color.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: space.xs,
  },
  total: {
    ...type.title,
    color: color.text,
    fontVariant: ['tabular-nums'],
    marginBottom: space.sm,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  itemRow: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  itemDate: {
    ...type.heading,
    color: color.text,
  },
  deleteBtn: {
    width: touch.minTarget,
    height: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
});
