import {buildAssetRowSearchText, getAssetRowSearchText} from './assetRowSearchText';

describe('assetRowSearchText', () => {
  it('builds formatted search text that includes asset symbol and chain metadata', () => {
    const searchText = buildAssetRowSearchText({
      currencyAbbreviation: 'usdc',
      chain: 'eth',
      tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      name: 'USDC',
    } as any);

    expect(searchText).toContain('usdc');
    expect(searchText).toContain('eth');
    expect(searchText).toContain('ethereum');
  });

  it('prefers precomputed item search text when present', () => {
    expect(
      getAssetRowSearchText({
        key: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        name: 'Bitcoin',
        cryptoAmount: '1 BTC',
        fiatAmount: '$100',
        deltaFiat: '+$1',
        deltaPercent: '+1.0%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
        searchText: 'custom-search-text',
      } as any),
    ).toBe('custom-search-text');
  });
});
