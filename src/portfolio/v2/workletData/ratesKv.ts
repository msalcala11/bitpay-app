import type {KvStore} from '../../core/kv/types';
import type {FiatRateSeries} from '../../core/fiatRatesShared';
import {parseStoredFiatRateSeriesRaw} from '../../core/pnl/storedFiatRateSeries';
import {
  workletKvGetString,
  type PortfolioWorkletKvConfig,
} from '../../runtime/worklet/portfolioWorkletKv';
import type {FiatRateAssetRef, StoredRateInterval} from '../model';

export type PortfolioV2RateKvReaderStore = Pick<KvStore, 'getString'>;

export type PortfolioV2RateSeriesRequest = Readonly<{
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}>;

export type PortfolioV2RateReader = Readonly<{
  loadSeries(
    request: PortfolioV2RateSeriesRequest,
  ): Promise<FiatRateSeries | null>;
}>;

export function normalizeRateAssetRef(
  asset: FiatRateAssetRef,
): FiatRateAssetRef {
  'worklet';

  const chain = String(asset.chain || '')
    .trim()
    .toLowerCase();
  const tokenAddress = String(asset.tokenAddress || '').trim();
  const normalizedTokenAddress =
    chain === 'sol' || chain === 'solana'
      ? tokenAddress
      : tokenAddress.toLowerCase();

  return {
    coin: String(asset.coin || '')
      .trim()
      .toLowerCase(),
    chain: normalizedTokenAddress ? chain || undefined : undefined,
    tokenAddress: normalizedTokenAddress || undefined,
  };
}

export function getRateSourceKey(asset: FiatRateAssetRef): string {
  'worklet';

  const normalized = normalizeRateAssetRef(asset);
  return normalized.tokenAddress
    ? `${normalized.coin}:${normalized.chain || ''}:${normalized.tokenAddress}`
    : normalized.coin;
}

export function getRateKey(args: {
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}): string {
  'worklet';

  const asset = normalizeRateAssetRef(args.asset);
  const base = `rate:v1:${String(args.quoteCurrency || 'USD').toUpperCase()}:${
    asset.coin
  }:${args.storedInterval}`;
  if (asset.chain || asset.tokenAddress) {
    return `${base}:${asset.chain ?? ''}:${asset.tokenAddress ?? ''}`;
  }
  return base;
}

export async function readPortfolioV2RateSeriesByKey(args: {
  store: PortfolioV2RateKvReaderStore;
  key: string;
}): Promise<FiatRateSeries | null> {
  return parseStoredFiatRateSeriesRaw(
    await args.store.getString(String(args.key || '')),
  );
}

export async function readPortfolioV2RateSeries(args: {
  store: PortfolioV2RateKvReaderStore;
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}): Promise<FiatRateSeries | null> {
  return readPortfolioV2RateSeriesByKey({
    store: args.store,
    key: getRateKey({
      quoteCurrency: args.quoteCurrency,
      asset: args.asset,
      storedInterval: args.storedInterval,
    }),
  });
}

export async function readPortfolioV2RateSeriesOnWorklet(
  config: PortfolioWorkletKvConfig,
  request: PortfolioV2RateSeriesRequest,
): Promise<FiatRateSeries | null> {
  'worklet';

  return parseStoredFiatRateSeriesRaw(
    workletKvGetString(
      config,
      getRateKey({
        quoteCurrency: request.quoteCurrency,
        asset: request.asset,
        storedInterval: request.storedInterval,
      }),
    ),
  );
}

export function createPortfolioV2RateReader(
  store: PortfolioV2RateKvReaderStore,
): PortfolioV2RateReader {
  return {
    loadSeries: request =>
      readPortfolioV2RateSeries({
        store,
        ...request,
      }),
  };
}
