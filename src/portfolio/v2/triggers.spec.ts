const mockScheduleRecompute = jest.fn();
let mockFeatureEnabled = true;
let mockReduxInitialized = true;
let mockShowPortfolioEnabled = true;
let mockQuoteCurrency = 'USD';
let mockCurrentEpoch = 7;

jest.mock('./scheduler', () => ({
  scheduleRecompute: (request: unknown) => mockScheduleRecompute(request),
}));

jest.mock('./featureFlag', () => ({
  isPortfolioV2EnabledOnJS: () => mockFeatureEnabled,
}));

jest.mock('./reduxAccess', () => ({
  getQuoteCurrencyFromStore: () => mockQuoteCurrency,
  getShowPortfolioEnabledFromStore: () => mockShowPortfolioEnabled,
  isPortfolioReduxAccessInitialized: () => mockReduxInitialized,
}));

jest.mock('./sharedState', () => ({
  getCurrentPortfolioWorkEpoch: () => mockCurrentEpoch,
}));

import {PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS} from './constants';
import type {NormalizedFormulaRecomputeInput} from './recompute';
import {
  canRunPortfolioV2Work,
  clearTriggerTimersForTesting,
  onHistoricalRatesPersisted,
  onLiveRatesUpdated,
} from './triggers';

function normalizedInput(
  quoteCurrency = 'USD',
): NormalizedFormulaRecomputeInput {
  return {
    computedAtMs: 100,
    formula: {
      quoteCurrency,
      wallets: [],
      assetGroups: [],
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockScheduleRecompute.mockClear();
  mockFeatureEnabled = true;
  mockReduxInitialized = true;
  mockShowPortfolioEnabled = true;
  mockQuoteCurrency = 'USD';
  mockCurrentEpoch = 7;
  clearTriggerTimersForTesting();
});

afterEach(() => {
  clearTriggerTimersForTesting();
  jest.useRealTimers();
});

describe('portfolio v2 triggers', () => {
  it('debounces live-rate touches and re-checks guards at fire time', () => {
    const input = normalizedInput();

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS - 1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    mockShowPortfolioEnabled = false;
    jest.advanceTimersByTime(1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    mockShowPortfolioEnabled = true;
    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: input,
    });
  });

  it('does not schedule live-rate touches when feature, redux, quote, or input guards fail', () => {
    const input = normalizedInput();

    mockFeatureEnabled = false;
    expect(canRunPortfolioV2Work()).toBe(false);
    onLiveRatesUpdated({normalizedFormulaInput: input});
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    mockFeatureEnabled = true;
    mockReduxInitialized = false;
    onLiveRatesUpdated({normalizedFormulaInput: input});
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    mockReduxInitialized = true;
    onLiveRatesUpdated({
      quoteCurrency: 'EUR',
      normalizedFormulaInput: input,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    onLiveRatesUpdated();
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });

  it('schedules historical-rate notifications as full recomputes with inputs only', () => {
    const input = normalizedInput();

    onHistoricalRatesPersisted({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      source: 'exchangeRateScreen',
      normalizedFormulaInput: input,
    });

    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: input,
    });

    mockScheduleRecompute.mockClear();
    onHistoricalRatesPersisted({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      source: 'externalEffect',
    } as any);
    onHistoricalRatesPersisted({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      source: 'externalEffect',
      normalizedFormulaInput: input,
    });

    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });
});
