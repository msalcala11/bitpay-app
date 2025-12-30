export type AssetRowItem = {
  key: string;
  currencyAbbreviation: string;
  chain: string;
  name: string;
  cryptoAmount: string;
  fiatAmount: string;
  deltaFiat: string;
  deltaPercent: string;
  isPositive: boolean;
};

export const getAssetsSectionMockItems = (): AssetRowItem[] => {
  return [
    {
      key: 'btc',
      currencyAbbreviation: 'btc',
      chain: 'btc',
      name: 'BTC',
      cryptoAmount: '0.56748',
      fiatAmount: '$52,458.18',
      deltaFiat: '-$1,267.15',
      deltaPercent: '-12.1%',
      isPositive: false,
    },
    {
      key: 'eth',
      currencyAbbreviation: 'eth',
      chain: 'eth',
      name: 'ETH',
      cryptoAmount: '0.56748',
      fiatAmount: '$52,458.18',
      deltaFiat: '+$1,267.14',
      deltaPercent: '+12.1%',
      isPositive: true,
    },
    {
      key: 'xrp',
      currencyAbbreviation: 'xrp',
      chain: 'xrp',
      name: 'XRP',
      cryptoAmount: '0.56748',
      fiatAmount: '$52,458.18',
      deltaFiat: '-$1,267.15',
      deltaPercent: '-12.1%',
      isPositive: false,
    },
    {
      key: 'usdc',
      currencyAbbreviation: 'usdc',
      chain: 'eth',
      name: 'USDC',
      cryptoAmount: '0.56748',
      fiatAmount: '$52,458.18',
      deltaFiat: '+$1,267.14',
      deltaPercent: '+12.1%',
      isPositive: true,
    },
  ];
};

export const getAllAssetsMockItems = (): AssetRowItem[] => {
  const base = getAssetsSectionMockItems();
  const bch = {
    ...base[3],
    key: 'bch',
    currencyAbbreviation: 'bch',
    chain: 'bch',
    name: 'BCH',
  };
  return [
    {
      ...base[0],
      name: 'BTC',
      key: 'btc_all',
    },
    base[1],
    base[2],
    bch,
    {
      ...base[3],
      key: 'usdc_2',
    },
    {
      ...base[3],
      key: 'usdc_3',
    },
    {
      ...base[3],
      key: 'usdc_4',
    },
    {
      ...base[3],
      key: 'usdc_5',
    },
    {
      ...base[3],
      key: 'usdc_6',
    },
    {
      ...base[3],
      key: 'usdc_7',
    },
  ];
};
