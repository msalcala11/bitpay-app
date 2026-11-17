import type {WatchlistCoin} from './watchlist.models';

// Keep held-token batches untouched. Additional watchlist requests are appended
// separately so the existing wallet pricing path and result keys stay intact.
export const watchedTokenAddresses = (
  chain: string,
  held: string[],
  items: WatchlistCoin[],
) => {
  const normalize = (value: string) =>
    chain === 'sol' ? value : value.toLowerCase();
  const known = new Set(held.map(normalize));
  const addresses: string[] = [];
  for (const item of items) {
    for (const asset of item.assets) {
      if (asset.chain !== chain || !asset.tokenAddress) {
        continue;
      }
      const address = normalize(asset.tokenAddress);
      if (!known.has(address)) {
        known.add(address);
        addresses.push(address);
      }
    }
  }
  return addresses;
};
