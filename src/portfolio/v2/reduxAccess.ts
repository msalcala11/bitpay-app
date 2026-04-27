import type {Store} from 'redux';

import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../constants/currencies';
import {tokenManager} from '../../managers/TokenManager';
import type {RootState} from '../../store';
import {getFiatTimeframeWindowMs} from '../../utils/portfolio/core/fiatTimeframes';
import {atomicToUnitNumber} from '../../utils/portfolio/core/pnl/atomic';
import {getPortfolioMmkvStorageOnRN} from '../adapters/rn/workletMmkvBridge';
import {
  resolveStoredFiatRateInterval,
  type FiatRateInterval,
  type FiatRatePoint,
  type FiatRateSeries,
} from '../core/fiatRatesShared';
import {getFiatRateAssetRef} from '../core/pnl/rates';
import {createPreparedRateReader} from '../core/pnl/rateReader';
import type {
  SnapshotChunkV2,
  SnapshotIndexV2,
  SnapshotPointV2,
  SnapshotRowV2,
} from '../core/pnl/snapshotStore';
import {parseStoredFiatRateSeriesRaw} from '../core/pnl/storedFiatRateSeries';
import {CANONICAL_RATE_QUOTE, MAX_CHART_POINTS} from './constants';
import {stableHash} from './compute/seriesAggregation';
import {loadManifest} from './manifest';
import type {FiatRateAssetRef, StoredRateInterval} from './model';
import {
  buildCappedSampleGrid,
  type BalanceChangeEvent,
  type FormulaWalletInput,
  type FormulaWalletIntervalInput,
  type NormalizedFormulaRecomputeInput,
} from './recompute';
import {
  getSnapshotChunkKey,
  getSnapshotIndexKey,
} from './workletData/snapshotsKv';
import {
  getRateKey,
  getRateSourceKey,
  normalizeRateAssetRef,
} from './workletData/ratesKv';

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
    token?: {address?: string; decimals?: number; symbol?: string};
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
  return String(
    wallet.id || wallet.walletId || wallet.credentials?.walletId || '',
  ).trim();
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
    .WALLET?.keys ??
    {}) ||
    {}) as Record<string, KeyLike>;
}

function getHiddenKeyIdsFromHomeCarouselConfig(
  state: RootState,
): ReadonlySet<string> {
  const homeCarouselConfig = (
    state as unknown as {
      APP?: {homeCarouselConfig?: Array<{id?: string; show?: boolean}>};
    }
  ).APP?.homeCarouselConfig;
  const hidden = new Set<string>();
  for (const item of Array.isArray(homeCarouselConfig)
    ? homeCarouselConfig
    : []) {
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

const PORTFOLIO_RECOMPUTE_INTERVALS = [
  '1D',
  '1W',
  '1M',
  '3M',
  '1Y',
  '5Y',
  'ALL',
] as const satisfies readonly FiatRateInterval[];

type PortfolioMmkvReadStorage = ReturnType<typeof getPortfolioMmkvStorageOnRN>;

function parseJsonSafe<T>(raw: string | null | undefined): T | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeRecomputeQuoteCurrency(value: unknown): string | null {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return normalized || null;
}

function snapshotIndexHasRows(index: SnapshotIndexV2 | null): boolean {
  return (
    !!index &&
    Array.isArray(index.chunks) &&
    index.chunks.some(chunk => Number(chunk?.rows || 0) > 0)
  );
}

function readSnapshotIndexFromStorage(
  storage: PortfolioMmkvReadStorage,
  walletId: string,
): SnapshotIndexV2 | null {
  const index = parseJsonSafe<SnapshotIndexV2>(
    storage.getString(getSnapshotIndexKey(walletId)),
  );
  if (!index || index.v !== 2 || index.walletId !== walletId) {
    return null;
  }

  return index;
}

function readSnapshotChunkFromStorage(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  chunkId: number | string;
}): SnapshotChunkV2 | null {
  const chunk = parseJsonSafe<SnapshotChunkV2>(
    args.storage.getString(
      getSnapshotChunkKey({
        walletId: args.walletId,
        chunkId: args.chunkId,
      }),
    ),
  );
  if (!chunk || chunk.v !== 2 || !Array.isArray(chunk.rows)) {
    return null;
  }

  return chunk;
}

function readSnapshotRowsInWindow(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  index: SnapshotIndexV2;
  fromExclusive: number;
  toInclusive: number;
}): SnapshotRowV2[] {
  const rows: SnapshotRowV2[] = [];

  for (const chunkMeta of args.index.chunks || []) {
    if (Number(chunkMeta?.toTs) <= args.fromExclusive) {
      continue;
    }
    if (Number(chunkMeta?.fromTs) > args.toInclusive) {
      break;
    }

    const chunk = readSnapshotChunkFromStorage({
      storage: args.storage,
      walletId: args.walletId,
      chunkId: chunkMeta.id,
    });
    for (const row of chunk?.rows || []) {
      const ts = Number(row?.[0]);
      if (ts > args.fromExclusive && ts <= args.toInclusive) {
        rows.push(row);
      }
    }
  }

  return rows.sort((left, right) => Number(left[0]) - Number(right[0]));
}

