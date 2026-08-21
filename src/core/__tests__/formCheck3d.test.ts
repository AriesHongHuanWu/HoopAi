import { buildSequence, decodeSequence, type RawSeqFrame } from '../formSequence';
import type { PoseKeypointName } from '../types';
import {
  BONE_PRIORS,
  FOREARM_LEN,
  HIP_HALF_LEN,
  NECK_LEN,
  SHANK_LEN,
  SHOULDER_HALF_LEN,
  THIGH_LEN,
  TRUNK_LEN,
  UPPER_ARM_LEN,
  liftSequence,
} from '../pose3d/lift';

interface V3 {
  x: number;
  y: number;
  z: number;
}
const H = 400;
const FLOOR = 560;
const CX = 320;
const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => mul(a, 1 / len(a));
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

type Skel = Partial<Record<PoseKeypointName, V3>>;
interface Pose {
  hipDrop: number;
  lean: number;
  alpha: number;
  beta: number;
}
const KEYS: { t: number; p: Pose }[] = [
  { t: 0.0, p: { hipDrop: 0.0, lean: 5, alpha: 12, beta: 30 } },
  { t: 0.35, p: { hipDrop: 0.1, lean: 20, alpha: 10, beta: 100 } },
  { t: 0.75, p: { hipDrop: 0.03, lean: 10, alpha: 90, beta: 178 } },
  { t: 1.2, p: { hipDrop: 0.0, lean: 4, alpha: 150, beta: 168 } },
  { t: 1.7, p: { hipDrop: 0.0, lean: 3, alpha: 143, beta: 158 } },
];
const smooth = (u: number) => u * u * (3 - 2 * u);
function poseAt(t: number): Pose {
  if (t <= KEYS[0]!.t) return KEYS[0]!.p;
  if (t >= KEYS[KEYS.length - 1]!.t) return KEYS[KEYS.length - 1]!.p;
  for (let i = 1; i < KEYS.length; i++) {
    const a = KEYS[i - 1]!;
    const b = KEYS[i]!;
    if (t <= b.t) {
      const u = smooth((t - a.t) / (b.t - a.t));
      const mix = (x: number, y: number) => x + (y - x) * u;
      return {
        hipDrop: mix(a.p.hipDrop, b.p.hipDrop),
        lean: mix(a.p.lean, b.p.lean),
        alpha: mix(a.p.alpha, b.p.alpha),
        beta: mix(a.p.beta, b.p.beta),
      };
    }
  }
  return KEYS[KEYS.length - 1]!.p;
}

function skeletonAt(t: number, psiDeg: number): Skel {
  const p = poseAt(t);
  const psi = rad(psiDeg);
  const f: V3 = { x: Math.sin(psi), y: 0, z: Math.cos(psi) };
  const l: V3 = { x: Math.cos(psi), y: 0, z: -Math.sin(psi) };
  const dirDown = (aDeg: number): V3 => {
    const a = rad(aDeg);
    return { x: Math.sin(a) * f.x, y: Math.cos(a), z: Math.sin(a) * f.z };
  };
  const dirUp = (aDeg: number): V3 => {
    const a = rad(aDeg);
    return { x: Math.sin(a) * f.x, y: -Math.cos(a), z: Math.sin(a) * f.z };
  };
  const hipC: V3 = { x: CX, y: FLOOR - (0.53 - p.hipDrop) * H, z: 0 };
  const shC = add(hipC, mul(dirUp(p.lean), TRUNK_LEN * H));
  const s: Skel = {
    left_hip: add(hipC, mul(l, HIP_HALF_LEN * H)),
    right_hip: add(hipC, mul(l, -HIP_HALF_LEN * H)),
    left_shoulder: add(shC, mul(l, SHOULDER_HALF_LEN * H)),
    right_shoulder: add(shC, mul(l, -SHOULDER_HALF_LEN * H)),
  };
  s.nose = add(shC, mul(dirUp(20), NECK_LEN * H));
  for (const side of ['right', 'left'] as const) {
    const a = side === 'right' ? p.alpha : p.alpha * 0.75;
    const b = side === 'right' ? p.beta : p.beta * 0.8;
    const sh = s[`${side}_shoulder` as PoseKeypointName]!;
    const el = add(sh, mul(dirDown(a), UPPER_ARM_LEN * H));
    s[`${side}_elbow` as PoseKeypointName] = el;
    s[`${side}_wrist` as PoseKeypointName] = add(el, mul(dirDown(b), FOREARM_LEN * H));
  }
  for (const side of ['right', 'left'] as const) {
    const hip = s[`${side}_hip` as PoseKeypointName]!;
    const ankle: V3 = { x: hip.x, y: FLOOR - 0.039 * H, z: hip.z };
    const d = sub(ankle, hip);
    const L = len(d);
    const dh = norm(d);
    const T = THIGH_LEN * H;
    const S = SHANK_LEN * H;
    let knee: V3;
    if (L >= T + S) knee = add(hip, mul(dh, T));
    else {
      const cosG = (T * T + L * L - S * S) / (2 * T * L);
      const g = Math.acos(Math.min(1, Math.max(-1, cosG)));
      const nRaw = sub(f, mul(dh, dot(f, dh)));
      const n = len(nRaw) > 1e-6 ? norm(nRaw) : { x: 0, y: 0, z: 1 };
      knee = add(hip, add(mul(dh, T * Math.cos(g)), mul(n, T * Math.sin(g))));
    }
    s[`${side}_knee` as PoseKeypointName] = knee;
    s[`${side}_ankle` as PoseKeypointName] = ankle;
  }
  return s;
}

