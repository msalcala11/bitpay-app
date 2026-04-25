import type {FiatRateAssetRef, StoredRateInterval} from '../model';

export type EnsureFreshArgs = Readonly<{
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  force?: boolean;
}>;

export function ensureFresh(_args: EnsureFreshArgs): Promise<void> {
  return Promise.resolve();
}
