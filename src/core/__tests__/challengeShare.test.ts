/**
 * challengeShare — encode/decode, deep-link and leaderboard-merge tests.
 *
 * The module is pure, so every case is exercised directly: round-trips,
 * hostile/garbled input (which must return null and never throw), the link
 * shapes Linking can hand us, and the additive-merge invariants. Anything that
 * can only be checked on a device (an actual AirDrop, an actual QR scan) is
 * deliberately out of scope here.
 */
import { describe, expect, it } from '@jest/globals';

import {
  APP_SCHEME,
  base64UrlDecode,
  base64UrlEncode,
  CHALLENGE_KINDS,
  decodeInvite,
  decodeResult,
  deriveInviteId,
  encodeInvite,
  encodeResult,
  inviteLink,
  MAX_LEADERBOARD_ROWS,
  mergeLeaderboard,
  parseHoopaiLink,
  rankOf,
  resultLink,
  resultToLeaderRow,
  shortCode,
  verifyShortCode,
  type ChallengeInvite,
  type ChallengeResult,
  type LeaderRow,
} from '../challengeShare';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function invite(overrides: Partial<ChallengeInvite> = {}): ChallengeInvite {
  return {
    v: 1,
    id: 'c1',
    kind: 'makes',
    label: 'Corner 3s',
    target: 10,
    spots: ['left-corner', 'right-corner'],
    fromName: 'Aries',
    createdMs: 1_700_000_000_000,
    ...overrides,
  };
}

function result(overrides: Partial<ChallengeResult> = {}): ChallengeResult {
  return {
    v: 1,
    id: 'c1',
    name: 'Kai',
    score: 8,
    attempts: 12,
    atMs: 1_700_000_500_000,
    ...overrides,
  };
}

function row(name: string, score: number, atMs: number, extra: Partial<LeaderRow> = {}): LeaderRow {
  return { name, score, atMs, ...extra };
}

/** Flip one character of a base64url string to a different valid character. */
function flipCharAt(s: string, index: number): string {
  const c = s[index];
  const replacement = c === 'A' ? 'B' : 'A';
  return s.slice(0, index) + replacement + s.slice(index + 1);
}

// ---------------------------------------------------------------------------
// base64url primitive
// ---------------------------------------------------------------------------

