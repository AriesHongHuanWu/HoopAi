/**
 * Orbit camera + perspective projection for the Form Studio 3D stage.
 *
 * Consumes lifted skeletons ({@link Frame3D} from ./lift) in the shared world
 * contract: +x right, +y DOWN, +z toward the viewer at zero yaw, units are
 * body-heights, hip-center at y = 0. The camera orbits a fixed target on the
 * vertical axis and projects with a plain pinhole model — number triples and
 * two rotate steps, no matrix library, so per-frame work stays cheap.
 *
 * Every function is pure and returns new objects; nothing mutates its inputs.
 * Pure TypeScript: no I/O, no wall clock, no React/Skia imports.
 */
import type { PoseKeypointName } from '../types';
import type { Frame3D } from './lift';

export interface OrbitCamera {
  /** Orbit angle around the vertical axis, degrees, wrapped to (-180, 180]. */
  yawDeg: number;
  /** Elevation angle, degrees; negative looks down at the shooter. */
  pitchDeg: number;
  /** Camera-to-target distance in body-heights. */
  distance: number;
  /** Vertical field of view, degrees. */
  fovDeg: number;
  /** World y of the orbit target (mid-torso: hips are y = 0 and +y is DOWN). */
  targetY: number;
}

export const PITCH_MIN = -70;
export const PITCH_MAX = 25;
export const DIST_MIN = 1.8;
export const DIST_MAX = 6;

/** Slightly off-axis, slightly above, framing the whole body. */
export const DEFAULT_CAMERA: OrbitCamera = {
  yawDeg: 25,
  pitchDeg: -8,
  distance: 3.2,
  fovDeg: 40,
  targetY: -0.25,
};

const DEG2RAD = Math.PI / 180;
/** Points closer than this along the view axis are culled (behind/at camera). */
const NEAR_PLANE = 0.05;

const clampNum = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Wrap degrees into (-180, 180]. */
const wrapDeg = (deg: number): number => {
  let d = deg % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
};

/**
 * Apply a pan drag to the camera. A horizontal drag across the full viewport
 * width spins a half revolution (180°); vertical drag tilts at half that rate
 * and clamps so the shooter can never flip upside down.
 */
export function orbitFromDrag(
  cam: OrbitCamera,
  dxPx: number,
  dyPx: number,
  viewportW: number,
): OrbitCamera {
  const w = Math.max(1, viewportW);
  return {
    ...cam,
    yawDeg: wrapDeg(cam.yawDeg + dxPx * (180 / w)),
    pitchDeg: clampNum(cam.pitchDeg + dyPx * (90 / w), PITCH_MIN, PITCH_MAX),
  };
}

/** Apply a pinch scale factor (>1 zooms in) with hard distance limits. */
export function pinchZoom(cam: OrbitCamera, scale: number): OrbitCamera {
  return {
    ...cam,
    distance: clampNum(cam.distance / Math.max(0.01, scale), DIST_MIN, DIST_MAX),
  };
}

export interface Projected {
  /** Screen x in px. */
  x: number;
  /** Screen y in px. */
  y: number;
  /** Camera-space distance along the view axis; larger = farther away. */
  depth: number;
}

/**
 * Project a world point to screen px, or null when it sits behind the near
 * plane. View transform: p' = R_x(-pitch) · R_y(-yaw) · (p - target); the
 * camera sits `distance` in front of the target along the rotated view axis,
 * so camera-space depth is `distance - p'.z`. World y is already DOWN, so
 * screen y needs no flip.
 */
export function projectPoint(
  p: { x: number; y: number; z: number },
  cam: OrbitCamera,
  vp: { w: number; h: number },
): Projected | null {
  const yaw = cam.yawDeg * DEG2RAD;
  const pitch = cam.pitchDeg * DEG2RAD;
  const px = p.x;
  const py = p.y - cam.targetY;
  const pz = p.z;
  // R_y(-yaw): rotate about the vertical axis.
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = px * cy - pz * sy;
  const z1 = px * sy + pz * cy;
  // R_x(-pitch): rotate about the screen-horizontal axis.
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = py * cp + z1 * sp;
  const z2 = -py * sp + z1 * cp;
  const zc = cam.distance - z2;
  if (zc <= NEAR_PLANE) return null;
  const f = vp.h / 2 / Math.tan((cam.fovDeg * DEG2RAD) / 2);
  return {
    x: vp.w / 2 + (f * x1) / zc,
    y: vp.h / 2 + (f * y2) / zc,
    depth: zc,
  };
}

export interface BoneSeg {
  a: Projected;
  b: Projected;
  /** Midpoint depth used for painter sorting and depth cueing. */
  depth: number;
  joints: readonly [PoseKeypointName, PoseKeypointName];
  /** min of the two joint confidences — honesty flows through rendering. */
  c: number;
}

/**
 * Project every bone whose joints both exist and both land in front of the
 * camera, sorted far→near (painter's algorithm: near bones draw last and
 * overlap far ones).
 */
export function projectSkeleton(
  frame: Frame3D,
  bones: readonly (readonly [PoseKeypointName, PoseKeypointName])[],
  cam: OrbitCamera,
  vp: { w: number; h: number },
): BoneSeg[] {
  // Joints are shared between bones — project each unique joint once.
  const cache: Partial<Record<PoseKeypointName, Projected | null>> = {};
  const project = (name: PoseKeypointName): Projected | null => {
    if (name in cache) return cache[name] ?? null;
    const joint = frame[name];
    const proj = joint ? projectPoint(joint, cam, vp) : null;
    cache[name] = proj;
    return proj;
  };
  const segs: BoneSeg[] = [];
  for (const bone of bones) {
    const jointA = frame[bone[0]];
    const jointB = frame[bone[1]];
    if (!jointA || !jointB) continue;
    const a = project(bone[0]);
    const b = project(bone[1]);
    if (!a || !b) continue;
    segs.push({
      a,
      b,
      depth: (a.depth + b.depth) / 2,
      joints: bone,
      c: Math.min(jointA.c, jointB.c),
    });
  }
  segs.sort((p, q) => q.depth - p.depth);
  return segs;
}

/**
 * Cheap depth cueing: nearer bones draw thicker. Scale is relative to the
 * orbit distance so zooming keeps the target's stroke near `base`.
 */
export function strokeWidthFor(depth: number, cam: OrbitCamera, base: number): number {
  return clampNum(base * (cam.distance / Math.max(0.1, depth)), 0.5 * base, 1.8 * base);
}

/**
 * Square reference grid on the horizontal plane y = opts.y (the ankle plane),
 * as projected line segments. Lines run parallel to world x and world z from
 * -extent..+extent every `step`; lines with an endpoint behind the near plane
 * are dropped.
 */
export function groundGrid(
  cam: OrbitCamera,
  vp: { w: number; h: number },
  opts: { y: number; extent?: number; step?: number },
): [Projected, Projected][] {
  const extent = opts.extent ?? 1.2;
  const step = opts.step ?? 0.3;
  const lines: [Projected, Projected][] = [];
  const count = Math.round((2 * extent) / step) + 1;
  for (let i = 0; i < count; i++) {
    const t = -extent + i * step;
    const xA = projectPoint({ x: -extent, y: opts.y, z: t }, cam, vp);
    const xB = projectPoint({ x: extent, y: opts.y, z: t }, cam, vp);
    if (xA && xB) lines.push([xA, xB]);
    const zA = projectPoint({ x: t, y: opts.y, z: -extent }, cam, vp);
    const zB = projectPoint({ x: t, y: opts.y, z: extent }, cam, vp);
    if (zA && zB) lines.push([zA, zB]);
  }
  return lines;
}
