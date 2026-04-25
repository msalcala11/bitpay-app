import {PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS} from './constants';
import {getCurrentPortfolioWorkEpoch} from './sharedState';
import {scheduleRecompute} from './scheduler';

let passiveLiveRateTimer: ReturnType<typeof setTimeout> | undefined;

export function onLiveRatesUpdated(args?: {
  changedAssetIds?: readonly string[];
}): void {
  if (passiveLiveRateTimer) {
    clearTimeout(passiveLiveRateTimer);
  }

  passiveLiveRateTimer = setTimeout(() => {
    passiveLiveRateTimer = undefined;
    scheduleRecompute({
      scope: {
        kind: 'liveRateTouch',
        changedAssetIds: args?.changedAssetIds,
      },
      startEpoch: getCurrentPortfolioWorkEpoch(),
    });
  }, PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
}

export function onHistoricalRatesPersisted(): void {
  scheduleRecompute({
    scope: 'full',
    startEpoch: getCurrentPortfolioWorkEpoch(),
  });
}

export function clearTriggerTimersForTesting(): void {
  if (passiveLiveRateTimer) {
    clearTimeout(passiveLiveRateTimer);
    passiveLiveRateTimer = undefined;
  }
}
