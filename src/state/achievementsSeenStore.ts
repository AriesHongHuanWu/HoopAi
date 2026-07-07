/**
 * Which unlocked badges the user has already SEEN on the Records screen,
 * persisted across launches (same expo-sqlite kv-store + zustand persist
 * pattern as settingsStore). Powers the subtle "NEW" pip: a badge unlocked
 * since the last Records visit shows the pip once, then is marked seen.
 *
 * `hasVisited` guards the very first visit (and fresh installs upgrading
 * into this feature): everything already unlocked is recorded silently
 * instead of drowning the board in pips.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface AchievementsSeenState {
  /** Has the Records screen been opened at least once since install? */
  hasVisited: boolean;
  /** Badge ids the user has seen in their unlocked state. */
  seenBadgeIds: string[];
  /**
   * Record the currently-unlocked badge ids as seen (idempotent union) and
   * stamp the visit. Call after computing which pips to show for THIS visit.
   */
  markSeen: (unlockedIds: readonly string[]) => void;
}

export const useAchievementsSeen = create<AchievementsSeenState>()(
  persist(
    (set) => ({
      hasVisited: false,
      seenBadgeIds: [],
      markSeen: (unlockedIds) =>
        set((s) => ({
          hasVisited: true,
          seenBadgeIds: Array.from(new Set([...s.seenBadgeIds, ...unlockedIds])),
        })),
    }),
    {
      name: 'hoopai-achievements-seen',
      storage: createJSONStorage(() => Storage),
      partialize: ({ markSeen: _markSeen, ...rest }) => rest,
      version: 1,
    },
  ),
);
