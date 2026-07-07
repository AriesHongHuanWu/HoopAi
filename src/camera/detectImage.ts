/**
 * detectImage — run the app's live detector on a STILL image (JS thread).
 *
 * This is the offline / on-demand counterpart to the live camera path in
 * `useShotEngine.ts`, used by the "Test AI" verify screen. It reproduces the
 * live input pipeline for WHICHEVER detector engine is selected in Settings, so
 * what you see here is what the live camera would produce for the same frame:
 *
 *   - YOLOX (default): 416px input, scaleMode 'contain' (letterbox the whole
 *     frame — nothing cropped), INTERLEAVED (NHWC), channel order BGR, 0..1
 *     (the *255 rescale is baked into the model), parsed with objectness.
 *   - YOLO11 (fallback): 640px input, scaleMode 'cover' (center-crop square),
 *     PLANAR (NCHW), channel order RGB, 0..1, parsed without objectness.
 *
 * These MUST match useShotEngine's resizer config + parser flags exactly, or the
 * verify screen would lie about what the live path sees.
 *
 * Parsing reuses `parseYoloOutput` (a 'worklet' fn equally callable on the JS
 * thread), then applies the SAME per-class score gates from `src/core/config`
 * DETECTION. Boxes are returned NORMALIZED 0..1 against the model's square input
 * (the same square the model saw), so the preview draws them by a plain multiply
 * as long as it renders the frame with the matching resizeMode ({@link DetectorConfig.scaleMode}).
 */