function rawFrames(psiDeg: number, fps = 30, dur = 1.7): { raw: RawSeqFrame[]; truth: Skel[] } {
  const raw: RawSeqFrame[] = [];
  const truth: Skel[] = [];
  const n = Math.round(dur * fps) + 1;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const s = skeletonAt(t, psiDeg);
    truth.push(s);
    const pts = new Map<PoseKeypointName, { x: number; y: number }>();
    for (const k of Object.keys(s) as PoseKeypointName[]) pts.set(k, { x: s[k]!.x, y: s[k]!.y });
    raw.push({ t, pts });
  }
  return { raw, truth };
}

function angle3(a: V3, b: V3, c: V3): number {
  const u = sub(a, b);
  const v = sub(c, b);
  return (Math.acos(Math.min(1, Math.max(-1, dot(u, v) / (len(u) * len(v))))) * 180) / Math.PI;
}

describe('PROBE', () => {
  it('measures encoder/lift scale compatibility', () => {
    for (const psi of [75, 40, 0]) {
      const { raw, truth } = rawFrames(psi);
      const seq = buildSequence(raw, 'right', 1.2)!;
      const dec = decodeSequence(seq);
      const lifted = liftSequence(dec, 'right')!;
      const ratios: Record<string, number[]> = {};
      for (const fr of dec) {
        for (const bp of BONE_PRIORS) {
          const a = fr[bp.a];
          const b = fr[bp.b];
          if (!a || !b) continue;
          (ratios[`${bp.a}->${bp.b}`] ??= []).push(
            Math.hypot(a.x - b.x, a.y - b.y) / bp.len,
          );
        }
      }
      const med = (v: number[]) => v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)]!;
      const R = Object.fromEntries(
        Object.entries(ratios).map(([k, v]) => [k, +med(v).toFixed(3)]),
      );
      const zAbs = lifted.frames.flatMap((fr) =>
        (['right_elbow', 'right_wrist', 'right_knee'] as PoseKeypointName[])
          .map((n) => (fr[n] ? Math.abs(fr[n]!.z) : null))
          .filter((x): x is number => x != null),
      );
      const relIdx = seq.releaseFrame ?? -1;
      const lf = lifted.frames[relIdx];
      const tIdx = Math.round(1.2 * 30);
      const trueElbow = angle3(
        truth[tIdx]!.right_shoulder!,
        truth[tIdx]!.right_elbow!,
        truth[tIdx]!.right_wrist!,
      );
      const trueKnee = angle3(
        truth[tIdx]!.right_hip!,
        truth[tIdx]!.right_knee!,
        truth[tIdx]!.right_ankle!,
      );
      const d2 = dec[relIdx]!;
      const flat = (p: { x: number; y: number }): V3 => ({ x: p.x, y: p.y, z: 0 });
      const elbow2d =
        d2.right_shoulder && d2.right_elbow && d2.right_wrist
          ? angle3(flat(d2.right_shoulder), flat(d2.right_elbow), flat(d2.right_wrist))
          : null;
      const elbow3d =
        lf?.right_shoulder && lf.right_elbow && lf.right_wrist
          ? angle3(lf.right_shoulder as V3, lf.right_elbow as V3, lf.right_wrist as V3)
          : null;
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            psi,
            frames: seq.frames,
            durationSec: +seq.durationSec.toFixed(3),
            releaseFrame: seq.releaseFrame,
            boneRatioMedian: R,
            liftConfidence: +lifted.confidence.toFixed(3),
            azimuthDeg: +lifted.azimuthDeg.toFixed(2),
            shoulderC: +(lf?.right_shoulder?.c ?? -1).toFixed(3),
            elbowC: +(lf?.right_elbow?.c ?? -1).toFixed(3),
            wristC: +(lf?.right_wrist?.c ?? -1).toFixed(3),
            maxLimbAbsZ: +Math.max(...zAbs).toFixed(4),
            trueElbow: +trueElbow.toFixed(1),
            trueKnee: +trueKnee.toFixed(1),
            elbow2d: elbow2d && +elbow2d.toFixed(1),
            elbow3d: elbow3d && +elbow3d.toFixed(1),
          },
          null,
          1,
        ),
      );
    }
    expect(true).toBe(true);
  });
});
