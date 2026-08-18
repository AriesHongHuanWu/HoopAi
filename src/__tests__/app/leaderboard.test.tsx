/**
 * Leaderboard screen — render contract for the backend-free friend board.
 *
 * The point of this feature is that a score can only appear because somebody
 * shared it with this phone, so the tests pin the two directions that claim is
 * made of:
 * - OUT: creating a challenge from the user's real last session shares the
 *   `hoopai://challenge?d=…` link through the system sheet (which is where
 *   AirDrop lives) and shows the dictatable short code.
 * - IN: a pasted link merges through challengeShare's mergeLeaderboard and
 *   lands in rank order with the local user's row marked; a link that fails its
 *   checksum renders the visible failure and adds NOTHING — the honesty
 *   requirement, since a silent no-op or a placeholder row would both read as
 *   "your friend scored something" when nothing arrived.
 *
 * Payloads are built with the real encoders (resultLink / decodeResult), never
 * hand-written strings: a fixture that drifted out of checksum agreement would
 * silently turn the happy-path tests into error-path tests.
 */
import React from 'react';
import { Share } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { resultLink, type ChallengeInvite, type ChallengeResult } from '@/core/challengeShare';
import { useFriendBoard } from '@/state/friendBoardStore';
import { useProfile } from '@/state/profileStore';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

// enter() returns undefined (the reduced-motion idiom) so Card renders static.
jest.mock('@/components/motion', () => ({
  __esModule: true,
  useCardStagger: jest.fn(() => () => undefined),
  useStaggerAt: jest.fn(() => () => undefined),
}));

jest.mock('@/utils/haptics', () => ({
  haptic: {
    selection: jest.fn(),
    impactLight: jest.fn(),
    impactMedium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => {
  const ReactLocal = require('react') as typeof React;
  return {
    router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
  };
});

jest.mock('expo-linking', () => ({ useURL: jest.fn(() => null) }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ShotList', () => ({
  __esModule: true,
  BackPill: () => null,
  formatSessionDate: (ms: number) => `date-${ms}`,
}));

jest.mock('@/data/db', () => ({
  listSessions: jest.fn(async () => []),
}));

// The persisted stores talk to expo-sqlite's kv-store. A SYNCHRONOUS in-memory
// stand-in matters here: zustand's persist hydrates synchronously when getItem
// returns a value rather than a promise, so the screen's hydration gate is
// already open on the first render and the tests never race it.
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => null),
    setItem: jest.fn(() => {}),
    removeItem: jest.fn(() => {}),
  },
}));

// ---------------------------------------------------------------------------
// Helpers

const db = jest.requireMock('@/data/db') as { listSessions: jest.Mock };
const linking = jest.requireMock('expo-linking') as { useURL: jest.Mock };
const routerMod = jest.requireMock('expo-router') as { router: { push: jest.Mock } };

/** Unmount inside act so React's teardown never trips the act() warning. */
async function unmount(r: ReactTestRenderer): Promise<void> {
  await act(async () => {
    r.unmount();
  });
}

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {});
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

/**
 * The board's rows, top-to-bottom, as their accessibility labels. Restricted
 * to HOST instances (`typeof type === 'string'`) because RN's View is itself a
 * component that forwards props to a host view, so an unfiltered findAll
 * reports every row twice.
 */
function boardLabels(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => typeof n.type === 'string' && n.props.testID === 'leaderRow')
    .map((n) => String(n.props.accessibilityLabel));
}

/** Type into a field and press a PillButton, both found the way a user would. */
async function pasteAndAdd(r: ReactTestRenderer, text: string) {
  const input = r.root.findAll(
    (n) =>
      n.props.accessibilityLabel === 'Paste a challenge link or code' &&
      typeof n.props.onChangeText === 'function',
  )[0];
  expect(input).toBeDefined();
  await act(async () => {
    input.props.onChangeText(text);
  });
  const add = r.root.findAll(
    (n) => n.props.label === 'Add to board' && typeof n.props.onPress === 'function',
  )[0];
  expect(add).toBeDefined();
  await act(async () => {
    add.props.onPress();
  });
}

