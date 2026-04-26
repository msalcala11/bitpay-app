import {makeMutable, type SharedValue} from 'react-native-reanimated';

import {
  CANONICAL_RATE_QUOTE,
  PORTFOLIO_PUBLISH_WARN_BYTES,
  PORTFOLIO_WORK_EPOCH_KEY,
} from './constants';
import {writePortfolioMmkvString} from './kvStore';
import {logPortfolioRuntimeError} from './logPortfolioRuntimeError';
import {approximateJsonBytes, nowMs, recordPortfolioV2Metric} from './metrics';
import {
  EMPTY_PORTFOLIO_STATE,
  type PortfolioPublishedState,
  type PortfolioPublishReason,
  type PortfolioState,
  type PortfolioWorkEpochReason,
} from './model';
import {getPortfolioMmkvStorageOnRN} from '../adapters/rn/workletMmkvBridge';

function createSharedValue<T>(initialValue: T): SharedValue<T> {
  const candidate = makeMutable(initialValue) as SharedValue<T> | T;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'value' in (candidate as Record<string, unknown>)
  ) {
    return candidate as SharedValue<T>;
  }

  let value = initialValue;
  return {
    get value() {
      return value;
    },
    set value(next: T) {
      value = next;
    },
    get: () => value,
    set: (next: T | ((value: T) => T)) => {
      value =
        typeof next === 'function' ? (next as (value: T) => T)(value) : next;
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    modify: modifier => {
      if (modifier) {
        value = modifier(value);
      }
    },
  };
}

export const sharedPortfolioState = createSharedValue<PortfolioPublishedState>(
  EMPTY_PORTFOLIO_STATE,
);
export const populateCancelFlag = createSharedValue(false);
export const populateLoopRunning = createSharedValue(false);
export const populateProgressTick = createSharedValue(0);
export const populateRetryTick = createSharedValue(0);

const portfolioPublishedStateListeners = new Set<() => void>();

export function subscribeToPortfolioPublishedState(
  listener: () => void,
): () => void {
  portfolioPublishedStateListeners.add(listener);
  return () => {
    portfolioPublishedStateListeners.delete(listener);
  };
}

function notifyPortfolioPublishedStateListeners(): void {
  for (const listener of portfolioPublishedStateListeners) {
    try {
      listener();
    } catch (err) {
      logPortfolioRuntimeError(err, {tag: 'portfolioStateListener'});
    }
  }
}

export function projectPortfolioStateForUi(
  canonical: PortfolioState,
): PortfolioPublishedState {
  return canonical;
}

export function emptyPortfolioStateForEpoch(args: {
  workEpoch: number;
  quoteCurrency: string;
  computedAtMs: number;
}): PortfolioState {
  return {
    ...EMPTY_PORTFOLIO_STATE,
    workEpoch: args.workEpoch,
    quoteCurrency: args.quoteCurrency,
    computedAtMs: args.computedAtMs,
  };
}

export function getCurrentPortfolioWorkEpoch(): number {
  const raw = getPortfolioMmkvStorageOnRN().getString(PORTFOLIO_WORK_EPOCH_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function bumpPortfolioWorkEpoch(
  _reason: PortfolioWorkEpochReason,
): number {
  const next = getCurrentPortfolioWorkEpoch() + 1;
  writePortfolioMmkvString({
    key: PORTFOLIO_WORK_EPOCH_KEY,
    value: String(next),
    reason: 'workEpoch',
  });
  return next;
}

export function publishPortfolioState(args: {
  canonical: PortfolioState;
  reason: PortfolioPublishReason;
  startEpoch: number;
}): void {
  const startedAt = nowMs();
  const currentEpoch = getCurrentPortfolioWorkEpoch();
  if (args.startEpoch !== currentEpoch) {
    logPortfolioRuntimeError(new Error('stale portfolio publish discarded'), {
      tag: 'staleWorkEpoch',
      startEpoch: args.startEpoch,
      currentEpoch,
    });
    return;
  }

  const published = projectPortfolioStateForUi(args.canonical);
  const approximateBytes = approximateJsonBytes(published);
  sharedPortfolioState.value = published;
  notifyPortfolioPublishedStateListeners();
  recordPortfolioV2Metric({
    kind: 'publish',
    reason: args.reason,
    revision: published.revision,
    approximateBytes,
    durationMs: Math.max(0, nowMs() - startedAt),
    warning: approximateBytes > PORTFOLIO_PUBLISH_WARN_BYTES,
  });
}

export function resetSharedPortfolioStateForDebugClear(args: {
  publishEpoch: number;
  quoteCurrency?: string;
  computedAtMs?: number;
  reason?: Extract<PortfolioPublishReason, 'reset' | 'debugClear'>;
}): void {
  publishPortfolioState({
    canonical: emptyPortfolioStateForEpoch({
      workEpoch: args.publishEpoch,
      quoteCurrency: args.quoteCurrency ?? CANONICAL_RATE_QUOTE,
      computedAtMs: args.computedAtMs ?? Date.now(),
    }),
    reason: args.reason ?? 'debugClear',
    startEpoch: args.publishEpoch,
  });

  populateProgressTick.value = 0;
  populateRetryTick.value = 0;
}
