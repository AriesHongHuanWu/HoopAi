/**
 * Storage manager (Q06) — reclaim space by deleting session RECORDINGS while
 * keeping every stat.
 *
 * Sessions record an optional master video (SessionRow.videoPath). Those files
 * dwarf everything else on disk, and once a user has reviewed a session they
 * rarely need the replay again. This screen heroes the running byte total as a
 * broadcast numeral (with its share of the phone's storage under it), lists
 * every session that still has a video on disk in ONE card of rows — each row
 * carrying a thin bar sized relative to the largest file, so the biggest video
 * is visible at a glance — and lets the user delete recordings one at a time
 * or in an "older than 30 days" sweep.
 *
 * IMPORTANT: this only ever touches VIDEO FILES. Deleting a recording clears
 * that session's videoPath (so History stops offering a dead replay) but never
 * removes the session, its shots, angles or FG%. The copy says so plainly —
 * "stats are kept" — so nobody fears losing their history to free up space.
 *
 * File sizes come from expo-file-system's legacy getInfoAsync; a session whose
 * file has already vanished (saved-to-Photos-then-cleaned, OS purge) is simply
 * not listed. All filesystem/db calls are the never-throw helpers, so a failure
 * degrades to an empty list, not a crash. The disk-capacity share is only
 * rendered when the OS reports a capacity — never estimated.
 */
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { BackPill, formatSessionDate } from '@/components/ShotList';
import { ScreenHeader, SectionEyebrow } from '@/components/ScreenHeader';
import { Card, EmptyState, PillButton, Row, Screen, SkeletonCard } from '@/components/ui';
import { AnimatedProgressBar, MotionStat, useCardStagger } from '@/components/motion';
import { color, iconSize, layout, radius, space, touch, type } from '@/constants/tokens';
import { clearSessionVideo, listSessions, type SessionSummaryRow } from '@/data/db';
import { deleteLocalVideo } from '@/data/videoLibrary';
import { haptic } from '@/utils/haptics';

/** How many sessions to scan for recordings. Generous — covers a full library. */
const SCAN_LIMIT = 500;
/** The bulk-cleanup age threshold, in days. */
const OLD_VIDEO_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

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

/** Fire selection haptics through the settings-gated gateway. */
function tick() {
  haptic.selection();
}

/** Human-readable byte size — MB for anything video-sized, GB past 1024. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / MIB;
  if (mb < 1) return '<1 MB';
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * The hero numeral, split for CountUp: GB with one decimal past 1 GiB,
 * otherwise MB (one decimal under 10 MB so a small library still moves).
 */
function heroStat(bytes: number): { value: number; decimals: number; suffix: string } {
  if (bytes >= GIB) return { value: bytes / GIB, decimals: 1, suffix: ' GB' };
  const mb = bytes / MIB;
  return { value: mb, decimals: mb < 10 ? 1 : 0, suffix: ' MB' };
}

/** Share of the phone's storage as human copy — floors at <0.1% rather than 0%. */
function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
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
  const [items, setItems] = useState<VideoItem[] | null>(null);
  /** Total disk capacity in bytes — null until (and unless) the OS reports it. */
  const [diskBytes, setDiskBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Card entrance choreography — the shared stagger, reduced-motion aware.
  const enter = useCardStagger();

  const refresh = useCallback(() => {
    let alive = true;
    void (async () => {
      const [next, capacity] = await Promise.all([
        loadVideoItems(),
        // Capacity is presentation-only (the share bar); a failure just hides
        // the bar — we never show a made-up denominator.
        FileSystem.getTotalDiskCapacityAsync().catch(() => null),
      ]);
      if (alive) {
        setItems(next);
        setDiskBytes(capacity != null && capacity > 0 ? capacity : null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(refresh);

  const totalBytes = (items ?? []).reduce((sum, i) => sum + i.bytes, 0);
  const maxBytes = (items ?? []).reduce((max, i) => Math.max(max, i.bytes), 0);
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
              tick();
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
              tick();
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

  const stat = heroStat(totalBytes);
  const share = diskBytes != null && diskBytes > 0 ? totalBytes / diskBytes : null;

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>
        <ScreenHeader
          title="Manage storage"
          lede="Reclaim space by deleting session recordings. Stats always stay."
        />

        {items == null ? (
          // Skeleton rows in the shared loading language — the hero block and
          // the list reserve their real geometry while sizes are read.
          <>
            <SkeletonCard hero lines={2} />
            <SkeletonCard lines={4} />
          </>
        ) : items.length === 0 ? (
          <EmptyState
            title="No session recordings on this phone"
            body="Session videos you keep show up here. Deleting a recording only ever removes the video file — every session's stats are kept."
          />
        ) : (
          <>
            {/* Total header — the one big number on this screen. */}
            <Card entering={enter(0)}>
              <SectionEyebrow icon="film" style={styles.sectionEyebrow}>
                Video storage used
              </SectionEyebrow>
              <MotionStat
                value={stat.value}
                decimals={stat.decimals}
                suffix={stat.suffix}
                size="large"
                style={styles.heroStat}
              />
              {share != null && diskBytes != null && (
                <>
                  <AnimatedProgressBar
                    progress={share}
                    style={styles.heroBar}
                    accessibilityLabel={`Recordings use ${formatShare(share)} of this phone's storage`}
                  />
                  <Text style={styles.faintCaption}>
                    {formatShare(share)} of this phone&apos;s {formatBytes(diskBytes)} storage.
                  </Text>
                </>
              )}
              <Text style={[styles.dim, styles.heroCount]}>
                {`${items.length} session recording${items.length === 1 ? '' : 's'}. Deleting a video keeps its stats — only the replay is removed.`}
              </Text>
              {oldCount > 0 && (
                <PillButton
                  variant="ghost"
                  label={busy ? 'Deleting…' : `Delete videos older than ${OLD_VIDEO_DAYS} days (${oldCount})`}
                  onPress={confirmDeleteOld}
                  disabled={busy}
                  style={styles.sweepBtn}
                />
              )}
            </Card>

            {/* Per-session recordings — one card of rows; each row's thin bar
                is sized against the LARGEST file, so the space hog is obvious
                without reading a single number. */}
            <Card entering={enter(1)}>
              <SectionEyebrow icon="videocam" style={styles.sectionEyebrow}>
                Recordings
              </SectionEyebrow>
              {items.map((item, index) => (
                <View key={item.row.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <Row style={styles.itemRow} gap={space.lg}>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemDate}>{formatSessionDate(item.row.startedAt)}</Text>
                      <Text style={styles.dim}>
                        {item.row.makes ?? 0}/{item.row.attempts} makes · {formatBytes(item.bytes)}
                      </Text>
                      <AnimatedProgressBar
                        progress={maxBytes > 0 ? item.bytes / maxBytes : 0}
                        height={4}
                        style={styles.sizeBar}
                        accessibilityLabel={`${formatBytes(item.bytes)}, relative to your largest recording`}
                      />
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
                      <Ionicons name="trash-outline" size={iconSize.lg} color={color.miss} />
                    </Pressable>
                  </Row>
                </View>
              ))}
            </Card>
          </>
        )}
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
    marginBottom: space.md,
  },
  /** Left-aligned hero numeral (MotionStat centers by default). */
  heroStat: {
    alignItems: 'flex-start',
  },
  heroBar: {
    marginTop: space.md,
  },
  faintCaption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  /** The hero card's count line — needs air under the numeral/bar block. */
  heroCount: {
    marginTop: space.sm,
  },
  sweepBtn: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.md,
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
  sizeBar: {
    marginTop: space.xs,
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
