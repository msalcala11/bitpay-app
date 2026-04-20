import type {Wallet} from '../../store/wallet/wallet.models';
import {
  sortAssetRowItemsByAssetFiatPriority,
  sortWalletsByAssetFiatPriority,
} from './assets';

describe('sortWalletsByAssetFiatPriority', () => {
  const makeWallet = (args: {
    id: string;
    coin: string;
    fiat: number;
  }): Wallet =>
    ({
      id: args.id,
      currencyAbbreviation: args.coin,
      chain: args.coin,
      network: 'livenet',
      balance: {
        fiat: args.fiat,
      },
    } as Wallet);

  it('prioritizes wallets by aggregated asset fiat balance', () => {
    const wallets = [
      makeWallet({id: 'btc-1', coin: 'btc', fiat: 100}),
      makeWallet({id: 'doge-1', coin: 'doge', fiat: 250}),
      makeWallet({id: 'btc-2', coin: 'btc', fiat: 300}),
      makeWallet({id: 'eth-1', coin: 'eth', fiat: 200}),
    ];

    expect(sortWalletsByAssetFiatPriority(wallets).map(wallet => wallet.id)).toEqual(
      ['btc-2', 'btc-1', 'doge-1', 'eth-1'],
    );
  });

  it('preserves input order when asset and wallet fiat balances tie', () => {
    const wallets = [
      makeWallet({id: 'doge-1', coin: 'doge', fiat: 100}),
      makeWallet({id: 'doge-2', coin: 'doge', fiat: 100}),
      makeWallet({id: 'btc-1', coin: 'btc', fiat: 50}),
      makeWallet({id: 'btc-2', coin: 'btc', fiat: 50}),
    ];

    expect(sortWalletsByAssetFiatPriority(wallets).map(wallet => wallet.id)).toEqual(
      ['doge-1', 'doge-2', 'btc-1', 'btc-2'],
    );
  });
});

describe('sortAssetRowItemsByAssetFiatPriority', () => {
  const wallets = [
    {
      id: 'doge-wallet',
      currencyAbbreviation: 'doge',
      chain: 'doge',
      network: 'livenet',
      balance: {fiat: 500},
    } as Wallet,
    {
      id: 'btc-wallet',
      currencyAbbreviation: 'btc',
      chain: 'btc',
      network: 'livenet',
      balance: {fiat: 100},
    } as Wallet,
  ];

  it('sorts asset rows by aggregated wallet fiat priority', () => {
    expect(
      sortAssetRowItemsByAssetFiatPriority({
        wallets,
        items: [
          {
            key: 'btc',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            name: 'BTC',
            cryptoAmount: '1',
            fiatAmount: '$100',
            deltaFiat: '+$1',
            deltaPercent: '+1%',
            isPositive: true,
            hasRate: true,
            hasPnl: true,
          },
          {
            key: 'doge',
            currencyAbbreviation: 'doge',
            chain: 'doge',
            name: 'DOGE',
            cryptoAmount: '2',
            fiatAmount: '$500',
            deltaFiat: '+$5',
            deltaPercent: '+2%',
            isPositive: true,
            hasRate: true,
            hasPnl: true,
          },
        ],
      }).map(item => item.key),
    ).toEqual(['doge', 'btc']);
  });
});
