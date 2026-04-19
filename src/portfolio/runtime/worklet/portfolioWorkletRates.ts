import type {BwsConfig} from '../../core/shared/bws';
import {
  CANONICAL_FIAT_QUOTE,
  DEFAULT_STORED_FIAT_RATE_INTERVALS,
  FX_BRIDGE_COIN,
  getFiatRateSeriesCacheKey,
  getFiatRateSeriesUrl,
  resolveStoredFiatRateInterval,
  type FiatRateAssetRef,
  type FiatRateInterval,
  type FiatRateSeries,
  type FiatRateSeriesCache,
  type FiatRateSeriesResponse,
} from '../../core/fiatRatesShared';
import type {WalletSummary} from '../../core/types';
import {getFiatRateSeriesWithFx} from '../../core/pnl/fxRates';
import {
  getFiatRateAssetRef,
  normalizeFiatRateSeriesCoin,
} from '../../core/pnl/rates';
import {
  hasStoredFiatRateSeriesPersistedFetchedOn,
  normalizeStoredFiatRateSeriesPoints,
  parseStoredFiatRateSeriesRaw,
  stringifyStoredFiatRateSeries,
} from '../../core/pnl/storedFiatRateSeries';
import {
  workletKvDelete,
  workletKvGetString,
  workletKvListKeys,
  workletKvSetString,
  type PortfolioWorkletKvConfig,
} from './portfolioWorkletKv';

export const getWorkletRateStorageKey = (args: {
  quoteCurrency: string;
  coin: string;
  interval: FiatRateInterval;
  chain?: string;
  tokenAddress?: string;
}): string => {
  'worklet';

  return `rate:v1:${getFiatRateSeriesCacheKey(
    args.quoteCurrency,
    args.coin,
    args.interval,
    {
      chain: args.chain,
      tokenAddress: args.tokenAddress,
    },
  )}`;
};

export function parseWorkletStoredFiatRateSeries(
  raw: string | null,
): FiatRateSeries | null {
  'worklet';
  return parseStoredFiatRateSeriesRaw(raw);
}

function encodeStoredSeries(series: FiatRateSeries): string {
  'worklet';
  return stringifyStoredFiatRateSeries(series);
}

function toSeriesFromProviderCandidate(
  candidate: unknown,
): FiatRateSeries | null {
  'worklet';

  if (Array.isArray(candidate)) {
    const points = normalizeStoredFiatRateSeriesPoints(candidate);
    return points.length
      ? {
          fetchedOn: Date.now(),
          points,
        }
      : null;
  }

  if (candidate && typeof candidate === 'object') {
    const fetchedOn = Number((candidate as any).fetchedOn);
    const points = normalizeStoredFiatRateSeriesPoints(
      (candidate as any).points,
    );
    if (points.length) {
      return {
        fetchedOn: Number.isFinite(fetchedOn) ? fetchedOn : Date.now(),
        points,
      };
    }
  }

  return null;
}

function extractSeries(
  raw: FiatRateSeriesResponse | Record<string, unknown> | unknown,
  coin: string,
): FiatRateSeries | null {
  'worklet';

  const direct = toSeriesFromProviderCandidate(raw);
  if (direct) {
    return direct;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const candidate =
    record[coin] ?? record[coin.toLowerCase()] ?? record[coin.toUpperCase()];
  const matched = toSeriesFromProviderCandidate(candidate);
  if (matched) {
    return matched;
  }

  const values = Object.values(record);
  if (values.length === 1) {
    return toSeriesFromProviderCandidate(values[0]);
  }

  return null;
}

async function fetchFiatRatePayload(args: {
  cfg: BwsConfig;
  quoteCurrency: string;
  interval: FiatRateInterval;
  asset?: Pick<FiatRateAssetRef, 'chain' | 'tokenAddress'>;
}): Promise<unknown> {
  'worklet';

  const url = getFiatRateSeriesUrl(
    args.cfg,
    args.quoteCurrency,
    args.interval,
    {
      chain: args.asset?.chain,
      tokenAddress: args.asset?.tokenAddress,
    },
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch (error: unknown) {
    const runtimeError =
      error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Portfolio fiat-rate request failed for ${url}: ${runtimeError.message}`,
    );
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to fetch fiat rates (${
        response.status
      }) for ${url}. ${rawText.slice(0, 400)}`,
    );
  }

  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    return {};
  }
}

