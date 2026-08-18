/**
 * challengeShare — friend challenges + a friend leaderboard with NO BACKEND.
 *
 * Hoopilot has no account and no server: the video never leaves the device.
 * That principle is what this module preserves while still delivering the
 * social loop. A challenge is made SELF-CONTAINED — everything a friend needs
 * to replay it (kind, target, spots, who sent it) is packed into a short
 * url-safe string, which becomes a `hoopai://` deep link. The link can travel
 * by AirDrop, Messages, a QR code someone points a camera at, or a code read
 * out loud. The friend shoots it locally, and their RESULT travels back the
 * same way. Nothing touches a network; the "leaderboard" is just the union of
 * result payloads each device has happened to receive.
 *
 * HONESTY NOTE: because there is no server, a leaderboard here is exactly and
 * only "the results that reached THIS phone". It is not a global ranking, it
 * cannot be complete, and a result payload is self-reported — a friend could
 * hand-edit their own number before sharing it. The checksum below catches
 * ACCIDENTAL corruption (a truncated paste, a mangled QR scan); it is not a
 * signature and deliberately does not pretend to prevent cheating. UI copy
 * should say "results shared with you", never "world rank".
 *
 * PURITY: everything here is pure and deterministic. No React, no I/O, no
 * network, and no wall-clock — every timestamp (`createdMs`, `atMs`) arrives
 * as a parameter so encode/decode/merge are unit-testable without a device.
 * Base64url and UTF-8 are implemented by hand because React Native has no
 * dependable `Buffer`, `atob`, or `btoa`.
 *
 * Format + merge discipline mirrors data/backup.ts: tolerant parsing that
 * returns null instead of throwing, an FNV-1a checksum over a canonical
 * fingerprint, and a strictly ADDITIVE merge that never deletes what you had.
 */

/** App URL scheme (must match `expo.scheme` in app.json). */
export const APP_SCHEME = 'hoopai';
/** Deep-link path segment carrying a challenge invite. */
export const INVITE_PATH = 'challenge';
/** Deep-link path segment carrying a friend's finished attempt. */
export const RESULT_PATH = 'result';
/** Query parameter holding the encoded payload. */
export const PAYLOAD_PARAM = 'd';

/** Payload schema version; the decoders reject anything else. */
export const CHALLENGE_SHARE_VERSION = 1;

/**
 * Longest payload we will even attempt to decode. A shared link is small by
 * construction (~200 chars); anything vastly larger is a bad paste, not a
 * challenge, and this bounds the work a hostile clipboard can cause.
 */
const MAX_PAYLOAD_CHARS = 4096;

/** The three things a challenge can ask for. Index order is part of the wire format. */
export const CHALLENGE_KINDS = ['score', 'makes', 'streak'] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

/**
 * A compact, self-contained challenge a friend can replay entirely offline.
 * `spots` are optional court-spot labels the sender wants shot; `target` is
 * the number to beat or reach, interpreted per `kind`.
 */
export interface ChallengeInvite {
  v: 1;
  id: string;
  kind: ChallengeKind;
  label: string;
  target: number;
  spots?: string[];
  fromName: string;
  createdMs: number;
}

/** A friend's completed attempt at the invite with the matching `id`. */
export interface ChallengeResult {
  v: 1;
  id: string;
  name: string;
  score: number;
  attempts?: number;
  atMs: number;
}

// Field length caps. Generous for real names/labels (including CJK, which is
// short in characters but 3 bytes each), tight enough that a garbage blob that
// happens to parse as JSON is still rejected.
const MAX_ID_CHARS = 64;
const MAX_LABEL_CHARS = 80;
const MAX_NAME_CHARS = 40;
const MAX_SPOTS = 32;
const MAX_SPOT_CHARS = 32;

// ---------------------------------------------------------------------------
// UTF-8 <-> bytes (hand-rolled; RN has no dependable TextEncoder/Buffer)
// ---------------------------------------------------------------------------

/**
 * UTF-8 encode a JS string. Surrogate PAIRS are combined into one code point;
 * a LONE surrogate is encoded as-is (3 bytes) rather than dropped, so any
 * string the user can type round-trips byte-identically.
 */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/**
 * UTF-8 decode. Returns null on any malformed sequence (bad lead byte, missing
 * continuation, out-of-range code point) — a garbled payload must fail here
 * rather than produce plausible-looking mojibake.
 */
