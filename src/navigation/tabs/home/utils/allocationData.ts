import type {WalletRowProps} from '../../../../components/list/WalletRow';
import type {
  AllocationLegendItem,
  AllocationSlice,
} from '../components/AllocationSection';
import type {AllocationRowItem} from '../screens/Allocation';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {Slate, SlateDark} from '../../../../styles/colors';

type AllocationAsset = {
  assetKey: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
  name: string;
  fiatValue: number;
};

const getAssetKey = (w: WalletRowProps): string => {
  const chain = (w.chain || '').toLowerCase();
  const coin = (w.currencyAbbreviation || '').toLowerCase();
  const tokenAddress = w.tokenAddress?.toLowerCase();
  return tokenAddress ? `${chain}:${coin}:${tokenAddress}` : `${chain}:${coin}`;
};

const getAssetColor = (
  currencyAbbreviation: string,
): {light: string; dark: string} => {
  const key = currencyAbbreviation.toLowerCase();
  const known: Record<string, {light: string; dark: string}> = {
    btc: {light: '#F7931A', dark: '#F7931A'},
    bch: {light: '#0AC18E', dark: '#0AC18E'},
    eth: {light: '#627EEA', dark: '#627EEA'},
    xrp: {light: '#000000', dark: '#000000'},
    sol: {light: '#7C3AED', dark: '#7C3AED'},
    usdc: {light: '#2775CA', dark: '#2775CA'},
    usdt: {light: '#26A17B', dark: '#26A17B'},
    doge: {light: '#C2A633', dark: '#C2A633'},
    ltc: {light: '#345D9D', dark: '#345D9D'},
    pol: {light: '#8247E5', dark: '#8247E5'},
    matic: {light: '#8247E5', dark: '#8247E5'},
  };
  return known[key] || {light: Slate, dark: SlateDark};
};

const toPercent = (value: number, total: number): number => {
  if (!total || total <= 0) {
    return 0;
  }
  return (value / total) * 100;
};

export const buildAllocationDataFromWalletRows = (
  wallets: WalletRowProps[],
  defaultAltCurrencyIsoCode: string,
  opts?: {
    topN?: number;
    includeOther?: boolean;
  },
): {
  totalFiat: number;
  legendItems: AllocationLegendItem[];
  slices: AllocationSlice[];
  rows: AllocationRowItem[];
} => {
  const byAssetKey = new Map<string, AllocationAsset>();

  (wallets || []).forEach(w => {
    const fiat = Number(w.fiatBalance) || 0;
    if (!(fiat > 0)) {
      return;
    }

    const assetKey = getAssetKey(w);
    const existing = byAssetKey.get(assetKey);
    if (existing) {
      existing.fiatValue += fiat;
      return;
    }

    byAssetKey.set(assetKey, {
      assetKey,
      currencyAbbreviation: (w.currencyAbbreviation || '').toLowerCase(),
      chain: (w.chain || '').toLowerCase(),
      tokenAddress: w.tokenAddress?.toLowerCase(),
      name: w.currencyName || w.currencyAbbreviation || '',
      fiatValue: fiat,
    });
  });

  const assets = Array.from(byAssetKey.values()).sort(
    (a, b) => b.fiatValue - a.fiatValue,
  );

  const totalFiat = assets.reduce((sum, a) => sum + (a.fiatValue || 0), 0);

  const rows: AllocationRowItem[] = assets.map(a => {
    const percent = toPercent(a.fiatValue, totalFiat);
    const color = getAssetColor(a.currencyAbbreviation);
    return {
      key: a.assetKey,
      currencyAbbreviation: a.currencyAbbreviation,
      chain: a.chain,
      tokenAddress: a.tokenAddress,
      name: a.name,
      fiatAmount: formatFiatAmount(a.fiatValue, defaultAltCurrencyIsoCode, {
        currencyDisplay: 'symbol',
      }),
      percent: `${percent.toFixed(1)}%`,
      progress: percent,
      barColor: color,
    };
  });

  const topN = opts?.topN ?? 5;
  const includeOther = opts?.includeOther ?? true;

  const topAssets = assets.slice(0, topN);
  const remainderAssets = assets.slice(topN);
  const otherFiat = remainderAssets.reduce((sum, a) => sum + (a.fiatValue || 0), 0);

  const legendItems: AllocationLegendItem[] = topAssets.map(a => {
    const percent = toPercent(a.fiatValue, totalFiat);
    return {
      key: a.assetKey,
      label: a.currencyAbbreviation.toUpperCase(),
      value: `${percent.toFixed(1)}%`,
      color: getAssetColor(a.currencyAbbreviation),
    };
  });

  const slices: AllocationSlice[] = topAssets.map(a => {
    const percent = toPercent(a.fiatValue, totalFiat);
    return {
      key: a.assetKey,
      value: percent,
      color: getAssetColor(a.currencyAbbreviation),
    };
  });

  if (includeOther && otherFiat > 0) {
    const percent = toPercent(otherFiat, totalFiat);
    legendItems.push({
      key: 'other',
      label: 'Other',
      value: `${percent.toFixed(1)}%`,
      color: {light: Slate, dark: SlateDark},
    });
    slices.push({
      key: 'other',
      value: percent,
      color: {light: Slate, dark: SlateDark},
    });
  }

  return {
    totalFiat,
    legendItems,
    slices,
    rows,
  };
};
