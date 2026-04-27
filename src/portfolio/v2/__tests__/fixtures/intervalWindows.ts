export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const DEFAULT_INTERVAL_WINDOW_START_TS = Date.parse(
  '2024-01-01T00:00:00Z',
);

export type TestIntervalWindow = Readonly<{
  startTs: number;
  middleTs: number;
  endTs: number;
  windowStartTs: number;
  windowEndTs: number;
  durationMs: number;
}>;

type BuildIntervalWindowArgs = {
  startTs?: number;
  endTs?: number;
  durationMs?: number;
};

const assertFiniteTimestamp = (
  name: string,
  value: number | undefined,
): void => {
  if (typeof value === 'undefined') {
    return;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
};

export function buildIntervalWindow(
  args: BuildIntervalWindowArgs = {},
): TestIntervalWindow {
  assertFiniteTimestamp('startTs', args.startTs);
  assertFiniteTimestamp('endTs', args.endTs);
  assertFiniteTimestamp('durationMs', args.durationMs);

  const hasStart = typeof args.startTs === 'number';
  const hasEnd = typeof args.endTs === 'number';
  const inferredDuration =
    hasStart && hasEnd ? args.endTs! - args.startTs! : ONE_DAY_MS;
  const durationMs = args.durationMs ?? inferredDuration;

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('durationMs must be positive');
  }

  const startTs = hasStart
    ? args.startTs!
    : hasEnd
    ? args.endTs! - durationMs
    : DEFAULT_INTERVAL_WINDOW_START_TS;
  const endTs = hasEnd ? args.endTs! : startTs + durationMs;

  if (endTs <= startTs) {
    throw new Error('endTs must be greater than startTs');
  }
  if (durationMs !== endTs - startTs) {
    throw new Error('durationMs must match the start/end window');
  }

  return Object.freeze({
    startTs,
    middleTs: startTs + durationMs / 2,
    endTs,
    windowStartTs: startTs,
    windowEndTs: endTs,
    durationMs,
  });
}