describe('base64url', () => {
  it('never emits +, / or = padding', () => {
    // Bytes 0..255 cover every 6-bit group, including the two that map to
    // '+' and '/' in standard base64.
    let s = '';
    for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
    const enc = base64UrlEncode(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips ascii, unicode and emoji (surrogate pairs)', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'hello world', '吳宏寬 籃球', '🏀🔥 swish', ' ']) {
      expect(base64UrlDecode(base64UrlEncode(s))).toBe(s);
    }
  });

  it('rejects out-of-alphabet characters and impossible lengths', () => {
    expect(base64UrlDecode('ab+d')).toBeNull();
    expect(base64UrlDecode('ab/d')).toBeNull();
    expect(base64UrlDecode('abcd=')).toBeNull();
    expect(base64UrlDecode('中文')).toBeNull();
    expect(base64UrlDecode('A')).toBeNull(); // length % 4 === 1 is impossible
    expect(base64UrlDecode('AAAAA')).toBeNull();
  });

  it('rejects non-zero leftover padding bits', () => {
    // A 2-char group encodes 1 byte and leaves 4 bits that MUST be zero.
    // 'IA' -> 0x20 (a space) with clean padding; 'IB' is the same byte with a
    // dirty padding bit, which is exactly what a flipped final character looks
    // like, so it must be rejected rather than silently accepted.
    expect(base64UrlDecode('IA')).toBe(' ');
    expect(base64UrlDecode('IB')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invite encode / decode
// ---------------------------------------------------------------------------

describe('encodeInvite / decodeInvite', () => {
  it('round-trips an invite exactly', () => {
    const inv = invite();
    expect(decodeInvite(encodeInvite(inv))).toEqual(inv);
  });

  it('round-trips every kind', () => {
    for (const kind of CHALLENGE_KINDS) {
      const inv = invite({ kind });
      expect(decodeInvite(encodeInvite(inv))?.kind).toBe(kind);
    }
  });

  it('preserves the presence and absence of spots', () => {
    const withNone = invite({ spots: undefined });
    expect(decodeInvite(encodeInvite(withNone))).toEqual(withNone);
    expect(decodeInvite(encodeInvite(withNone))?.spots).toBeUndefined();

    const withEmpty = invite({ spots: [] });
    expect(decodeInvite(encodeInvite(withEmpty))?.spots).toEqual([]);
  });

  it('round-trips unicode names and labels', () => {
    const inv = invite({ fromName: '吳宏寬', label: '罰球 10 中 🏀' });
    expect(decodeInvite(encodeInvite(inv))).toEqual(inv);
  });

  it('produces a url-safe payload with no +, / or =', () => {
    expect(encodeInvite(invite())).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic — same invite, same payload', () => {
    expect(encodeInvite(invite())).toBe(encodeInvite(invite()));
  });

  it('rejects empty, whitespace and garbage input without throwing', () => {
    for (const bad of ['', '   ', 'not-a-payload!!!', '@@@@', '{}', 'null']) {
      expect(() => decodeInvite(bad)).not.toThrow();
      expect(decodeInvite(bad)).toBeNull();
    }
  });

  it('rejects a truncated payload', () => {
    const enc = encodeInvite(invite());
    for (const cut of [1, 4, 10, enc.length - 1]) {
      expect(decodeInvite(enc.slice(0, cut))).toBeNull();
    }
  });

  it('rejects a payload with a flipped character', () => {
    const enc = encodeInvite(invite());
    for (let i = 0; i < enc.length; i++) {
      expect(decodeInvite(flipCharAt(enc, i))).toBeNull();
    }
  });

  it('checksum specifically rejects a hand-edited value', () => {
    // Re-encode the wire object with a real structure but a tampered score
    // target and the ORIGINAL checksum: base64 and JSON both succeed, so only
    // the checksum can catch this.
    const enc = encodeInvite(invite());
    const json = base64UrlDecode(enc);
    expect(json).not.toBeNull();
    const wire = JSON.parse(json as string) as Record<string, unknown>;
    expect(wire.t).toBe(10);
    wire.t = 999;
    const tampered = base64UrlEncode(JSON.stringify(wire));
    expect(base64UrlDecode(tampered)).not.toBeNull(); // still valid base64+JSON
    expect(decodeInvite(tampered)).toBeNull(); // ...but the checksum says no
  });

  it('rejects an unknown version', () => {
    const wire = JSON.parse(base64UrlDecode(encodeInvite(invite())) as string);
    wire.v = 2;
    expect(decodeInvite(base64UrlEncode(JSON.stringify(wire)))).toBeNull();
  });

  it('rejects an unknown kind index', () => {
    const wire = JSON.parse(base64UrlDecode(encodeInvite(invite())) as string);
    wire.k = 99;
    expect(decodeInvite(base64UrlEncode(JSON.stringify(wire)))).toBeNull();
  });

  it('does not accept a result payload', () => {
    expect(decodeInvite(encodeResult(result()))).toBeNull();
  });

  it('rejects an absurdly long input rather than working on it', () => {
    expect(decodeInvite('A'.repeat(100_000))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Result encode / decode
// ---------------------------------------------------------------------------

describe('encodeResult / decodeResult', () => {
  it('round-trips a result exactly', () => {
    const r = result();
    expect(decodeResult(encodeResult(r))).toEqual(r);
  });

  it('preserves the presence and absence of attempts', () => {
    const noAttempts = result({ attempts: undefined });
    expect(decodeResult(encodeResult(noAttempts))).toEqual(noAttempts);
    expect(decodeResult(encodeResult(noAttempts))?.attempts).toBeUndefined();
    expect(decodeResult(encodeResult(result({ attempts: 0 })))?.attempts).toBe(0);
  });

  it('allows a zero score (an honest 0-for-10 must still be shareable)', () => {
    expect(decodeResult(encodeResult(result({ score: 0 })))?.score).toBe(0);
  });

  it('rejects empty, garbage and truncated input without throwing', () => {
    for (const bad of ['', '  ', '???', 'AAAA']) {
      expect(() => decodeResult(bad)).not.toThrow();
      expect(decodeResult(bad)).toBeNull();
    }
    const enc = encodeResult(result());
    expect(decodeResult(enc.slice(0, enc.length - 3))).toBeNull();
  });

  it('rejects a flipped character anywhere in the payload', () => {
    const enc = encodeResult(result());
    for (let i = 0; i < enc.length; i++) {
      expect(decodeResult(flipCharAt(enc, i))).toBeNull();
    }
  });

  it('checksum rejects a hand-edited score', () => {
    const wire = JSON.parse(base64UrlDecode(encodeResult(result())) as string);
    wire.s = 999;
    expect(decodeResult(base64UrlEncode(JSON.stringify(wire)))).toBeNull();
  });

  it('does not accept an invite payload', () => {
    expect(decodeResult(encodeInvite(invite()))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

describe('inviteLink / resultLink / parseHoopaiLink', () => {
  it('builds hoopai:// links on the expected routes', () => {
    expect(inviteLink(invite()).startsWith(`${APP_SCHEME}://challenge?d=`)).toBe(true);
    expect(resultLink(result()).startsWith(`${APP_SCHEME}://result?d=`)).toBe(true);
  });

  it('round-trips an invite through its link', () => {
    const inv = invite();
    const parsed = parseHoopaiLink(inviteLink(inv));
    expect(parsed?.type).toBe('invite');
    expect(parsed?.type === 'invite' ? parsed.invite : null).toEqual(inv);
  });

  it('round-trips a result through its link', () => {
    const r = result();
    const parsed = parseHoopaiLink(resultLink(r));
    expect(parsed?.type).toBe('result');
    expect(parsed?.type === 'result' ? parsed.result : null).toEqual(r);
  });

  it('tolerates the https:// universal-link form with a path prefix', () => {
    const payload = encodeInvite(invite());
    for (const url of [
      `https://hoopilot.app/challenge?d=${payload}`,
      `https://hoopilot.app/share/challenge?d=${payload}`,
      `https://hoopilot.app/challenge/?d=${payload}`,
      `http://hoopilot.app/challenge?d=${payload}`,
    ]) {
      expect(parseHoopaiLink(url)?.type).toBe('invite');
    }
  });

  it('tolerates the slash variants Linking can produce', () => {
    const payload = encodeInvite(invite());
    for (const url of [
      `hoopai://challenge?d=${payload}`,
      `hoopai:///challenge?d=${payload}`,
      `hoopai:challenge?d=${payload}`,
      `HOOPAI://Challenge?d=${payload}`,
    ]) {
      expect(parseHoopaiLink(url)?.type).toBe('invite');
    }
  });

  it('tolerates extra query params, a fragment, surrounding whitespace and percent-encoding', () => {
    const payload = encodeInvite(invite());
    expect(parseHoopaiLink(`hoopai://challenge?utm=qr&d=${payload}&ref=airdrop`)?.type).toBe(
      'invite',
    );
    expect(parseHoopaiLink(`hoopai://challenge?d=${payload}#top`)?.type).toBe('invite');
    expect(parseHoopaiLink(`  hoopai://challenge?d=${payload}  `)?.type).toBe('invite');
    expect(
      parseHoopaiLink(`hoopai://challenge?d=${encodeURIComponent(payload)}`)?.type,
    ).toBe('invite');
  });

  it('returns null for unknown schemes, unknown routes and missing payloads', () => {
    const payload = encodeInvite(invite());
    for (const url of [
      `evilapp://challenge?d=${payload}`,
      `ftp://hoopilot.app/challenge?d=${payload}`,
      `hoopai://settings?d=${payload}`,
      'hoopai://challenge',
      'hoopai://challenge?d=',
      'hoopai://challenge?x=abc',
      'hoopai://',
      'challenge?d=abc',
      '',
      '   ',
      'https://hoopilot.app/challenge?d=%E0%A4%A', // malformed percent escape
    ]) {
      expect(() => parseHoopaiLink(url)).not.toThrow();
      expect(parseHoopaiLink(url)).toBeNull();
    }
  });

  it('will not read a result payload on the invite route (or vice versa)', () => {
    expect(parseHoopaiLink(`hoopai://challenge?d=${encodeResult(result())}`)).toBeNull();
    expect(parseHoopaiLink(`hoopai://result?d=${encodeInvite(invite())}`)).toBeNull();
  });

  it('rejects a link whose payload was truncated in transit', () => {
    const link = inviteLink(invite());
    expect(parseHoopaiLink(link.slice(0, link.length - 5))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Short code (display / verify only)
// ---------------------------------------------------------------------------

describe('shortCode', () => {
  it('is 8 unambiguous characters in XXXX-XXXX form', () => {
    const code = shortCode(invite());
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(code).not.toMatch(/[O0I1]/);
  });

  it('is deterministic and changes when the invite changes', () => {
    expect(shortCode(invite())).toBe(shortCode(invite()));
    expect(shortCode(invite({ target: 11 }))).not.toBe(shortCode(invite()));
    expect(shortCode(invite({ fromName: 'Kai' }))).not.toBe(shortCode(invite()));
    expect(shortCode(invite({ spots: ['top-key'] }))).not.toBe(shortCode(invite()));
  });

  it('survives a link round-trip (the code is stable across transport)', () => {
    const decoded = decodeInvite(encodeInvite(invite()));
    expect(decoded).not.toBeNull();
    expect(shortCode(decoded as ChallengeInvite)).toBe(shortCode(invite()));
  });

  it('verifies a typed code regardless of case, spaces and dashes', () => {
    const inv = invite();
    const code = shortCode(inv);
    expect(verifyShortCode(inv, code)).toBe(true);
    expect(verifyShortCode(inv, code.toLowerCase())).toBe(true);
    expect(verifyShortCode(inv, code.replace('-', ' '))).toBe(true);
    expect(verifyShortCode(inv, code.replace('-', ''))).toBe(true);
    expect(verifyShortCode(inv, ` ${code} `)).toBe(true);
  });

  it('rejects a wrong code without throwing', () => {
    const inv = invite();
    expect(verifyShortCode(inv, 'AAAA-AAAA')).toBe(false);
    expect(verifyShortCode(inv, '')).toBe(false);
    expect(verifyShortCode(inv, shortCode(invite({ target: 99 })))).toBe(false);
  });
});

describe('deriveInviteId', () => {
  it('is deterministic and content-dependent', () => {
    expect(deriveInviteId('Aries', 'Corner 3s', 1000)).toBe(
      deriveInviteId('Aries', 'Corner 3s', 1000),
    );
    expect(deriveInviteId('Aries', 'Corner 3s', 1001)).not.toBe(
      deriveInviteId('Aries', 'Corner 3s', 1000),
    );
    expect(deriveInviteId('Kai', 'Corner 3s', 1000)).not.toBe(
      deriveInviteId('Aries', 'Corner 3s', 1000),
    );
  });

  it('fits inside the id length the decoder accepts', () => {
    const id = deriveInviteId('吳宏寬', 'a'.repeat(80), 1_700_000_000_000);
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(16);
    const inv = invite({ id });
    expect(decodeInvite(encodeInvite(inv))?.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Leaderboard merge
// ---------------------------------------------------------------------------

describe('mergeLeaderboard', () => {
  it('sorts by score descending', () => {
    const merged = mergeLeaderboard([], [row('Kai', 5, 10), row('Aries', 9, 20), row('Sam', 7, 30)]);
    expect(merged.map((r) => r.name)).toEqual(['Aries', 'Sam', 'Kai']);
  });

  it('keeps only each name\'s best score', () => {
    const merged = mergeLeaderboard(
      [row('Kai', 5, 10)],
      [row('Kai', 9, 20), row('Kai', 3, 30)],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(9);
  });

  it('never lowers an existing entry with a worse incoming one', () => {
    const merged = mergeLeaderboard([row('Kai', 12, 10)], [row('Kai', 4, 99)]);
    expect(merged[0].score).toBe(12);
    expect(merged[0].atMs).toBe(10);
  });

  it('dedupes an identical row shared twice', () => {
    const dup = row('Kai', 7, 100, { attempts: 10 });
    const merged = mergeLeaderboard([], [dup, { ...dup }, { ...dup }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(dup);
  });

  it('is idempotent — merging the same incoming twice changes nothing', () => {
    const incoming = [row('Kai', 7, 100), row('Sam', 9, 200)];
    const once = mergeLeaderboard([row('Aries', 8, 50)], incoming);
    const twice = mergeLeaderboard(once, incoming);
    expect(twice).toEqual(once);
  });

  it('breaks score ties by earliest achiever, then by name', () => {
    const merged = mergeLeaderboard(
      [],
      [row('Zoe', 7, 300), row('Kai', 7, 100), row('Sam', 7, 100)],
    );
    // Kai and Sam both scored 7 at t=100, so name order decides; Zoe was later.
    expect(merged.map((r) => r.name)).toEqual(['Kai', 'Sam', 'Zoe']);
  });

  it('is order-independent', () => {
    const rows = [row('Kai', 7, 100), row('Sam', 9, 200), row('Zoe', 7, 50)];
    const a = mergeLeaderboard([], rows);
    const b = mergeLeaderboard([], [...rows].reverse());
    expect(a).toEqual(b);
  });

  it('treats names case-insensitively as the same person', () => {
    const merged = mergeLeaderboard([row('Kai', 5, 10)], [row('  kai ', 8, 20)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(8);
  });

  it('keeps isMe sticky once set', () => {
    const merged = mergeLeaderboard([row('Kai', 5, 10, { isMe: true })], [row('Kai', 9, 20)]);
    expect(merged[0].isMe).toBe(true);
    expect(merged[0].score).toBe(9);
  });

  it('drops rows with no usable standing (empty name, non-finite score)', () => {
    const merged = mergeLeaderboard(
      [],
      [
        row('', 9, 10),
        row('   ', 9, 10),
        row('NaNny', Number.NaN, 10),
        row('Inf', Number.POSITIVE_INFINITY, 10),
        row('Kai', 5, 10),
      ],
    );
    expect(merged.map((r) => r.name)).toEqual(['Kai']);
  });

  it('does not throw on malformed rows', () => {
    const junk = [null, undefined, 42, 'nope', {}, { name: 'Kai' }] as unknown as LeaderRow[];
    expect(() => mergeLeaderboard(junk, junk)).not.toThrow();
    expect(mergeLeaderboard(junk, junk)).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const existing = [row('Kai', 5, 10)];
    const incoming = [row('Kai', 9, 20)];
    const snapshot = JSON.stringify([existing, incoming]);
    mergeLeaderboard(existing, incoming);
    expect(JSON.stringify([existing, incoming])).toBe(snapshot);
  });

  it('caps the board length when everything is new', () => {
    const incoming = Array.from({ length: MAX_LEADERBOARD_ROWS + 50 }, (_, i) =>
      row(`P${i}`, i, 1000),
    );
    const merged = mergeLeaderboard([], incoming);
    expect(merged).toHaveLength(MAX_LEADERBOARD_ROWS);
    // The cap keeps the TOP scores, not the first-seen ones.
    expect(merged[0].score).toBe(MAX_LEADERBOARD_ROWS + 49);
  });

  it('never drops an existing name, even when the cap is exceeded', () => {
    // One low-scoring friend already on the board, then a flood of better ones.
    const existing = [row('Loyal', -1, 5)];
    const incoming = Array.from({ length: MAX_LEADERBOARD_ROWS + 20 }, (_, i) =>
      row(`P${i}`, 100 + i, 1000),
    );
    const merged = mergeLeaderboard(existing, incoming);
    expect(merged.some((r) => r.name === 'Loyal')).toBe(true);
    // Length may exceed the cap by exactly the protected rows that fell out.
    expect(merged.length).toBe(MAX_LEADERBOARD_ROWS + 1);
  });

  it('keeps every existing name when the board was already over the cap', () => {
    const existing = Array.from({ length: MAX_LEADERBOARD_ROWS + 30 }, (_, i) =>
      row(`Old${i}`, i, 1000),
    );
    const merged = mergeLeaderboard(existing, [row('New', 9999, 2000)]);
    for (const e of existing) {
      expect(merged.some((r) => r.name === e.name)).toBe(true);
    }
    expect(merged.some((r) => r.name === 'New')).toBe(true);
  });

  it('accepts rows built from decoded results', () => {
    const r = result();
    const mine = resultToLeaderRow(result({ name: 'Aries', score: 11 }), true);
    const merged = mergeLeaderboard([mine], [resultToLeaderRow(r)]);
    expect(merged.map((x) => x.name)).toEqual(['Aries', 'Kai']);
    expect(merged[0].isMe).toBe(true);
    expect(merged[1].attempts).toBe(12);
    expect(merged[1].isMe).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------

describe('rankOf', () => {
  const board = [row('Aries', 12, 10), row('Kai', 9, 20), row('Sam', 9, 30), row('Zoe', 4, 40)];

  it('ranks 1-based from the top', () => {
    expect(rankOf(board, 'Aries')).toBe(1);
  });

  it('gives tied scores the same rank and skips the next (competition ranking)', () => {
    expect(rankOf(board, 'Kai')).toBe(2);
    expect(rankOf(board, 'Sam')).toBe(2);
    expect(rankOf(board, 'Zoe')).toBe(4);
  });

  it('returns null for a name that is not on the board', () => {
    expect(rankOf(board, 'Nobody')).toBeNull();
    expect(rankOf(board, '')).toBeNull();
    expect(rankOf(board, '   ')).toBeNull();
    expect(rankOf([], 'Aries')).toBeNull();
  });

  it('matches names case-insensitively and ignores outer whitespace', () => {
    expect(rankOf(board, ' aries ')).toBe(1);
  });

  it('is correct on an unsorted list and uses each name\'s best score', () => {
    const messy = [row('Kai', 1, 5), row('Zoe', 4, 40), row('Aries', 12, 10), row('Kai', 9, 20)];
    expect(rankOf(messy, 'Kai')).toBe(2);
    expect(rankOf(messy, 'Aries')).toBe(1);
    expect(rankOf(messy, 'Zoe')).toBe(3);
  });

  it('does not throw on malformed input', () => {
    const junk = [null, 7, { name: 'Kai' }] as unknown as LeaderRow[];
    expect(() => rankOf(junk, 'Kai')).not.toThrow();
    expect(rankOf(junk, 'Kai')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the actual product loop
// ---------------------------------------------------------------------------

describe('offline challenge loop', () => {
  it('invite -> link -> friend replays -> result link -> board', () => {
    // 1. I build a challenge and share the link (AirDrop / Messages / QR).
    const inv = invite({ id: deriveInviteId('Aries', 'Corner 3s', 1_700_000_000_000) });
    const link = inviteLink(inv);

    // 2. My friend's phone opens it.
    const inbound = parseHoopaiLink(link);
    expect(inbound?.type).toBe('invite');
    const received = inbound?.type === 'invite' ? inbound.invite : null;
    expect(received).toEqual(inv);

    // 3. They shoot it and send their result back on the same challenge id.
    const theirs = result({ id: (received as ChallengeInvite).id, name: 'Kai', score: 8 });
    const back = parseHoopaiLink(resultLink(theirs));
    expect(back?.type).toBe('result');
    const decoded = back?.type === 'result' ? back.result : null;
    expect(decoded?.id).toBe(inv.id);

    // 4. It lands on MY board next to my own attempt.
    const board = mergeLeaderboard(
      [resultToLeaderRow(result({ name: 'Aries', score: 6, atMs: 1 }), true)],
      [resultToLeaderRow(decoded as ChallengeResult)],
    );
    expect(board.map((r) => r.name)).toEqual(['Kai', 'Aries']);
    expect(rankOf(board, 'Aries')).toBe(2);
    expect(rankOf(board, 'Kai')).toBe(1);
  });
});
