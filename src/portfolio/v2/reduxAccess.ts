import type {Store} from 'redux';

import type {RootState} from '../../store';
import {getFiatRateAssetRef} from '../core/pnl/rates';
import {CANONICAL_RATE_QUOTE} from './constants';
import type {FiatRateAssetRef, StoredRateInterval} from './model';
import {normalizeRateAssetRef} from './workletData/ratesKv';

let portfolioReduxStore:
  | (Store<RootState> & {getState(): RootState})
  | undefined;

export function initPortfolioReduxAccess(
  store: Store<RootState> & {getState(): RootState},
): void {
  portfolioReduxStore = store;
}

export function resetPortfolioReduxAccessForTesting(): void {
  portfolioReduxStore = undefined;
}

export function isPortfolioReduxAccessInitialized(): boolean {
  return !!portfolioReduxStore;
}

export function getReduxStateForPortfolioV2(): RootState {
  if (!portfolioReduxStore) {
    throw new Error(
      'Portfolio v2 Redux access has not been initialized. Call initPortfolioReduxAccess(...) from the getStore().then(...) bootstrap path.',
    );
  }
  return portfolioReduxStore.getState();
}

/**
 * Phase 0 inventory: the existing live-rate slice carries all supported alt
 * currencies simultaneously rather than a single quote-scoped payload. Passive
 * live-rate recompute should select quote-specific entries using this current
 * display quote; no separate getLiveRatesQuoteCurrencyFromStore accessor is
 * needed unless that Redux invariant changes.
 */
export function getQuoteCurrencyFromStore(): string {
  const state = getReduxStateForPortfolioV2() as unknown as {
    APP?: {
      defaultAltCurrency?: {isoCode?: string};
      defaultAltCurrencyIsoCode?: string;
    };
  };
  return (
    state.APP?.defaultAltCurrency?.isoCode ||
    state.APP?.defaultAltCurrencyIsoCode ||
    'USD'
  );
}

type WalletLike = {
  id?: string;
  walletId?: string;
  chain?: string;
  network?: string;
  currencyAbbreviation?: string;
  tokenAddress?: string;
  hideWallet?: boolean;
  hideWalletByAccount?: boolean;
  pendingTssSession?: boolean;
  credentials?: {
    walletId?: string;
    chain?: string;
    network?: string;
    coin?: string;
    token?: {address?: string; symbol?: string};
  };
};

type KeyLike = {
  id?: string;
  show?: boolean;
  wallets?: WalletLike[];
};

export type EnsureFreshDependencyArgs = Readonly<{
  quoteCurrency?: string;
  intervals?: readonly StoredRateInterval[];
  force?: boolean;
}>;

const DEFAULT_STORED_RATE_INTERVALS: readonly StoredRateInterval[] = [
  '1D',
  '1W',
  '1M',
  'ALL',
];

function getWalletId(wallet: WalletLike): string {
  return String(wallet.id || wallet.walletId || wallet.credentials?.walletId || '').trim();
}

function isLivenetWallet(wallet: WalletLike): boolean {
  const network = String(wallet.network || wallet.credentials?.network || '')
    .trim()
    .toLowerCase();
  return network === 'livenet' || network === 'mainnet';
}

function isRuntimeEligibleWallet(wallet: WalletLike): boolean {
  if (!getWalletId(wallet)) return false;
  if (!isLivenetWallet(wallet)) return false;
  if (wallet.pendingTssSession) return false;
  return !!String(
    wallet.currencyAbbreviation ||
      wallet.credentials?.token?.symbol ||
      wallet.credentials?.coin ||
      '',
  ).trim();
}

function getKeysFromState(state: RootState): Record<string, KeyLike> {
  return (((state as unknown as {WALLET?: {keys?: Record<string, KeyLike>}})
    .WALLET?.keys ?? {}) || {}) as Record<string, KeyLike>;
}

