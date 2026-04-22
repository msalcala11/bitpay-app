import {runPortfolioChartQuery} from './common';

const mockComputeAnalysisChart = jest.fn();
const mockComputeAnalysis = jest.fn();

jest.mock('../../constants/config', () => ({
  BASE_BWS_URL: 'https://bws.invalid',
  BWC_TIMEOUT: 60_000,
}));

jest.mock('../../store/wallet/utils/currency', () => ({
  GetPrecision: jest.fn(() => ({
    unitDecimals: 8,
  })),
}));

jest.mock('../../utils/portfolio/displayCurrency', () => ({
  buildCommittedPortfolioHoldingsRevisionToken: jest.fn(
    ({lastPopulatedAt}: {lastPopulatedAt?: number}) =>
      typeof lastPopulatedAt === 'number' ? String(lastPopulatedAt) : '0',
  ),
  getAssetCurrentDisplayQuoteRate: jest.fn(() => 0),
  resolveActivePortfolioDisplayQuoteCurrency: jest.fn(
    ({quoteCurrency}: {quoteCurrency?: string}) => quoteCurrency || 'USD',
  ),
}));

jest.mock('../adapters/rn/walletMappers', () => ({
  isPortfolioRuntimeEligibleWallet: jest.fn(() => true),
  toPortfolioStoredWallet: jest.fn(),
}));

jest.mock('../runtime/portfolioRuntime', () => ({
  getPortfolioRuntimeClient: jest.fn(() => ({
    computeAnalysisChart: mockComputeAnalysisChart,
    computeAnalysis: mockComputeAnalysis,
  })),
}));

describe('runPortfolioChartQuery', () => {
  beforeEach(() => {
    mockComputeAnalysisChart.mockReset();
    mockComputeAnalysis.mockReset();
  });

  it('calls computeAnalysisChart directly and does not call computeAnalysis', async () => {
    const chartResult = {
      timeframe: '1D',
      quoteCurrency: 'USD',
      driverAssetId: 'btc:btc',
      driverCoin: 'btc',
      analysisWindow: undefined,
      assetIds: ['btc:btc'],
      coins: ['btc'],
      singleAsset: true,
      timestamps: [1],
      totalFiatBalance: [100],
      totalRemainingCostBasisFiat: [100],
      totalUnrealizedPnlFiat: [0],
      totalPnlChange: [0],
      totalPnlPercent: [0],
      driverMarkRate: [100],
      driverRatePercentChange: [0],
      lastSpotRatesByRateKey: {'btc:btc': 100},
      latestHoldingsByRateKey: {'btc:btc': {units: 1}},
      latestRemainingCostBasisFiatTotal: 100,
    } as const;

    mockComputeAnalysisChart.mockResolvedValue(chartResult);

    const wallets = [
      {
        walletId: 'wallet-1',
        addedAt: 0,
        summary: {
          walletId: 'wallet-1',
          walletName: 'Wallet 1',
          chain: 'btc',
          network: 'livenet',
          currencyAbbreviation: 'btc',
          balanceAtomic: '0',
          balanceFormatted: '0',
        },
        credentials: {
          walletId: 'wallet-1',
          chain: 'btc',
          network: 'livenet',
          coin: 'btc',
        },
      },
    ] as any;

    await expect(
      runPortfolioChartQuery({
        wallets,
        quoteCurrency: 'USD',
        timeframe: '1D',
        maxPoints: 5,
        currentRatesByAssetId: {'btc:btc': 100},
        asOfMs: 1234,
      }),
    ).resolves.toBe(chartResult);

    expect(mockComputeAnalysisChart).toHaveBeenCalledWith(
      expect.objectContaining({
        wallets,
        quoteCurrency: 'USD',
        timeframe: '1D',
        maxPoints: 5,
        currentRatesByAssetId: {'btc:btc': 100},
        nowMs: 1234,
      }),
    );
    expect(mockComputeAnalysis).not.toHaveBeenCalled();
  });
});
