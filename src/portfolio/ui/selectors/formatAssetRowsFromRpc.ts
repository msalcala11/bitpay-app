import {formatCurrencyAbbreviation, formatFiatAmount} from '../../../utils/helper-methods';
import type {AssetRowItem} from '../../../utils/portfolio/assets';
import type {
  PortfolioAssetRowPnlItem,
  PortfolioAssetRowsResult,
} from '../../core/pnl/assetRows';
import {buildAssetRowSearchText} from './assetRowSearchText';

const UNAVAILABLE_DELTA_FIAT = '—     ';
const UNAVAILABLE_DELTA_PERCENT = '  —  %';

function formatDeltaFiat(delta: number, quoteCurrency: string): string {
  const safeDelta = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
  const abs = Math.abs(safeDelta);
  const prefix = safeDelta >= 0 ? '+' : '-';
  return `${prefix}${formatFiatAmount(abs, quoteCurrency, {
    customPrecision: 'minimal',
  })}`;
}

function formatDeltaPercent(ratio: number | null | undefined): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return UNAVAILABLE_DELTA_PERCENT;
  }

  const pct = ratio * 100;
  const abs = Math.abs(pct);
  const prefix = pct >= 0 ? '+' : '-';
  return `${prefix}${abs.toFixed(1)}%`;
}

function formatAssetRowFromRpc(
  row: PortfolioAssetRowPnlItem,
  quoteCurrency: string,
): AssetRowItem {
  const showPnlPlaceholder = !!row.showPnlPlaceholder;
  const deltaRatio = row.displayPercentRatio;
  const hasPnl = !!row.hasPnl && !showPnlPlaceholder;
  const item: AssetRowItem = {
    key: row.key,
    currencyAbbreviation: row.currencyAbbreviation,
    chain: row.chain || '',
    tokenAddress: row.tokenAddress,
    name: formatCurrencyAbbreviation(row.currencyAbbreviation),
    cryptoAmount: row.cryptoAmount,
    fiatAmount: formatFiatAmount(row.fiatValue, quoteCurrency, {
      customPrecision: 'minimal',
    }),
    deltaFiat: showPnlPlaceholder
      ? UNAVAILABLE_DELTA_FIAT
      : formatDeltaFiat(row.deltaFiatValue, quoteCurrency),
    deltaPercent: showPnlPlaceholder
      ? UNAVAILABLE_DELTA_PERCENT
      : formatDeltaPercent(deltaRatio),
    isPositive: !!row.isPositive,
    hasRate: !!row.hasRate,
    hasPnl,
    showPnlPlaceholder,
  };

  item.searchText = buildAssetRowSearchText(item);
  return item;
}

export function formatAssetRowsFromRpc(args: {
  result?: PortfolioAssetRowsResult;
  quoteCurrency?: string;
}): AssetRowItem[] {
  const rows = args.result?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return [];
  }

  const quoteCurrency = String(
    args.quoteCurrency || args.result?.quoteCurrency || 'USD',
  ).toUpperCase();

  return rows.map(row => formatAssetRowFromRpc(row, quoteCurrency));
}

export default formatAssetRowsFromRpc;
