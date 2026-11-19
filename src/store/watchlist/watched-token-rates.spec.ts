import {watchedTokenAddresses} from './watched-token-rates';
import type {WatchlistCoin} from './watchlist.models';

it('adds unheld watched token addresses without changing the held inputs', () => {
  const held = ['0xA', '0xb'];
  const items = [
    {selector: {chain: 'eth', tokenAddress: '0xA'}},
    {selector: {chain: 'eth', tokenAddress: '0xC'}},
    {selector: {chain: 'sol', tokenAddress: 'AbC'}},
  ] as WatchlistCoin[];
  expect(watchedTokenAddresses('eth', held, items)).toEqual(['0xc']);
  expect(held).toEqual(['0xA', '0xb']);
  expect(watchedTokenAddresses('sol', ['abc'], items)).toEqual(['AbC']);
});

it('requests only each row’s chosen contract and ignores legacy asset lists while preserving held batches', () => {
  const held = ['0xA', '0xb'];
  const items = [
    {
      id: 'coin:one',
      selector: {chain: 'eth', tokenAddress: '0xC'},
      assets: [
        {chain: 'eth', tokenAddress: '0xC'},
        {chain: 'eth', tokenAddress: '0xD'},
      ],
    },
    {
      id: 'coin:two',
      selector: {chain: 'sol', tokenAddress: 'AbC'},
      assets: [
        {chain: 'sol', tokenAddress: 'AbC'},
        {chain: 'eth', tokenAddress: '0xE'},
      ],
    },
    {
      id: 'coin:held',
      selector: {chain: 'eth', tokenAddress: '0xa'},
      assets: [{chain: 'eth', tokenAddress: '0xa'}],
    },
  ] as unknown as WatchlistCoin[];
  expect(watchedTokenAddresses('eth', held, items)).toEqual(['0xc']);
  expect(watchedTokenAddresses('sol', ['abc'], items)).toEqual(['AbC']);
  expect(held).toEqual(['0xA', '0xb']);
});