function findLastSnapshotRowAtOrBefore(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  index: SnapshotIndexV2;
  ts: number;
}): SnapshotRowV2 | null {
  let best: SnapshotRowV2 | null = null;

  for (const chunkMeta of args.index.chunks || []) {
    if (Number(chunkMeta?.fromTs) > args.ts) {
      break;
    }

    const chunk = readSnapshotChunkFromStorage({
      storage: args.storage,
      walletId: args.walletId,
      chunkId: chunkMeta.id,
    });
    for (const row of chunk?.rows || []) {
      const rowTs = Number(row?.[0]);
      if (rowTs <= args.ts) {
        best = row;
      } else {
        break;
      }
    }
  }

  return best;
}

function findFirstSnapshotPoint(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  index: SnapshotIndexV2;
}): SnapshotPointV2 | null {
  for (const chunkMeta of args.index.chunks || []) {
    const chunk = readSnapshotChunkFromStorage({
      storage: args.storage,
      walletId: args.walletId,
      chunkId: chunkMeta.id,
    });
    const row = chunk?.rows?.[0];
    if (row) {
      return {
        timestamp: Number(row[0]),
        cryptoBalance: String(row[1]),
      };
    }
  }

  return null;
}

function findLatestSnapshotRow(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  index: SnapshotIndexV2;
}): SnapshotRowV2 | null {
  for (let i = (args.index.chunks || []).length - 1; i >= 0; i -= 1) {
    const chunkMeta = args.index.chunks[i];
    const chunk = readSnapshotChunkFromStorage({
      storage: args.storage,
      walletId: args.walletId,
      chunkId: chunkMeta.id,
    });
    const row = chunk?.rows?.[chunk.rows.length - 1];
    if (row) {
      return row;
    }
  }

  return null;
}