function invite(over: Partial<ChallengeInvite> = {}): ChallengeInvite {
  return {
    v: 1,
    id: 'c1',
    kind: 'makes',
    label: 'Corner 3s',
    target: 12,
    fromName: 'Aries',
    createdMs: 1_700_000_000_000,
    ...over,
  };
}

function result(over: Partial<ChallengeResult> = {}): ChallengeResult {
  return { v: 1, id: 'c1', name: 'Kai', score: 9, attempts: 12, atMs: 5000, ...over };
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    label: '',
    videoPath: null,
    keepMode: 'makes',
    recordingStartSec: null,
    modeId: null,
    modeResultJson: null,
    attempts: 12,
    makes: 8,
    fgPct: 0.66,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.listSessions.mockResolvedValue([]);
  linking.useURL.mockReturnValue(null);
  act(() => {
    useFriendBoard.setState({ invites: [], boards: {}, selectedId: null });
    useProfile.setState({ nickname: '' });
  });
});

// ---------------------------------------------------------------------------

describe('Leaderboard board', () => {
  it('renders merged rows in rank order with the user’s row marked', async () => {
    act(() => {
      const s = useFriendBoard.getState();
      s.addInvite(invite());
      // Deliberately added worst-first and out of order: the on-screen order
      // must come from mergeLeaderboard, not from arrival order.
      s.addResult({ v: 1, id: 'c1', name: 'Aries', score: 12, attempts: 20, atMs: 1000 }, true);
      s.addResult({ v: 1, id: 'c1', name: 'Kai', score: 15, attempts: 20, atMs: 2000 });
      s.addResult({ v: 1, id: 'c1', name: 'Mo', score: 12, attempts: 18, atMs: 3000 });
    });

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    // Competition ranking from rankOf, not the array index: Aries and Mo tie
    // on 12 and therefore SHARE rank 2 (no phantom 3rd place above nobody).
    expect(boardLabels(r)).toEqual([
      '1. Kai — 15',
      '2. Aries (you) — 12',
      '2. Mo — 12',
    ]);

    // Exactly one row is the local user's, and it is the one merged with isMe.
    expect(boardLabels(r).filter((l) => l.includes('(you)'))).toEqual(['2. Aries (you) — 12']);
    await unmount(r);
  });

  it('shows the challenge as results shared with this phone, never a global rank', async () => {
    act(() => {
      useFriendBoard.getState().addInvite(invite());
    });
    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    const copy = textOf(r.toJSON());
    expect(copy).toContain('Results that reached this phone');
    // An invite carries a target, not the sender's score — so it must NOT
    // manufacture a row for them.
    expect(boardLabels(r)).toEqual([]);
    expect(copy).toContain('Nothing on this board yet');
    await unmount(r);
  });
});

describe('Leaderboard inbound', () => {
  it('renders the failure and adds no row when a pasted code does not decode', async () => {
    act(() => {
      const s = useFriendBoard.getState();
      s.addInvite(invite());
      s.addResult({ v: 1, id: 'c1', name: 'Aries', score: 12, attempts: 20, atMs: 1000 }, true);
    });

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);
    expect(boardLabels(r)).toHaveLength(1);

    await pasteAndAdd(r, 'hoopai://result?d=totally-not-a-real-payload');

    expect(textOf(r.toJSON())).toContain("That code didn't scan");
    // The whole point: nothing was invented to fill the gap.
    expect(boardLabels(r)).toEqual(['1. Aries (you) — 12']);
    expect(useFriendBoard.getState().boards.c1).toHaveLength(1);
    await unmount(r);
  });

  it('adds exactly one row for a valid pasted result link', async () => {
    act(() => {
      const s = useFriendBoard.getState();
      s.addInvite(invite());
      s.addResult({ v: 1, id: 'c1', name: 'Aries', score: 12, attempts: 20, atMs: 1000 }, true);
    });

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);
    expect(boardLabels(r)).toHaveLength(1);

    await pasteAndAdd(r, resultLink(result()));

    expect(boardLabels(r)).toEqual(['1. Aries (you) — 12', '2. Kai — 9']);
    expect(textOf(r.toJSON())).not.toContain("That code didn't scan");
    expect(textOf(r.toJSON())).toContain('Added Kai — 9');
    await unmount(r);
  });

  it('ingests a hoopai link that launched the app', async () => {
    act(() => {
      useFriendBoard.getState().addInvite(invite());
    });
    linking.useURL.mockReturnValue(resultLink(result({ name: 'Sam', score: 7 })));

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    expect(boardLabels(r)).toEqual(['1. Sam — 7']);
    await unmount(r);
  });
});

