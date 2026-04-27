import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {NormalizedFormulaRecomputeInput} from '../../v2/recompute';
import {useRuntimeFiatRateSeriesCache} from './useRuntimeFiatRateSeriesCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadRuntimeFiatRateSeriesCache = jest.fn();
const mockScheduleRecompute = jest.fn();
const mockBuildBaseRecomputeInputsAtFireTime = jest.fn();
let mockFeatureEnabled = true;
let mockReduxInitialized = true;
let mockShowPortfolioEnabled = true;
let mockQuoteCurrency = 'USD';
let mockCurrentEpoch = 7;

jest.mock('../fiatRateSeries', () => {
  return {
    buildRuntimeFiatRateCacheRequestKey: jest.fn(
      ({
        quoteCurrency,
        requests,
        maxAgeMs,
      }: {
        quoteCurrency: string;
        requests: Array<{
          coin: string;
          chain?: string;
          tokenAddress?: string;
          intervals: string[];
        }>;
        maxAgeMs?: number;
      }) =>
        [
          String(quoteCurrency || '')
            .trim()
            .toUpperCase(),
          typeof maxAgeMs === 'number' ? String(maxAgeMs) : '',
          (requests || [])
            .map(
              request =>
                `${request.coin}|${request.chain || ''}|${
                  request.tokenAddress || ''
                }|${(request.intervals || []).join(',')}`,
            )
            .sort()
            .join('||'),
        ].join('|'),
    ),
    normalizeRuntimeFiatRateCacheRequests: jest.fn(
      (
        requests: Array<{
          coin: string;
          chain?: string;
          tokenAddress?: string;
          intervals: string[];
        }>,
      ) =>
        [...(requests || [])]
          .map(request => ({
            ...request,
            coin: String(request.coin || '')
              .trim()
              .toLowerCase(),
            intervals: [...new Set(request.intervals || [])].sort(),
          }))
          .sort((a, b) => a.coin.localeCompare(b.coin)),
    ),
    loadRuntimeFiatRateSeriesCache: jest.fn((...args) =>
      mockLoadRuntimeFiatRateSeriesCache(...args),
    ),
  };
});

jest.mock('../../v2/scheduler', () => ({
  scheduleRecompute: (request: unknown) => mockScheduleRecompute(request),
}));

jest.mock('../../v2/featureFlag', () => ({
  isPortfolioV2EnabledOnJS: () => mockFeatureEnabled,
}));

jest.mock('../../v2/reduxAccess', () => ({
  buildBaseRecomputeInputsAtFireTime: () =>
    mockBuildBaseRecomputeInputsAtFireTime(),
  getQuoteCurrencyFromStore: () => mockQuoteCurrency,
  getShowPortfolioEnabledFromStore: () => mockShowPortfolioEnabled,
  isPortfolioReduxAccessInitialized: () => mockReduxInitialized,
}));

jest.mock('../../v2/sharedState', () => ({
  getCurrentPortfolioWorkEpoch: () => mockCurrentEpoch,
}));

const HookHarness = ({
  historicalRatesPersistedSource,
  notifyHistoricalRatesPersisted,
  refreshToken,
  requests,
}: {
  historicalRatesPersistedSource?:
    | 'exchangeRateScreen'
    | 'manualRefresh'
    | 'externalEffect';
  notifyHistoricalRatesPersisted?: boolean;
  refreshToken?: string | number;
  requests?: Array<{
    coin: string;
    chain?: string;
    tokenAddress?: string;
    intervals: Array<'1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL'>;
  }>;
}) => {
  useRuntimeFiatRateSeriesCache({
    quoteCurrency: 'USD',
    requests: requests || [
      {
        coin: 'btc',
        intervals: ['1D'],
      },
    ],
    refreshToken,
    notifyHistoricalRatesPersisted,
    historicalRatesPersistedSource,
  });

  return null;
};

function normalizedInput(computedAtMs = 100): NormalizedFormulaRecomputeInput {
  return {
    computedAtMs,
    formula: {
      quoteCurrency: 'USD',
      wallets: [],
      assetGroups: [],
    },
  };
}

describe('useRuntimeFiatRateSeriesCache', () => {
  beforeEach(() => {
    mockLoadRuntimeFiatRateSeriesCache.mockReset();
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValue({});
    mockScheduleRecompute.mockReset();
    mockBuildBaseRecomputeInputsAtFireTime.mockReset();
    mockFeatureEnabled = true;
    mockReduxInitialized = true;
    mockShowPortfolioEnabled = true;
    mockQuoteCurrency = 'USD';
    mockCurrentEpoch = 7;
  });

  it('does not reload for semantically identical request arrays across rerenders', async () => {
    let view: TestRenderer.ReactTestRenderer;

    await act(async () => {
      view = TestRenderer.create(<HookHarness />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      view!.update(<HookHarness />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);
  });

  it('still reloads when an explicit refresh token changes', async () => {
    let view: TestRenderer.ReactTestRenderer;

    await act(async () => {
      view = TestRenderer.create(<HookHarness refreshToken="a" />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      view!.update(<HookHarness refreshToken="b" />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(2);
  });

  it('does not notify portfolio v2 by default for read-only cache consumers', async () => {
    const input = normalizedInput(140);
    mockBuildBaseRecomputeInputsAtFireTime.mockReturnValueOnce(input);

    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValueOnce({
      'USD:btc:1D': {
        fetchedOn: 1,
        points: [],
      },
    });

    await act(async () => {
      TestRenderer.create(
        <HookHarness
          historicalRatesPersistedSource="exchangeRateScreen"
          requests={[
            {
              coin: 'BTC',
              intervals: ['1D'],
            },
          ]}
        />,
      );
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).not.toHaveBeenCalled();
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });

  it('schedules portfolio v2 from the opted-in Exchange Rate cache-load usage without an injected builder', async () => {
    const input = normalizedInput(150);
    mockBuildBaseRecomputeInputsAtFireTime.mockReturnValueOnce(input);

    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValueOnce({
      'USD:btc:1D': {
        fetchedOn: 1,
        points: [],
      },
    });

    await act(async () => {
      TestRenderer.create(
        <HookHarness
          historicalRatesPersistedSource="exchangeRateScreen"
          notifyHistoricalRatesPersisted
          requests={[
            {
              coin: 'BTC',
              intervals: ['1D', '3M', 'ALL'],
            },
            {
              coin: 'USDC',
              chain: 'ETH',
              tokenAddress: '0xAbC123',
              intervals: ['1Y'],
            },
          ]}
        />,
      );
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).toHaveBeenCalledTimes(1);
    expect(mockScheduleRecompute).toHaveBeenCalledWith({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: input,
    });
  });

  it('does not notify portfolio v2 for empty cache loads', async () => {
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValueOnce({});

    await act(async () => {
      TestRenderer.create(<HookHarness notifyHistoricalRatesPersisted />);
    });

    expect(mockBuildBaseRecomputeInputsAtFireTime).not.toHaveBeenCalled();
    expect(mockScheduleRecompute).not.toHaveBeenCalled();
  });
});
