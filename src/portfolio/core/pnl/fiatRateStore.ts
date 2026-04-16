import type {KvStore} from '../kv/types';
import {jsonParseSafe, jsonStringifySafe} from '../kv/types';
import type {
  FiatRateAssetRef,
  FiatRateInterval,
  FiatRatePoint,
  FiatRateSeries,
  FiatRateSeriesResponse,
} from '../fiatRatesShared';
import {resolveStoredFiatRateInterval} from '../fiatRatesShared';
import type {BwsConfig} from '../shared/bws';
import {getFiatRateSeriesWithFx} from './fxRates';
import {getFiatRateAssetRef} from './rates';

type StoredFiatRateSeriesV2 = {
  v: 2;
  p: Array<[number, number]>;
};

function rateKey(args: {
  quoteCurrency: string;
  coin: string;
  interval: FiatRateInterval;
  chain?: string;
  tokenAddress?: string;
}): string {
  const base = `rate:v1:${args.quoteCurrency.toUpperCase()}:${args.coin.toLowerCase()}:${resolveStoredFiatRateInterval(args.interval)}`;
  if (!args.tokenAddress) return base;
  return `${base}:${String(args.chain || '').toLowerCase()}:${String(args.tokenAddress).toLowerCase()}`;
}

function normalizeSeriesPoints(raw: unknown): FiatRatePoint[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map(p =>
      Array.isArray(p)
        ? {ts: Number(p[0]), rate: Number(p[1])}
        : {ts: Number((p as any)?.ts), rate: Number((p as any)?.rate)},
    )
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.rate))
    .sort((a, b) => a.ts - b.ts);
}

function toSeriesFromProviderCandidate(candidate: unknown): FiatRateSeries | null {
  const directPoints = normalizeSeriesPoints(candidate);
  if (directPoints.length) {
    return {
      fetchedOn: Date.now(),
      points: directPoints,
    };
  }

  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const fetchedOnRaw = Number((candidate as any).fetchedOn);
    const points = normalizeSeriesPoints((candidate as any).points);
    if (points.length) {
      return {
        fetchedOn: Number.isFinite(fetchedOnRaw) ? fetchedOnRaw : Date.now(),
        points,
      };
    }
  }

  return null;
}

function decodeStoredFiatRateSeriesValue(candidate: unknown): FiatRateSeries | null {
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    if (Number((candidate as any).v) === 2) {
      const points = normalizeSeriesPoints((candidate as StoredFiatRateSeriesV2).p);
      if (!points.length) return null;
      return {
        fetchedOn: 0,
        points,
      };
    }

    const fetchedOnRaw = Number((candidate as any).fetchedOn);
    const points = normalizeSeriesPoints((candidate as any).points);
    if (points.length) {
      return {
        fetchedOn: Number.isFinite(fetchedOnRaw) ? fetchedOnRaw : 0,
        points,
      };
    }
  }

  const directPoints = normalizeSeriesPoints(candidate);
  if (!directPoints.length) return null;

  return {
    fetchedOn: 0,
    points: directPoints,
  };
}

function encodeStoredFiatRateSeriesValue(series: FiatRateSeries): StoredFiatRateSeriesV2 {
  return {
    v: 2,
    p: normalizeSeriesPoints(series.points).map(point => [point.ts, point.rate]),
  };
}

export function parseStoredFiatRateSeries(raw: string | null): FiatRateSeries | null {
  return decodeStoredFiatRateSeriesValue(jsonParseSafe<unknown>(raw, null));
}

function extractSeries(raw: unknown, coin: string): FiatRateSeries | null {
  const direct = toSeriesFromProviderCandidate(raw);
  if (direct) return direct;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const candidate =
    record[coin] ??
    record[coin.toLowerCase()] ??
    record[coin.toUpperCase()];

  const matched = toSeriesFromProviderCandidate(candidate);
  if (matched) return matched;

  // Token-specific endpoints may return a single keyed entry that does not match the requested symbol exactly.
  const singleValue = Object.values(record).length === 1 ? Object.values(record)[0] : undefined;
  const fallback = toSeriesFromProviderCandidate(singleValue);
  if (fallback) return fallback;

  return null;
}

export interface FiatRateProvider {
  loadSeries(args: {
    cfg: BwsConfig;
    quoteCurrency: string;
    interval: FiatRateInterval;
    coins: string[];
    asset?: FiatRateAssetRef;
  }): Promise<FiatRateSeriesResponse | unknown>;
}

/**
 * A tiny persistent cache for fiat rate series.
 *
 * In the web harness we back this with IndexedDB (in a worker). In RN you can back it with
 * MMKV/SQLite/etc.
 */