import {
  Skia,
  AlphaType,
  ColorType,
  FilterMode,
  MipmapMode,
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import {
  loadTensorflowModel,
  type TensorflowModel,
} from 'react-native-fast-tflite';
import { Platform } from 'react-native';

import { DETECTION } from '../core/config';
import type { DetClass } from '../core/types';
import { cullLetterboxDetections } from '../ml/letterboxCull';
import { parseYoloOutput } from '../ml/yoloParser';
import { useSettings } from '../state/settingsStore';

/* eslint-disable @typescript-eslint/no-var-requires */
const YOLO11_ASSET = require('../../assets/models/hoopai-det.tflite');
const YOLOX_ASSET = require('../../assets/models/hoopai-yolox.tflite');
const YOLOX640_ASSET = require('../../assets/models/hoopai-yolox-640.tflite');
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Resolved detector input config for the selected engine. Mirrors the live
 * resizer + parser settings in useShotEngine.ts exactly.
 */
export interface DetectorConfig {
  asset: number;
  /** Model input side (square). */
  input: number;
  /** Memory layout of the packed buffer. */
  layout: 'planar' | 'interleaved';
  channelOrder: 'rgb' | 'bgr';
  /** How the source frame maps into the square input (must match the preview). */
  scaleMode: 'cover' | 'contain';
  /** YOLOX has an objectness channel (score = obj*cls); YOLO11 does not. */
  hasObjectness: boolean;
  label: string;
}

/** Build the config for whatever engine live detection is currently set to. */
export function resolveDetectorConfig(): DetectorConfig {
  const engine = useSettings.getState().detectorEngine;
  if (engine === 'yolox') {
    // Quality = 640 (bigger ball), Speed = 416 — must mirror useShotEngine.
    const hq = useSettings.getState().perfMode !== 'speed';
    return {
      asset: hq ? YOLOX640_ASSET : YOLOX_ASSET,
      input: hq ? 640 : 416,
      layout: 'interleaved',
      channelOrder: 'bgr',
      scaleMode: 'contain',
      hasObjectness: true,
      label: hq ? 'YOLOX 640' : 'YOLOX 416',
    };
  }
  return {
    asset: YOLO11_ASSET,
    input: DETECTION.inputSize, // 640
    layout: 'planar',
    channelOrder: 'rgb',
    scaleMode: 'cover',
    hasObjectness: false,
    label: 'YOLO11',
  };
}

/**
 * A single detection from a still image. x, y, w, h are NORMALIZED 0..1 against
 * the model's SQUARE input (letterboxed for 'contain', center-cropped for
 * 'cover'). Render the frame with the same {@link DetectorConfig.scaleMode} and
 * a box maps to on-screen px by a straight multiply.
 */
export interface DetBox {
  cls: 'ball' | 'rim' | 'ball_in_basket' | 'person';
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-class score gate, mirroring the live pipeline's DETECTION thresholds. */
function passesGate(cls: DetClass, score: number): boolean {
  switch (cls) {
    case 'ball':
      return score >= DETECTION.ballScoreMin;
    case 'rim':
      return score >= DETECTION.rimScoreMin;
    case 'ball_in_basket':
      return score >= DETECTION.ballInBasketScoreMin;
    case 'person':
      return score >= DETECTION.personScoreMin;
    default:
      return false;
  }
}

/**
 * Load the detector for `config`. Plain CPU (XNNPACK) FIRST — this is an OFFLINE
 * verification screen where accelerator speed is irrelevant and CPU is always
 * numerically correct (an accelerator that mis-compiles the graph would show
 * phantom boxes on the very screen meant to prove the model's true output). The
 * platform accelerator is only a last-resort fallback. Returns null if all fail.
 */
export async function loadDetector(config: DetectorConfig): Promise<TensorflowModel | null> {
  const accel: ('core-ml' | 'android-gpu')[] =
    Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
  const attempts: ('core-ml' | 'android-gpu')[][] = [[], accel];
  for (const delegates of attempts) {
    try {
      return await loadTensorflowModel(config.asset, delegates);
    } catch {
      // Try the next delegate list.
    }
  }
  return null;
}

/**
 * Decode the image at `uri`, map it into the model's square input per
 * `config.scaleMode`, and pack a float32 buffer (0..1) in the model's layout +
 * channel order. All Skia objects are disposed before returning.
 */
async function packInput(
  uri: string,
  config: DetectorConfig,
): Promise<{ buf: ArrayBuffer; srcW: number; srcH: number }> {
  const S = config.input;
  const data = await Skia.Data.fromURI(uri);
  let image: SkImage | null = null;
  let surface: SkSurface | null = null;
  try {
    image = Skia.Image.MakeImageFromEncoded(data);
    if (image == null) throw new Error(`could not decode image at ${uri}`);
    const iw = image.width();
    const ih = image.height();
    if (iw <= 0 || ih <= 0) throw new Error(`invalid image dimensions ${iw}x${ih}`);

    let srcRect;
    let dstRect;
    if (config.scaleMode === 'cover') {
      // Center-crop the source to the largest centered SQUARE, scale to fill S×S.
      const sideC = Math.min(iw, ih);
      srcRect = Skia.XYWHRect((iw - sideC) / 2, (ih - sideC) / 2, sideC, sideC);
      dstRect = Skia.XYWHRect(0, 0, S, S);
    } else {
      // 'contain': fit the WHOLE frame into S×S preserving aspect, centered, with
      // black bars on the short axis (matches the GPU resizer's letterbox pad).
      const scale = Math.min(S / iw, S / ih);
      const rw = iw * scale;
      const rh = ih * scale;
      srcRect = Skia.XYWHRect(0, 0, iw, ih);
      dstRect = Skia.XYWHRect((S - rw) / 2, (S - rh) / 2, rw, rh);
    }

    surface = Skia.Surface.MakeOffscreen(S, S);
    if (surface == null) throw new Error('could not create offscreen surface');
    const canvas = surface.getCanvas();
    // Offscreen starts transparent-black; for 'contain' the un-drawn bars stay
    // (0,0,0) after we drop alpha — the black pad the model expects.
    canvas.drawImageRectOptions(
      image,
      srcRect,
      dstRect,
      FilterMode.Linear,
      MipmapMode.None,
      Skia.Paint(),
    );
    surface.flush();

    const snapshot = surface.makeImageSnapshot();
    try {
      const pixels = snapshot.readPixels(0, 0, {
        width: S,
        height: S,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Unpremul,
      });
      if (pixels == null) throw new Error('readPixels returned null');
      const rgba =
        pixels instanceof Uint8Array
          ? pixels
          : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

      const area = S * S;
      const out = new Float32Array(3 * area);
      const bgr = config.channelOrder === 'bgr';
      const interleaved = config.layout === 'interleaved';
      const g1 = area; // planar plane offsets
      const b2 = 2 * area;
      for (let i = 0; i < area; i++) {
        const p = i * 4;
        const r = rgba[p]! / 255;
        const g = rgba[p + 1]! / 255;
        const b = rgba[p + 2]! / 255;
        const c0 = bgr ? b : r;
        const c2 = bgr ? r : b;
        if (interleaved) {
          const o = i * 3;
          out[o] = c0;
          out[o + 1] = g;
          out[o + 2] = c2;
        } else {
          out[i] = c0;
          out[g1 + i] = g;
          out[b2 + i] = c2;
        }
      }
      return { buf: out.buffer, srcW: iw, srcH: ih };
    } finally {
      snapshot.dispose();
    }
  } finally {
    if (surface != null) surface.dispose();
    if (image != null) image.dispose();
    data.dispose();
  }
}

/**
 * Run the detector on the still image at `uri` and return surviving boxes
 * (NORMALIZED 0..1 against the model's square input). Runs `model.run` ASYNC on
 * the JS thread (not a worklet). Parses with the shared `parseYoloOutput` using
 * the engine's objectness flag, applies the per-class gates, and normalizes the
 * parser's input-px boxes to 0..1 (÷ input side).
 */
export async function detectImageToBoxes(
  uri: string,
  model: TensorflowModel,
  config: DetectorConfig,
): Promise<DetBox[]> {
  const { buf, srcW, srcH } = await packInput(uri, config);
  const outputs = await model.run([buf]);
  const out0 = outputs[0];
  if (out0 == null) return [];

  const S = config.input;
  const parsed = parseYoloOutput(new Float32Array(out0), 0, {
    inputSize: S,
    hasObjectness: config.hasObjectness,
  });

  // 'contain' pads the square with black bars, and the model hallucinates
  // detections there — same phantom-person problem as the live path, same
  // fix (ml/letterboxCull.ts). 'cover' has no bars, so nothing to cull.
  const detections =
    config.scaleMode === 'contain'
      ? cullLetterboxDetections(parsed.detections, S, srcW, srcH)
      : parsed.detections;

  const result: DetBox[] = [];
  for (const d of detections) {
    if (!passesGate(d.cls, d.score)) continue;
    // Drop any box covering ~the whole frame (a mis-scaled/degenerate box) so the
    // screen meant to PROVE detection never renders a screen-covering phantom.
    if (d.box.width >= 0.9 * S || d.box.height >= 0.9 * S) continue;
    result.push({
      cls: d.cls,
      score: d.score,
      x: d.box.x / S,
      y: d.box.y / S,
      w: d.box.width / S,
      h: d.box.height / S,
    });
  }
  return result;
}
