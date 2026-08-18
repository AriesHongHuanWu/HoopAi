/**
 * friendBoardStore — where a friend leaderboard actually LIVES on this phone.
 *
 * WHY this exists: src/core/challengeShare.ts is deliberately pure. It can
 * encode an invite, decode a friend's result and merge rows, but it has
 * nowhere to keep what it merged — and a challenge is asynchronous by design
 * (you AirDrop an invite today, their result comes back tomorrow). This is
 * that nowhere. It mirrors settingsStore / profileStore exactly (zustand +
 * persist over expo-sqlite's key-value store) because that is the one
 * persistence pattern this app has.
 *
 * WHY boards are PER CHALLENGE: mergeLeaderboard is documented as per-invite
 * ("the caller keeps Map<inviteId, LeaderRow[]>"). Pooling every result into
 * one list would rank a corner-3s score against a free-throw score and present
 * it as a standing — a lie dressed as a leaderboard. So boards are keyed by
 * ChallengeInvite.id and never merged across ids.
 *
 * HONESTY (this is the product requirement, not a nicety):
 * - Nothing here syncs. Every row got here because a link or code was opened
 *   or pasted ON this device, so a board is exactly "the results that reached
 *   this phone" — never complete, never a world ranking.
 * - Scores are self-reported. challengeShare's checksum catches a truncated
 *   paste or a mangled scan; it is not a signature and cannot catch a friend
 *   who edited their own number.
 * - The store writes only what arrived. An invite carries a `target`, not the
 *   sender's result, so {@link FriendBoardState.addInvite} creates an EMPTY
 *   board rather than inventing a row for them.
 * - Nothing is evicted automatically. A board is a handful of names and
 *   numbers; silently dropping a friend's result to save bytes would be
 *   precisely the invisible data loss this feature must not have.
 *   {@link FriendBoardState.forget} is the user's own explicit control.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  mergeLeaderboard,
  resultToLeaderRow,
  type ChallengeInvite,
  type ChallengeResult,
  type LeaderRow,
} from '../core/challengeShare';

export interface FriendBoardState {
  /** Invites this phone knows about, newest `createdMs` first. */
  invites: ChallengeInvite[];
  /** Per-challenge rows, keyed by {@link ChallengeInvite.id}. */
  boards: Record<string, LeaderRow[]>;
  /** Which challenge the screen is showing, or null before anything arrives. */
  selectedId: string | null;

  /**
   * Track an invite (yours or a friend's) and show it. Re-adding the same id
   * replaces the stored copy rather than duplicating it, so pasting the same
   * link twice is a no-op the user can't tell apart from the first time.
   */
  addInvite: (invite: ChallengeInvite) => void;
  /**
   * Merge one decoded result into its challenge's board and show it. `isMe`
   * is an explicit decision at the call site (challengeShare's rule): pass
   * true only for a result THIS user produced. mergeLeaderboard keeps one row
   * per person at their best score, so a re-shared worse attempt can never
   * demote anyone and the same link pasted twice adds nothing.
   */
  addResult: (result: ChallengeResult, isMe?: boolean) => void;
  /** Switch the visible challenge. */
  select: (id: string | null) => void;
  /** Drop a challenge and its board from this phone. The only deletion path. */
  forget: (id: string) => void;
}

export const useFriendBoard = create<FriendBoardState>()(
  persist(
    (set) => ({
      invites: [],
      boards: {},
      selectedId: null,

      addInvite: (invite) =>
        set((s) => ({
          invites: [invite, ...s.invites.filter((i) => i.id !== invite.id)].sort(
            (a, b) => b.createdMs - a.createdMs,
          ),
          // Created EMPTY on purpose — see the module docblock. An existing
          // board is left untouched: the invite may be arriving AFTER the
          // result that opened this board.
          boards: s.boards[invite.id] === undefined ? { ...s.boards, [invite.id]: [] } : s.boards,
          selectedId: invite.id,
        })),

      addResult: (result, isMe = false) =>
        set((s) => ({
          boards: {
            ...s.boards,
            [result.id]: mergeLeaderboard(s.boards[result.id] ?? [], [
              resultToLeaderRow(result, isMe),
            ]),
          },
          selectedId: result.id,
        })),

      select: (id) => set({ selectedId: id }),

      forget: (id) =>
        set((s) => {
          const { [id]: _dropped, ...boards } = s.boards;
          const invites = s.invites.filter((i) => i.id !== id);
          const stillThere = s.selectedId !== null && s.selectedId !== id;
          return {
            invites,
            boards,
            selectedId: stillThere ? s.selectedId : (trackedChallengeIds({ invites, boards })[0] ?? null),
          };
        }),
    }),
    {
      name: 'hoopai-friend-board',
      storage: createJSONStorage(() => Storage),
      partialize: ({
        addInvite: _addInvite,
        addResult: _addResult,
        select: _select,
        forget: _forget,
        ...rest
      }) => rest,
      // See settingsStore.ts for the rationale on starting persisted schema
      // versioning at 1 rather than leaving it unset.
      version: 1,
      migrate: (persisted) => persisted as FriendBoardState,
    },
  ),
);

/**
 * Every challenge id this phone can show, invites first (newest first) and
 * then boards that arrived WITHOUT an invite.
 *
 * That second group is real, not a defensive edge case: a friend can send back
 * their result for a challenge whose invite never reached this device (you
 * dictated the code, or they forwarded a link to someone else). Their number
 * is still theirs, so it is kept and shown — the screen just says plainly that
 * the challenge's details aren't on this phone rather than inventing a title.
 */
export function trackedChallengeIds(s: {
  invites: readonly ChallengeInvite[];
  boards: Readonly<Record<string, LeaderRow[]>>;
}): string[] {
  const fromInvites = s.invites.map((i) => i.id);
  const seen = new Set(fromInvites);
  return [...fromInvites, ...Object.keys(s.boards).filter((id) => !seen.has(id))];
}