async function fetchFiatRateSeries(args: {
  cfg: BwsConfig;
  quoteCurrency: string;
  interval: FiatRateInterval;
  asset: FiatRateAssetRef;
}): Promise<FiatRateSeries | null> {
  'worklet';

  const payload = await fetchFiatRatePayload({
    cfg: args.cfg,
    quoteCurrency: args.quoteCurrency,
    interval: args.interval,
    asset: {
      chain: args.asset.chain,
      tokenAddress: args.asset.tokenAddress,
    },
  });

  return extractSeries(payload, args.asset.coin);
}

export function loadWorkletStoredRateSeries(
  args: PortfolioWorkletKvConfig & {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    chain?: string;
    tokenAddress?: string;
  },
): FiatRateSeries | null {
  'worklet';

  const key = getWorkletRateStorageKey({
    quoteCurrency: args.quoteCurrency,
    coin: args.coin,
    interval: args.interval,
    chain: args.chain,
    tokenAddress: args.tokenAddress,
  });

  return parseWorkletStoredFiatRateSeries(workletKvGetString(args, key));
}

async function loadOrFetchRateSeries(
  args: PortfolioWorkletKvConfig & {
    cfg: BwsConfig;
    quoteCurrency: string;
    interval: FiatRateInterval;
    asset: FiatRateAssetRef;
  },
): Promise<FiatRateSeries | null> {
  'worklet';

  const stored = loadWorkletStoredRateSeries({
    storage: args.storage,
    registryKey: args.registryKey,
    quoteCurrency: args.quoteCurrency,
    coin: args.asset.coin,
    interval: args.interval,
    chain: args.asset.chain,
    tokenAddress: args.asset.tokenAddress,
  });
  if (
    stored?.points?.length &&
    hasStoredFiatRateSeriesPersistedFetchedOn(stored)
  ) {
    return stored;
  }

  let fetched: FiatRateSeries | null;
  try {
    fetched = await fetchFiatRateSeries({
      cfg: args.cfg,
      quoteCurrency: args.quoteCurrency,
      interval: args.interval,
      asset: args.asset,
    });
  } catch (error: unknown) {
    if (stored?.points?.length) {
      return stored;
    }
    throw error;
  }
  if (!fetched?.points?.length) {
    return stored?.points?.length ? stored : null;
  }

  workletKvSetString(
    args,
    getWorkletRateStorageKey({
      quoteCurrency: args.quoteCurrency,
      coin: args.asset.coin,
      interval: args.interval,
      chain: args.asset.chain,
      tokenAddress: args.asset.tokenAddress,
    }),
    encodeStoredSeries(fetched),
  );
  return fetched;
}

