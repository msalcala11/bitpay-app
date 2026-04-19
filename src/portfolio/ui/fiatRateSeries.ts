import type {FiatRateCacheRequest} from '../core/fiatRatesShared';
import type {FiatRateSeriesCache} from '../../store/rate/rate.models';
import {getPortfolioRuntimeClient} from '../runtime/portfolioRuntime';
import {createPortfolioQueryBwsConfig} from './common';

const sortRequestIntervals = (intervals: string[]): string[] => {
  return Array.from(new Set(intervals.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
};

export const normalizeRuntimeFiatRateCacheRequests = (
  requests: FiatRateCacheRequest[],
): FiatRateCacheRequest[] => {
  const merged = new Map<string, FiatRateCacheRequest>();

  for (const request of Array.isArray(requests) ? requests : []) {
    const coin = String(request?.coin || '')
      .trim()
      .toLowerCase();
    const chain = String(request?.chain || '')
      .trim()
      .toLowerCase();
    const tokenAddress = String(request?.tokenAddress || '').trim();
    const intervals = sortRequestIntervals(
      (Array.isArray(request?.intervals) ? request.intervals : []).map(
        interval => String(interval || '').trim(),
      ),
    );

    if (!coin || !intervals.length) {
      continue;
    }

    const key = `${coin}|${chain}|${tokenAddress}`;
    const existing = merged.get(key);
    if (existing) {
      existing.intervals = sortRequestIntervals([
        ...existing.intervals,
        ...intervals,
      ]) as FiatRateCacheRequest['intervals'];
      continue;
    }

    merged.set(key, {
      coin,
      intervals: intervals as FiatRateCacheRequest['intervals'],
      ...(chain ? {chain} : {}),
      ...(tokenAddress ? {tokenAddress} : {}),
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    `${a.coin}|${a.chain || ''}|${a.tokenAddress || ''}`.localeCompare(
      `${b.coin}|${b.chain || ''}|${b.tokenAddress || ''}`,
    ),
  );
};

export const buildRuntimeFiatRateCacheRequestKey = (args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
}): string => {
  const normalizedRequests = normalizeRuntimeFiatRateCacheRequests(
    args.requests,
  );

  return [
    String(args.quoteCurrency || '')
      .trim()
      .toUpperCase(),
    typeof args.maxAgeMs === 'number' && Number.isFinite(args.maxAgeMs)
      ? String(args.maxAgeMs)
      : '',
    normalizedRequests
      .map(
        request =>
          `${request.coin}|${request.chain || ''}|${
            request.tokenAddress || ''
          }|${request.intervals.join(',')}`,
      )
      .join('||'),
  ].join('|');
};

export async function loadRuntimeFiatRateSeriesCache(args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
  force?: boolean;
}): Promise<FiatRateSeriesCache> {
  const requests = normalizeRuntimeFiatRateCacheRequests(args.requests);
  if (!requests.length) {
    return {};
  }

  return getPortfolioRuntimeClient().getRateSeriesCache({
    cfg: createPortfolioQueryBwsConfig(),
    quoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase(),
    requests,
    maxAgeMs: args.maxAgeMs,
    force: args.force,
  });
}

export async function replaceRuntimeFiatRateSeriesCache(args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
}): Promise<FiatRateSeriesCache> {
  const client = getPortfolioRuntimeClient();
  await client.clearRateStorage({});

  const requests = normalizeRuntimeFiatRateCacheRequests(args.requests);
  if (!requests.length) {
    return {};
  }

  return loadRuntimeFiatRateSeriesCache({
    quoteCurrency: args.quoteCurrency,
    requests,
    maxAgeMs: args.maxAgeMs,
    force: true,
  });
}
