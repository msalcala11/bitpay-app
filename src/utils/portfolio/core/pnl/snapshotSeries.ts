import type {BalanceSnapshotEventType, BalanceSnapshotStored} from './types';

export type BalanceSnapshotSeries = {
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
    i: string; // id
    t: number; // timestamp (ms)
    e: 0 | 1; // 0=tx, 1=daily
    b: string; // cryptoBalance
    c: number; // remainingCostBasisFiat
    r: number; // markRate
    x?: string[]; // txIds for daily
  }>;
};

export const isBalanceSnapshotSeries = (
  x: unknown,
): x is BalanceSnapshotSeries => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const v = (x as any).v;
  if (v !== 1) return false;
  return Array.isArray((x as any).rows);
};

const eventTypeToCode = (e: BalanceSnapshotEventType): 0 | 1 =>
  e === 'daily' ? 1 : 0;
const codeToEventType = (e: 0 | 1): BalanceSnapshotEventType =>
  e === 1 ? 'daily' : 'tx';

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const isEventTypeCode = (value: unknown): value is 0 | 1 =>
  value === 0 || value === 1;

/**
 * Packs full snapshot objects into a compact "series" representation for persistence.
 *
 * Note: `createdAt` is stored once at the series level, and is applied to all hydrated
 * snapshots as a convenience.
 */
export const packBalanceSnapshotsToSeries = (args: {
  snapshots: BalanceSnapshotStored[];
  compressionEnabled: boolean;
  createdAt?: number;
}): BalanceSnapshotSeries | null => {
  const snaps = args.snapshots || [];
  if (!snaps.length) return null;

  const first = snaps[0];
  const explicitCreatedAt = toFiniteNumber(args.createdAt, Number.NaN);
  const latestCreatedAt = toFiniteNumber(
    snaps[snaps.length - 1].createdAt,
    Number.NaN,
  );
  const createdAt = Number.isFinite(explicitCreatedAt)
    ? explicitCreatedAt
    : Number.isFinite(latestCreatedAt)
    ? latestCreatedAt
    : Date.now();

  const rows = new Array<BalanceSnapshotSeries['rows'][number]>(snaps.length);
  for (let i = 0; i < snaps.length; i += 1) {
    const s = snaps[i];
    const row: BalanceSnapshotSeries['rows'][number] = {
      i: s.id,
      t: toFiniteNumber(s.timestamp, 0),
      e: eventTypeToCode(s.eventType),
      b: s.cryptoBalance,
      c: toFiniteNumber(s.remainingCostBasisFiat, 0),
      r: toFiniteNumber(s.markRate, 0),
    };
    if (s.eventType === 'daily' && Array.isArray(s.txIds) && s.txIds.length) {
      row.x = s.txIds.slice();
    }
    rows[i] = row;
  }

  const series: BalanceSnapshotSeries = {
    v: 1,
    walletId: first.walletId,
    chain: first.chain,
    coin: first.coin,
    network: first.network,
    assetId: first.assetId,
    quoteCurrency: first.quoteCurrency,
    createdAt,
    compressionEnabled: !!args.compressionEnabled,
    rows,
  };

  return series;
};

/** Hydrates a compact series back into full snapshot objects for UI/runtime use. */
export const hydrateBalanceSnapshotsFromSeries = (
  series: BalanceSnapshotSeries,
): BalanceSnapshotStored[] => {
  const out: BalanceSnapshotStored[] = [];
  for (const row of series.rows || []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

    const {i, t, e, b, c, r, x} = row as Partial<
      BalanceSnapshotSeries['rows'][number]
    >;
    if (
      typeof i !== 'string' ||
      typeof b !== 'string' ||
      !isEventTypeCode(e)
    ) {
      continue;
    }

    const timestamp = toFiniteNumber(t, Number.NaN);
    const remainingCostBasisFiat = toFiniteNumber(c, Number.NaN);
    const markRate = toFiniteNumber(r, Number.NaN);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(remainingCostBasisFiat) ||
      !Number.isFinite(markRate)
    ) {
      continue;
    }

    const eventType = codeToEventType(e);
    const snap: BalanceSnapshotStored = {
      id: i,
      walletId: series.walletId,
      chain: series.chain,
      coin: series.coin,
      network: series.network,
      assetId: series.assetId,
      timestamp,
      eventType,
      cryptoBalance: b,
      remainingCostBasisFiat,
      quoteCurrency: series.quoteCurrency,
      markRate,
      createdAt: series.createdAt,
    };
    if (eventType === 'daily') {
      // Be lenient when hydrating persisted caches: if txIds are malformed or
      // missing, keep the snapshot and treat it as having no txIds.
      if (
        Array.isArray(x) &&
        x.length &&
        x.every(txId => typeof txId === 'string')
      ) {
        snap.txIds = x.slice();
      }
    }
    out.push(snap);
  }
  return out;
};
