import {watchedTokenAddresses} from './watched-token-rates';
import type {WatchlistCoin} from './watchlist.models';

it('adds unheld watched token addresses without changing the held inputs', () => {
  const held = ['0xA', '0xb'];
  const items = [
    {
      assets: [
        {chain: 'eth', tokenAddress: '0xA'},
        {chain: 'eth', tokenAddress: '0xC'},
        {chain: 'sol', tokenAddress: 'AbC'},
      ],
    },
  ] as WatchlistCoin[];
  expect(watchedTokenAddresses('eth', held, items)).toEqual(['0xc']);
  expect(held).toEqual(['0xA', '0xb']);
  expect(watchedTokenAddresses('sol', ['abc'], items)).toEqual(['AbC']);
});
