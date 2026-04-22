import {BASE_BWS_URL, BWC_TIMEOUT} from '../../constants/config';
import {GetPrecision} from '../../store/wallet/utils/currency';
import type {Wallet} from '../../store/wallet/wallet.models';
import type {AppDispatch} from '../../utils/hooks';
import type {Rates} from '../../store/rate/rate.models';
import {
  isPortfolioRuntimeEligibleWallet,
  toPortfolioStoredWallet,
} from '../adapters/rn/walletMappers';
import {getAssetIdFromWallet} from '../core/pnl/assetId';
import {
  type PnlAnalysisChartResult,
  type PnlAnalysisResult,
  type PnlTimeframe,
} from '../core/pnl/analysisStreaming';
import type {BwsConfig} from '../core/shared/bws';
import type {StoredWallet} from '../core/types';
import {getPortfolioRuntimeClient} from '../runtime/portfolioRuntime';
import {
  buildCommittedPortfolioHoldingsRevisionToken,
  getAssetCurrentDisplayQuoteRate,
  resolveActivePortfolioDisplayQuoteCurrency,
} from '../../utils/portfolio/displayCurrency';

export function createPortfolioQueryBwsConfig(): BwsConfig {
  return {
    baseUrl: BASE_BWS_URL,
    timeoutMs: BWC_TIMEOUT,
  };
}

export function resolveCommittedPortfolioQuoteCurrency(args: {
  portfolioQuoteCurrency?: string;
  defaultAltCurrencyIsoCode?: string;
}): string {
  const committedQuote = String(args.portfolioQuoteCurrency || '')
    .trim()
    .toUpperCase();
  if (committedQuote) {
    return committedQuote;
  }

  const defaultAlt = String(args.defaultAltCurrencyIsoCode || '')
    .trim()
    .toUpperCase();
  return defaultAlt || 'USD';
}

export function buildCommittedPortfolioRevisionToken(args: {
  quoteCurrency?: string;
  lastPopulatedAt?: number;
}): string {
  return buildCommittedPortfolioHoldingsRevisionToken({
    lastPopulatedAt: args.lastPopulatedAt,
  });
}

// Backwards-compatible alias retained during the migration of portfolio UI
// hooks to committed-only revision tokens.
export const resolvePortfolioQuoteCurrency =
  resolveCommittedPortfolioQuoteCurrency;
export {buildCommittedPortfolioHoldingsRevisionToken};
export {resolveActivePortfolioDisplayQuoteCurrency};

function shouldLogPortfolioAssetDiagnostics(debugSource?: string): boolean {
  return /asset/i.test(String(debugSource || ''));
}

function summarizeAnalysisResultShape(
  value: PnlAnalysisResult | undefined,
): {
  walletCount: number;
  pointCount: number;
  assetSummaryCount: number;
  assetIdCount: number;
} {
  return {
    walletCount: Array.isArray(value?.wallets) ? value.wallets.length : 0,
    pointCount: Array.isArray(value?.points) ? value.points.length : 0,
    assetSummaryCount: Array.isArray(value?.assetSummaries)
      ? value.assetSummaries.length
      : 0,
    assetIdCount: Array.isArray(value?.assetIds) ? value.assetIds.length : 0,
  };
}

function toAnalysisSessionTag(sessionId: string | undefined): string {
  const raw = String(sessionId || '').trim();
  if (!raw) {
    return 'unknown';
  }

  const parts = raw.split(':');
  return parts[parts.length - 1] || raw;
}

function getWalletUnitDecimals(dispatch: AppDispatch, wallet: Wallet): number {
  const precision =
    dispatch(
      GetPrecision(
        wallet.currencyAbbreviation,
        wallet.chain,
        wallet.tokenAddress,
      ) as any,
    ) || undefined;

  return precision?.unitDecimals || 0;
}

export function mapWalletsToStoredWallets(args: {
  dispatch: AppDispatch;
  wallets: Wallet[];
}): {
  eligibleWallets: Wallet[];
  storedWallets: StoredWallet[];
} {
  const eligibleWallets = (
    Array.isArray(args.wallets) ? args.wallets : []
  ).filter(isPortfolioRuntimeEligibleWallet);

  return {
    eligibleWallets,
    storedWallets: eligibleWallets.map(wallet =>
      toPortfolioStoredWallet({
        wallet,
        unitDecimals: getWalletUnitDecimals(args.dispatch, wallet),
        addedAt: 0,
      }),
    ),
  };
}

export function getStoredWalletRequestSignature(
  storedWallets: StoredWallet[],
): string {
  return storedWallets
    .map(wallet => {
      const summary = wallet.summary;
      return [
        summary.walletId,
        summary.chain,
        summary.currencyAbbreviation,
        summary.tokenAddress || '',
      ].join(':');
    })
    .sort()
    .join('|');
}

