import type {FiatRateAssetRef, StoredRateInterval} from '../model';

export function getRateKey(args: {
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}): string {
  const base = `rate:v1:${args.quoteCurrency}:${args.asset.coin}:${args.storedInterval}`;
  if (args.asset.chain || args.asset.tokenAddress) {
    return `${base}:${args.asset.chain ?? ''}:${args.asset.tokenAddress ?? ''}`;
  }
  return base;
}
