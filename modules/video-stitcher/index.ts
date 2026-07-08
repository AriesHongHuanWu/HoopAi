/**
 * `video-stitcher` — local Expo native module.
 *
 * Exports the raw native module handle and its TypeScript surface. App code
 * should import from `@/media/videoStitcher` (the guarded wrapper), NOT this
 * file directly — the wrapper degrades gracefully when the native module is
 * absent (Expo Go, Jest, pre-native-build binaries). See README.md.
 */
import { requireOptionalNativeModule } from 'expo';
import { type EventSubscription } from 'expo-modules-core';

/** A stitch window in SECONDS of source-video time. */
export interface StitchSegment {
  startSec: number;
  endSec: number;
}

export interface StitchOptions {
  /** `file://…` URI (or bare path) of the source recording. */
  sourceUri: string;
  /** Ordered clip windows to concatenate. */
  segments: StitchSegment[];
  /** Optional output basename (`.mp4` appended if missing). */
  outputFileName?: string;
}

export interface StitchResult {
  /** `file://…` URI of the exported MP4 in the app cache. */
  uri: string;
  /** Duration of the exported reel, seconds. */
  durationSec: number;
}

/** Payload of the `onProgress` event: one fires per appended segment. */
export interface StitchProgressEvent {
  /** Zero-based index of the segment just appended. */
  index: number;
  /** Total number of segments requested. */
  total: number;
}

export interface VideoStitcherModuleType {
  isAvailable(): boolean;
  cancel(): void;
  stitch(options: StitchOptions): Promise<StitchResult>;
  addListener(
    eventName: 'onProgress',
    listener: (event: StitchProgressEvent) => void,
  ): EventSubscription;
}

/**
 * The native module, or `null` when it isn't linked into this binary. Never
 * throws at import time — callers must null-check (the wrapper does).
 */
export const VideoStitcher =
  requireOptionalNativeModule<VideoStitcherModuleType>('VideoStitcher');
