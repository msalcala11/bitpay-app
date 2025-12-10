import {getHistoricFiatRate} from '../wallet/effects/rates/rates';

const RATE_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, {rate: number; fetchedOn: number}>();

// Network request counter and URL tracking for debugging/monitoring
let networkRequestCount = 0;
let lastRequestUrl = '';

export const resetNetworkRequestCount = () => {
  networkRequestCount = 0;
  lastRequestUrl = '';
};

export const getNetworkRequestCount = () => networkRequestCount;

export const getLastRequestUrl = () => lastRequestUrl;

export interface QuoteRateRequest {
  quoteCurrency: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
  timestampMs: number;
}

const getHourBucket = (timestampMs: number) => {
  const msPerHour = 60 * 60 * 1000;
  return Math.floor(timestampMs / msPerHour) * msPerHour;
};

const getCacheKey = ({
  quoteCurrency,
  currencyAbbreviation,
  chain,
  tokenAddress,
  timestampMs,
}: QuoteRateRequest) => {
  const bucket = getHourBucket(timestampMs);
  const tokenPart = tokenAddress ? tokenAddress.toLowerCase() : 'native';
  return `${chain.toLowerCase()}-${currencyAbbreviation.toLowerCase()}-${tokenPart}-${quoteCurrency.toUpperCase()}-${bucket}`;
};

export const getHistoricQuoteRate = async (
  request: QuoteRateRequest,
): Promise<number> => {
  const key = getCacheKey(request);
  const cached = cache.get(key);
  const now = Date.now();

  if (cached && now - cached.fetchedOn < RATE_CACHE_TTL_MS) {
    return cached.rate;
  }

  try {
    const hourBucket = getHourBucket(request.timestampMs);
    networkRequestCount++;
    lastRequestUrl = `${request.currencyAbbreviation}/${request.quoteCurrency}@${new Date(hourBucket).toISOString().slice(0, 13)}`;
    const response = await getHistoricFiatRate(
      request.quoteCurrency,
      request.currencyAbbreviation,
      hourBucket.toString(),
    );
    const rate = response?.rate || 0;
    cache.set(key, {rate, fetchedOn: now});
    return rate;
  } catch (err) {
    return 0;
  }
};
