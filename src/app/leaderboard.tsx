/**
 * Leaderboard — challenge a friend and compare scores with NO BACKEND.
 *
 * This is the UI over src/core/challengeShare.ts. Hoopilot has no account and
 * no server; the video never leaves the phone. So a "friend leaderboard" here
 * is built entirely out of things the user chose to hand over: a challenge is
 * packed into a `hoopai://challenge?d=…` link, the friend shoots it locally,
 * and their result comes back as `hoopai://result?d=…`. Merging those payloads
 * IS the leaderboard.
 *
 * TRANSPORT — the link, the short code and the system share sheet, nothing
 * else. React Native's `Share.share({ message, url })` opens the OS share
 * sheet, and on iOS that sheet is where AirDrop lives: there is no separate
 * AirDrop API to call, so the share sheet IS the deck's AirDrop path. There is
 * deliberately NO QR renderer: this project has no react-native-svg and no QR
 * library, and adding a dependency to draw a square that encodes the same
 * string the share sheet already carries would buy nothing. The dictatable
 * `shortCode` covers the "read it out across the gym" case; it is a one-way
 * fingerprint for CONFIRMING two people hold the same challenge, never a
 * compressed copy of it (challengeShare has no decodeShortCode, by design).
 *
 * INBOUND — paste, or the link that launched the app. The TextInput accepts a
 * full link OR a bare payload, and every decode goes through challengeShare's
 * tolerant parsers. `Linking.useURL()` picks up a `hoopai://` link that opened
 * the app so a tapped AirDrop lands here without retyping. Note the honest
 * limit: nothing at the root layout routes an inbound link to this screen yet,
 * so a launch link is ingested when the user opens Leaderboard, not before.
 *
 * HONESTY, which is the point of the screen:
 * - A decode failure says so ("That code didn't scan") and adds NOTHING. It is
 *   never a silent no-op and never a placeholder row.
 * - The board is captioned as results that reached THIS phone. It is not a
 *   world ranking, it cannot be complete, and a friend's score is self-reported
 *   — the checksum catches a mangled paste, not an edited number.
 * - An invite carries a target, not the sender's result, so receiving one adds
 *   a challenge and an EMPTY board rather than a row nobody reported.
 * - With no session, no makes, or an unreadable database, the create card says
 *   which of those it is instead of offering a challenge built on a guess.
 */