export async function ensureWorkletRates(
  args: PortfolioWorkletKvConfig & {
    cfg: BwsConfig;
    quoteCurrency: string;
    interval: FiatRateInterval;
    coins: string[];
    assets?: FiatRateAssetRef[];
  },
): Promise<void> {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase() || 'USD';
  const interval = resolveStoredFiatRateInterval(args.interval);
  const assetsRaw: FiatRateAssetRef[] = [
    ...(Array.isArray(args.coins) ? args.coins : []).map(coin => ({coin})),
    ...(Array.isArray(args.assets) ? args.assets : []),
  ];

  const uniqueAssets = Array.from(
    new Map(
      assetsRaw.map(asset => {
        const normalized = getFiatRateAssetRef({
          currencyAbbreviation: asset.coin,
          chain: asset.chain,
          tokenAddress: asset.tokenAddress,
        });
        const key = `${normalized.coin}|${normalized.chain || ''}|${
          normalized.tokenAddress || ''
        }`;
        return [key, normalized] as const;
      }),
    ).values(),
  );

  const missingDefaults: string[] = [];
  const missingExplicit: FiatRateAssetRef[] = [];
  const fallbackDefaultCoins = new Set<string>();

  for (const asset of uniqueAssets) {
    const existing = loadWorkletStoredRateSeries({
      storage: args.storage,
      registryKey: args.registryKey,
      quoteCurrency,
      coin: asset.coin,
      interval,
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    });
    if (existing?.points?.length) {
      if (hasStoredFiatRateSeriesPersistedFetchedOn(existing)) {
        continue;
      }
      if (!asset.tokenAddress) {
        fallbackDefaultCoins.add(asset.coin);
      }
    }

    if (asset.tokenAddress) {
      missingExplicit.push(asset);
    } else {
      missingDefaults.push(asset.coin);
    }
  }

  if (!missingDefaults.length && !missingExplicit.length) {
    return;
  }

  if (missingDefaults.length) {
    let payload: unknown;
    try {
      payload = await fetchFiatRatePayload({
        cfg: args.cfg,
        quoteCurrency,
        interval,
      });
    } catch (error: unknown) {
      const missingWithoutFallback = missingDefaults.filter(
        coin => !fallbackDefaultCoins.has(coin),
      );
      if (missingWithoutFallback.length) {
        throw error;
      }
      payload = null;
    }

    if (payload != null) {
      for (const coin of missingDefaults) {
        const series = extractSeries(payload, coin);
        if (series?.points?.length) {
          workletKvSetString(
            args,
            getWorkletRateStorageKey({
              quoteCurrency,
              coin,
              interval,
            }),
            encodeStoredSeries(series),
          );
        }
      }
    }
  }

  for (const asset of missingExplicit) {
    try {
      const series = await fetchFiatRateSeries({
        cfg: args.cfg,
        quoteCurrency,
        interval,
        asset,
      });
      if (series?.points?.length) {
        workletKvSetString(
          args,
          getWorkletRateStorageKey({
            quoteCurrency,
            coin: asset.coin,
            interval,
            chain: asset.chain,
            tokenAddress: asset.tokenAddress,
          }),
          encodeStoredSeries(series),
        );
      }
    } catch {
      continue;
    }
  }
}

export async function getWorkletRateSeriesWithFx(
  args: PortfolioWorkletKvConfig & {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    chain?: string;
    tokenAddress?: string;
  },
): Promise<FiatRateSeries | null> {
  'worklet';

  return getFiatRateSeriesWithFx({
    getSeries: query => {
      'worklet';

      return Promise.resolve(
        loadWorkletStoredRateSeries({
          storage: args.storage,
          registryKey: args.registryKey,
          quoteCurrency: query.quoteCurrency,
          coin: query.coin,
          interval: query.interval,
          chain: query.chain,
          tokenAddress: query.tokenAddress,
        }),
      );
    },
    quoteCurrency: args.quoteCurrency,
    coin: args.coin,
    interval: args.interval,
    chain: args.chain,
    tokenAddress: args.tokenAddress,
  });
}

export function listWorkletRates(
  args: PortfolioWorkletKvConfig & {
    quoteCurrency?: string;
  },
): Array<{
  key: string;
  quoteCurrency: string;
  coin: string;
  interval: FiatRateInterval;
  fetchedOn: number;
  points: number;
  firstTs: number | null;
  lastTs: number | null;
  bytes: number;
}> {
  'worklet';

  const quote = args.quoteCurrency
    ? String(args.quoteCurrency).toUpperCase()
    : null;
  const prefix = quote ? `rate:v1:${quote}:` : 'rate:v1:';
  const keys = workletKvListKeys(args, prefix).sort();

  const out: Array<{
    key: string;
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    fetchedOn: number;
    points: number;
    firstTs: number | null;
    lastTs: number | null;
    bytes: number;
  }> = [];

  for (const key of keys) {
    const raw = workletKvGetString(args, key);
    if (!raw) continue;
    const series = parseWorkletStoredFiatRateSeries(raw);
    if (!series?.points?.length) continue;

    const parts = key.split(':');
    const quoteCurrency = parts[2] ?? '';
    const coin = parts[3] ?? '';
    const interval = String(parts[4] ?? '') as FiatRateInterval;
    const firstTs = Number(series.points[0]?.ts);
    const lastTs = Number(series.points[series.points.length - 1]?.ts);

    out.push({
      key,
      quoteCurrency,
      coin,
      interval,
      fetchedOn: Number(series.fetchedOn ?? 0),
      points: series.points.length,
      firstTs: Number.isFinite(firstTs) ? firstTs : null,
      lastTs: Number.isFinite(lastTs) ? lastTs : null,
      bytes: raw.length,
    });
  }

  return out;
}

