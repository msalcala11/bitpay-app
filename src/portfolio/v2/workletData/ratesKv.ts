import type {FiatRateAssetRef, StoredRateInterval} from '../model';

export function normalizeRateAssetRef(asset: FiatRateAssetRef): FiatRateAssetRef {
  'worklet';

  const chain = String(asset.chain || '')
    .trim()
    .toLowerCase();
  const tokenAddress = String(asset.tokenAddress || '').trim();
  const normalizedTokenAddress =
    chain === 'sol' || chain === 'solana'
      ? tokenAddress
      : tokenAddress.toLowerCase();

  return {
    coin: String(asset.coin || '').trim().toLowerCase(),
    chain: normalizedTokenAddress ? chain || undefined : undefined,
    tokenAddress: normalizedTokenAddress || undefined,
  };
}

export function getRateSourceKey(asset: FiatRateAssetRef): string {
  'worklet';

  const normalized = normalizeRateAssetRef(asset);
  return normalized.tokenAddress
    ? `${normalized.coin}:${normalized.chain || ''}:${normalized.tokenAddress}`
    : normalized.coin;
}

export function getRateKey(args: {
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}): string {
  'worklet';

  const asset = normalizeRateAssetRef(args.asset);
  const base = `rate:v1:${String(args.quoteCurrency || 'USD').toUpperCase()}:${asset.coin}:${args.storedInterval}`;
  if (asset.chain || asset.tokenAddress) {
    return `${base}:${asset.chain ?? ''}:${asset.tokenAddress ?? ''}`;
  }
  return base;
}