import * as Linking from 'expo-linking';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { useCardStagger } from '@/components/motion';
import { BackPill, formatSessionDate } from '@/components/ShotList';
import { Card, Eyebrow, EmptyState, ErrorCard, PillButton, Row, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import {
  decodeInvite,
  decodeResult,
  deriveInviteId,
  inviteLink,
  parseHoopaiLink,
  rankOf,
  shortCode,
  type ChallengeInvite,
  type ChallengeResult,
} from '@/core/challengeShare';
import { listSessions, type SessionSummaryRow } from '@/data/db';
import { trackedChallengeIds, useFriendBoard } from '@/state/friendBoardStore';
import { useProfile } from '@/state/profileStore';
import { haptic } from '@/utils/haptics';

/**
 * Field caps mirroring challengeShare's MAX_NAME_CHARS / MAX_LABEL_CHARS. Kept
 * as constants here (they are content limits, not layout) so a long nickname
 * is trimmed BEFORE encoding rather than producing a payload its own decoder
 * would then reject.
 */
const NAME_MAX = 40;
const LABEL_MAX = 80;

/** True once the persisted board has rehydrated (same gate as records.tsx). */
function useFriendBoardHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useFriendBoard.persist.hasHydrated());
  useEffect(() => {
    if (useFriendBoard.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useFriendBoard.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

/** What the last inbound paste / link did. Drives the honest status block. */
type Inbox =
  | { kind: 'idle' }
  | { kind: 'error' }
  | { kind: 'invite'; from: string; label: string }
  | { kind: 'result'; name: string; score: number; rank: number | null; known: boolean };

/** The most recent session, or why there isn't one to challenge with. */
type Recent =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; row: SessionSummaryRow | null };

// ---------------------------------------------------------------------------

/**
 * One standing on the board. Rank comes from challengeShare's `rankOf`
 * (competition ranking, so a tie shares a rank) rather than the array index,
 * and the local user's row is tinted AND labelled "(you)" — colour alone would
 * carry the whole signal otherwise.
 */
function LeaderRowView({
  name,
  score,
  attempts,
  rank,
  isMe,
}: {
  name: string;
  score: number;
  attempts?: number;
  rank: number | null;
  isMe: boolean;
}) {
  const label = `${rank ?? '—'}. ${name}${isMe ? ' (you)' : ''} — ${score}`;
  return (
    <View
      testID="leaderRow"
      accessible
      accessibilityLabel={label}
      style={[styles.leaderRow, isMe && styles.leaderRowMe]}
    >
      <Text style={[styles.rank, isMe && styles.rankMe]}>{rank ?? '—'}</Text>
      <View style={styles.leaderWho}>
        <Text style={[styles.leaderName, isMe && styles.leaderNameMe]} numberOfLines={1}>
          {name}
          {isMe ? ' (you)' : ''}
        </Text>
        {attempts !== undefined && (
          <Text style={styles.leaderMeta}>{`of ${attempts} attempts`}</Text>
        )}
      </View>
      <Text style={[styles.score, isMe && styles.scoreMe]}>{score}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

export default function LeaderboardScreen() {
  const enter = useCardStagger();
  const hydrated = useFriendBoardHydrated();

  const invites = useFriendBoard((s) => s.invites);
  const boards = useFriendBoard((s) => s.boards);
  const selectedId = useFriendBoard((s) => s.selectedId);
  const addInvite = useFriendBoard((s) => s.addInvite);
  const addResult = useFriendBoard((s) => s.addResult);
  const select = useFriendBoard((s) => s.select);
  const forget = useFriendBoard((s) => s.forget);

  // The name that goes out with a challenge. Seeded from the profile nickname,
  // but only until the user types — the profile store hydrates asynchronously,
  // so a plain useState initializer would keep an empty field forever.
  const nickname = useProfile((s) => s.nickname);
  const [myName, setMyName] = useState('');
  const nameTouched = useRef(false);
  useEffect(() => {
    if (!nameTouched.current) setMyName(nickname);
  }, [nickname]);

  const [recent, setRecent] = useState<Recent>({ status: 'loading' });
  const [paste, setPaste] = useState('');
  const [inbox, setInbox] = useState<Inbox>({ kind: 'idle' });
  const [shared, setShared] = useState<{ code: string; link: string } | null>(null);
  const [shareFailed, setShareFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listSessions(1)
        .then((rows) => {
          if (!alive) return;
          setRecent({ status: 'ready', row: rows[0] ?? null });
        })
        .catch(() => {
          if (!alive) return;
          setRecent({ status: 'failed' });
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  // -------------------------------------------------------------------------
  // Inbound

  /**
   * Decode one pasted string (link OR bare payload) and merge it. Returns
   * whether anything was added. Order matters: parseHoopaiLink first because
   * it knows the url shapes, then the raw decoders for a payload pasted on its
   * own. Every failure path lands on the SAME visible error — there is no
   * branch here that quietly does nothing.
   */
  const ingest = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      const link = text.length > 0 ? parseHoopaiLink(text) : null;

      const invite = link?.type === 'invite' ? link.invite : decodeInvite(text);
      if (invite !== null) {
        addInvite(invite);
        setInbox({ kind: 'invite', from: invite.fromName, label: invite.label });
        haptic.success();
        return true;
      }

      const result = link?.type === 'result' ? link.result : decodeResult(text);
      if (result !== null) {
        addResult(result, false);
        // Read back through the store: mergeLeaderboard may have collapsed
        // this into an existing row, so the rank has to come from what the
        // board actually holds now, not from the payload.
        const after = useFriendBoard.getState();
        setInbox({
          kind: 'result',
          name: result.name,
          score: result.score,
          rank: rankOf(after.boards[result.id] ?? [], result.name),
          known: after.invites.some((i) => i.id === result.id),
        });
        haptic.success();
        return true;
      }

      setInbox({ kind: 'error' });
      haptic.error();
      return false;
    },
    [addInvite, addResult],
  );

  const onAdd = useCallback(() => {
    if (ingest(paste)) setPaste('');
  }, [ingest, paste]);

  // A `hoopai://` link that opened the app. Ingested once per distinct url and
  // only after hydration, so it can't be overwritten by the rehydrate that
  // lands a tick later.
  const launchUrl = Linking.useURL();
  const ingestedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || launchUrl === null) return;
    if (ingestedUrl.current === launchUrl) return;
    ingestedUrl.current = launchUrl;
    // Any other url that happened to open the app is somebody else's business;
    // shouting "that code didn't scan" at it would be a lie.
    if (parseHoopaiLink(launchUrl) === null) return;
    ingest(launchUrl);
  }, [hydrated, launchUrl, ingest]);

  // -------------------------------------------------------------------------
  // Outbound

  const trimmedName = myName.trim().slice(0, NAME_MAX);
  const recentRow = recent.status === 'ready' ? recent.row : null;
  const canChallenge =
    hydrated && trimmedName.length > 0 && recentRow !== null && recentRow.makes > 0;

  const onShareChallenge = useCallback(async () => {
    if (!canChallenge || recentRow === null) return;
    const createdMs = Date.now();
    const label = (
      recentRow.label.trim().length > 0
        ? recentRow.label.trim()
        : `${formatSessionDate(recentRow.startedAt)} session`
    ).slice(0, LABEL_MAX);
    const id = deriveInviteId(trimmedName, label, createdMs);
    const invite: ChallengeInvite = {
      v: 1,
      id,
      kind: 'makes',
      label,
      target: recentRow.makes,
      fromName: trimmedName,
      createdMs,
    };
    // The sender's own row is a REAL result (it is the session that set the
    // target), so it seeds the board with isMe. Nothing is invented: score and
    // attempts come straight off the stored session.
    const mine: ChallengeResult = {
      v: 1,
      id,
      name: trimmedName,
      score: recentRow.makes,
      attempts: recentRow.attempts,
      atMs: recentRow.endedAt ?? recentRow.startedAt,
    };
    addInvite(invite);
    addResult(mine, true);

    const link = inviteLink(invite);
    const code = shortCode(invite);
    setShared({ code, link });
    setShareFailed(false);
    haptic.impactMedium();
    try {
      // The system sheet — AirDrop, Messages, anything the OS offers. The link
      // is repeated inside `message` because Android's Share drops `url`
      // entirely, and a challenge text without its link is useless.
      await Share.share({
        message: `${trimmedName} is challenging you on Hoopilot: beat ${recentRow.makes} makes on "${label}". Code ${code}\n${link}`,
        url: link,
      });
    } catch {
      setShareFailed(true);
    }
  }, [canChallenge, recentRow, trimmedName, addInvite, addResult]);

  // -------------------------------------------------------------------------
  // Board selection

  const ids = useMemo(() => trackedChallengeIds({ invites, boards }), [invites, boards]);
  const activeId = selectedId !== null && ids.includes(selectedId) ? selectedId : (ids[0] ?? null);
  const rows = useMemo(
    () => (activeId !== null ? (boards[activeId] ?? []) : []),
    [activeId, boards],
  );
  const activeInvite: ChallengeInvite | null =
    activeId !== null ? (invites.find((i) => i.id === activeId) ?? null) : null;
  const ranked = useMemo(
    () => rows.map((row) => ({ row, rank: rankOf(rows, row.name) })),
    [rows],
  );
  const myRank = useMemo(
    () => (trimmedName.length === 0 ? null : rankOf(rows, trimmedName)),
    [rows, trimmedName],
  );

  return (
    <Screen scroll>
      <BackPill />
      <Eyebrow>Friends</Eyebrow>
      <Text style={styles.title} accessibilityRole="header">
        Leaderboard
      </Text>

      <Card style={styles.card} entering={enter(0)}>
        {/* The heading is a test-pinned honesty line; the body is the claim
            COMPRESSED (text diet), not softened: no server, only what was
            shared, self-reported. */}
        <Text style={styles.cardHeading}>Results that reached this phone</Text>
        <Text style={styles.body}>
          No server, no account — challenges and results travel as links between phones. Only
          what was shared with you shows here, and every score is self-reported.
        </Text>
      </Card>

      {/* CREATE ------------------------------------------------------------ */}
      <Card style={styles.card} entering={enter(1)}>
        <Text style={styles.cardHeading}>Challenge a friend</Text>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          accessibilityLabel="Your name on the challenge"
          value={myName}
          onChangeText={(t) => {
            nameTouched.current = true;
            setMyName(t.slice(0, NAME_MAX));
          }}
          placeholder="Name your friend will recognise"
          placeholderTextColor={color.textFaint}
          maxLength={NAME_MAX}
          style={styles.input}
        />

        {recent.status === 'loading' && <Text style={styles.body}>Reading your last session…</Text>}

        {recent.status === 'failed' && (
          <Text style={styles.warn}>
            Couldn&apos;t read your sessions, so there is no score to challenge with. Nothing was
            sent.
          </Text>
        )}

        {recent.status === 'ready' && recentRow === null && (
          <Text style={styles.warn}>
            No sessions on this phone yet. Record one and its makes become the number your friend
            has to beat.
          </Text>
        )}

        {recent.status === 'ready' && recentRow !== null && recentRow.makes === 0 && (
          <Text style={styles.warn}>
            Your last session has no makes, so there is no target to send. Shoot a session with at
            least one make first.
          </Text>
        )}

        {recentRow !== null && recentRow.makes > 0 && (
          <>
            <Row style={styles.metaRow}>
              <Text style={styles.body}>
                {`Last session: ${recentRow.makes} of ${recentRow.attempts} · ${formatSessionDate(recentRow.startedAt)}`}
              </Text>
            </Row>
            <Text style={styles.hint}>
              Your friend gets a challenge to beat {recentRow.makes} makes — sent over AirDrop,
              Messages or anything on the share sheet.
            </Text>
          </>
        )}

        <PillButton
          label="Share challenge"
          icon="share-outline"
          onPress={() => {
            void onShareChallenge();
          }}
          disabled={!canChallenge}
          style={styles.action}
        />
        {trimmedName.length === 0 && (
          <Text style={styles.hint}>Add your name so your friend knows who challenged them.</Text>
        )}

        {shared !== null && (
          <View style={styles.codeBlock}>
            <Text style={styles.label}>Dictatable code</Text>
            <Text style={styles.code} accessibilityLabel={`Challenge code ${shared.code}`}>
              {shared.code}
            </Text>
            {/* Honesty compressed: the code confirms, only the link carries. */}
            <Text style={styles.hint}>
              Read it out to confirm the same challenge — the link is what carries it.
            </Text>
            <Text style={styles.link} selectable numberOfLines={3}>
              {shared.link}
            </Text>
          </View>
        )}
        {shareFailed && (
          <Text style={styles.warn}>
            The share sheet didn&apos;t complete. The challenge is saved on this phone — copy the
            link above and send it any way you like.
          </Text>
        )}
      </Card>

      {/* RECEIVE ----------------------------------------------------------- */}
      <Card style={styles.card} entering={enter(2)}>
        <Text style={styles.cardHeading}>Add a friend&apos;s challenge or result</Text>
        <Text style={styles.body}>
          Paste the whole link they sent — read on this phone, looked up nowhere.
        </Text>
        <TextInput
          accessibilityLabel="Paste a challenge link or code"
          value={paste}
          onChangeText={setPaste}
          placeholder="hoopai://result?d=…"
          placeholderTextColor={color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, styles.inputMultiline]}
        />
        <PillButton
          label="Add to board"
          icon="download-outline"
          onPress={onAdd}
          // Disabled on an empty field so pressing it cannot report "that code
          // didn't scan" when nothing was ever pasted — that error must only
          // ever mean a real payload failed to decode.
          disabled={!hydrated || paste.trim().length === 0}
          style={styles.action}
        />

        {inbox.kind === 'error' && (
          <View style={styles.inboxError}>
            <ErrorCard
              title="That code didn't scan"
              body="Nothing was added. The link or code was incomplete, mangled on the way over, or from a different version of Hoopilot. Ask them to send it again and paste the whole thing, including the hoopai:// part."
            />
          </View>
        )}
        {inbox.kind === 'invite' && (
          <Text style={styles.ok}>
            {`Challenge from ${inbox.from} added: "${inbox.label}". Nothing goes on their board until they send you a result.`}
          </Text>
        )}
        {inbox.kind === 'result' && (
          <Text style={styles.ok}>
            {`Added ${inbox.name} — ${inbox.score}${inbox.rank !== null ? `, now rank ${inbox.rank}` : ''}.${
              inbox.known
                ? ''
                : " You don't have this challenge's invite on this phone, so their number is all there is."
            }`}
          </Text>
        )}
      </Card>

      {/* BOARD ------------------------------------------------------------- */}
      {ids.length > 1 && (
        <Card style={styles.card} entering={enter(3)}>
          <Text style={styles.cardHeading}>Challenges</Text>
          <View style={styles.chipWrap}>
            {ids.map((id) => {
              const inv = invites.find((i) => i.id === id) ?? null;
              const chipLabel = inv !== null ? inv.label || inv.fromName : 'Unnamed challenge';
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: id === activeId }}
                  accessibilityLabel={`Show ${chipLabel}`}
                  onPress={() => {
                    haptic.selection();
                    select(id);
                  }}
                  style={({ pressed }) => [
                    styles.pickerChip,
                    id === activeId && styles.pickerChipOn,
                    pressed && styles.pickerChipPressed,
                  ]}
                >
                  <Text
                    style={[styles.pickerLabel, id === activeId && styles.pickerLabelOn]}
                    numberOfLines={1}
                  >
                    {chipLabel}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>
      )}

      {activeId === null ? (
        <View style={styles.card}>
          <EmptyState
            title="No challenges yet"
            body="Share one above, or paste a link a friend sent you. Whatever lands here stays on this phone."
          />
        </View>
      ) : (
        <Card style={styles.card} entering={enter(4)}>
          <Text style={styles.cardHeading}>
            {activeInvite !== null ? activeInvite.label || 'Challenge' : 'Challenge'}
          </Text>
          <Text style={styles.hint}>
            {activeInvite !== null
              ? `From ${activeInvite.fromName} · beat ${activeInvite.target} ${activeInvite.kind}`
              : // Unknown-invite honesty, compressed to one line — the claim
                // (nothing invented, shown exactly as shared) survives intact.
                'No invite on this phone — results shown exactly as shared.'}
          </Text>

          {rows.length === 0 ? (
            <Text style={styles.warn}>
              Nothing on this board yet. It fills in when a result actually reaches this phone.
            </Text>
          ) : (
            <>
              <View style={styles.board}>
                {ranked.map(({ row, rank }) => (
                  <LeaderRowView
                    key={`${row.name}-${row.atMs}`}
                    name={row.name}
                    score={row.score}
                    attempts={row.attempts}
                    rank={rank}
                    isMe={row.isMe === true}
                  />
                ))}
              </View>
              <Text style={styles.hint}>
                {myRank !== null
                  ? `You're ${myRank} of ${rows.length} here — out of the results shared with you.`
                  : "Your own result isn't on this board yet."}
              </Text>
            </>
          )}

          <PillButton
            label="Remove from this phone"
            variant="ghost"
            onPress={() => {
              haptic.selection();
              forget(activeId);
            }}
            style={styles.action}
          />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  card: {
    marginBottom: space.lg,
  },
  cardHeading: {
    ...type.heading,
    color: color.text,
    marginBottom: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
  },
  hint: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  warn: {
    ...type.body,
    color: color.unsure,
    marginTop: space.sm,
  },
  ok: {
    ...type.body,
    color: color.make,
    marginTop: space.md,
  },
  label: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  input: {
    ...type.body,
    color: color.text,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: touch.minTarget,
  },
  inputMultiline: {
    marginTop: space.md,
    minHeight: touch.minTarget * 1.5,
    textAlignVertical: 'top',
  },
  metaRow: {
    marginTop: space.md,
  },
  action: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
  codeBlock: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  code: {
    ...type.statMedium,
    color: color.accent,
  },
  link: {
    ...type.caption,
    color: color.info,
    marginTop: space.sm,
  },
  inboxError: {
    marginTop: space.md,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  pickerChip: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    maxWidth: '100%',
  },
  pickerChipOn: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  pickerChipPressed: {
    opacity: 0.7,
  },
  pickerLabel: {
    ...type.caption,
    color: color.textDim,
  },
  pickerLabelOn: {
    color: color.accent,
  },
  board: {
    marginTop: space.md,
    gap: space.sm,
  },
  leaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.minTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  leaderRowMe: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  rank: {
    ...type.statMedium,
    color: color.textFaint,
    minWidth: space.xl,
  },
  rankMe: {
    color: color.accent,
  },
  leaderWho: {
    flex: 1,
  },
  leaderName: {
    ...type.bodyMedium,
    color: color.text,
  },
  leaderNameMe: {
    color: color.accent,
  },
  leaderMeta: {
    ...type.micro,
    color: color.textFaint,
  },
  score: {
    ...type.statMedium,
    color: color.text,
  },
  scoreMe: {
    color: color.accent,
  },
});
