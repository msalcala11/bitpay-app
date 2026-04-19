import type {FiatRatePoint} from '../fiatRatesShared';
import {getFiatRateChangeFromPointsForTimeframe} from '../fiatRateTimeframeChange';
import type {ComputeAnalysisArgs} from '../engine/portfolioEngine';
import {
  formatBigIntDecimal,
  getAtomicDecimals,
  makeAtomicToUnitNumberConverter,
  parseAtomicToBigint,
} from '../format';
import type {
  PnlAnalysisResult,
  PnlTimeframe,
  WalletPoint,
} from './analysisStreaming';
import {getAssetIdFromWallet} from './assetId';
import type {StoredWallet} from '../types';

export type ComputeAssetRowsArgs = ComputeAnalysisArgs & {
  collapseAcrossChains?: boolean;

  /**
   * Optional current spot rates supplied by JS from Redux RATE.rates.
   * This is input data only. All calculations still happen on the worklet.
   */
  currentRatesByAssetId?: Record<string, number>;
};

export type PortfolioAssetRowPnlItem = {
  key: string;
  assetId: string;
  currencyAbbreviation: string;
  chain?: string;
  tokenAddress?: string;

  balanceAtomic: string;
  unitDecimals: number;
  cryptoAmount: string;

  fiatValue: number;
  deltaFiatValue: number;
  displayPercentRatio: number | null;
  pnlPercentRatio: number | null;
  pricePercentRatio: number | null;

  hasRate: boolean;
  hasPnl: boolean;
  hasActivityInWindow: boolean;
  showPnlPlaceholder: boolean;
  isPositive: boolean;
  sortValueFiat: number;
};

export type PortfolioAssetRowsResult = {
  timeframe: PnlTimeframe;
  quoteCurrency: string;
  startTs: number;
  endTs: number;
  generatedAt: number;
  rows: PortfolioAssetRowPnlItem[];
};

type WalletGroupAccumulator = {
  key: string;
  wallets: StoredWallet[];
};

type PriceChangeForWallet = {
  hasRate: boolean;
  currentRate: number;
  baselineRate: number;
  priceDeltaFiat: number;
  baselineFiat: number;
  percentRatio: number | null;
};

function isFiniteNumber(value: unknown): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOrZero(value: unknown): number {
  'worklet';

  return isFiniteNumber(value) ? value : 0;
}