export class FiatRateStore {
  private kv: KvStore;
  private mem = new Map<string, FiatRateSeries>();
  private provider: FiatRateProvider | null;

  constructor(kv: KvStore, opts?: {provider?: FiatRateProvider}) {
    this.kv = kv;
    this.provider = opts?.provider ?? null;
  }

  clearMemoryCache(): void {
    this.mem.clear();
  }

  private async getStoredSeries(args: {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    chain?: string;
    tokenAddress?: string;
  }): Promise<FiatRateSeries | null> {
    const key = rateKey(args);
    const cached = this.mem.get(key);
    if (cached) return cached;

    const raw = await this.kv.getString(key);
    const series = parseStoredFiatRateSeries(raw);
    if (!series) return null;
    this.mem.set(key, series);
    return series;
  }

  async getSeries(args: {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    chain?: string;
    tokenAddress?: string;
  }): Promise<FiatRateSeries | null> {
    return this.getStoredSeries(args);
  }

  async getSeriesWithFx(args: {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    chain?: string;
    tokenAddress?: string;
  }): Promise<FiatRateSeries | null> {
    const derived = await getFiatRateSeriesWithFx({
      getSeries: query => this.getStoredSeries(query),
      quoteCurrency: args.quoteCurrency,
      coin: args.coin,
      interval: args.interval,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
    });
    if (!derived) return null;

    // Cache derived read-through results in memory only; do not persist duplicate quote series.
    this.mem.set(rateKey(args), derived);
    return derived;
  }

  async setSeries(args: {
    quoteCurrency: string;
    coin: string;
    interval: FiatRateInterval;
    series: FiatRateSeries;
    chain?: string;
    tokenAddress?: string;
  }): Promise<void> {
    const key = rateKey(args);
    this.mem.set(key, args.series);
    await this.kv.setString(key, jsonStringifySafe(encodeStoredFiatRateSeriesValue(args.series)));
  }

  /**
   * Ensures the requested (quoteCurrency, interval) rates exist for the given coins.
   *
   * NOTE: The BWS endpoint returns many coins in one payload; we store only the subset we need.
   */
  async ensureRates(args: {
    cfg: BwsConfig;
    quoteCurrency: string;
    interval: FiatRateInterval;
    coins: string[];
    assets?: FiatRateAssetRef[];
  }): Promise<void> {
    const quoteCurrency = args.quoteCurrency.toUpperCase();
    const assetsRaw: FiatRateAssetRef[] = [
      ...args.coins.map(coin => ({coin})),
      ...(args.assets ?? []),
    ];
    const assets = Array.from(
      new Map(
        assetsRaw.map(asset => {
          const normalized = getFiatRateAssetRef({
            currencyAbbreviation: asset.coin,
            chain: asset.chain,
            tokenAddress: asset.tokenAddress,
          });
          const id = `${normalized.coin}|${normalized.chain || ''}|${normalized.tokenAddress || ''}`;
          return [id, normalized];
        }),
      ).values(),
    );
    const interval = resolveStoredFiatRateInterval(args.interval);

    const missingDefaults: string[] = [];
    const missingExplicit: FiatRateAssetRef[] = [];
    for (const asset of assets) {
      const existing = await this.getStoredSeries({
        quoteCurrency,
        coin: asset.coin,
        interval,
        chain: asset.chain,
        tokenAddress: asset.tokenAddress,
      });
      if (existing?.points?.length) continue;
      if (asset.tokenAddress) missingExplicit.push(asset);
      else missingDefaults.push(asset.coin);
    }
    if (!missingDefaults.length && !missingExplicit.length) return;

    if (!this.provider) {
      throw new Error('FiatRateStore cannot fetch rates without an injected rate provider.');
    }

    if (missingDefaults.length) {
      const json = await this.provider.loadSeries({
        cfg: args.cfg,
        quoteCurrency,
        interval,
        coins: missingDefaults,
      });

      for (const coin of missingDefaults) {
        const series = extractSeries(json, coin);
        if (series?.points?.length) {
          await this.setSeries({quoteCurrency, coin, interval, series});
        }
      }
    }

    for (const asset of missingExplicit) {
      const json = await this.provider.loadSeries({
        cfg: args.cfg,
        quoteCurrency,
        interval,
        coins: [asset.coin],
        asset,
      });

      const series = extractSeries(json, asset.coin);
      if (series?.points?.length) {
        await this.setSeries({
          quoteCurrency,
          coin: asset.coin,
          interval,
          series,
          chain: asset.chain,
          tokenAddress: asset.tokenAddress,
        });
      }
    }
  }
}
