import type {StoredWallet} from './types';
import type {BalanceSnapshotStored} from './pnl/types';
import {
  hydrateBalanceSnapshotsFromSeriesV1,
  isBalanceSnapshotSeriesV1,
  packBalanceSnapshotsToSeriesV1,
} from './pnl/snapshotSeries';

const STORAGE_KEY = 'bitpay-pnl-harness.wallets.v1';
const SELECTED_KEY = 'bitpay-pnl-harness.selectedWalletId.v1';
const FIAT_CODE_KEY = 'bitpay-pnl-harness.selectedFiatCode.v1';
const FIAT_RATE_SERIES_CACHE_KEY = 'bitpay-pnl-harness.fiatRateSeriesCache.v1';

// Compact persisted snapshot series.
const BALANCE_SNAPSHOT_SERIES_KEY_PREFIX_V1 = 'bitpay-pnl-harness.balanceSnapshotSeries.v1.';

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

export type BalanceSnapshotsMeta = {
  quoteCurrency: string;
  compressionEnabled: boolean;
};

const getBalanceSnapshotSeriesKeyV1 = (walletId: string): string =>
  `${BALANCE_SNAPSHOT_SERIES_KEY_PREFIX_V1}${walletId}`;

export function loadBalanceSnapshotsMeta(walletId: string): BalanceSnapshotsMeta | null {
  try {
    const raw = localStorage.getItem(getBalanceSnapshotSeriesKeyV1(walletId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isBalanceSnapshotSeriesV1(parsed)) return null;
    return {quoteCurrency: parsed.quoteCurrency, compressionEnabled: parsed.compressionEnabled};
  } catch {
    return null;
  }
}

export function loadBalanceSnapshots(walletId: string): BalanceSnapshotStored[] {
  try {
    const raw = localStorage.getItem(getBalanceSnapshotSeriesKeyV1(walletId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!isBalanceSnapshotSeriesV1(parsed)) return [];
    return hydrateBalanceSnapshotsFromSeriesV1(parsed);
  } catch {
    return [];
  }
}

export function saveBalanceSnapshots(
  walletId: string,
  snapshots: BalanceSnapshotStored[],
  meta?: BalanceSnapshotsMeta | null,
): void {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    clearBalanceSnapshots(walletId);
    return;
  }

  const series = packBalanceSnapshotsToSeriesV1({
    snapshots,
    compressionEnabled: !!meta?.compressionEnabled,
    createdAt: Date.now(),
  });
  if (!series) {
    clearBalanceSnapshots(walletId);
    return;
  }

  // Prefer explicit meta quoteCurrency if provided.
  if (meta?.quoteCurrency) {
    series.quoteCurrency = String(meta.quoteCurrency || '').toUpperCase();
  }

  localStorage.setItem(getBalanceSnapshotSeriesKeyV1(walletId), JSON.stringify(series));
}

export function clearBalanceSnapshots(walletId: string): void {
  localStorage.removeItem(getBalanceSnapshotSeriesKeyV1(walletId));
}

export function clearAllBalanceSnapshots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(BALANCE_SNAPSHOT_SERIES_KEY_PREFIX_V1)) {
        keys.push(k);
      }
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}
