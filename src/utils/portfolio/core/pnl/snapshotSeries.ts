import type {BalanceSnapshotStored} from './types';

// Legacy spec compatibility only. Production snapshot compression/storage is
// owned by portfolio runtime/MMKV stores, not Redux persist transforms.
export type BalanceSnapshotSeries = {
  version: 1;
  snapshots: BalanceSnapshotStored[];
};

export const packBalanceSnapshotsToSeries = (args: {
  snapshots: BalanceSnapshotStored[];
  compressionEnabled?: boolean;
}): BalanceSnapshotSeries | undefined => {
  if (!Array.isArray(args.snapshots) || args.snapshots.length === 0) {
    return undefined;
  }

  return {
    version: 1,
    snapshots: args.snapshots.slice(),
  };
};

export const isBalanceSnapshotSeries = (
  value: unknown,
): value is BalanceSnapshotSeries => {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as BalanceSnapshotSeries).snapshots)
  );
};

export const hydrateBalanceSnapshotsFromSeries = (
  series: BalanceSnapshotSeries,
): BalanceSnapshotStored[] => {
  return Array.isArray(series?.snapshots) ? series.snapshots.slice() : [];
};
