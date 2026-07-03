/**
 * History — list of past sessions as cards: date up top, FG% as the big
 * numeral, makes/attempts meta and a mini pip row of the actual shot
 * sequence. Tapping a card opens the full session detail at /history/[id].
 * The empty state draws the signature shot arc waiting for its first make.
 */
import { Canvas, Circle, DashPathEffect, Line, Path, vec } from '@shopify/react-native-skia';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  BackPill,
  PipRow,
  formatSessionDate,
  formatSessionTime,
} from '@/components/ShotList';
import {
  Card,
  Eyebrow,
  PillButton,
  Row,
  Screen,
  StatNumber,
} from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ShotOutcome } from '@/core/types';
import { listSessions, sessionShots, type SessionSummaryRow } from '@/data/db';

interface HistoryItem {
  row: SessionSummaryRow;
  /** Shot outcome sequence for the mini pip row. */
  pips: ShotOutcome[];
}

const EMPTY_ILLO_H = 120;

/** Empty state — a dashed shot arc waiting on its first session. */
function EmptyArc() {
  const [w, setW] = useState(0);
  const h = EMPTY_ILLO_H;
  const rimX = w * 0.82;
  const rimY = h * 0.36;
  const path = `M ${w * 0.08} ${h - 18} Q ${w * 0.45} ${-h * 0.28} ${rimX} ${rimY - 10}`;
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: h }}>
      {w > 0 && (
        <Canvas style={{ width: w, height: h }}>
          <Line p1={vec(space.sm, h - 12)} p2={vec(w - space.sm, h - 12)} color={color.border} strokeWidth={2} />
          <Path path={path} style="stroke" strokeWidth={2.5} color={color.accent} opacity={0.5}>
            <DashPathEffect intervals={[1, 9]} />
          </Path>
          <Circle cx={rimX} cy={rimY} r={9} style="stroke" color={color.textDim} strokeWidth={3} />
          <Line p1={vec(rimX + 15, rimY - 24)} p2={vec(rimX + 15, rimY + 9)} color={color.textDim} strokeWidth={3} />
        </Canvas>
      )}
    </View>
  );
}

export default function HistoryScreen() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const rows = await listSessions(30);
        const pips = await Promise.all(
          rows.map((r) =>
            sessionShots(r.id).then((shots) => shots.map((s) => s.outcome)),
          ),
        );
        if (!alive) return;
        setItems(rows.map((row, i) => ({ row, pips: pips[i] ?? [] })));
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Your sessions</Eyebrow>
      <Text style={styles.title}>History</Text>

      {items === null ? (
        <Text style={styles.dim}>Loading sessions…</Text>
      ) : items.length === 0 ? (
        <Card>
          <EmptyArc />
          <Text style={[styles.heading, { marginTop: space.md }]}>
            No sessions yet
          </Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Finish your first tracked session and it will show up here with
            makes, misses and shot angles.
          </Text>
          <PillButton
            label="Start a session"
            onPress={() => router.replace('/')}
            style={{ marginTop: space.lg }}
          />
        </Card>
      ) : (
        <View style={{ gap: space.md }}>
          {items.map(({ row, pips }) => {
            const makes = row.makes ?? 0;
            const fg = Math.round(row.fgPct * 100);
            return (
              <Card
                key={row.id}
                onPress={() =>
                  router.push({
                    pathname: '/history/[id]',
                    params: { id: String(row.id) },
                  })
                }
              >
                <Row style={{ justifyContent: 'space-between' }} gap={space.lg}>
                  <View style={styles.cardInfo}>
                    <Text style={styles.heading}>
                      {formatSessionDate(row.startedAt)}
                    </Text>
                    <Text style={styles.caption}>
                      {formatSessionTime(row.startedAt)}
                    </Text>
                    <Text style={[styles.meta, { marginTop: space.sm }]}>
                      {row.attempts} {row.attempts === 1 ? 'shot' : 'shots'} ·{' '}
                      {makes} {makes === 1 ? 'make' : 'makes'}
                    </Text>
                  </View>
                  <StatNumber value={`${fg}%`} size="medium" label="FG" />
                </Row>
                {pips.length > 0 && (
                  <PipRow
                    outcomes={pips}
                    size={10}
                    max={24}
                    style={{ marginTop: space.md }}
                  />
                )}
              </Card>
            );
          })}
        </View>
      )}

      {items !== null && items.length > 0 && (
        <PillButton
          variant="ghost"
          label="View trends"
          onPress={() => router.push('/trends')}
          style={{ marginTop: space.xl, alignSelf: 'center' }}
        />
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
  heading: {
    ...type.heading,
    color: color.text,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  meta: {
    ...type.body,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
});
