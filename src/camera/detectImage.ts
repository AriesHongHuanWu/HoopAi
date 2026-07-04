/**
 * detectImage — run the app's live detector on a STILL image (JS thread).
 *
 * This is the offline / on-demand counterpart to the live camera path in
 * `useShotEngine.ts`. It exists so features that operate on a captured frame
 * (thumbnail review, a shared photo, a paused video frame, tests) can get the
 * exact same detections the realtime worklet would produce for that frame.
 *
 * It reproduces the live input pipeline BYTE-FOR-BYTE so scores match:
 *   - The live path resizes each camera frame with `react-native-vision-camera-
 *     resizer` configured `pixelLayout:'planar'`, `channelOrder:'rgb'`,
 *     `dataType:'float32'`, `scaleMode:'cover'` (see useShotEngine.ts), and the
 *     model receives values in 0..1.
 *   - `scaleMode:'cover'` == center-crop the source to a square, then scale that
 *     square up/down to the model side (640). We do the same here with Skia:
 *     draw the center square of the decoded image into a full 640×640 offscreen
 *     surface via `drawImageRect(src, dst)`.
 *   - We then read back RGBA8888 (Unpremul) pixels and pack them into a PLANAR
 *     NCHW float32 buffer [1,3,640,640], RGB, /255 — identical to what the model
 *     consumes live (verified: interleaved/NHWC feeds the model scrambled pixels
 *     and every score collapses to ~0; planar produces real detections).
 *
 * Parsing reuses `parseYoloOutput` (a 'worklet' fn that is equally callable on
 * the JS thread), then applies the SAME per-class score gates from
 * `src/core/config` DETECTION. Boxes are converted from 640-px space to
 * normalized 0..1 (÷640) relative to the center-cropped square.
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
import { parseYoloOutput } from '../ml/yoloParser';

/* eslint-disable @typescript-eslint/no-var-requires */
// Same 'standard' detector asset the live engine loads by default.
const MODEL_ASSET = require('../../assets/models/hoopai-det.tflite');
/* eslint-enable @typescript-eslint/no-var-requires */

/** Detector input side. Kept in lockstep with DETECTION.inputSize (640). */
const INPUT = DETECTION.inputSize;

/**
 * A single detection produced from a still image.
 *
 * x, y, w, h are NORMALIZED 0..1 relative to the CENTER-CROPPED SQUARE of the
 * source image (the same square the model actually saw). To draw over the
 * original photo, map back through the same center-crop the detector used.
 */
