import {BASE_BWS_URL, BWC_TIMEOUT} from '../../constants/config';
import {GetPrecision} from '../../store/wallet/utils/currency';
import type {Wallet} from '../../store/wallet/wallet.models';
import type {AppDispatch} from '../../utils/hooks';
import {
  isPortfolioRuntimeEligibleWallet,
  toPortfolioStoredWallet,
} from '../adapters/rn/walletMappers';
import type {PnlAnalysisChartResult, PnlAnalysisResult, PnlTimeframe} from '../core/pnl/analysisStreaming';
import type {PortfolioAssetRowsResult} from '../core/pnl/assetRows';
import type {BwsConfig} from '../core/shared/bws';
import type {StoredWallet} from '../core/types';
import {getPortfolioRuntimeClient} from '../runtime/portfolioRuntime';

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
  const quoteCurrency = resolveCommittedPortfolioQuoteCurrency({
    portfolioQuoteCurrency: args.quoteCurrency,
  });

  return [
    quoteCurrency,
    typeof args.lastPopulatedAt === 'number'
      ? String(args.lastPopulatedAt)
      : 'uncommitted',
  ].join('|');
}

// Backwards-compatible alias retained during the migration of portfolio UI
// hooks to committed-only revision tokens.
export const resolvePortfolioQuoteCurrency = resolveCommittedPortfolioQuoteCurrency;

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
  const eligibleWallets = (Array.isArray(args.wallets) ? args.wallets : []).filter(
    isPortfolioRuntimeEligibleWallet,
  );

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

export async function runPortfolioAnalysisQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
}): Promise<PnlAnalysisResult> {
  return getPortfolioRuntimeClient().computeAnalysis({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
  });
}


export async function runPortfolioAssetRowsQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
}): Promise<PortfolioAssetRowsResult> {
  return getPortfolioRuntimeClient().computeAssetRows({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints ?? 2,
    collapseAcrossChains: true,
    currentRatesByAssetId: args.currentRatesByAssetId,
  });
}

export async function runPortfolioChartQuery(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  maxPoints?: number;
}): Promise<PnlAnalysisChartResult> {
  return getPortfolioRuntimeClient().computeAnalysisChart({
    cfg: createPortfolioQueryBwsConfig(),
    wallets: args.wallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
  });
}

export function getLastFiniteNumber(values: Array<number | null | undefined> | undefined): number | undefined {
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

export function normalizeDisplayPercentage(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(2));
}