export function buildCurrentRatesByAssetId(args: {
  storedWallets: StoredWallet[];
  quoteCurrency: string;
  rates?: Rates;
}): Record<string, number> {
  const quoteCurrency = resolveActivePortfolioDisplayQuoteCurrency({
    quoteCurrency: args.quoteCurrency,
  });
  const currentRatesByAssetId: Record<string, number> = {};

  for (const wallet of args.storedWallets || []) {
    const assetId = getAssetIdFromWallet(wallet.summary);
    if (assetId in currentRatesByAssetId) {
      continue;
    }

    const currentRate = getAssetCurrentDisplayQuoteRate({
      rates: args.rates,
      currencyAbbreviation: wallet.summary.currencyAbbreviation,
      chain: wallet.summary.chain,
      tokenAddress: wallet.summary.tokenAddress,
      quoteCurrency,
    });

    if (
      typeof currentRate === 'number' &&
      Number.isFinite(currentRate) &&
      currentRate > 0
    ) {
      currentRatesByAssetId[assetId] = currentRate;
    }
  }

  return currentRatesByAssetId;
}

export function getCurrentRatesByAssetIdSignature(
  currentRatesByAssetId: Record<string, number> | undefined,
): string {
  if (!currentRatesByAssetId) {
    return '';
  }

  return Object.keys(currentRatesByAssetId)
    .sort()
    .map(assetId => `${assetId}:${String(currentRatesByAssetId[assetId])}`)
    .join('|');
}

export function resolveCurrentRatesAsOfMs(args: {
  ratesUpdatedAt?: number;
  rates?: Rates;
}): number | undefined {
  if (
    typeof args.ratesUpdatedAt === 'number' &&
    Number.isFinite(args.ratesUpdatedAt) &&
    args.ratesUpdatedAt > 0
  ) {
    return args.ratesUpdatedAt;
  }

  let latestTimestamp: number | undefined;
  for (const rateEntries of Object.values(args.rates || {})) {
    if (!Array.isArray(rateEntries)) {
      continue;
    }

    for (const rateEntry of rateEntries) {
      const candidateTimestamps = [rateEntry?.fetchedOn, rateEntry?.ts];
      for (const candidateTimestamp of candidateTimestamps) {
        if (
          typeof candidateTimestamp === 'number' &&
          Number.isFinite(candidateTimestamp) &&
          candidateTimestamp > 0 &&
          (latestTimestamp == null || candidateTimestamp > latestTimestamp)
        ) {
          latestTimestamp = candidateTimestamp;
        }
      }
    }
  }

  return latestTimestamp;
}

