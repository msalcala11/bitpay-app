import {
  balanceHistoryChartOrchestrationReducer,
  createInitialBalanceHistoryChartOrchestrationState,
  getTimeframeComputeDisposition,
  selectComputedSeriesForAttempt,
  selectTimeframeErrorForAttempt,
  type TimeframeChartState,
} from './balanceHistoryChartOrchestration';

type TestSeries = {
  id: string;
};

type TestChangeRowData = {
  percent: number;
};

const createState = () =>
  createInitialBalanceHistoryChartOrchestrationState<
    TestSeries,
    TestChangeRowData
  >();

describe('balanceHistoryChartOrchestration', () => {
  it('stores successful compute results for a timeframe', () => {
    const series = {id: 'series-1'};

    let state = createState();
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'startCompute',
      timeframe: '1W',
      attemptRevision: 'attempt-1',
      generation: 0,
    });
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'resolveCompute',
      timeframe: '1W',
      attemptRevision: 'attempt-1',
      series,
      seriesRevision: 'revision-1',
      generation: 0,
    });

    expect(state.byTimeframe['1W']).toEqual({
      isComputing: false,
      lastAttemptRevision: 'attempt-1',
      lastError: undefined,
      series,
      seriesRevision: 'revision-1',
    });
    expect(
      selectComputedSeriesForAttempt({
        timeframeState: state.byTimeframe['1W'],
        timeframeRevision: 'revision-1',
        attemptRevision: 'attempt-1',
      }),
    ).toBe(series);
  });

  it('stores compute errors and scopes them to the failed attempt revision', () => {
    let state = createState();
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'startCompute',
      timeframe: 'ALL',
      attemptRevision: 'attempt-1',
      generation: 0,
    });
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'rejectCompute',
      timeframe: 'ALL',
      attemptRevision: 'attempt-1',
      error: 'boom',
      generation: 0,
    });

    expect(state.byTimeframe.ALL).toEqual({
      isComputing: false,
      lastAttemptRevision: 'attempt-1',
      lastError: 'boom',
    });
    expect(
      selectTimeframeErrorForAttempt({
        timeframeState: state.byTimeframe.ALL,
        attemptRevision: 'attempt-1',
      }),
    ).toBe('boom');
    expect(
      selectTimeframeErrorForAttempt({
        timeframeState: state.byTimeframe.ALL,
        attemptRevision: 'attempt-2',
      }),
    ).toBeUndefined();
  });

  it('suppresses retries after errors but lets selected computes recover interrupted attempts', () => {
    const interruptedAttemptState: TimeframeChartState<
      TestSeries,
      TestChangeRowData
    > = {
      lastAttemptRevision: 'attempt-1',
    };

    expect(
      getTimeframeComputeDisposition({
        cachedStatus: 'missing',
        timeframeRevision: 'revision-1',
        attemptRevision: 'attempt-1',
        timeframeState: interruptedAttemptState,
        hasAnySnapshots: true,
        inputsReady: true,
        retryPolicy: 'retry_interrupted_attempts',
      }),
    ).toEqual({shouldQueue: true});
    expect(
      getTimeframeComputeDisposition({
        cachedStatus: 'missing',
        timeframeRevision: 'revision-1',
        attemptRevision: 'attempt-1',
        timeframeState: interruptedAttemptState,
        hasAnySnapshots: true,
        inputsReady: true,
        retryPolicy: 'suppress_after_attempt',
      }),
    ).toEqual({
      shouldQueue: false,
      reason: 'retry_suppressed_after_attempt',
    });

    const failedAttemptState: TimeframeChartState<
      TestSeries,
      TestChangeRowData
    > = {
      lastAttemptRevision: 'attempt-1',
      lastError: 'boom',
    };

    expect(
      getTimeframeComputeDisposition({
        cachedStatus: 'missing',
        timeframeRevision: 'revision-1',
        attemptRevision: 'attempt-1',
        timeframeState: failedAttemptState,
        hasAnySnapshots: true,
        inputsReady: true,
        retryPolicy: 'retry_interrupted_attempts',
      }),
    ).toEqual({
      shouldQueue: false,
      reason: 'retry_suppressed_after_error',
    });
  });

  it('ignores stale generation completions after invalidation', () => {
    const staleSeries = {id: 'stale-series'};

    let state = createState();
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'startCompute',
      timeframe: '1D',
      attemptRevision: 'attempt-1',
      generation: 0,
    });
    state = balanceHistoryChartOrchestrationReducer(state, {
      type: 'advanceGeneration',
      generation: 1,
    });

    expect(state.generation).toBe(1);
    expect(state.byTimeframe['1D']).toEqual({
      isComputing: false,
      lastAttemptRevision: 'attempt-1',
      lastError: undefined,
    });

    const afterStaleSuccess = balanceHistoryChartOrchestrationReducer(state, {
      type: 'resolveCompute',
      timeframe: '1D',
      attemptRevision: 'attempt-1',
      series: staleSeries,
      seriesRevision: 'revision-1',
      generation: 0,
    });
    const afterStaleError = balanceHistoryChartOrchestrationReducer(state, {
      type: 'rejectCompute',
      timeframe: '1D',
      attemptRevision: 'attempt-1',
      error: 'stale error',
      generation: 0,
    });

    expect(afterStaleSuccess).toBe(state);
    expect(afterStaleError).toBe(state);
    expect(state.byTimeframe['1D']?.series).toBeUndefined();
    expect(state.byTimeframe['1D']?.lastError).toBeUndefined();
  });
});
