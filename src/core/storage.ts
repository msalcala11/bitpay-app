import type {StoredWallet} from './types';

const STORAGE_KEY = 'bitpay-pnl-harness.wallets.v1';
const SELECTED_KEY = 'bitpay-pnl-harness.selectedWalletId.v1';
const FIAT_CODE_KEY = 'bitpay-pnl-harness.selectedFiatCode.v1';
const FIAT_RATE_SERIES_CACHE_KEY = 'bitpay-pnl-harness.fiatRateSeriesCache.v1';

// Legacy: snapshot meta used to be stored separately by the harness UI.
// New format stores meta alongside the series.
const SNAPSHOT_META_PREFIX_LEGACY = 'bitpay-pnl-harness.balanceSnapshotsMeta.v1.';

export function loadWallets(): StoredWallet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveWallets(wallets: StoredWallet[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

export function clearWallets(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SELECTED_KEY);
}

export function loadSelectedWalletId(): string | null {
  return localStorage.getItem(SELECTED_KEY);
}

export function saveSelectedWalletId(walletId: string | null): void {
  if (!walletId) localStorage.removeItem(SELECTED_KEY);
  else localStorage.setItem(SELECTED_KEY, walletId);
}

export function loadSelectedFiatCode(): string | null {
  return localStorage.getItem(FIAT_CODE_KEY);
}

export function saveSelectedFiatCode(code: string): void {
  localStorage.setItem(FIAT_CODE_KEY, (code || '').toUpperCase());
}

export function loadFiatRateSeriesCache(): Record<string, any> {
  try {
    const raw = localStorage.getItem(FIAT_RATE_SERIES_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveFiatRateSeriesCache(cache: Record<string, any>): void {
  localStorage.setItem(FIAT_RATE_SERIES_CACHE_KEY, JSON.stringify(cache));
}

export function clearFiatRateSeriesCache(): void {
  localStorage.removeItem(FIAT_RATE_SERIES_CACHE_KEY);
}


// v2 stores a compact series object instead of repeating constant fields per snapshot.
const BALANCE_SNAPSHOTS_KEY_PREFIX_V2 = 'bitpay-pnl-harness.balanceSnapshots.v2.';
// v1 stored an array of full snapshots.
const BALANCE_SNAPSHOTS_KEY_PREFIX_V1 = 'bitpay-pnl-harness.balanceSnapshots.v1.';

export type BalanceSnapshotsMeta = {
  quoteCurrency: string;
  compressionEnabled: boolean;
};

type StoredBalanceSnapshotSeriesV2 = {
  v: 2;
  walletId: string;
  chain: string;
  coin: string;
  network: string;
  assetId: string;
  quoteCurrency: string;
  compressionEnabled: boolean;
  rows: Array<{
    id: string;
    t: number; // timestamp
    e: 0 | 1; // 0=tx, 1=daily
    b: string; // cryptoBalance
    c: number; // remainingCostBasisFiat
    r: number; // markRate
    x?: string[]; // txIds (daily only)
    a?: number; // createdAt (optional)
  }>;
};

const getBalanceSnapshotsKeyV2 = (walletId: string): string =>
  `${BALANCE_SNAPSHOTS_KEY_PREFIX_V2}${walletId}`;

const getBalanceSnapshotsKeyV1 = (walletId: string): string =>
  `${BALANCE_SNAPSHOTS_KEY_PREFIX_V1}${walletId}`;

const getLegacySnapshotMetaKey = (walletId: string): string => `${SNAPSHOT_META_PREFIX_LEGACY}${walletId}`;

export function loadBalanceSnapshotsMeta(walletId: string): BalanceSnapshotsMeta | null {
  // Prefer v2 (meta stored alongside the series).
  try {
    const raw = localStorage.getItem(getBalanceSnapshotsKeyV2(walletId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const q = (parsed as any).quoteCurrency;
        const c = (parsed as any).compressionEnabled;
        if (typeof q === 'string' && typeof c === 'boolean') {
          return {quoteCurrency: q, compressionEnabled: c};
        }
      }
    }
  } catch {
    // ignore
  }

  // Fallback: legacy separate meta key.
  try {
    const raw = localStorage.getItem(getLegacySnapshotMetaKey(walletId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (typeof (p as any).quoteCurrency !== 'string') return null;
    if (typeof (p as any).compressionEnabled !== 'boolean') return null;
    return {quoteCurrency: String((p as any).quoteCurrency), compressionEnabled: !!(p as any).compressionEnabled};
  } catch {
    return null;
  }
}

const migrateLegacySnapshots = (arr: any[]): any[] => {
  // Migration: older versions stored `txids` for all snapshots.
  // New schema: `txIds` is optional and only present for daily snapshots.
  return arr
    .filter(x => x && typeof x === 'object')
    .map(s => {
      const snap: any = {...s};

      if ('txids' in snap && !('txIds' in snap)) {
        if (snap.eventType === 'daily' && Array.isArray(snap.txids)) {
          snap.txIds = snap.txids;
        }
      }

      if (snap.eventType !== 'daily') {
        delete snap.txIds;
      }

      // Migration: we no longer store `direction` on snapshots.
      delete snap.direction;

      delete snap.txids;
      return snap;
    });
};

const hydrateSeriesV2 = (series: StoredBalanceSnapshotSeriesV2): any[] => {
  const out: any[] = [];
  for (const row of series.rows || []) {
    if (!row || typeof row !== 'object') continue;
    const eventType = row.e === 1 ? 'daily' : 'tx';
    const snap: any = {
      id: row.id,
      walletId: series.walletId,
      chain: series.chain,
      coin: series.coin,
      network: series.network,
      assetId: series.assetId,
      timestamp: row.t,
      eventType,
      cryptoBalance: row.b,
      remainingCostBasisFiat: row.c,
      quoteCurrency: series.quoteCurrency,
      markRate: row.r,
    };
    if (typeof row.a === 'number') snap.createdAt = row.a;
    if (eventType === 'daily' && Array.isArray(row.x)) snap.txIds = row.x;
    out.push(snap);
  }
  return out;
};

export function loadBalanceSnapshots(walletId: string): any[] {
  try {
    // Prefer v2 series.
    const rawV2 = localStorage.getItem(getBalanceSnapshotsKeyV2(walletId));
    if (rawV2) {
      const parsed = JSON.parse(rawV2);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as any).v === 2) {
        return hydrateSeriesV2(parsed as StoredBalanceSnapshotSeriesV2);
      }
      // If it's not a v2 object, fall through to v1 handling.
    }

    // Legacy v1 array.
    const rawV1 = localStorage.getItem(getBalanceSnapshotsKeyV1(walletId));
    if (!rawV1) return [];
    const parsedV1 = JSON.parse(rawV1);
    if (!Array.isArray(parsedV1)) return [];
    return migrateLegacySnapshots(parsedV1);
  } catch {
    return [];
  }
}

export function saveBalanceSnapshots(
  walletId: string,
  snapshots: any[],
  meta?: BalanceSnapshotsMeta | null,
): void {
  // If empty, clear storage (and legacy meta).
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    clearBalanceSnapshots(walletId);
    return;
  }

  // Extract constant fields from the first snapshot.
  const first = snapshots[0] || {};

  const series: StoredBalanceSnapshotSeriesV2 = {
    v: 2,
    walletId: String(first.walletId ?? walletId),
    chain: String(first.chain ?? ''),
    coin: String(first.coin ?? ''),
    network: String(first.network ?? ''),
    assetId: String(first.assetId ?? ''),
    quoteCurrency: String(meta?.quoteCurrency ?? first.quoteCurrency ?? '').toUpperCase(),
    compressionEnabled: !!meta?.compressionEnabled,
    rows: [],
  };

  for (const s of snapshots) {
    if (!s || typeof s !== 'object') continue;
    const eventType = String((s as any).eventType);
    const isDaily = eventType === 'daily';
    const row: any = {
      id: String((s as any).id ?? ''),
      t: Number((s as any).timestamp ?? 0),
      e: isDaily ? 1 : 0,
      b: String((s as any).cryptoBalance ?? '0'),
      c: Number((s as any).remainingCostBasisFiat ?? 0),
      r: Number((s as any).markRate ?? NaN),
    };
    if (typeof (s as any).createdAt === 'number') row.a = (s as any).createdAt;
    if (isDaily && Array.isArray((s as any).txIds)) row.x = (s as any).txIds.map(String);
    series.rows.push(row);
  }

  localStorage.setItem(getBalanceSnapshotsKeyV2(walletId), JSON.stringify(series));

  // Cleanup legacy keys.
  try {
    localStorage.removeItem(getBalanceSnapshotsKeyV1(walletId));
    localStorage.removeItem(getLegacySnapshotMetaKey(walletId));
  } catch {
    // ignore
  }
}

export function clearBalanceSnapshots(walletId: string): void {
  localStorage.removeItem(getBalanceSnapshotsKeyV2(walletId));
  localStorage.removeItem(getBalanceSnapshotsKeyV1(walletId));
  localStorage.removeItem(getLegacySnapshotMetaKey(walletId));
}

export function clearAllBalanceSnapshots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith(BALANCE_SNAPSHOTS_KEY_PREFIX_V2) ||
          k.startsWith(BALANCE_SNAPSHOTS_KEY_PREFIX_V1) ||
          k.startsWith(SNAPSHOT_META_PREFIX_LEGACY))
      ) {
        keys.push(k);
      }
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}