export async function runPortfolioAnalysisQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
  asOfMs?: number;
  debugSource?: string;
}): Promise<PnlAnalysisResult> {
  if (args.debugSource) {
    console.log('[portfolio-analysis-bridge] js analysis request', {
      source: args.debugSource,
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  const result = await getPortfolioRuntimeClient().computeAnalysis({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    currentRatesByAssetId: args.currentRatesByAssetId,
    nowMs: args.asOfMs,
  });
  if (result && args.debugSource) {
    console.log('[portfolio-analysis-bridge] js analysis result', {
      source: args.debugSource,
      walletCount: Array.isArray(result.wallets) ? result.wallets.length : 0,
      pointCount: Array.isArray(result.points) ? result.points.length : 0,
      assetSummaryCount: Array.isArray(result.assetSummaries)
        ? result.assetSummaries.length
        : 0,
    });
  }
  if (!result) {
    console.log('[portfolio-analysis-bridge] js analysis result undefined', {
      source: args.debugSource || 'unknown',
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  if (
    result &&
    (!Array.isArray(result.wallets) || result.wallets.length === 0) &&
    (!Array.isArray(result.points) || result.points.length === 0) &&
    (!Array.isArray(result.assetSummaries) ||
      result.assetSummaries.length === 0)
  ) {
    console.log('[portfolio-analysis-bridge] js analysis result empty', {
      source: args.debugSource || 'unknown',
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  return result;
}

export async function preparePortfolioAnalysisSessionQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
  asOfMs?: number;
  debugSource?: string;
}): Promise<{sessionId: string}> {
  const shouldLogDiagnostics = shouldLogPortfolioAssetDiagnostics(
    args.debugSource,
  );
  const startedAt = Date.now();
  if (args.debugSource) {
    console.log('[portfolio-analysis-bridge] js analysis session prepare', {
      source: args.debugSource,
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  const session = await getPortfolioRuntimeClient().prepareAnalysisSession({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    currentRatesByAssetId: args.currentRatesByAssetId,
    nowMs: args.asOfMs,
  });
  if (shouldLogDiagnostics) {
    console.log('[portfolio-analysis-bridge] js analysis session prepared', {
      source: args.debugSource || 'unknown',
      sessionTag: toAnalysisSessionTag(session.sessionId),
      elapsedMs: Date.now() - startedAt,
      walletCount: args.wallets.length,
      timeframe: args.timeframe,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
    });
  }
  return session;
}

export async function runPortfolioAnalysisSessionScopeQuery(args: {
  sessionId: string;
  walletIds?: string[];
  debugSource?: string;
}): Promise<PnlAnalysisResult> {
  const shouldLogDiagnostics = shouldLogPortfolioAssetDiagnostics(
    args.debugSource,
  );
  const startedAt = Date.now();
  if (args.debugSource) {
    console.log(
      '[portfolio-analysis-bridge] js analysis session scope request',
      {
        source: args.debugSource,
        sessionTag: toAnalysisSessionTag(args.sessionId),
        scopedWalletCount: Array.isArray(args.walletIds)
          ? args.walletIds.length
          : 0,
      },
    );
  }
  const result = await getPortfolioRuntimeClient().computeAnalysisSessionScope({
    sessionId: args.sessionId,
    walletIds: args.walletIds,
  });
  if (shouldLogDiagnostics) {
    console.log(
      '[portfolio-analysis-bridge] js analysis session scope result',
      {
        source: args.debugSource || 'unknown',
        sessionTag: toAnalysisSessionTag(args.sessionId),
        elapsedMs: Date.now() - startedAt,
        scopedWalletCount: Array.isArray(args.walletIds)
          ? args.walletIds.length
          : 0,
        ...summarizeAnalysisResultShape(result),
      },
    );
  }
  if (
    result &&
    (!Array.isArray(result.wallets) || result.wallets.length === 0) &&
    (!Array.isArray(result.points) || result.points.length === 0) &&
    (!Array.isArray(result.assetSummaries) ||
      result.assetSummaries.length === 0)
  ) {
    console.log(
      '[portfolio-analysis-bridge] js analysis session scope result empty',
      {
        source: args.debugSource || 'unknown',
        sessionTag: toAnalysisSessionTag(args.sessionId),
        elapsedMs: Date.now() - startedAt,
        scopedWalletCount: Array.isArray(args.walletIds)
          ? args.walletIds.length
          : 0,
      },
    );
  }
  return result;
}

export async function disposePortfolioAnalysisSessionQuery(args: {
  sessionId: string;
}): Promise<void> {
  return getPortfolioRuntimeClient().disposeAnalysisSession({
    sessionId: args.sessionId,
  });
}

export async function runPortfolioChartQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
  asOfMs?: number;
  debugSource?: string;
}): Promise<PnlAnalysisChartResult> {
  if (args.debugSource) {
    console.log('[portfolio-analysis-bridge] js chart request', {
      source: args.debugSource,
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  const result = await getPortfolioRuntimeClient().computeAnalysisChart({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    currentRatesByAssetId: args.currentRatesByAssetId,
    nowMs: args.asOfMs,
  });
  if (result && args.debugSource) {
    console.log('[portfolio-analysis-bridge] js chart result', {
      source: args.debugSource,
      timestampCount: Array.isArray(result.timestamps)
        ? result.timestamps.length
        : 0,
      totalFiatBalanceCount: Array.isArray(result.totalFiatBalance)
        ? result.totalFiatBalance.length
        : 0,
      lastSpotRateCount: result?.lastSpotRatesByRateKey
        ? Object.keys(result.lastSpotRatesByRateKey).length
        : 0,
      latestHoldingsCount: result?.latestHoldingsByRateKey
        ? Object.keys(result.latestHoldingsByRateKey).length
        : 0,
    });
  }
  if (!result) {
    console.log('[portfolio-analysis-bridge] js chart result undefined', {
      source: args.debugSource || 'unknown',
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  if (
    result &&
    (!Array.isArray(result.timestamps) || result.timestamps.length === 0) &&
    (!Array.isArray(result.totalFiatBalance) ||
      result.totalFiatBalance.length === 0)
  ) {
    console.log('[portfolio-analysis-bridge] js chart result empty', {
      source: args.debugSource || 'unknown',
      walletCount: args.wallets.length,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints:
        typeof args.maxPoints === 'number' ? args.maxPoints : null,
      currentRateAssetCount: args.currentRatesByAssetId
        ? Object.keys(args.currentRatesByAssetId).length
        : 0,
      asOfMs: args.asOfMs ?? null,
    });
  }
  return result;
}

export function getLastFiniteNumber(
  values: Array<number | null | undefined> | undefined,
): number | undefined {
  if (!Array.isArray(values) || !values.length) {
    return undefined;
  }

  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function normalizeDisplayPercentage(
  value: number | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(2));
}
