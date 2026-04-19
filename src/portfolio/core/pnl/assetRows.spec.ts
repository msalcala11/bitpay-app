import {getFiatRateSeriesCacheKey, type FiatRatePoint} from '../fiatRatesShared';
import type {PnlAnalysisResult, PnlTimeframe, WalletPoint} from './analysisStreaming';
import {buildPortfolioAssetRowsResult} from './assetRows';
import {getFiatRateChangeForTimeframe} from '../fiatRateTimeframeChange';

const nowMs = Date.parse('2024-01-02T15:30:00.000Z');
const oneDayBaselineMs = Date.parse('2024-01-01T15:00:00.000Z');

const wallet = {
  walletId: 'w1',
  addedAt: 0,
  credentials: {
    walletId: 'w1',
    chain: 'btc',
    network: 'livenet',
    coin: 'btc',
  },
  summary: {
    walletId: 'w1',
    walletName: 'BTC Wallet',
    chain: 'btc',
    network: 'livenet',
    currencyAbbreviation: 'btc',
    balanceAtomic: '100000000',
    balanceFormatted: '1',
  },
} as any;

function makeWalletPoint(args: {
  hasActivityInWindow: boolean;
  unrealizedPnlFiat: number;
  remainingCostBasisFiat: number;
  markRate: number;
}): WalletPoint {
  return {
    balanceAtomic: '100000000',
    formattedCryptoBalance: '1',
    fiatBalance: args.markRate,
    remainingCostBasisFiat: args.remainingCostBasisFiat,
    unrealizedPnlFiat: args.unrealizedPnlFiat,
    hasActivityInWindow: args.hasActivityInWindow,
    markRate: args.markRate,
    ratePercentChange: 0,
    pnlPercent:
      args.remainingCostBasisFiat > 0
        ? args.unrealizedPnlFiat / args.remainingCostBasisFiat
        : 0,
  };
}

function makeAnalysis(args: {
  timeframe: PnlTimeframe;
  startTs: number;
  endTs: number;
  walletPoint: WalletPoint;
}): PnlAnalysisResult {
  return {
    timeframe: args.timeframe,
    quoteCurrency: 'USD',
    driverAssetId: 'btc:btc',
    driverCoin: 'btc',
    assetIds: ['btc:btc'],
    coins: ['btc'],
    wallets: [],
    points: [
      {
        timestamp: args.startTs,
        totalFiatBalance: 0,
        totalRemainingCostBasisFiat: 0,
        totalUnrealizedPnlFiat: 0,
        totalPnlPercent: 0,
        byWalletId: {},
      },
      {
        timestamp: args.endTs,
        totalFiatBalance: args.walletPoint.fiatBalance,
        totalRemainingCostBasisFiat: args.walletPoint.remainingCostBasisFiat,
        totalUnrealizedPnlFiat: args.walletPoint.unrealizedPnlFiat,
        totalPnlPercent: args.walletPoint.pnlPercent,
        byWalletId: {
          w1: args.walletPoint,
        },
      },
    ],
    assetSummaries: [],
    totalSummary: {
      pnlStart: 0,
      pnlEnd: args.walletPoint.unrealizedPnlFiat,
      pnlChange: args.walletPoint.unrealizedPnlFiat,
      pnlPercent: args.walletPoint.pnlPercent,
    },
  };
}

function buildRows(args: {
  timeframe: PnlTimeframe;
  points: FiatRatePoint[];
  walletPoint: WalletPoint;
  currentRate: number;
}) {
  return buildPortfolioAssetRowsResult({
    storedWallets: [wallet],
    analysis: makeAnalysis({
      timeframe: args.timeframe,
      startTs: args.points[0].ts,
      endTs: nowMs,
      walletPoint: args.walletPoint,
    }),
    ratePointsByAssetId: {
      'btc:btc': args.points,
    },
    currentRatesByAssetId: {
      'btc:btc': args.currentRate,
    },
    quoteCurrency: 'USD',
    timeframe: args.timeframe,
    nowMs,
    collapseAcrossChains: true,
  });
}

describe('buildPortfolioAssetRowsResult', () => {
  it('uses the same shared 1D price percentage as the Exchange Rate page for rows with no in-window activity', () => {
    const currentRate = 125;
    const ratePoints: FiatRatePoint[] = [
      {ts: oneDayBaselineMs, rate: 100},
      {ts: nowMs, rate: 150},
    ];
    const exchangeCache = {
      [getFiatRateSeriesCacheKey('USD', 'btc', '1D')]: {
        fetchedOn: nowMs,
        points: ratePoints,
      },
    };
    const exchangeChange = getFiatRateChangeForTimeframe({
      fiatRateSeriesCache: exchangeCache,
      fiatCode: 'USD',
      currencyAbbreviation: 'btc',
      timeframe: '1D',
      currentRate,
      nowMs,
      method: 'linear',
    });

    const result = buildRows({
      timeframe: '1D',
      points: ratePoints,
      currentRate,
      walletPoint: makeWalletPoint({
        hasActivityInWindow: false,
        unrealizedPnlFiat: 5,
        remainingCostBasisFiat: 200,
        markRate: currentRate,
      }),
    });

    expect(exchangeChange?.percentRatio).toBeCloseTo(0.25);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      hasActivityInWindow: false,
      showPnlPlaceholder: false,
    });
    expect(result.rows[0].pnlPercentRatio).toBeCloseTo(0.025);
    expect(result.rows[0].pricePercentRatio).toBeCloseTo(
      exchangeChange!.percentRatio,
    );
    expect(result.rows[0].displayPercentRatio).toBeCloseTo(
      exchangeChange!.percentRatio,
    );
    expect(result.rows[0].deltaFiatValue).toBeCloseTo(25);
  });

  it('uses portfolio PnL instead of pure price change when a 1D row has in-window activity', () => {
    const currentRate = 150;
    const ratePoints: FiatRatePoint[] = [
      {ts: oneDayBaselineMs, rate: 100},
      {ts: nowMs, rate: currentRate},
    ];

    const result = buildRows({
      timeframe: '1D',
      points: ratePoints,
      currentRate,
      walletPoint: makeWalletPoint({
        hasActivityInWindow: true,
        unrealizedPnlFiat: 10,
        remainingCostBasisFiat: 200,
        markRate: currentRate,
      }),
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      hasActivityInWindow: true,
      deltaFiatValue: 10,
    });
    expect(result.rows[0].pricePercentRatio).toBeCloseTo(0.5);
    expect(result.rows[0].pnlPercentRatio).toBeCloseTo(0.05);
    expect(result.rows[0].displayPercentRatio).toBeCloseTo(0.05);
  });

  it('keeps ALL / total gain-loss rows on portfolio PnL even when there is no activity in the latest window', () => {
    const currentRate = 150;
    const ratePoints: FiatRatePoint[] = [
      {ts: Date.parse('2023-01-01T00:00:00.000Z'), rate: 50},
      {ts: nowMs, rate: currentRate},
    ];

    const result = buildRows({
      timeframe: 'ALL',
      points: ratePoints,
      currentRate,
      walletPoint: makeWalletPoint({
        hasActivityInWindow: false,
        unrealizedPnlFiat: 10,
        remainingCostBasisFiat: 200,
        markRate: currentRate,
      }),
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pricePercentRatio).toBeCloseTo(2);
    expect(result.rows[0].pnlPercentRatio).toBeCloseTo(0.05);
    expect(result.rows[0].displayPercentRatio).toBeCloseTo(0.05);
    expect(result.rows[0].deltaFiatValue).toBeCloseTo(10);
  });
});