function utf8String(bytes: readonly number[]): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    i += 1;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    }
    let cp: number;
    let extra: number;
    if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      return null;
    }
    if (i + extra > bytes.length) return null;
    for (let k = 0; k < extra; k++) {
      const b = bytes[i];
      i += 1;
      if ((b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp > 0x10ffff) return null;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// base64url (RFC 4648 section 5, unpadded) — url/QR safe: no '+', '/', or '='
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** charCode -> 6-bit value, or -1 for anything outside the alphabet. */
const B64_REVERSE: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Encode a string as unpadded base64url. Padding is omitted so the result can
 * be dropped straight into a query string, a QR code or a text message with no
 * escaping and nothing a link-detector will chop off.
 */
export function base64UrlEncode(input: string): string {
  const bytes = utf8Bytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    if (b1 < 0) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    if (b2 < 0) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Decode unpadded base64url back to a string, or null. Strict on purpose: an
 * out-of-alphabet character, an impossible length (n % 4 === 1), or non-zero
 * leftover padding bits all reject — that strictness is the first line of
 * defence that makes a truncated or character-flipped paste fail.
 */
export function base64UrlDecode(input: string): string | null {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const v = code < 128 ? B64_REVERSE[code] : -1;
    if (v < 0) return null;
    // Mask to the low byte first: only `bits` (<= 7) bits are still live, and
    // this keeps the accumulator well inside 32-bit range.
    acc = ((acc & 0xff) << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 6) return null; // length % 4 === 1: no such base64 string
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null; // dirty padding
  return utf8String(bytes);
}

// ---------------------------------------------------------------------------
// Checksum — FNV-1a over a canonical fingerprint (same idea as backup.ts)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit. Not cryptographic — an accidental-corruption detector. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Canonical string form of a payload's VALUES, used for both the checksum and
 * the short code. Built via JSON.stringify of a fixed-order array so every
 * field is unambiguously delimited and escaped — a label containing a comma or
 * a quote cannot collide with a different field split.
 */
function inviteFingerprint(inv: ChallengeInvite): string {
  return JSON.stringify([
    'i',
    inv.v,
    inv.id,
    inv.kind,
    inv.label,
    inv.target,
    inv.spots ?? null,
    inv.fromName,
    inv.createdMs,
  ]);
}

function resultFingerprint(r: ChallengeResult): string {
  return JSON.stringify(['r', r.v, r.id, r.name, r.score, r.attempts ?? null, r.atMs]);
}

/** Fixed 8-char hex so the checksum field itself has no ambiguous length. */
function checksumHex(fingerprint: string): string {
  return fnv1a(fingerprint).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Wire keys are single letters to keep the link short enough to AirDrop, paste
 * into a message, or fit comfortably in a QR code:
 *   y = payload type ('i' invite | 'r' result), v = version, x = checksum,
 *   i = id, k = kind index, l = label, t = target, p = spots,
 *   n = name (sender or scorer), c = createdMs, s = score, a = attempts,
 *   m = atMs.
 * The `y` tag is what stops a result blob from being read as an invite.
 */
interface WireInvite {
  y: 'i';
  v: number;
  i: string;
  k: number;
  l: string;
  t: number;
  p?: string[];
  n: string;
  c: number;
  x: string;
}

interface WireResult {
  y: 'r';
  v: number;
  i: string;
  n: string;
  s: number;
  a?: number;
  m: number;
  x: string;
}

/** Encode an invite as a compact url-safe payload string. */
export function encodeInvite(inv: ChallengeInvite): string {
  const wire: WireInvite = {
    y: 'i',
    v: CHALLENGE_SHARE_VERSION,
    i: inv.id,
    k: CHALLENGE_KINDS.indexOf(inv.kind),
    l: inv.label,
    t: inv.target,
    ...(Array.isArray(inv.spots) ? { p: inv.spots } : {}),
    n: inv.fromName,
    c: inv.createdMs,
    x: checksumHex(inviteFingerprint(inv)),
  };
  return base64UrlEncode(JSON.stringify(wire));
}

/** Encode a finished attempt as a compact url-safe payload string. */
export function encodeResult(r: ChallengeResult): string {
  const wire: WireResult = {
    y: 'r',
    v: CHALLENGE_SHARE_VERSION,
    i: r.id,
    n: r.name,
    s: r.score,
    ...(typeof r.attempts === 'number' && Number.isFinite(r.attempts) ? { a: r.attempts } : {}),
    m: r.atMs,
    x: checksumHex(resultFingerprint(r)),
  };
  return base64UrlEncode(JSON.stringify(wire));
}

function isFilledString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Shared prologue: bound the input, base64url-decode it, JSON-parse it. */
function decodeWire(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAYLOAD_CHARS) return null;
  const json = base64UrlDecode(trimmed);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Decode an invite payload, or null. NEVER throws. Rejects a payload that is
 * the wrong type, the wrong version, structurally invalid, or whose checksum
 * does not match the values it carries (truncated / garbled / hand-edited).
 */
export function decodeInvite(s: string): ChallengeInvite | null {
  const w = decodeWire(s);
  if (w === null) return null;
  if (w.y !== 'i') return null;
  if (w.v !== CHALLENGE_SHARE_VERSION) return null;
  if (!isFilledString(w.i, MAX_ID_CHARS)) return null;
  if (typeof w.k !== 'number' || !Number.isInteger(w.k)) return null;
  const kind = CHALLENGE_KINDS[w.k];
  if (kind === undefined) return null;
  if (typeof w.l !== 'string' || w.l.length > MAX_LABEL_CHARS) return null;
  if (!isFiniteNumber(w.t) || w.t <= 0) return null;
  if (!isFilledString(w.n, MAX_NAME_CHARS)) return null;
  if (!isFiniteNumber(w.c) || w.c < 0) return null;

  let spots: string[] | undefined;
  if (w.p !== undefined) {
    if (!Array.isArray(w.p) || w.p.length > MAX_SPOTS) return null;
    if (!w.p.every((x) => typeof x === 'string' && x.length <= MAX_SPOT_CHARS)) return null;
    spots = w.p as string[];
  }

  const invite: ChallengeInvite = {
    v: 1,
    id: w.i,
    kind,
    label: w.l,
    target: w.t,
    ...(spots !== undefined ? { spots } : {}),
    fromName: w.n,
    createdMs: w.c,
  };
  if (typeof w.x !== 'string' || w.x !== checksumHex(inviteFingerprint(invite))) return null;
  return invite;
}

/** Decode a result payload, or null. NEVER throws. Same rejection rules. */
export function decodeResult(s: string): ChallengeResult | null {
  const w = decodeWire(s);
  if (w === null) return null;
  if (w.y !== 'r') return null;
  if (w.v !== CHALLENGE_SHARE_VERSION) return null;
  if (!isFilledString(w.i, MAX_ID_CHARS)) return null;
  if (!isFilledString(w.n, MAX_NAME_CHARS)) return null;
  if (!isFiniteNumber(w.s)) return null;
  if (!isFiniteNumber(w.m) || w.m < 0) return null;
  if (w.a !== undefined && (!isFiniteNumber(w.a) || w.a < 0)) return null;

  const result: ChallengeResult = {
    v: 1,
    id: w.i,
    name: w.n,
    score: w.s,
    ...(w.a !== undefined ? { attempts: w.a as number } : {}),
    atMs: w.m,
  };
  if (typeof w.x !== 'string' || w.x !== checksumHex(resultFingerprint(result))) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/** `hoopai://challenge?d=<payload>` — hand this to Share.share for AirDrop. */
export function inviteLink(inv: ChallengeInvite): string {
  return `${APP_SCHEME}://${INVITE_PATH}?${PAYLOAD_PARAM}=${encodeInvite(inv)}`;
}

/** `hoopai://result?d=<payload>` — the friend's reply link. */
export function resultLink(r: ChallengeResult): string {
  return `${APP_SCHEME}://${RESULT_PATH}?${PAYLOAD_PARAM}=${encodeResult(r)}`;
}

export type HoopaiLink =
  | { type: 'invite'; invite: ChallengeInvite }
  | { type: 'result'; result: ChallengeResult };

/** Percent-decode without throwing on a malformed escape sequence. */
function safeDecodeURIComponent(v: string): string | null {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

/**
 * Parse an inbound link, or null. Deliberately tolerant about the SHAPE of the
 * URL because a link can arrive from many places, each mangling it slightly:
 * the custom scheme in all of Linking's forms (`hoopai://x`, `hoopai:///x`,
 * `hoopai:x`), a future https:// universal link with any host and path prefix,
 * a trailing slash, a `#fragment`, extra tracking query params, and a
 * percent-encoded payload.
 *
 * It is NOT tolerant about the payload: an unknown scheme, an unknown path, a
 * missing `d`, or a payload that fails its checksum all return null.
 */
export function parseHoopaiLink(url: string): HoopaiLink | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (raw.length === 0 || raw.length > MAX_PAYLOAD_CHARS) return null;

  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const scheme = raw.slice(0, colon).toLowerCase();
  if (scheme !== APP_SCHEME && scheme !== 'https' && scheme !== 'http') return null;

  // Strip the scheme, any number of leading slashes, and a #fragment.
  let rest = raw.slice(colon + 1).replace(/^\/+/, '');
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);

  const q = rest.indexOf('?');
  const pathPart = q >= 0 ? rest.slice(0, q) : rest;
  const queryPart = q >= 0 ? rest.slice(q + 1) : '';

  // The route is the LAST non-empty path segment, so both `hoopai://challenge`
  // and `https://hoopilot.app/share/challenge/` resolve the same way.
  const segments = pathPart.split('/').filter((seg) => seg.length > 0);
  const route = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : '';
  if (route !== INVITE_PATH && route !== RESULT_PATH) return null;

  let payload: string | null = null;
  for (const pair of queryPart.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    if (key !== PAYLOAD_PARAM) continue;
    payload = eq >= 0 ? safeDecodeURIComponent(pair.slice(eq + 1)) : '';
    break;
  }
  if (payload === null || payload.length === 0) return null;

  if (route === INVITE_PATH) {
    const invite = decodeInvite(payload);
    return invite === null ? null : { type: 'invite', invite };
  }
  const result = decodeResult(payload);
  return result === null ? null : { type: 'result', result };
}

// ---------------------------------------------------------------------------
// Short code — a DISPLAY / VERIFY code, not a transport
// ---------------------------------------------------------------------------

/**
 * Base32 alphabet with every confusable glyph removed: no O/0, no I/1. What
 * remains is 8 digits (2-9) plus 24 letters (A-Z without I and O), so a code
 * read out over a noisy gym can be typed back correctly.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * A short, dictatable code for an invite, formatted `XXXX-XXXX`.
 *
 * NOT ROUND-TRIPPABLE, and there is deliberately no `decodeShortCode`. Forty
 * bits cannot carry a label, a sender name and a spot list, so this is a
 * one-way fingerprint of the invite, not a compressed copy of it. Use it only
 * to CONFIRM that two people are looking at the same challenge ("is yours
 * 7K4M-P2QX?") after the invite itself arrived by link, QR or AirDrop — see
 * {@link verifyShortCode}. It is a 40-bit non-cryptographic hash: fine for
 * spotting a wrong challenge among a friend group, useless against anyone
 * deliberately forging a collision.
 */
export function shortCode(inv: ChallengeInvite): string {
  const fp = inviteFingerprint(inv);
  // Two independently-seeded FNV passes give 40 usable bits (8 base32 chars);
  // one 32-bit pass would only fill 7, which groups awkwardly.
  const hi = fnv1a(fp);
  const lo = fnv1a(fp, 0x01000193);
  // hi*256 + a low byte stays well under 2^53, so plain float math is exact.
  let value = hi * 256 + (lo & 0xff);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = CODE_ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * True when `typed` is the short code for `inv`. Forgiving about how a human
 * writes it down: case, spaces and dashes anywhere are ignored. Confusable
 * characters are NOT remapped, because {@link CODE_ALPHABET} never emits them
 * in the first place — a typed O or I really is a typo.
 */
export function verifyShortCode(inv: ChallengeInvite, typed: string): boolean {
  if (typeof typed !== 'string') return false;
  const normalize = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return normalize(typed) === normalize(shortCode(inv));
}

/**
 * A deterministic id for a new invite, derived from its own content. Pure on
 * purpose: the UI needs an id without reaching for randomness or a clock, and
 * two devices building the same invite would agree on it.
 */
export function deriveInviteId(fromName: string, label: string, createdMs: number): string {
  const fp = JSON.stringify([fromName, label, createdMs]);
  const hi = fnv1a(fp);
  const lo = fnv1a(fp, 0x01000193);
  return `${hi.toString(36)}${lo.toString(36)}`.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Leaderboard — offline, additive merge
// ---------------------------------------------------------------------------

/** One person's standing on ONE challenge's board (see mergeLeaderboard). */
export interface LeaderRow {
  name: string;
  score: number;
  attempts?: number;
  atMs: number;
  /** Marks the local user's own row so the UI can highlight it. */
  isMe?: boolean;
}

/**
 * Cap on how many rows a board renders. Only rows introduced by `incoming` are
 * ever cut — see {@link mergeLeaderboard}.
 */
export const MAX_LEADERBOARD_ROWS = 100;

/** Identity key: names are matched case-insensitively, ignoring outer space. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Drop rows that carry no usable standing, and normalize the rest. */
function sanitize(row: unknown): LeaderRow | null {
  if (row === null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name.length === 0) return null;
  if (!isFiniteNumber(r.score)) return null;
  return {
    name,
    score: r.score,
    ...(isFiniteNumber(r.attempts) ? { attempts: r.attempts } : {}),
    atMs: isFiniteNumber(r.atMs) ? r.atMs : 0,
    ...(r.isMe === true ? { isMe: true } : {}),
  };
}

/**
 * Which of two rows for the SAME person is their standing: the higher score,
 * and on a tie the one they set FIRST (an earlier `atMs`), so re-sharing an
 * identical score never quietly bumps someone down the tie-break order.
 */
function betterRow(a: LeaderRow, b: LeaderRow): LeaderRow {
  if (b.score > a.score) return b;
  if (b.score === a.score && b.atMs < a.atMs) return b;
  return a;
}

/** Board order: best score first, earliest achiever ahead on a tie, then name. */
function compareRows(a: LeaderRow, b: LeaderRow): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Merge freshly-received rows into the board you already have, offline.
 *
 * Rules, mirroring backup.ts's additive-only import:
 * - Exact duplicates (same person, same `atMs`, same score) collapse — the
 *   same result link pasted twice must not double up.
 * - One row per person, holding their BEST score. A worse re-share can never
 *   lower somebody, and their `isMe` flag is sticky once set.
 * - Sorted by {@link compareRows}; the ordering is total, so the result is
 *   deterministic regardless of input order.
 * - Capped at {@link MAX_LEADERBOARD_ROWS}, EXCEPT that anyone already on
 *   `existing` is always kept. A friend who arrives late can be cut for length;
 *   a name you already had is never deleted by a merge. That means the list may
 *   exceed the cap if you already had more people than the cap — which is the
 *   truthful outcome, not a silent data loss.
 *
 * Boards are per-challenge: the caller keeps `Map<inviteId, LeaderRow[]>` and
 * merges only rows whose `ChallengeResult.id` matches.
 */
export function mergeLeaderboard(existing: LeaderRow[], incoming: LeaderRow[]): LeaderRow[] {
  const best = new Map<string, LeaderRow>();
  const protectedKeys = new Set<string>();
  const seenExact = new Set<string>();

  const absorb = (rows: readonly LeaderRow[] | undefined, isExisting: boolean) => {
    if (!Array.isArray(rows)) return;
    for (const raw of rows) {
      const row = sanitize(raw);
      if (row === null) continue;
      const key = nameKey(row.name);
      if (isExisting) protectedKeys.add(key);
      const exact = `${key}|${row.atMs}|${row.score}`;
      if (seenExact.has(exact)) continue;
      seenExact.add(exact);
      const prev = best.get(key);
      if (prev === undefined) {
        best.set(key, row);
        continue;
      }
      const winner = betterRow(prev, row);
      best.set(key, { ...winner, ...(prev.isMe || row.isMe ? { isMe: true } : {}) });
    }
  };

  absorb(existing, true);
  absorb(incoming, false);

  const sorted = Array.from(best.values()).sort(compareRows);
  if (sorted.length <= MAX_LEADERBOARD_ROWS) return sorted;
  const kept = new Set(sorted.slice(0, MAX_LEADERBOARD_ROWS).map((r) => nameKey(r.name)));
  return sorted.filter((r) => {
    const key = nameKey(r.name);
    return kept.has(key) || protectedKeys.has(key);
  });
}

/**
 * 1-based rank of `name`, or null if that person is not on the board.
 *
 * Uses COMPETITION ranking: everyone tied on a score shares the same rank and
 * the next distinct score skips accordingly (10, 10, 8 -> ranks 1, 1, 3). It
 * reads each person's best score itself rather than trusting the array order,
 * so an unsorted or not-yet-merged list still ranks correctly.
 */
export function rankOf(rows: LeaderRow[], name: string): number | null {
  if (!Array.isArray(rows) || typeof name !== 'string') return null;
  const target = nameKey(name);
  if (target.length === 0) return null;

  const bestByName = new Map<string, number>();
  for (const raw of rows) {
    const row = sanitize(raw);
    if (row === null) continue;
    const key = nameKey(row.name);
    const prev = bestByName.get(key);
    if (prev === undefined || row.score > prev) bestByName.set(key, row.score);
  }

  const mine = bestByName.get(target);
  if (mine === undefined) return null;
  let ahead = 0;
  bestByName.forEach((score, key) => {
    if (key !== target && score > mine) ahead += 1;
  });
  return ahead + 1;
}

/**
 * Adapt a decoded {@link ChallengeResult} into a board row. Kept here so the
 * UI never has to reshape the payload by hand (and so `isMe` is an explicit
 * decision at the call site, not an accident).
 */
export function resultToLeaderRow(r: ChallengeResult, isMe = false): LeaderRow {
  return {
    name: r.name,
    score: r.score,
    ...(typeof r.attempts === 'number' ? { attempts: r.attempts } : {}),
    atMs: r.atMs,
    ...(isMe ? { isMe: true } : {}),
  };
}
