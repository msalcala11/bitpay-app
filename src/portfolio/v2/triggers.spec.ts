const mockScheduleRecompute = jest.fn();
const mockBuildBaseRecomputeInputsAtFireTime = jest.fn();
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
  buildBaseRecomputeInputsAtFireTime: () =>
    mockBuildBaseRecomputeInputsAtFireTime(),
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
  mockBuildBaseRecomputeInputsAtFireTime.mockReset();
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

  it('coalesces changed asset ids across live-rate debounce calls', () => {
    const ethInput = normalizedInput();
    const btcInput = {
      ...normalizedInput(),
      computedAtMs: 120,
    };

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: ethInput,
    });
    onLiveRatesUpdated({
      changedAssetIds: ['btc'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: btcInput,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(mockScheduleRecompute).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['btc', 'eth']},
      startEpoch: 7,
      normalizedFormulaInput: btcInput,
    });
  });

  it('promotes debounced live-rate touches to all current values when any call omits changed ids', () => {
    const input = normalizedInput();

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    onLiveRatesUpdated({
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(mockScheduleRecompute).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: {kind: 'liveRateTouch'},
      startEpoch: 7,
      normalizedFormulaInput: input,
    });
  });

  it('keeps all-current-value scope when a later debounced call provides changed ids', () => {
    const input = normalizedInput();

    onLiveRatesUpdated({
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    onLiveRatesUpdated({
      changedAssetIds: ['btc'],
      quoteCurrency: 'USD',
      normalizedFormulaInput: input,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(mockScheduleRecompute).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: {kind: 'liveRateTouch'},
      startEpoch: 7,
      normalizedFormulaInput: input,
    });
  });

  it('builds live-rate recompute input at debounce fire time', () => {
    const fireTimeInput = {
      ...normalizedInput(),
      computedAtMs: 200,
    };
    const buildNormalizedFormulaInput = jest.fn(() => fireTimeInput);

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      buildNormalizedFormulaInput,
    });

    expect(buildNormalizedFormulaInput).not.toHaveBeenCalled();
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(buildNormalizedFormulaInput).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: fireTimeInput,
    });
  });

  it('does not schedule when live-rate input building fails at debounce fire time', () => {
    const buildUndefinedInput = jest.fn(() => undefined);

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      buildNormalizedFormulaInput: buildUndefinedInput,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(buildUndefinedInput).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    const buildThrowingInput = jest.fn(() => {
      throw new Error('failed to build input');
    });

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      buildNormalizedFormulaInput: buildThrowingInput,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(buildThrowingInput).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });

  it('does not schedule when quote changes before debounce fire time', () => {
    const input = normalizedInput('USD');
    const buildNormalizedFormulaInput = jest.fn(() => input);

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      buildNormalizedFormulaInput,
    });

    mockQuoteCurrency = 'EUR';
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(buildNormalizedFormulaInput).not.toHaveBeenCalled();
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });

  it('does not schedule when fire-time live-rate input has a mismatched quote', () => {
    const input = normalizedInput('EUR');
    const buildNormalizedFormulaInput = jest.fn(() => input);

    onLiveRatesUpdated({
      changedAssetIds: ['eth'],
      quoteCurrency: 'USD',
      buildNormalizedFormulaInput,
    });
    jest.advanceTimersByTime(PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS);

    expect(buildNormalizedFormulaInput).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
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

  it('schedules historical-rate notifications as full recomputes with production fire-time inputs', () => {
    const fireTimeInput = {...normalizedInput(), computedAtMs: 150};
    mockBuildBaseRecomputeInputsAtFireTime.mockReturnValueOnce(fireTimeInput);

    onHistoricalRatesPersisted({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      source: 'externalEffect',
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: fireTimeInput,
    });

    mockScheduleRecompute.mockClear();
    mockBuildBaseRecomputeInputsAtFireTime.mockClear();
    onHistoricalRatesPersisted({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      source: 'externalEffect',
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).not.toHaveBeenCalled();
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });

  it('does not schedule historical-rate notifications when fire-time input building fails', () => {
    mockBuildBaseRecomputeInputsAtFireTime.mockReturnValueOnce(undefined);

    onHistoricalRatesPersisted({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['1D'],
      source: 'exchangeRateScreen',
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).not.toHaveBeenCalled();

    mockScheduleRecompute.mockClear();
    mockBuildBaseRecomputeInputsAtFireTime.mockClear();
    mockShowPortfolioEnabled = false;

    onHistoricalRatesPersisted({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['1D'],
      source: 'exchangeRateScreen',
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).not.toHaveBeenCalled();
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });
});
