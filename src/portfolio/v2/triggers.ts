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

type NormalizedFormulaInputBuilder = () =>
  | NormalizedFormulaRecomputeInput
  | undefined;

type PortfolioTriggerQuoteSource = Readonly<{
  quoteCurrency?: string;
  normalizedFormulaInput?: NormalizedFormulaRecomputeInput;
}>;

export type LiveRatesUpdatedTriggerArgs = Readonly<{
  changedAssetIds?: readonly string[];
  quoteCurrency?: string;
  normalizedFormulaInput?: NormalizedFormulaRecomputeInput;
  buildNormalizedFormulaInput?: NormalizedFormulaInputBuilder;
}>;

export type HistoricalRatesPersistedTriggerArgs = Readonly<{
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  source: 'exchangeRateScreen' | 'manualRefresh' | 'externalEffect';
  normalizedFormulaInput: NormalizedFormulaRecomputeInput;
}>;

type PendingLiveRateTrigger = Readonly<{
  changedAssetIds?: readonly string[];
  quoteCurrency?: string;
  buildNormalizedFormulaInput: NormalizedFormulaInputBuilder;
}>;

let pendingLiveRateTrigger: PendingLiveRateTrigger | undefined;

function normalizeQuoteCurrency(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeChangedAssetIds(
  changedAssetIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!changedAssetIds?.length) {
    return undefined;
  }

  return uniqueSorted(changedAssetIds);
}

function mergeChangedAssetIds(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!existing || !incoming) {
    return undefined;
  }

  return uniqueSorted([...existing, ...incoming]);
}

function getNormalizedFormulaInputBuilder(
  args: LiveRatesUpdatedTriggerArgs,
): NormalizedFormulaInputBuilder | undefined {
  if (args.buildNormalizedFormulaInput) {
    return args.buildNormalizedFormulaInput;
  }

  if (args.normalizedFormulaInput) {
    return () => args.normalizedFormulaInput;
  }

  return undefined;
}

function buildPendingLiveRateInput(
  pending: PendingLiveRateTrigger,
): NormalizedFormulaRecomputeInput | undefined {
  try {
    return pending.buildNormalizedFormulaInput();
  } catch {
    return undefined;
  }
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
  if (!args || !passesTriggerGuards(args)) {
    return;
  }

  const buildNormalizedFormulaInput = getNormalizedFormulaInputBuilder(args);
  if (!buildNormalizedFormulaInput) {
    return;
  }

  const changedAssetIds = normalizeChangedAssetIds(args.changedAssetIds);
  pendingLiveRateTrigger = {
    changedAssetIds: pendingLiveRateTrigger
      ? mergeChangedAssetIds(
          pendingLiveRateTrigger.changedAssetIds,
          changedAssetIds,
        )
      : changedAssetIds,
    quoteCurrency: args.quoteCurrency,
    buildNormalizedFormulaInput,
  };

  if (passiveLiveRateTimer) {
    clearTimeout(passiveLiveRateTimer);
  }

  passiveLiveRateTimer = setTimeout(() => {
    passiveLiveRateTimer = undefined;
    const pending = pendingLiveRateTrigger;
    pendingLiveRateTrigger = undefined;
    if (!pending || !passesTriggerGuards(pending)) {
      return;
    }

    const normalizedFormulaInput = buildPendingLiveRateInput(pending);
    if (
      !normalizedFormulaInput ||
      !passesTriggerGuards({
        quoteCurrency: pending.quoteCurrency,
        normalizedFormulaInput,
      })
    ) {
      return;
    }

    const scope = pending.changedAssetIds
      ? {
          kind: 'liveRateTouch' as const,
          changedAssetIds: pending.changedAssetIds,
        }
      : {kind: 'liveRateTouch' as const};

    scheduleRecompute({
      scope,
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
  pendingLiveRateTrigger = undefined;
}
