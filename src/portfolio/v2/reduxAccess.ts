import type {Store} from 'redux';

import type {RootState} from '../../store';
import type {StoredWallet, WalletCredentials, WalletSummary} from '../core/types';
import {getFiatRateAssetRef} from '../core/pnl/rates';
import {DEFAULT_BWS_CONFIG, type BwsConfig} from '../core/shared/bws';
import {
  createPortfolioTxHistorySigningDispatchContextOnRN,
  type PortfolioTxHistorySigningDispatchContext,
} from '../adapters/rn/txHistorySigning';
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

export function getShowPortfolioEnabledFromStore(): boolean {
  const state = getReduxStateForPortfolioV2() as unknown as {
    APP?: {showPortfolioValue?: boolean};
  };
  return state.APP?.showPortfolioValue !== false;
}

type WalletLike = {
  id?: string;
  walletId?: string;
  walletName?: string;
  chain?: string;
  network?: string;
  currencyAbbreviation?: string;
  tokenAddress?: string;
  balanceAtomic?: string;
  balanceFormatted?: string;
  balance?: {
    crypto?: string;
    sat?: number;
  };
  hideWallet?: boolean;
  hideWalletByAccount?: boolean;
  pendingTssSession?: boolean;
  credentials?: {
    toObj?: () => Record<string, unknown>;
    walletId?: string;
    walletName?: string;
    chain?: string;
    network?: string;
    coin?: string;
    requestPrivKey?: string;
    requestPubKey?: string;
    token?: {address?: string; symbol?: string; decimals?: number};
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

export type PopulateRuntimeWalletContext = StoredWallet &
  Readonly<{
    fiatRateAssetRef: FiatRateAssetRef;
    network: string;
  }>;

export type PopulateRuntimeContext = Readonly<{
  cfg: BwsConfig;
  quoteCurrency: string;
  walletsById: Readonly<Record<string, PopulateRuntimeWalletContext>>;
  signingContextsByWalletId: Readonly<
    Record<string, PortfolioTxHistorySigningDispatchContext>
  >;
  queueSchemaVersion: 1;
  manifestSchemaVersion: 1;
}>;

const DEFAULT_STORED_RATE_INTERVALS: readonly StoredRateInterval[] = [
  '1D',
  '1W',
  '1M',
  'ALL',
];

function withCanonicalStoredRateIntervals(
  intervals?: readonly StoredRateInterval[],
): StoredRateInterval[] {
  return Array.from(
    new Set<StoredRateInterval>([
      ...DEFAULT_STORED_RATE_INTERVALS,
      ...(intervals || []),
    ]),
  );
}

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

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function serializeWalletCredentials(wallet: WalletLike): WalletCredentials {
  const credentials = wallet.credentials;
  try {
    if (typeof credentials?.toObj === 'function') {
      return credentials.toObj();
    }
    return JSON.parse(JSON.stringify(credentials || {}));
  } catch {
    return {};
  }
}

function defaultUnitDecimals(wallet: WalletLike): number {
  const tokenDecimals = Number(wallet.credentials?.token?.decimals);
  if (Number.isFinite(tokenDecimals) && tokenDecimals >= 0) {
    return Math.trunc(tokenDecimals);
  }

  const chain = String(wallet.chain || wallet.credentials?.chain || '')
    .trim()
    .toLowerCase();
  switch (chain) {
    case 'eth':
    case 'matic':
    case 'pol':
    case 'arb':
    case 'base':
    case 'op':
      return 18;
    case 'sol':
      return 9;
    case 'xrp':
      return 6;
    case 'btc':
    case 'bch':
    case 'doge':
    case 'ltc':
    default:
      return 8;
  }
}

function decimalUnitStringToAtomicString(value: unknown, decimals: number): string {
  const normalized = String(value || '0')
    .replace(/,/g, '')
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return '0';
  }

  const [whole = '0', fraction = ''] = normalized.split('.');
  const scale = Math.max(0, Math.trunc(decimals));
  const paddedFraction = fraction.slice(0, scale).padEnd(scale, '0');
  const atomic = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  return atomic || '0';
}

function walletBalanceAtomic(wallet: WalletLike): string {
  const explicit = String(wallet.balanceAtomic || '').trim();
  if (/^\d+$/.test(explicit)) {
    return explicit;
  }

  const sat = Number(wallet.balance?.sat);
  if (Number.isFinite(sat) && sat >= 0 && Math.trunc(sat) === sat) {
    return String(sat);
  }

  return decimalUnitStringToAtomicString(
    wallet.balance?.crypto || wallet.balanceFormatted || '0',
    defaultUnitDecimals(wallet),
  );
}

function storedWalletForPopulate(wallet: WalletLike): PopulateRuntimeWalletContext | null {
  const walletId = getWalletId(wallet);
  const asset = assetRefForWallet(wallet);
  if (!walletId || !asset) {
    return null;
  }

  const credentials = {
    ...serializeWalletCredentials(wallet),
    walletId,
    walletName:
      sanitizeString(wallet.walletName) ||
      sanitizeString(wallet.credentials?.walletName),
    chain: sanitizeString(wallet.chain) || sanitizeString(wallet.credentials?.chain),
    network:
      sanitizeString(wallet.network) || sanitizeString(wallet.credentials?.network),
    coin:
      sanitizeString(wallet.currencyAbbreviation) ||
      sanitizeString(wallet.credentials?.token?.symbol) ||
      sanitizeString(wallet.credentials?.coin),
    requestPrivKey: sanitizeString(wallet.credentials?.requestPrivKey),
    requestPubKey: sanitizeString(wallet.credentials?.requestPubKey),
    token:
      wallet.tokenAddress || wallet.credentials?.token?.address
        ? {
            ...(wallet.credentials?.token || {}),
            address:
              sanitizeString(wallet.tokenAddress) ||
              sanitizeString(wallet.credentials?.token?.address),
            symbol:
              sanitizeString(wallet.currencyAbbreviation) ||
              sanitizeString(wallet.credentials?.token?.symbol),
          }
        : wallet.credentials?.token,
  } as WalletCredentials;

  const chain = String(credentials.chain || '').trim().toLowerCase();
  const network = String(credentials.network || '').trim().toLowerCase();
  const currencyAbbreviation = String(credentials.coin || chain)
    .trim()
    .toLowerCase();
  const tokenAddress =
    sanitizeString(wallet.tokenAddress) ||
    sanitizeString((credentials.token as {address?: string} | undefined)?.address);
  const balanceFormatted = String(
    wallet.balanceFormatted || wallet.balance?.crypto || '0',
  ).replace(/,/g, '');
  const summary: WalletSummary = {
    walletId,
    walletName:
      sanitizeString(wallet.walletName) ||
      sanitizeString(credentials.walletName) ||
      walletId,
    chain,
    network,
    currencyAbbreviation,
    tokenAddress,
    balanceAtomic: walletBalanceAtomic(wallet),
    balanceFormatted,
  };

  return {
    walletId,
    credentials,
    summary,
    addedAt: Date.now(),
    fiatRateAssetRef: asset,
    network,
  };
}

function buildSigningContextForWallet(
  wallet: PopulateRuntimeWalletContext,
): PortfolioTxHistorySigningDispatchContext | undefined {
  try {
    return createPortfolioTxHistorySigningDispatchContextOnRN({
      requestPrivKey:
        sanitizeString((wallet.credentials as {requestPrivKey?: string}).requestPrivKey),
      requestPubKey:
        sanitizeString((wallet.credentials as {requestPubKey?: string}).requestPubKey),
      requestCount: 4,
    });
  } catch {
    return undefined;
  }
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
  const intervals = withCanonicalStoredRateIntervals(args?.intervals);
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

export function getPopulateEligibleWalletIdsFromStore(): readonly string[] {
  return Array.from(getPopulateEligibleWalletIdSetFromStore()).sort(
    (left, right) => left.localeCompare(right),
  );
}

export function buildPopulateRuntimeContextFromStore(): PopulateRuntimeContext {
  const walletsById: Record<string, PopulateRuntimeWalletContext> = {};
  const signingContextsByWalletId: Record<
    string,
    PortfolioTxHistorySigningDispatchContext
  > = {};

  for (const wallet of getEligibleStoredWalletsFromStore()) {
    const storedWallet = storedWalletForPopulate(wallet);
    if (!storedWallet) {
      continue;
    }

    walletsById[storedWallet.walletId] = storedWallet;
    const signingContext = buildSigningContextForWallet(storedWallet);
    if (signingContext) {
      signingContextsByWalletId[storedWallet.walletId] = signingContext;
    }
  }

  return {
    cfg: DEFAULT_BWS_CONFIG,
    quoteCurrency: getQuoteCurrencyFromStore(),
    walletsById,
    signingContextsByWalletId,
    queueSchemaVersion: 1,
    manifestSchemaVersion: 1,
  };
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
