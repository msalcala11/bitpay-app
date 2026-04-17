import {formatCurrencyAbbreviation, formatFiatAmount} from '../../../utils/helper-methods';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {formatBigIntDecimal, getAtomicDecimals, makeAtomicToUnitNumberConverter, parseAtomicToBigint} from '../../core/format';
import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import type {PnlAnalysisResult} from '../../core/pnl/analysisStreaming';
import type {StoredWallet} from '../../core/types';

const UNAVAILABLE_DELTA_FIAT = '—     ';
const UNAVAILABLE_DELTA_PERCENT = '  —  %';

function formatDeltaFiat(delta: number, quoteCurrency: string): string {
  const abs = Math.abs(delta);
  const prefix = delta >= 0 ? '+' : '-';
  return `${prefix}${formatFiatAmount(abs, quoteCurrency, {
    customPrecision: 'minimal',
  })}`;
}

function formatDeltaPercent(ratio: number): string {
  const pct = ratio * 100;
  const abs = Math.abs(pct);
  const prefix = pct >= 0 ? '+' : '-';
  return `${prefix}${abs.toFixed(1)}%`;
}

export function buildAssetRowsFromAnalysis(args: {
  storedWallets: StoredWallet[];
  analysis?: PnlAnalysisResult;
  quoteCurrency: string;
  gainLossMode: GainLossMode;
  collapseAcrossChains?: boolean;
}): AssetRowItem[] {
  const quoteCurrency = (args.quoteCurrency || 'USD').toUpperCase();
  const collapseAcrossChains = args.collapseAcrossChains !== false;
  const isTodayGainLoss = args.gainLossMode === '1D';
  const analysis = args.analysis;
  const assetSummaryByAssetId = new Map(
    (analysis?.assetSummaries || []).map(summary => [summary.assetId, summary]),
  );
  const lastPoint = analysis?.points?.length
    ? analysis.points[analysis.points.length - 1]
    : undefined;

  const walletsByGroupKey = new Map<string, StoredWallet[]>();

  for (const wallet of args.storedWallets || []) {
    if ((wallet.summary.network || '').toLowerCase() !== 'livenet') {
      continue;
    }

    const coin = (wallet.summary.currencyAbbreviation || '').toLowerCase();
    if (!coin) {
      continue;
    }

    const assetId = getAssetIdFromWallet(wallet.summary);
    const groupKey = collapseAcrossChains ? coin : assetId;
    const list = walletsByGroupKey.get(groupKey) || [];
    list.push(wallet);
    walletsByGroupKey.set(groupKey, list);
  }

  const rows: Array<{
    key: string;
    coin: string;
    chain: string;
    tokenAddress?: string;
    cryptoAmount: string;
    fiatValue: number;
    pnlFiat: number;
    pnlRatio: number;
    hasRate: boolean;
    hasPnl: boolean;
  }> = [];

  for (const [key, groupWallets] of walletsByGroupKey.entries()) {
    if (!groupWallets.length) {
      continue;
    }

    const first = groupWallets[0];
    const coin = (first.summary.currencyAbbreviation || '').toLowerCase();
    const repWallet = collapseAcrossChains
      ?
          groupWallets.find(
            wallet =>
              (wallet.summary.chain || '').toLowerCase() === coin &&
              !wallet.summary.tokenAddress,
          ) || first
      : first;

    let totalAtomic = 0n;
    let fiatValue = 0;
    let pnlFiat = 0;
    let remainingBasisFiat = 0;
    let hasRate = false;
    let hasPnl = false;

    for (const wallet of groupWallets) {
      const assetId = getAssetIdFromWallet(wallet.summary);
      const assetSummary = assetSummaryByAssetId.get(assetId);
      const decimals = getAtomicDecimals(wallet.credentials);
      const atomic = parseAtomicToBigint(wallet.summary.balanceAtomic || '0');
      const toUnitNumber = makeAtomicToUnitNumberConverter(decimals);

      totalAtomic += atomic;

      if (assetSummary && assetSummary.rateEnd > 0) {
        fiatValue += toUnitNumber(atomic) * assetSummary.rateEnd;
        hasRate = true;
      }

      const walletPoint = lastPoint?.byWalletId?.[wallet.summary.walletId];
      if (walletPoint) {
        pnlFiat += Number(walletPoint.unrealizedPnlFiat || 0);
        remainingBasisFiat += Number(walletPoint.remainingCostBasisFiat || 0);
        hasPnl = true;
      }
    }

    if (totalAtomic <= 0n) {
      continue;
    }

    const repDecimals = getAtomicDecimals(repWallet.credentials);
    const pnlRatio = remainingBasisFiat > 0 ? pnlFiat / remainingBasisFiat : 0;
    const cryptoAmount = formatBigIntDecimal(
      totalAtomic,
      repDecimals,
      Math.min(repDecimals, 8),
    );
    const showPnlPlaceholder = !hasPnl && (!isTodayGainLoss || !hasRate);

    rows.push({
      key,
      coin,
      chain: repWallet.summary.chain,
      tokenAddress: repWallet.summary.tokenAddress,
      cryptoAmount,
      fiatValue,
      pnlFiat,
      pnlRatio: Number.isFinite(pnlRatio) ? pnlRatio : 0,
      hasRate,
      hasPnl,
    });
  }

  rows.sort((a, b) => (b.fiatValue || 0) - (a.fiatValue || 0));

  return rows.map(row => {
    const showPnlPlaceholder = !row.hasPnl && (!isTodayGainLoss || !row.hasRate);

    return {
      key: row.key,
      currencyAbbreviation: row.coin,
      chain: row.chain,
      tokenAddress: row.tokenAddress,
      name: formatCurrencyAbbreviation(row.coin),
      cryptoAmount: row.cryptoAmount,
      fiatAmount: formatFiatAmount(row.fiatValue, quoteCurrency, {
        customPrecision: 'minimal',
      }),
      deltaFiat: showPnlPlaceholder
        ? UNAVAILABLE_DELTA_FIAT
        : formatDeltaFiat(row.pnlFiat, quoteCurrency),
      deltaPercent: showPnlPlaceholder
        ? UNAVAILABLE_DELTA_PERCENT
        : formatDeltaPercent(row.pnlRatio),
      isPositive: row.pnlFiat >= 0,
      hasRate: row.hasRate,
      hasPnl: row.hasPnl,
      showPnlPlaceholder,
    } as AssetRowItem;
  });
}

export default buildAssetRowsFromAnalysis;
