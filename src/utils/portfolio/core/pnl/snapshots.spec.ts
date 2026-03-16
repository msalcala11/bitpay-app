import {getAssetIdFromWallet} from './snapshots';

describe('getAssetIdFromWallet', () => {
  it('lowercases EVM token addresses', () => {
    expect(
      getAssetIdFromWallet({
        chain: 'eth',
        currencyAbbreviation: 'USDC',
        tokenAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
      }),
    ).toBe('eth:usdc:0xabcdef1234567890abcdef1234567890abcdef12');
  });

  it('preserves SVM token address case', () => {
    expect(
      getAssetIdFromWallet({
        chain: 'sol',
        currencyAbbreviation: 'USDC',
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }),
    ).toBe('sol:usdc:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('omits the token segment when the wallet has no token address', () => {
    expect(
      getAssetIdFromWallet({
        chain: 'eth',
        currencyAbbreviation: 'ETH',
      }),
    ).toBe('eth:eth');
  });
});