function getPositiveFiniteNumber(value: unknown): number | undefined {
  'worklet';

  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function isMainnetWallet(wallet: StoredWallet): boolean {
  'worklet';

  return String(wallet?.summary?.network || '').toLowerCase() === 'livenet';
}

function getWalletCoin(wallet: StoredWallet): string {
  'worklet';

  return String(wallet?.summary?.currencyAbbreviation || '')
    .trim()
    .toLowerCase();
}

function getWalletGroupKey(wallet: StoredWallet, collapseAcrossChains: boolean): string {
  'worklet';

  const coin = getWalletCoin(wallet);
  if (!coin) return '';
  return collapseAcrossChains ? coin : getAssetIdFromWallet(wallet.summary);
}

function chooseRepresentativeWallet(args: {
  groupWallets: StoredWallet[];
  collapseAcrossChains: boolean;
}): StoredWallet {
  'worklet';

  const first = args.groupWallets[0];
  if (!args.collapseAcrossChains) return first;

  const coin = getWalletCoin(first);
  return (
    args.groupWallets.find(wallet => {
      'worklet';

      return (
        String(wallet?.summary?.chain || '').toLowerCase() === coin &&
        !wallet?.summary?.tokenAddress
      );
    }) || first
  );
}

function groupPortfolioAssetRows(args: {
  storedWallets: StoredWallet[];
  collapseAcrossChains: boolean;
}): WalletGroupAccumulator[] {
  'worklet';

  const groupsByKey = new Map<string, WalletGroupAccumulator>();

  for (const wallet of args.storedWallets || []) {
    if (!wallet || !isMainnetWallet(wallet)) {
      continue;
    }

    const key = getWalletGroupKey(wallet, args.collapseAcrossChains);
    if (!key) {
      continue;
    }

    const existing = groupsByKey.get(key);
    if (existing) {
      existing.wallets.push(wallet);
      continue;
    }

    groupsByKey.set(key, {key, wallets: [wallet]});
  }

  return Array.from(groupsByKey.values());
}

function getWalletPoint(args: {
  analysis?: PnlAnalysisResult;
  walletId: string;
}): WalletPoint | undefined {
  'worklet';

  const points = args.analysis?.points;
  if (!Array.isArray(points) || !points.length) {
    return undefined;
  }

  return points[points.length - 1]?.byWalletId?.[args.walletId];
}

function computePriceChangeForWallet(args: {
  assetId: string;
  units: number;
  walletPoint?: WalletPoint;
  timeframe: PnlTimeframe;
  nowMs: number;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  currentRatesByAssetId?: Record<string, number>;
}): PriceChangeForWallet {
  'worklet';

  const ratePoints = args.ratePointsByAssetId[args.assetId];
  const currentRateOverride = args.currentRatesByAssetId?.[args.assetId];
  const priceChange = getFiatRateChangeFromPointsForTimeframe({
    points: ratePoints,
    timeframe: args.timeframe,
    nowMs: args.nowMs,
    assetId: args.assetId,
    currentRatesByAssetId: args.currentRatesByAssetId,
    currentRate: currentRateOverride,
    method: 'linear',
  });

  const walletPointRate = getPositiveFiniteNumber(args.walletPoint?.markRate);
  const currentRate =
    getPositiveFiniteNumber(priceChange?.currentRate) ??
    getPositiveFiniteNumber(currentRateOverride) ??
    walletPointRate ??
    0;
  const baselineRate = getPositiveFiniteNumber(priceChange?.baselineRate) ?? 0;
  const hasRate = currentRate > 0 || walletPointRate !== undefined;

  const baselineFiat = baselineRate > 0 ? args.units * baselineRate : 0;
  const priceDeltaFiat =
    currentRate > 0 && baselineRate > 0
      ? args.units * (currentRate - baselineRate)
      : 0;

  const pricePercentRatio = priceChange?.percentRatio;

  return {
    hasRate,
    currentRate,
    baselineRate,
    priceDeltaFiat: Number.isFinite(priceDeltaFiat) ? priceDeltaFiat : 0,
    baselineFiat: Number.isFinite(baselineFiat) ? baselineFiat : 0,
    percentRatio: isFiniteNumber(pricePercentRatio)
      ? pricePercentRatio
      : null,
  };
}

function getResultTimeBounds(args: {
  analysis?: PnlAnalysisResult;
  fallbackNowMs: number;
}): {startTs: number; endTs: number} {
  'worklet';

  const points = args.analysis?.points;
  if (Array.isArray(points) && points.length) {
    const firstTs = Number(points[0]?.timestamp);
    const lastTs = Number(points[points.length - 1]?.timestamp);
    return {
      startTs: Number.isFinite(firstTs) ? firstTs : args.fallbackNowMs,
      endTs: Number.isFinite(lastTs) ? lastTs : args.fallbackNowMs,
    };
  }

  return {startTs: args.fallbackNowMs, endTs: args.fallbackNowMs};
}

/**
 * Worklet-safe asset-row aggregation for Home / All Assets.
 *
 * This function intentionally returns only compact row values. It must not leak
 * full PnL timelines or force the JS thread to aggregate wallet-level PnL.
 */
export function buildPortfolioAssetRowsResult(args: {
  storedWallets: StoredWallet[];
  analysis?: PnlAnalysisResult;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  nowMs?: number;
  generatedAt?: number;
  collapseAcrossChains?: boolean;
  currentRatesByAssetId?: Record<string, number>;
}): PortfolioAssetRowsResult {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const timeframe = args.timeframe;
  const collapseAcrossChains = args.collapseAcrossChains !== false;
  const generatedAt = isFiniteNumber(args.generatedAt) ? args.generatedAt : Date.now();
  const nowMs = isFiniteNumber(args.nowMs) ? args.nowMs : generatedAt;
  const {startTs, endTs} = getResultTimeBounds({
    analysis: args.analysis,
    fallbackNowMs: nowMs,
  });
  const groups = groupPortfolioAssetRows({
    storedWallets: args.storedWallets || [],
    collapseAcrossChains,
  });
  const rows: PortfolioAssetRowPnlItem[] = [];

  for (const group of groups) {
    if (!group.wallets.length) {
      continue;
    }

    const repWallet = chooseRepresentativeWallet({
      groupWallets: group.wallets,
      collapseAcrossChains,
    });
    const repDecimals = getAtomicDecimals(repWallet.credentials);
    const repAssetId = getAssetIdFromWallet(repWallet.summary);
    const coin = getWalletCoin(repWallet);

    let totalAtomic = 0n;
    let fiatValue = 0;
    let pnlFiat = 0;
    let remainingBasisFiat = 0;
    let priceDeltaFiat = 0;
    let priceBaselineFiat = 0;
    let fallbackPricePercentRatio: number | null = null;
    let hasRate = false;
    let hasWalletPoint = false;
    let hasActivityInWindow = false;

    for (const wallet of group.wallets) {
      const assetId = getAssetIdFromWallet(wallet.summary);
      const decimals = getAtomicDecimals(wallet.credentials);
      const toUnitNumber = makeAtomicToUnitNumberConverter(decimals);
      const atomic = parseAtomicToBigint(wallet.summary.balanceAtomic || '0');
      const units = toUnitNumber(atomic);
      const walletPoint = getWalletPoint({
        analysis: args.analysis,
        walletId: wallet.summary.walletId,
      });
      const price = computePriceChangeForWallet({
        assetId,
        units,
        walletPoint,
        timeframe,
        nowMs,
        ratePointsByAssetId: args.ratePointsByAssetId,
        currentRatesByAssetId: args.currentRatesByAssetId,
      });
      const walletPointFiatBalance = walletPoint?.fiatBalance;

      totalAtomic += atomic;
      hasRate = hasRate || price.hasRate;
      if (fallbackPricePercentRatio === null && price.percentRatio !== null) {
        fallbackPricePercentRatio = price.percentRatio;
      }

      if (price.currentRate > 0) {
        fiatValue += units * price.currentRate;
      } else if (isFiniteNumber(walletPointFiatBalance)) {
        fiatValue += walletPointFiatBalance;
      }

      priceDeltaFiat += price.priceDeltaFiat;
      priceBaselineFiat += price.baselineFiat;

      if (walletPoint) {
        hasWalletPoint = true;
        hasActivityInWindow =
          hasActivityInWindow || walletPoint.hasActivityInWindow === true;
        pnlFiat += finiteOrZero(walletPoint.unrealizedPnlFiat);
        remainingBasisFiat += finiteOrZero(walletPoint.remainingCostBasisFiat);
      }
    }

    if (totalAtomic <= 0n) {
      continue;
    }

    const cryptoAmount = formatBigIntDecimal(
      totalAtomic,
      repDecimals,
      Math.min(repDecimals, 8),
    );
    const weightedPricePercentRatio =
      priceBaselineFiat > 0
        ? priceDeltaFiat / priceBaselineFiat
        : fallbackPricePercentRatio;
    const pricePercentRatio = isFiniteNumber(weightedPricePercentRatio)
      ? weightedPricePercentRatio
      : null;
    const pnlPercentRatio = hasWalletPoint
      ? remainingBasisFiat > 0
        ? pnlFiat / remainingBasisFiat
        : 0
      : null;

    const usePriceOnlyDisplay =
      timeframe === '1D' &&
      hasWalletPoint &&
      !hasActivityInWindow &&
      pricePercentRatio !== null &&
      hasRate;
    const displayPercentRatio = usePriceOnlyDisplay
      ? pricePercentRatio
      : pnlPercentRatio;
    const deltaFiatValue = usePriceOnlyDisplay
      ? priceDeltaFiat
      : hasWalletPoint
      ? pnlFiat
      : 0;
    const hasPnl =
      hasWalletPoint ||
      (usePriceOnlyDisplay && isFiniteNumber(displayPercentRatio));
    const showPnlPlaceholder =
      !hasPnl ||
      !isFiniteNumber(deltaFiatValue) ||
      displayPercentRatio === null;
    const safeDeltaFiatValue = Number.isFinite(deltaFiatValue)
      ? deltaFiatValue
      : 0;
    const safeFiatValue = Number.isFinite(fiatValue) ? fiatValue : 0;

    rows.push({
      key: group.key,
      assetId: repAssetId,
      currencyAbbreviation: coin,
      chain: repWallet.summary.chain,
      tokenAddress: repWallet.summary.tokenAddress,
      balanceAtomic: totalAtomic.toString(),
      unitDecimals: repDecimals,
      cryptoAmount,
      fiatValue: safeFiatValue,
      deltaFiatValue: safeDeltaFiatValue,
      displayPercentRatio,
      pnlPercentRatio,
      pricePercentRatio,
      hasRate,
      hasPnl,
      hasActivityInWindow,
      showPnlPlaceholder,
      isPositive: safeDeltaFiatValue >= 0,
      sortValueFiat: safeFiatValue,
    });
  }

  rows.sort((a, b) => (b.sortValueFiat || 0) - (a.sortValueFiat || 0));

  return {
    timeframe,
    quoteCurrency,
    startTs,
    endTs,
    generatedAt,
    rows,
  };
}