export function clearWorkletRates(
  args: PortfolioWorkletKvConfig & {
    quoteCurrency?: string;
  },
): void {
  'worklet';

  const quote = args.quoteCurrency
    ? String(args.quoteCurrency).toUpperCase()
    : null;
  const prefix = quote ? `rate:v1:${quote}:` : 'rate:v1:';
  for (const key of workletKvListKeys(args, prefix)) {
    workletKvDelete(args, key);
  }
}

export async function ensureWorkletSnapshotRateSeriesCache(
  args: PortfolioWorkletKvConfig & {
    cfg: BwsConfig;
    quoteCurrency: string;
    wallet: WalletSummary;
  },
): Promise<FiatRateSeriesCache> {
  'worklet';

  const quoteCurrency = String(
    args.quoteCurrency || CANONICAL_FIAT_QUOTE,
  ).toUpperCase();
  const asset = getFiatRateAssetRef({
    currencyAbbreviation: args.wallet.currencyAbbreviation,
    chain: args.wallet.chain,
    tokenAddress: args.wallet.tokenAddress,
  });
  const {coin, chain, tokenAddress} = asset;

  const intervals = Array.from(
    new Set(
      DEFAULT_STORED_FIAT_RATE_INTERVALS.map(resolveStoredFiatRateInterval),
    ),
  );
  const cache: FiatRateSeriesCache = {};
  let lastError: Error | undefined;

  for (const interval of intervals) {
    try {
      const series = await loadOrFetchRateSeries({
        storage: args.storage,
        registryKey: args.registryKey,
        cfg: args.cfg,
        quoteCurrency,
        interval,
        asset,
      });
      if (!series?.points?.length) {
        continue;
      }

      cache[
        getFiatRateSeriesCacheKey(quoteCurrency, coin, interval, {
          chain,
          tokenAddress,
        })
      ] = series;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!Object.keys(cache).length && lastError) {
    throw lastError;
  }

  return cache;
}

export async function ensureWorkletCanonicalAndFxRates(
  args: PortfolioWorkletKvConfig & {
    cfg: BwsConfig;
    quoteCurrency: string;
    timeframe: FiatRateInterval;
    assets: Array<{
      coin: string;
      chain?: string;
      tokenAddress?: string;
    }>;
  },
): Promise<void> {
  'worklet';

  const targetQuoteCurrency = String(
    args.quoteCurrency || CANONICAL_FIAT_QUOTE,
  ).toUpperCase();
  const defaultCoins = Array.from(
    new Set([
      ...args.assets
        .filter(asset => !asset.tokenAddress)
        .map(asset => normalizeFiatRateSeriesCoin(asset.coin)),
      FX_BRIDGE_COIN,
    ]),
  );
  const explicitAssets = args.assets.filter(asset => !!asset.tokenAddress);

  await ensureWorkletRates({
    storage: args.storage,
    registryKey: args.registryKey,
    cfg: args.cfg,
    quoteCurrency: CANONICAL_FIAT_QUOTE,
    interval: args.timeframe,
    coins: defaultCoins,
    assets: explicitAssets,
  });

  if (targetQuoteCurrency !== CANONICAL_FIAT_QUOTE) {
    await ensureWorkletRates({
      storage: args.storage,
      registryKey: args.registryKey,
      cfg: args.cfg,
      quoteCurrency: targetQuoteCurrency,
      interval: args.timeframe,
      coins: [FX_BRIDGE_COIN],
    });
  }
}