function parseAtomicUnits(value: unknown, decimals: number): number | null {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  try {
    return atomicToUnitNumber(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

type CurrencyUnitInfoLike = Readonly<{
  unitInfo?: Readonly<{
    unitDecimals?: number;
  }>;
}>;

const TOKEN_CHAIN_SUFFIX_BY_CHAIN: Readonly<Record<string, string>> = {
  arb: 'arb',
  base: 'base',
  eth: 'e',
  matic: 'm',
  op: 'op',
  sol: 'sol',
  solana: 'sol',
};

function isCaseSensitiveTokenChain(chain: string): boolean {
  return chain === 'sol' || chain === 'solana';
}

function normalizeUnitDecimals(value: unknown): number | null {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 30
  ) {
    return Math.floor(value);
  }

  return null;
}

function walletChain(wallet: WalletLike): string {
  return String(
    wallet.chain || wallet.credentials?.chain || wallet.credentials?.coin || '',
  )
    .trim()
    .toLowerCase();
}

function walletTokenAddress(wallet: WalletLike): string {
  return String(
    wallet.tokenAddress || wallet.credentials?.token?.address || '',
  ).trim();
}

function tokenLookupKey(args: {chain: string; tokenAddress: string}): string {
  const suffix = TOKEN_CHAIN_SUFFIX_BY_CHAIN[args.chain];
  const address = isCaseSensitiveTokenChain(args.chain)
    ? args.tokenAddress.trim()
    : args.tokenAddress.trim().toLowerCase();
  return suffix && address ? `${address}_${suffix}` : address.toLowerCase();
}

function customTokenDataByAddressFromState(
  state: RootState,
): Readonly<Record<string, CurrencyUnitInfoLike>> {
  return (
    ((
      state as unknown as {
        WALLET?: {
          customTokenDataByAddress?: Record<string, CurrencyUnitInfoLike>;
        };
      }
    ).WALLET?.customTokenDataByAddress as
      | Record<string, CurrencyUnitInfoLike>
      | undefined) || {}
  );
}

function tokenManagerDataByAddress(): Readonly<
  Record<string, CurrencyUnitInfoLike>
> {
  try {
    return tokenManager.getTokenOptions().tokenDataByAddress || {};
  } catch {
    return {};
  }
}

function getWalletDisplayUnitDecimals(args: {
  state: RootState;
  wallet: WalletLike;
}): number | null {
  const chain = walletChain(args.wallet);
  const tokenAddress = walletTokenAddress(args.wallet);

  if (tokenAddress) {
    const key = tokenLookupKey({chain, tokenAddress});
    const tokenDecimals = normalizeUnitDecimals(
      (
        BitpaySupportedTokens[key] ||
        customTokenDataByAddressFromState(args.state)[key] ||
        tokenManagerDataByAddress()[key]
      )?.unitInfo?.unitDecimals,
    );
    if (tokenDecimals !== null) {
      return tokenDecimals;
    }

    return normalizeUnitDecimals(args.wallet.credentials?.token?.decimals);
  }

  return normalizeUnitDecimals(
    BitpaySupportedCoins[chain]?.unitInfo?.unitDecimals,
  );
}

function walletCurrencyAbbreviation(wallet: WalletLike): string {
  return String(
    wallet.currencyAbbreviation ||
      wallet.credentials?.token?.symbol ||
      wallet.credentials?.coin ||
      '',
  )
    .trim()
    .toLowerCase();
}

type RatesLike = Readonly<
  Record<
    string,
    | readonly {
        code?: string;
        rate?: number;
      }[]
    | undefined
  >
>;

function getRatesFromState(state: RootState): RatesLike | undefined {
  return (state as unknown as {RATE?: {rates?: RatesLike}}).RATE?.rates;
}

function directLiveRateForKeys(args: {
  rates: RatesLike | undefined;
  keys: readonly string[];
  quoteCurrency: string;
}): number | undefined {
  const quoteCurrency = normalizeRecomputeQuoteCurrency(args.quoteCurrency);
  if (!quoteCurrency) {
    return undefined;
  }

  for (const key of args.keys) {
    const entries = args.rates?.[key];
    const rate = entries?.find(
      entry =>
        normalizeRecomputeQuoteCurrency(entry?.code) === quoteCurrency &&
        typeof entry?.rate === 'number' &&
        Number.isFinite(entry.rate) &&
        entry.rate > 0,
    )?.rate;
    if (typeof rate === 'number') {
      return rate;
    }
  }

  return undefined;
}

function liveRateKeysForAsset(args: {
  assetGroupId: string;
  asset: FiatRateAssetRef;
}): readonly string[] {
  const keys = new Set<string>();
  const add = (value: unknown, options?: {caseSensitive?: boolean}) => {
    const raw = String(value || '').trim();
    const normalized = options?.caseSensitive ? raw : raw.toLowerCase();
    if (normalized) {
      keys.add(normalized);
    }
  };

  const chain = String(args.asset.chain || '')
    .trim()
    .toLowerCase();
  const tokenAddress = String(args.asset.tokenAddress || '').trim();
  if (tokenAddress) {
    const caseSensitive = isCaseSensitiveTokenChain(chain);
    add(tokenLookupKey({chain, tokenAddress}), {caseSensitive});
    add(tokenAddress, {caseSensitive});
    return Array.from(keys);
  }

  add(args.asset.coin);
  add(args.assetGroupId);
  if (args.assetGroupId === 'pol') {
    add('matic');
  }

  return Array.from(keys);
}

function getWalletLiveRateFromState(args: {
  state: RootState;
  quoteCurrency: string;
  assetGroupId: string;
  asset: FiatRateAssetRef;
}): number | undefined {
  const rates = getRatesFromState(args.state);
  const assetKeys = liveRateKeysForAsset({
    assetGroupId: args.assetGroupId,
    asset: args.asset,
  });
  const canonicalRate = directLiveRateForKeys({
    rates,
    keys: assetKeys,
    quoteCurrency: CANONICAL_RATE_QUOTE,
  });
  if (typeof canonicalRate !== 'number') {
    return undefined;
  }

  if (args.quoteCurrency === CANONICAL_RATE_QUOTE) {
    return canonicalRate;
  }

  const canonicalBtcRate = directLiveRateForKeys({
    rates,
    keys: ['btc'],
    quoteCurrency: CANONICAL_RATE_QUOTE,
  });
  const targetBtcRate = directLiveRateForKeys({
    rates,
    keys: ['btc'],
    quoteCurrency: args.quoteCurrency,
  });

  if (
    typeof canonicalBtcRate !== 'number' ||
    typeof targetBtcRate !== 'number' ||
    canonicalBtcRate <= 0
  ) {
    return undefined;
  }

  const bridged = (canonicalRate * targetBtcRate) / canonicalBtcRate;
  return Number.isFinite(bridged) && bridged > 0 ? bridged : undefined;
}

function readRateSeriesFromStorage(args: {
  storage: PortfolioMmkvReadStorage;
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}): FiatRateSeries | null {
  return parseStoredFiatRateSeriesRaw(
    args.storage.getString(
      getRateKey({
        quoteCurrency: args.quoteCurrency,
        asset: args.asset,
        storedInterval: args.storedInterval,
      }),
    ),
  );
}

function sanitizedRatePoints(
  series: FiatRateSeries | null | undefined,
): readonly FiatRatePoint[] {
  return (series?.points || [])
    .map(point => ({ts: Number(point.ts), rate: Number(point.rate)}))
    .filter(
      point =>
        Number.isFinite(point.ts) &&
        Number.isFinite(point.rate) &&
        point.rate > 0,
    )
    .sort((left, right) => left.ts - right.ts);
}

function latestRatePointTs(
  series: FiatRateSeries | null | undefined,
): number | undefined {
  const points = sanitizedRatePoints(series);
  return points.length ? points[points.length - 1].ts : undefined;
}

function rateSeriesFingerprint(
  series: FiatRateSeries | null | undefined,
): string {
  const points = sanitizedRatePoints(series);
  return stableHash([
    Number(series?.fetchedOn || 0),
    ...points.flatMap(point => [point.ts, point.rate]),
  ]);
}

function buildBalanceEventsForWindow(args: {
  storage: PortfolioMmkvReadStorage;
  walletId: string;
  index: SnapshotIndexV2;
  windowStartTs: number;
  windowEndTs: number;
  displayUnitDecimals: number;
}): {
  baselineUnits: number;
  balanceEvents: readonly BalanceChangeEvent[];
} | null {
  const baselineRow = findLastSnapshotRowAtOrBefore({
    storage: args.storage,
    walletId: args.walletId,
    index: args.index,
    ts: args.windowStartTs,
  });
  let previousUnits = parseAtomicUnits(
    baselineRow?.[1] ?? '0',
    args.displayUnitDecimals,
  );
  if (previousUnits === null) {
    return null;
  }

  const baselineUnits = previousUnits;
  const events: BalanceChangeEvent[] = [];
  let order = 0;
  for (const row of readSnapshotRowsInWindow({
    storage: args.storage,
    walletId: args.walletId,
    index: args.index,
    fromExclusive: args.windowStartTs,
    toInclusive: args.windowEndTs,
  })) {
    const nextUnits = parseAtomicUnits(row[1], args.displayUnitDecimals);
    if (nextUnits === null) {
      return null;
    }

    const unitsDelta = nextUnits - previousUnits;
    if (unitsDelta !== 0) {
      events.push({
        ts: Number(row[0]),
        unitsDelta,
        order,
      });
      order += 1;
    }
    previousUnits = nextUnits;
  }

  return {baselineUnits, balanceEvents: events};
}

function buildRateReadTimestamps(args: {
  windowStartTs: number;
  windowEndTs: number;
  balanceEvents: readonly BalanceChangeEvent[];
}): readonly number[] {
  const timestamps = new Set<number>([
    args.windowStartTs,
    args.windowEndTs,
    ...buildCappedSampleGrid({
      windowStartTs: args.windowStartTs,
      windowEndTs: args.windowEndTs,
      maxPoints: MAX_CHART_POINTS,
    }),
  ]);
  for (const event of args.balanceEvents) {
    if (event.unitsDelta > 0) {
      timestamps.add(event.ts);
    }
  }
  return Array.from(timestamps).sort((left, right) => left - right);
}

function bridgeRatePointsForInterval(args: {
  canonicalAssetSeries: FiatRateSeries | null;
  canonicalBtcSeries: FiatRateSeries | null;
  targetBtcSeries: FiatRateSeries | null;
  timestamps: readonly number[];
}): readonly FiatRatePoint[] {
  const canonicalAssetReader = createPreparedRateReader({
    series: args.canonicalAssetSeries,
    policy: 'linearRender',
  });
  const canonicalBtcReader = createPreparedRateReader({
    series: args.canonicalBtcSeries,
    policy: 'linearRender',
  });
  const targetBtcReader = createPreparedRateReader({
    series: args.targetBtcSeries,
    policy: 'linearRender',
  });

  const points: FiatRatePoint[] = [];
  for (const ts of args.timestamps) {
    const canonicalAsset = canonicalAssetReader.read(ts);
    const canonicalBtc = canonicalBtcReader.read(ts);
    const targetBtc = targetBtcReader.read(ts);
    if (
      canonicalAsset.kind !== 'rate' ||
      canonicalBtc.kind !== 'rate' ||
      targetBtc.kind !== 'rate' ||
      canonicalBtc.rate <= 0
    ) {
      return [];
    }

    points.push({
      ts,
      rate: (canonicalAsset.rate * targetBtc.rate) / canonicalBtc.rate,
    });
  }

  return points;
}

function getIntervalWindowEndTs(args: {
  quoteCurrency: string;
  canonicalAssetSeries: FiatRateSeries | null;
  canonicalBtcSeries: FiatRateSeries | null;
  targetBtcSeries: FiatRateSeries | null;
  nowMs: number;
}): number {
  const candidates = [latestRatePointTs(args.canonicalAssetSeries)];
  if (args.quoteCurrency !== CANONICAL_RATE_QUOTE) {
    candidates.push(
      latestRatePointTs(args.canonicalBtcSeries),
      latestRatePointTs(args.targetBtcSeries),
    );
  }

  return Math.min(
    args.nowMs,
    ...candidates.filter(
      (candidate): candidate is number =>
        typeof candidate === 'number' && Number.isFinite(candidate),
    ),
  );
}

function buildWalletIntervalInput(args: {
  storage: PortfolioMmkvReadStorage;
  quoteCurrency: string;
  walletId: string;
  index: SnapshotIndexV2;
  asset: FiatRateAssetRef;
  interval: FiatRateInterval;
  displayUnitDecimals: number;
  nowMs: number;
}): FormulaWalletIntervalInput | null {
  const storedInterval = resolveStoredFiatRateInterval(args.interval);
  const canonicalAssetSeries = readRateSeriesFromStorage({
    storage: args.storage,
    quoteCurrency: CANONICAL_RATE_QUOTE,
    asset: args.asset,
    storedInterval,
  });
  const canonicalBtcSeries =
    args.quoteCurrency === CANONICAL_RATE_QUOTE
      ? null
      : readRateSeriesFromStorage({
          storage: args.storage,
          quoteCurrency: CANONICAL_RATE_QUOTE,
          asset: {coin: 'btc'},
          storedInterval,
        });
  const targetBtcSeries =
    args.quoteCurrency === CANONICAL_RATE_QUOTE
      ? null
      : readRateSeriesFromStorage({
          storage: args.storage,
          quoteCurrency: args.quoteCurrency,
          asset: {coin: 'btc'},
          storedInterval,
        });

  const windowEndTs = getIntervalWindowEndTs({
    quoteCurrency: args.quoteCurrency,
    canonicalAssetSeries,
    canonicalBtcSeries,
    targetBtcSeries,
    nowMs: args.nowMs,
  });
  const firstSnapshotPoint = findFirstSnapshotPoint({
    storage: args.storage,
    walletId: args.walletId,
    index: args.index,
  });
  const windowMs = getFiatTimeframeWindowMs(args.interval);
  const firstNonZeroTs = args.index.checkpoint?.firstNonZeroTs;
  const windowStartTs =
    typeof windowMs === 'number'
      ? windowEndTs - windowMs
      : typeof firstNonZeroTs === 'number' &&
        Number.isFinite(firstNonZeroTs) &&
        firstNonZeroTs > 0
      ? firstNonZeroTs
      : Number(firstSnapshotPoint?.timestamp || 0);

  if (
    !Number.isFinite(windowStartTs) ||
    !Number.isFinite(windowEndTs) ||
    windowEndTs <= windowStartTs
  ) {
    return null;
  }

  const balance = buildBalanceEventsForWindow({
    storage: args.storage,
    walletId: args.walletId,
    index: args.index,
    windowStartTs,
    windowEndTs,
    displayUnitDecimals: args.displayUnitDecimals,
  });
  if (!balance) {
    return null;
  }

  const timestamps = buildRateReadTimestamps({
    windowStartTs,
    windowEndTs,
    balanceEvents: balance.balanceEvents,
  });
  const ratePoints =
    args.quoteCurrency === CANONICAL_RATE_QUOTE
      ? sanitizedRatePoints(canonicalAssetSeries)
      : bridgeRatePointsForInterval({
          canonicalAssetSeries,
          canonicalBtcSeries,
          targetBtcSeries,
          timestamps,
        });

  return {
    interval: args.interval,
    seriesIdentityKey: [
      'wallet',
      args.walletId,
      'asset',
      getRateSourceKey(args.asset),
      'quote',
      args.quoteCurrency,
      'snap',
      Math.trunc(Number(args.index.revision || 0)),
      'rate',
      storedInterval,
      rateSeriesFingerprint(canonicalAssetSeries),
      args.quoteCurrency === CANONICAL_RATE_QUOTE
        ? 'direct'
        : `bridge:${rateSeriesFingerprint(
            canonicalBtcSeries,
          )}:${rateSeriesFingerprint(targetBtcSeries)}`,
    ].join(':'),
    windowStartTs,
    windowEndTs,
    sampledFromStoredInterval: storedInterval,
    finalPointSource: 'historicalRate',
    baselineUnits: balance.baselineUnits,
    balanceEvents: balance.balanceEvents,
    ratePoints,
    maxPoints: MAX_CHART_POINTS,
  };
}

function buildFormulaWalletInput(args: {
  storage: PortfolioMmkvReadStorage;
  wallet: WalletLike;
  quoteCurrency: string;
  index: SnapshotIndexV2;
  nowMs: number;
  state: RootState;
}): FormulaWalletInput | null {
  const walletId = getWalletId(args.wallet);
  const asset = assetRefForWallet(args.wallet);
  const assetGroupId = walletCurrencyAbbreviation(args.wallet);
  if (!walletId || !asset?.coin || !assetGroupId) {
    return null;
  }

  const displayUnitDecimals = getWalletDisplayUnitDecimals({
    state: args.state,
    wallet: args.wallet,
  });
  if (displayUnitDecimals === null) {
    return null;
  }
  const latestRow = findLatestSnapshotRow({
    storage: args.storage,
    walletId,
    index: args.index,
  });
  const displayUnitsAtomic = String(
    latestRow?.[1] ?? args.index.checkpoint?.balanceAtomic ?? '',
  ).trim();
  if (!/^\d+$/.test(displayUnitsAtomic)) {
    return null;
  }

  const intervals = PORTFOLIO_RECOMPUTE_INTERVALS.map(interval =>
    buildWalletIntervalInput({
      storage: args.storage,
      quoteCurrency: args.quoteCurrency,
      walletId,
      index: args.index,
      asset,
      interval,
      displayUnitDecimals,
      nowMs: args.nowMs,
    }),
  ).filter(
    (interval): interval is FormulaWalletIntervalInput => interval !== null,
  );
  if (!intervals.length) {
    return null;
  }

  const liveRate = getWalletLiveRateFromState({
    state: args.state,
    quoteCurrency: args.quoteCurrency,
    assetGroupId,
    asset,
  });

  return {
    walletId,
    assetGroupId,
    assetIdentityKey: getRateSourceKey(asset),
    rateSourceKey: getRateSourceKey(asset),
    displayUnitsAtomic,
    displayUnitDecimals,
    ...(typeof liveRate === 'number' ? {liveRate} : {}),
    lastWrittenAt: Number(args.index.updatedAt || args.nowMs),
    lastAccessedAt: args.nowMs,
    intervals,
  };
}

export function buildBaseRecomputeInputsAtFireTime():
  | NormalizedFormulaRecomputeInput
  | undefined {
  const quoteCurrency = normalizeRecomputeQuoteCurrency(
    getQuoteCurrencyFromStore(),
  );
  if (!quoteCurrency) {
    return undefined;
  }

  const state = getReduxStateForPortfolioV2();
  const visibleWallets = getVisibleEligibleWalletsFromStore();
  const manifest = loadManifest();
  if (!manifest) {
    return undefined;
  }

  const populatedWalletIds = new Set(manifest?.populatedWalletIds || []);
  const invalidHistoryWalletIds = new Set(
    manifest?.invalidHistoryWalletIds || [],
  );
  const assetOrderById = new Map(
    (manifest?.populateOrderAssetGroupIds || []).map((assetGroupId, index) => [
      assetGroupId,
      index,
    ]),
  );
  const storage = getPortfolioMmkvStorageOnRN();
  const formulaWallets: FormulaWalletInput[] = [];
  const assetGroupsById = new Map<
    string,
    {assetGroupId: string; displaySymbol: string; orderIndex: number}
  >();
  const nowMs = Date.now();

  for (const [index, wallet] of visibleWallets.entries()) {
    const walletId = getWalletId(wallet);
    if (
      !walletId ||
      invalidHistoryWalletIds.has(walletId) ||
      !populatedWalletIds.has(walletId)
    ) {
      continue;
    }

    const snapshotIndex = readSnapshotIndexFromStorage(storage, walletId);
    if (!snapshotIndex || !snapshotIndexHasRows(snapshotIndex)) {
      continue;
    }

    const formulaWallet = buildFormulaWalletInput({
      storage,
      wallet,
      quoteCurrency,
      index: snapshotIndex,
      nowMs,
      state,
    });
    if (!formulaWallet) {
      continue;
    }

    formulaWallets.push(formulaWallet);
    if (!assetGroupsById.has(formulaWallet.assetGroupId)) {
      assetGroupsById.set(formulaWallet.assetGroupId, {
        assetGroupId: formulaWallet.assetGroupId,
        displaySymbol: formulaWallet.assetGroupId.toUpperCase(),
        orderIndex: assetOrderById.get(formulaWallet.assetGroupId) ?? index,
      });
    }
  }

  if (!formulaWallets.length) {
    return undefined;
  }

  return {
    computedAtMs: nowMs,
    formula: {
      quoteCurrency,
      wallets: formulaWallets.sort((left, right) =>
        left.walletId.localeCompare(right.walletId),
      ),
      assetGroups: Array.from(assetGroupsById.values()).sort((left, right) => {
        const orderDelta = left.orderIndex - right.orderIndex;
        return (
          orderDelta || left.assetGroupId.localeCompare(right.assetGroupId)
        );
      }),
    },
    populatedWalletIds: Array.from(populatedWalletIds).sort((left, right) =>
      left.localeCompare(right),
    ),
    invalidHistoryWalletIds: Array.from(invalidHistoryWalletIds).sort(
      (left, right) => left.localeCompare(right),
    ),
    orderRevision: manifest?.orderRevision,
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
  return buildEnsureFreshArgsFromWallets(
    getEligibleStoredWalletsFromStore(),
    args,
  );
}

export function buildEnsureFreshArgsForVisibleAssetGroups(
  args?: EnsureFreshDependencyArgs,
) {
  return buildEnsureFreshArgsFromWallets(
    getVisibleEligibleWalletsFromStore(),
    args,
  );
}