describe('Leaderboard outbound', () => {
  it('shares the invite link through the system sheet and shows the short code', async () => {
    db.listSessions.mockResolvedValue([sessionRow()]);
    useProfile.setState({ nickname: 'Aries' });
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' } as Awaited<ReturnType<typeof Share.share>>);

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    const btn = r.root.findAll(
      (n) => n.props.label === 'Share challenge' && typeof n.props.onPress === 'function',
    )[0];
    expect(btn.props.disabled).toBe(false);
    await act(async () => {
      btn.props.onPress();
    });

    expect(shareSpy).toHaveBeenCalledTimes(1);
    const arg = shareSpy.mock.calls[0][0] as { message: string; url: string };
    expect(arg.url).toMatch(/^hoopai:\/\/challenge\?d=/);
    // Android drops `url`, so the link has to survive inside the message too.
    expect(arg.message).toContain(arg.url);

    // The share seeds the board with the sender's OWN real session result.
    expect(boardLabels(r)).toEqual(['1. Aries (you) — 8']);
    // XXXX-XXXX dictatable code, on screen and in the message.
    const code = textOf(r.toJSON()).match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);
    expect(code).not.toBeNull();
    expect(arg.message).toContain(code![0]);
    shareSpy.mockRestore();
    await unmount(r);
  });

  it('refuses to build a challenge when there is no session to build it from', async () => {
    db.listSessions.mockResolvedValue([]);
    useProfile.setState({ nickname: 'Aries' });

    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    const btn = r.root.findAll(
      (n) => n.props.label === 'Share challenge' && typeof n.props.onPress === 'function',
    )[0];
    expect(btn.props.disabled).toBe(true);
    expect(textOf(r.toJSON())).toContain('No sessions on this phone yet');
    await unmount(r);
  });
});

describe('Leaderboard entry point', () => {
  it('rides in the Data tab’s EXPLORE nav row and pushes /leaderboard', async () => {
    const { NavTileRow } = require('@/components/NavTiles');
    const r = await render(
      <NavTileRow
        eyebrow="EXPLORE"
        tiles={[{ icon: 'trending-up', label: 'Trends', hint: 'h', onPress: () => {} }]}
      />,
    );

    const tile = r.root.findAll(
      (n) => n.props.accessibilityLabel === 'Leaderboard' && typeof n.props.onPress === 'function',
    )[0];
    expect(tile).toBeDefined();
    await act(async () => {
      tile.props.onPress();
    });
    expect(routerMod.router.push).toHaveBeenCalledWith('/leaderboard');
    await unmount(r);
  });
});

describe('Leaderboard empty paste', () => {
  it('cannot report a scan failure when nothing was pasted', async () => {
    const LeaderboardScreen = require('../../app/leaderboard').default;
    const r = await render(<LeaderboardScreen />);

    // The error copy must mean "a real payload failed to decode", so the
    // button is unreachable while the field is empty.
    const add = r.root.findAll(
      (n) => n.props.label === 'Add to board' && typeof n.props.onPress === 'function',
    )[0];
    expect(add.props.disabled).toBe(true);
    expect(textOf(r.toJSON())).not.toContain("That code didn't scan");

    // Whitespace is not a payload either.
    const input = r.root.findAll(
      (n) =>
        n.props.accessibilityLabel === 'Paste a challenge link or code' &&
        typeof n.props.onChangeText === 'function',
    )[0];
    await act(async () => {
      input.props.onChangeText('   ');
    });
    const stillAdd = r.root.findAll(
      (n) => n.props.label === 'Add to board' && typeof n.props.onPress === 'function',
    )[0];
    expect(stillAdd.props.disabled).toBe(true);
    await unmount(r);
  });
});