function getHiddenKeyIdsFromHomeCarouselConfig(
  state: RootState,
): ReadonlySet<string> {
  const homeCarouselConfig = (state as unknown as {
    APP?: {homeCarouselConfig?: Array<{id?: string; show?: boolean}>};
  }).APP?.homeCarouselConfig;
  const hidden = new Set<string>();
  for (const item of Array.isArray(homeCarouselConfig) ? homeCarouselConfig : []) {
    const id = String(item?.id || '');
    if (id && id !== 'coinbaseBalanceCard' && item?.show === false) {
      hidden.add(id);
    }
  }
  return hidden;
}

function dedupeWallets(wallets: readonly WalletLike[]): WalletLike[] {
  const seen = new Set<string>();
  const out: WalletLike[] = [];
  for (const wallet of wallets) {
    const id = getWalletId(wallet);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(wallet);
  }
  return out;
}

function assetRefForWallet(wallet: WalletLike): FiatRateAssetRef | null {
  const asset = getFiatRateAssetRef({
    currencyAbbreviation: wallet.currencyAbbreviation,
    chain: wallet.chain || wallet.credentials?.chain,
    tokenAddress: wallet.tokenAddress || wallet.credentials?.token?.address,
    credentials: wallet.credentials as any,
  });
  const normalized = normalizeRateAssetRef(asset);
  return normalized.coin ? normalized : null;
}

function buildEnsureFreshArgsFromWallets(
  wallets: readonly WalletLike[],
  args?: EnsureFreshDependencyArgs,
): {
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  force?: boolean;
} {
  const quoteCurrency = String(
    args?.quoteCurrency || getQuoteCurrencyFromStore() || CANONICAL_RATE_QUOTE,
  ).toUpperCase();
  const intervals = Array.from(
    new Set(args?.intervals?.length ? args.intervals : DEFAULT_STORED_RATE_INTERVALS),
  );
  const assetsByKey = new Map<string, FiatRateAssetRef>();

  for (const wallet of wallets) {
    const asset = assetRefForWallet(wallet);
    if (!asset) continue;
    assetsByKey.set(JSON.stringify(asset), asset);
  }

  // Every freshness path needs BTC bridge coverage even if no BTC wallet exists.
  assetsByKey.set('{"coin":"btc"}', {coin: 'btc'});

  return {
    quoteCurrency,
    assetRefs: Array.from(assetsByKey.values()).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
    intervals,
    force: args?.force,
  };
}

export function getEligibleStoredWalletsFromStore(): readonly WalletLike[] {
  const keys = getKeysFromState(getReduxStateForPortfolioV2());
  const allWallets = Object.values(keys).flatMap(key =>
    Array.isArray(key.wallets) ? key.wallets : [],
  );
  return dedupeWallets(allWallets).filter(isRuntimeEligibleWallet);
}

export function getPopulateEligibleWalletIdSetFromStore(): ReadonlySet<string> {
  return new Set(getEligibleStoredWalletsFromStore().map(getWalletId));
}

export function getVisibleEligibleWalletsFromStore(): readonly WalletLike[] {
  const state = getReduxStateForPortfolioV2();
  const hiddenKeyIds = getHiddenKeyIdsFromHomeCarouselConfig(state);
  const visibleWallets = Object.values(getKeysFromState(state)).flatMap(key => {
    if (key.show === false) return [];
    if (key.id && hiddenKeyIds.has(key.id)) return [];
    return (key.wallets || []).filter(
      wallet => !wallet.hideWallet && !wallet.hideWalletByAccount,
    );
  });
  return dedupeWallets(visibleWallets).filter(isRuntimeEligibleWallet);
}

export function buildEnsureFreshArgsForPopulateEligibleAssetGroups(
  args?: EnsureFreshDependencyArgs,
) {
  return buildEnsureFreshArgsFromWallets(getEligibleStoredWalletsFromStore(), args);
}

export function buildEnsureFreshArgsForVisibleAssetGroups(
  args?: EnsureFreshDependencyArgs,
) {
  return buildEnsureFreshArgsFromWallets(getVisibleEligibleWalletsFromStore(), args);
}
