export const SNAPSHOT_COMPRESSION_DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SNAPSHOT_COMPRESSION_AGE_DAYS = 90;

export function normalizeSnapshotCompressionAgeDays(
  value: unknown,
  fallback = DEFAULT_SNAPSHOT_COMPRESSION_AGE_DAYS,
): number {
  'worklet';

  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const candidate = Number(value);
  if (!Number.isFinite(candidate) || candidate < 0) {
    return fallback;
  }
  return Math.trunc(candidate);
}

export function getSnapshotCompressionAgeMs(
  compressionAgeDays: unknown,
  fallback?: number,
): number {
  'worklet';

  return (
    normalizeSnapshotCompressionAgeDays(compressionAgeDays, fallback) *
    SNAPSHOT_COMPRESSION_DAY_MS
  );
}
