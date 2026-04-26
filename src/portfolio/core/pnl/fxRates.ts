import type {
  FiatRateInterval,
  FiatRatePoint,
  FiatRateSeries,
  FiatRateSeriesCache,
  StoredFiatRateInterval,
} from '../fiatRatesShared';
import {
  CANONICAL_FIAT_QUOTE,
  FX_BRIDGE_COIN,
  getFiatRateSeriesCacheKey,
  resolveStoredFiatRateInterval,
} from '../fiatRatesShared';
import {createPreparedRateReader, normalizeRatePoints} from './rateReader';
import {normalizeFiatRateSeriesCoin} from './rates';

type SeriesGetter = (args: {
  quoteCurrency: string;
  coin: string;
  interval: StoredFiatRateInterval;
  chain?: string;
  tokenAddress?: string;
}) => Promise<FiatRateSeries | null>;

function normalizePoints(pointsRaw: FiatRatePoint[] | undefined): FiatRatePoint[] {
  'worklet';

  return normalizeRatePoints(pointsRaw);
}

function getSeriesFromCache(args: {
  fiatRateSeriesCache: FiatRateSeriesCache;
  quoteCurrency: string;
  coin: string;
  interval: StoredFiatRateInterval;
  chain?: string;
  tokenAddress?: string;
}): FiatRateSeries | null {
  'worklet';

  const key = getFiatRateSeriesCacheKey(args.quoteCurrency, args.coin, args.interval, {
    chain: args.chain,
    tokenAddress: args.tokenAddress,
  });
  const series = args.fiatRateSeriesCache?.[key];
  return series?.points?.length ? series : null;
}

function deriveTargetSeries(args: {
  quoteCurrency: string;
  interval: StoredFiatRateInterval;
  canonicalQuote?: string;
  baseCoinSeries: FiatRateSeries;
  bridgeTargetSeries: FiatRateSeries;
  bridgeCanonicalSeries: FiatRateSeries;
}): FiatRateSeries | null {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase();
  const canonicalQuote = String(args.canonicalQuote || CANONICAL_FIAT_QUOTE).toUpperCase();

  if (quoteCurrency === canonicalQuote) {
    return {
      fetchedOn: Number(args.baseCoinSeries.fetchedOn ?? Date.now()) || Date.now(),
      points: normalizePoints(args.baseCoinSeries.points),
    };
  }

  const basePoints = normalizePoints(args.baseCoinSeries.points);
  const bridgeTargetReader = createPreparedRateReader({
    series: args.bridgeTargetSeries,
    policy: 'linearRender',
  });
  const bridgeCanonicalReader = createPreparedRateReader({
    series: args.bridgeCanonicalSeries,
    policy: 'linearRender',
  });
  if (!basePoints.length || !bridgeTargetReader.hasPoints || !bridgeCanonicalReader.hasPoints) return null;

  const derivedPoints: FiatRatePoint[] = [];
  for (const p of basePoints) {
    const bridgeTargetRate = bridgeTargetReader.read(p.ts);
    const bridgeCanonicalRate = bridgeCanonicalReader.read(p.ts);
    if (
      bridgeTargetRate.kind !== 'rate' ||
      bridgeCanonicalRate.kind !== 'rate' ||
      p.rate <= 0 ||
      bridgeTargetRate.rate <= 0 ||
      bridgeCanonicalRate.rate <= 0
    ) {
      return null;
    }

    const rate = p.rate * bridgeTargetRate.rate / bridgeCanonicalRate.rate;
    if (!Number.isFinite(rate)) return null;
    derivedPoints.push({ts: p.ts, rate});
  }

  if (!derivedPoints.length) return null;

  return {
    fetchedOn: Math.max(
      Number(args.baseCoinSeries.fetchedOn ?? 0) || 0,
      Number(args.bridgeTargetSeries.fetchedOn ?? 0) || 0,
      Number(args.bridgeCanonicalSeries.fetchedOn ?? 0) || 0,
    ),
    points: derivedPoints,
  };
}

