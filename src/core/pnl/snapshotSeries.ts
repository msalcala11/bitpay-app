import type {BalanceSnapshotEventType, BalanceSnapshotStored} from './types';

export type BalanceSnapshotSeriesV1 = {
  v: 1;
  walletId: string;
  chain: string;
  coin: string;
  network: string;
  assetId: string;
  quoteCurrency: string;
  createdAt: number;
  compressionEnabled: boolean;

  // snapshot rows with only varying fields
  rows: Array<{
    id: string;
    t: number; // timestamp (ms)
    e: 0 | 1; // 0=tx, 1=daily
    b: string; // cryptoBalance
    d?: string; // balanceDeltaAtomic
    c: number; // remainingCostBasisFiat
    r: number; // markRate
    x?: string[]; // txIds for daily
  }>;
};

export const isBalanceSnapshotSeriesV1 = (x: unknown): x is BalanceSnapshotSeriesV1 => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const v = (x as any).v;
  if (v !== 1) return false;
  return Array.isArray((x as any).rows);
};

const eventTypeToCode = (e: BalanceSnapshotEventType): 0 | 1 => (e === 'daily' ? 1 : 0);
const codeToEventType = (e: 0 | 1): BalanceSnapshotEventType => (e === 1 ? 'daily' : 'tx');

/**
 * Packs full snapshot objects into a compact "series" representation for persistence.
 *
 * Note: `createdAt` is stored once at the series level, and is applied to all hydrated
 * snapshots as a convenience.
 */
export const packBalanceSnapshotsToSeriesV1 = (args: {
  snapshots: BalanceSnapshotStored[];
  compressionEnabled: boolean;
  createdAt?: number;
}): BalanceSnapshotSeriesV1 | null => {
  const snaps = args.snapshots || [];
  if (!snaps.length) return null;

  const first = snaps[0];
  const createdAt =
    typeof args.createdAt === 'number'
      ? args.createdAt
      : typeof snaps[snaps.length - 1].createdAt === 'number'
        ? (snaps[snaps.length - 1].createdAt as number)
        : Date.now();

  const series: BalanceSnapshotSeriesV1 = {
    v: 1,
    walletId: first.walletId,
    chain: first.chain,
    coin: first.coin,
    network: first.network,
    assetId: first.assetId,
    quoteCurrency: first.quoteCurrency,
    createdAt,
    compressionEnabled: !!args.compressionEnabled,
    rows: [],
  };

  for (const s of snaps) {
    const row: BalanceSnapshotSeriesV1['rows'][number] = {
      id: s.id,
      t: s.timestamp,
      e: eventTypeToCode(s.eventType),
      b: s.cryptoBalance,
      d: s.balanceDeltaAtomic,
      c: Number(s.remainingCostBasisFiat || 0),
      r: Number(s.markRate || 0),
    };
    if (s.eventType === 'daily' && Array.isArray(s.txIds) && s.txIds.length) {
      row.x = s.txIds.slice();
    }
    series.rows.push(row);
  }

  return series;
};

/** Hydrates a compact series back into full snapshot objects for UI/runtime use. */
export const hydrateBalanceSnapshotsFromSeriesV1 = (
  series: BalanceSnapshotSeriesV1,
): BalanceSnapshotStored[] => {
  const out: BalanceSnapshotStored[] = [];
  for (const row of series.rows || []) {
    if (!row || typeof row !== 'object') continue;
    const eventType = codeToEventType(row.e);
    const snap: BalanceSnapshotStored = {
      id: row.id,
      walletId: series.walletId,
      chain: series.chain,
      coin: series.coin,
      network: series.network,
      assetId: series.assetId,
      timestamp: row.t,
      eventType,
      cryptoBalance: row.b,
      balanceDeltaAtomic: row.d,
      remainingCostBasisFiat: row.c,
      quoteCurrency: series.quoteCurrency,
      markRate: row.r,
      createdAt: series.createdAt,
    };
    if (eventType === 'daily' && Array.isArray(row.x) && row.x.length) {
      snap.txIds = row.x.slice();
    }
    out.push(snap);
  }
  return out;
};
