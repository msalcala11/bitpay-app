export type ReactPerfSnapshotPrimitive =
  | boolean
  | null
  | number
  | string
  | undefined;

export type ReactPerfSnapshot = Record<string, ReactPerfSnapshotPrimitive>;

export type ReactPerfSnapshotChangeSummary = {
  addedKeyCount: number;
  changedKeyCount: number;
  changedKeyValueSample: string[];
  changedKeysSample: string[];
  nextKeyCount: number;
  previousKeyCount: number;
  removedKeyCount: number;
};

const formatSnapshotValue = (value: ReactPerfSnapshotPrimitive): string => {
  if (value == null) {
    return String(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(1) : String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
};

export const summarizeReactPerfSnapshotChanges = (args: {
  previous?: ReactPerfSnapshot;
  next: ReactPerfSnapshot;
  maxSampleSize?: number;
}): ReactPerfSnapshotChangeSummary => {
  const previous = args.previous || {};
  const next = args.next || {};
  const maxSampleSize = Math.max(1, args.maxSampleSize || 8);
  const changedKeysSample: string[] = [];
  const changedKeyValueSample: string[] = [];
  const keys = Array.from(
    new Set([...Object.keys(previous), ...Object.keys(next)]),
  ).sort((a, b) => a.localeCompare(b));
  let addedKeyCount = 0;
  let changedKeyCount = 0;
  let removedKeyCount = 0;

  for (const key of keys) {
    const previousHasKey = Object.prototype.hasOwnProperty.call(previous, key);
    const nextHasKey = Object.prototype.hasOwnProperty.call(next, key);
    const previousValue = previous[key];
    const nextValue = next[key];

    if (!previousHasKey && nextHasKey) {
      addedKeyCount += 1;
    } else if (previousHasKey && !nextHasKey) {
      removedKeyCount += 1;
    } else if (previousValue === nextValue) {
      continue;
    }

    changedKeyCount += 1;

    if (changedKeysSample.length >= maxSampleSize) {
      continue;
    }

    changedKeysSample.push(key);
    changedKeyValueSample.push(
      `${key}:${formatSnapshotValue(previousValue)}->${formatSnapshotValue(
        nextValue,
      )}`,
    );
  }

  return {
    addedKeyCount,
    changedKeyCount,
    changedKeyValueSample,
    changedKeysSample,
    nextKeyCount: Object.keys(next).length,
    previousKeyCount: Object.keys(previous).length,
    removedKeyCount,
  };
};
