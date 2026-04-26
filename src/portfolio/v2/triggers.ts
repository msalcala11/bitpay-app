import {PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS} from './constants';
import {isPortfolioV2EnabledOnJS} from './featureFlag';
import type {FiatRateAssetRef, StoredRateInterval} from './model';
import type {NormalizedFormulaRecomputeInput} from './recompute';
import {
  getQuoteCurrencyFromStore,
  getShowPortfolioEnabledFromStore,
  isPortfolioReduxAccessInitialized,
} from './reduxAccess';
import {getCurrentPortfolioWorkEpoch} from './sharedState';
import {scheduleRecompute} from './scheduler';

let passiveLiveRateTimer: ReturnType<typeof setTimeout> | undefined;

type PortfolioTriggerQuoteSource = Readonly<{
  quoteCurrency?: string;
  normalizedFormulaInput?: NormalizedFormulaRecomputeInput;
}>;

export type LiveRatesUpdatedTriggerArgs = Readonly<{
  changedAssetIds?: readonly string[];
  quoteCurrency?: string;
  normalizedFormulaInput?: NormalizedFormulaRecomputeInput;
}>;

export type HistoricalRatesPersistedTriggerArgs = Readonly<{
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  source: 'exchangeRateScreen' | 'manualRefresh' | 'externalEffect';
  normalizedFormulaInput: NormalizedFormulaRecomputeInput;
}>;

function normalizeQuoteCurrency(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export function canRunPortfolioV2Work(): boolean {
  try {
    return isPortfolioV2EnabledOnJS() && isPortfolioReduxAccessInitialized();
  } catch {
    return false;
  }
}

function passesTriggerGuards(args?: PortfolioTriggerQuoteSource): boolean {
  if (!canRunPortfolioV2Work()) {
    return false;
  }

  try {
    if (!getShowPortfolioEnabledFromStore()) {
      return false;
    }

    const currentQuote = normalizeQuoteCurrency(getQuoteCurrencyFromStore());
    const triggerQuote = normalizeQuoteCurrency(args?.quoteCurrency);
    const inputQuote = normalizeQuoteCurrency(
      args?.normalizedFormulaInput?.formula.quoteCurrency,
    );

    if (!currentQuote) {
      return false;
    }
    if (triggerQuote && triggerQuote !== currentQuote) {
      return false;
    }
    if (inputQuote && inputQuote !== currentQuote) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function onLiveRatesUpdated(args?: LiveRatesUpdatedTriggerArgs): void {
  if (!args?.normalizedFormulaInput || !passesTriggerGuards(args)) {
    return;
  }

  const normalizedFormulaInput = args.normalizedFormulaInput;
  const changedAssetIds = args.changedAssetIds;

  if (passiveLiveRateTimer) {
    clearTimeout(passiveLiveRateTimer);
  }

  passiveLiveRateTimer = setTimeout(() => {
    passiveLiveRateTimer = undefined;
    if (!passesTriggerGuards(args)) {
      return;
    }

    scheduleRecompute({
      scope: {
        kind: 'liveRateTouch',
        changedAssetIds,
      },
      startEpoch: getCurrentPortfolioWorkEpoch(),
      normalizedFormulaInput,
    });
  }, PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
}

export function onHistoricalRatesPersisted(
  args: HistoricalRatesPersistedTriggerArgs,
): void {
  if (!args?.normalizedFormulaInput || !passesTriggerGuards(args)) {
    return;
  }

  scheduleRecompute({
    scope: 'full',
    startEpoch: getCurrentPortfolioWorkEpoch(),
    normalizedFormulaInput: args.normalizedFormulaInput,
  });
}

export function clearTriggerTimersForTesting(): void {
  if (passiveLiveRateTimer) {
    clearTimeout(passiveLiveRateTimer);
    passiveLiveRateTimer = undefined;
  }
}