export async function getFiatRateSeriesWithFx(args: {
  getSeries: SeriesGetter;
  quoteCurrency: string;
  coin: string;
  interval: FiatRateInterval;
  chain?: string;
  tokenAddress?: string;
  canonicalQuote?: string;
  bridgeCoin?: string;
  preferDirectTargetSeries?: boolean;
}): Promise<FiatRateSeries | null> {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase();
  const canonicalQuote = String(args.canonicalQuote || CANONICAL_FIAT_QUOTE).toUpperCase();
  const coin = normalizeFiatRateSeriesCoin(args.coin);
  const bridgeCoin = normalizeFiatRateSeriesCoin(args.bridgeCoin || FX_BRIDGE_COIN);
  const storedInterval = resolveStoredFiatRateInterval(args.interval);

  const shouldReadDirectTargetSeries =
    quoteCurrency === canonicalQuote || args.preferDirectTargetSeries === true;

  if (shouldReadDirectTargetSeries) {
    const direct = await args.getSeries({
      quoteCurrency,
      coin,
      interval: storedInterval,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
    });
    if (direct?.points?.length) {
      return direct;
    }
  }

  if (quoteCurrency === canonicalQuote) return null;

  const [baseCoinSeries, bridgeTargetSeries, bridgeCanonicalSeries] = await Promise.all([
    args.getSeries({
      quoteCurrency: canonicalQuote,
      coin,
      interval: storedInterval,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
    }),
    args.getSeries({quoteCurrency, coin: bridgeCoin, interval: storedInterval}),
    args.getSeries({quoteCurrency: canonicalQuote, coin: bridgeCoin, interval: storedInterval}),
  ]);

  if (!baseCoinSeries || !bridgeTargetSeries || !bridgeCanonicalSeries) return null;

  return deriveTargetSeries({
    quoteCurrency,
    interval: storedInterval,
    canonicalQuote,
    baseCoinSeries,
    bridgeTargetSeries,
    bridgeCanonicalSeries,
  });
}

export function getFiatRateSeriesFromCacheWithFx(args: {
  fiatRateSeriesCache: FiatRateSeriesCache;
  quoteCurrency: string;
  coin: string;
  interval: FiatRateInterval;
  chain?: string;
  tokenAddress?: string;
  canonicalQuote?: string;
  bridgeCoin?: string;
  preferDirectTargetSeries?: boolean;
}): FiatRateSeries | null {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase();
  const canonicalQuote = String(args.canonicalQuote || CANONICAL_FIAT_QUOTE).toUpperCase();
  const coin = normalizeFiatRateSeriesCoin(args.coin);
  const bridgeCoin = normalizeFiatRateSeriesCoin(args.bridgeCoin || FX_BRIDGE_COIN);
  const storedInterval = resolveStoredFiatRateInterval(args.interval);

  const shouldReadDirectTargetSeries =
    quoteCurrency === canonicalQuote || args.preferDirectTargetSeries === true;

  if (shouldReadDirectTargetSeries) {
    const direct = getSeriesFromCache({
      fiatRateSeriesCache: args.fiatRateSeriesCache,
      quoteCurrency,
      coin,
      interval: storedInterval,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
    });
    if (direct?.points?.length) {
      return direct;
    }
  }

  if (quoteCurrency === canonicalQuote) return null;

  const baseCoinSeries = getSeriesFromCache({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    quoteCurrency: canonicalQuote,
    coin,
    interval: storedInterval,
    chain: args.chain,
    tokenAddress: args.tokenAddress,
  });
  const bridgeTargetSeries = getSeriesFromCache({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    quoteCurrency,
    coin: bridgeCoin,
    interval: storedInterval,
  });
  const bridgeCanonicalSeries = getSeriesFromCache({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    quoteCurrency: canonicalQuote,
    coin: bridgeCoin,
    interval: storedInterval,
  });

  if (!baseCoinSeries || !bridgeTargetSeries || !bridgeCanonicalSeries) return null;

  return deriveTargetSeries({
    quoteCurrency,
    interval: storedInterval,
    canonicalQuote,
    baseCoinSeries,
    bridgeTargetSeries,
    bridgeCanonicalSeries,
  });
}