export interface DetBox {
  cls: 'ball' | 'rim' | 'ball_in_basket' | 'person';
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Per-class score gate, mirroring the live pipeline's DETECTION thresholds.
 * A box below its class gate is dropped.
 */
function passesGate(cls: DetClass, score: number): boolean {
  switch (cls) {
    case 'ball':
      return score >= DETECTION.ballScoreMin; // 0.3
    case 'rim':
      return score >= DETECTION.rimScoreMin; // 0.35
    case 'ball_in_basket':
      return score >= DETECTION.ballInBasketScoreMin; // 0.35
    case 'person':
      return score >= DETECTION.personScoreMin; // 0.4
    default:
      return false;
  }
}

/**
 * Load the detector with the SAME delegate fallback chain the live engine uses:
 * try the platform accelerator first (CoreML on iOS / GPU on Android), then fall
 * back to the plain CPU delegate (`[]`), which is always compatible. Returns
 * null if every attempt fails (e.g. the placeholder asset hasn't been replaced
 * by a trained model yet).
 */
export async function loadDetector(): Promise<TensorflowModel | null> {
  const accel: ('core-ml' | 'android-gpu')[] =
    Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
  // Accelerator first, then plain CPU (empty delegate list) as the final rung.
  const attempts: ('core-ml' | 'android-gpu')[][] = [accel, []];
  for (const delegates of attempts) {
    try {
      const model = await loadTensorflowModel(MODEL_ASSET, delegates);
      return model;
    } catch {
      // Try the next (less accelerated) rung.
    }
  }
  return null;
}

/**
 * Decode the image at `uri`, center-crop to a square, scale to INPUT×INPUT, and
 * pack a PLANAR NCHW RGB float32 buffer normalized to 0..1 — the exact tensor
 * layout the model consumes live. All Skia objects created here are disposed
 * before returning (success or throw).
 *
 * @returns the packed [1,3,INPUT,INPUT] buffer as an ArrayBuffer.
 */
async function packPlanarInput(uri: string): Promise<ArrayBuffer> {
  const data = await Skia.Data.fromURI(uri);
  let image: SkImage | null = null;
  let surface: SkSurface | null = null;
  try {
    image = Skia.Image.MakeImageFromEncoded(data);
    if (image == null) {
      throw new Error(`could not decode image at ${uri}`);
    }
    const iw = image.width();
    const ih = image.height();
    if (iw <= 0 || ih <= 0) {
      throw new Error(`invalid image dimensions ${iw}x${ih}`);
    }

    // scaleMode:'cover' == center-crop the source to the largest centered
    // SQUARE, then scale that square to fill INPUT×INPUT. Compute that square
    // as the source rect; the dest rect is the full offscreen surface.
    const side = Math.min(iw, ih);
    const srcX = (iw - side) / 2;
    const srcY = (ih - side) / 2;
    const srcRect = Skia.XYWHRect(srcX, srcY, side, side);
    const dstRect = Skia.XYWHRect(0, 0, INPUT, INPUT);

    surface = Skia.Surface.MakeOffscreen(INPUT, INPUT);
    if (surface == null) {
      throw new Error('could not create offscreen surface');
    }
    const canvas = surface.getCanvas();
    const paint = Skia.Paint();
    // drawImageRect with a plain paint uses the default (nearest) sampling; use
    // drawImageRectOptions with LINEAR to match a resizer's bilinear downscale
    // quality. Either works for detection; linear is closer to the GPU resizer.
    canvas.drawImageRectOptions(
      image,
      srcRect,
      dstRect,
      FilterMode.Linear,
      MipmapMode.None,
      paint,
    );
    surface.flush();

    const snapshot = surface.makeImageSnapshot();
    try {
      // Read back tightly-packed RGBA8888, UNPREMULTIPLIED, at INPUT×INPUT.
      // Unpremul matters: premultiplied would scale RGB by alpha; the offscreen
      // surface is opaque here, but Unpremul is the safe, layout-stable choice
      // and matches the resizer (which never premultiplies).
      const pixels = snapshot.readPixels(0, 0, {
        width: INPUT,
        height: INPUT,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Unpremul,
      });
      if (pixels == null) {
        throw new Error('readPixels returned null');
      }
      // pixels is RGBA8888 => a Uint8Array of length INPUT*INPUT*4.
      const rgba =
        pixels instanceof Uint8Array
          ? pixels
          : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

      const area = INPUT * INPUT;
      // PLANAR NCHW: [ R-plane (area) | G-plane (area) | B-plane (area) ].
      const out = new Float32Array(3 * area);
      const gPlane = area;
      const bPlane = 2 * area;
      for (let i = 0; i < area; i++) {
        const p = i * 4; // RGBA stride
        out[i] = rgba[p]! / 255; // R
        out[gPlane + i] = rgba[p + 1]! / 255; // G
        out[bPlane + i] = rgba[p + 2]! / 255; // B
        // alpha (rgba[p + 3]) intentionally dropped — model input is 3-channel.
      }
      return out.buffer;
    } finally {
      snapshot.dispose();
    }
  } finally {
    // Dispose in any case; SkData/SkImage/SkSurface are all JSI-owned native
    // resources and leak the underlying memory if not released.
    if (surface != null) surface.dispose();
    if (image != null) image.dispose();
    data.dispose();
  }
}

/**
 * Run the detector on the still image at `uri` and return the surviving boxes
 * (NORMALIZED 0..1 against the center-cropped square).
 *
 * Runs `model.run([buf])` ASYNC on the JS thread (this is NOT a worklet — the
 * async native call is fine off the frame processor). Parses with the shared
 * `parseYoloOutput`, applies the per-class DETECTION gates, and normalizes the
 * parser's 640-px boxes to 0..1 (÷640).
 */
export async function detectImageToBoxes(
  uri: string,
  model: TensorflowModel,
): Promise<DetBox[]> {
  const buf = await packPlanarInput(uri);
  // Async inference on the JS thread (contract: model.run, not runSync).
  const outputs = await model.run([buf]);
  const out0 = outputs[0];
  if (out0 == null) return [];

  // t is unused for a still image; pass 0. parseYoloOutput auto-detects the
  // channels-first/last layout and normalized-vs-pixel coords, applies NMS, and
  // returns boxes in INPUT (640) pixel space with box.{x,y,width,height} as the
  // TOP-LEFT corner + size.
  const parsed = parseYoloOutput(new Float32Array(out0), 0, { inputSize: INPUT });

  const result: DetBox[] = [];
  for (const d of parsed.detections) {
    if (!passesGate(d.cls, d.score)) continue;
    // Defensive size gate for the verification surface: drop any box covering
    // ~the whole frame (a mis-scaled/degenerate detector box). Parser boxes are
    // in INPUT (640) px; reject width or height >= 0.9 of the frame side so the
    // screen meant to PROVE detection never renders a screen-covering phantom.
    if (d.box.width >= 0.9 * INPUT || d.box.height >= 0.9 * INPUT) continue;
    result.push({
      cls: d.cls,
      score: d.score,
      x: d.box.x / INPUT,
      y: d.box.y / INPUT,
      w: d.box.width / INPUT,
      h: d.box.height / INPUT,
    });
  }
  return result;
}
