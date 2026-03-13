import {logManager} from '../../managers/LogManager';

type BalanceChartRepeatDebugArgs = {
  effectName: string;
  scopeId?: string;
  signature?: string;
  payload?: Record<string, unknown>;
  thresholdCount?: number;
  thresholdWindowMs?: number;
};

type RepeatWindow = {
  count: number;
  firstSeenAt: number;
  lastLoggedAt: number;
  signature: string;
};

const DEFAULT_THRESHOLD_COUNT = 6;
const DEFAULT_THRESHOLD_WINDOW_MS = 1200;
const repeatWindowsByKey = new Map<string, RepeatWindow>();

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const debugBalanceChartRepeatedEffect = (
  args: BalanceChartRepeatDebugArgs,
): void => {
  if (!(typeof __DEV__ !== 'undefined' && __DEV__)) {
    return;
  }

  const effectName = String(args.effectName || '');
  if (!effectName) {
    return;
  }

  const scopeId = String(args.scopeId || 'global');
  const signature = String(args.signature || '');
  const thresholdCount = Math.max(
    2,
    Math.floor(args.thresholdCount || DEFAULT_THRESHOLD_COUNT),
  );
  const thresholdWindowMs = Math.max(
    250,
    Math.floor(args.thresholdWindowMs || DEFAULT_THRESHOLD_WINDOW_MS),
  );
  const now = Date.now();
  const key = `${effectName}:${scopeId}`;
  const prev = repeatWindowsByKey.get(key);

  if (
    !prev ||
    prev.signature !== signature ||
    now - prev.firstSeenAt > thresholdWindowMs
  ) {
    logManager.debug(
      `[BalanceHistoryChart][LoopDebug] ${effectName} observed`,
      safeStringify({
        scopeId,
        signature,
        ...(args.payload || {}),
      }),
    );
    repeatWindowsByKey.set(key, {
      count: 1,
      firstSeenAt: now,
      lastLoggedAt: 0,
      signature,
    });
    return;
  }

  const next: RepeatWindow = {
    ...prev,
    count: prev.count + 1,
  };
  repeatWindowsByKey.set(key, next);

  if (next.count < thresholdCount) {
    return;
  }
  if (now - next.lastLoggedAt < thresholdWindowMs) {
    return;
  }

  next.lastLoggedAt = now;
  repeatWindowsByKey.set(key, next);

  logManager.warn(
    `[BalanceHistoryChart][LoopDebug] ${effectName} repeated ${next.count} times in ${now - next.firstSeenAt}ms`,
    safeStringify({
      scopeId,
      signature,
      ...(args.payload || {}),
    }),
  );
};

export default debugBalanceChartRepeatedEffect;
