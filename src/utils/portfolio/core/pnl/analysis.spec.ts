import type {FiatRateInterval, FiatRateSeriesCache} from '../fiatRateSeries';
import {getFiatRateSeriesCacheKey} from '../fiatRateSeries';
import {buildPnlAnalysisSeries, type WalletForAnalysis} from './analysis';

const DAY_MS = 24 * 60 * 60 * 1000;

const BTC_CREDENTIALS = {
  coin: 'btc',
  chain: 'btc',
  network: 'livenet',
};

const makeWallet = (args: {
  snapshotTs: number;
  cryptoBalanceAtomic?: string;
  markRate: number;
  remainingCostBasisFiat: number;
}): WalletForAnalysis => ({
  walletId: 'wallet-1',
  walletName: 'Wallet 1',
  currencyAbbreviation: 'btc',
  credentials: BTC_CREDENTIALS,
  snapshots: [
    {
      id: `tx:${args.snapshotTs}`,
      walletId: 'wallet-1',
      chain: 'btc',
      coin: 'btc',
      network: 'livenet',
      assetId: 'btc:btc',
      timestamp: args.snapshotTs,
      eventType: 'tx',
      cryptoBalance: args.cryptoBalanceAtomic || '100000000',
      remainingCostBasisFiat: args.remainingCostBasisFiat,
      quoteCurrency: 'USD',
      markRate: args.markRate,
      createdAt: args.snapshotTs,
    },
  ],
});

const makeCache = (
  entries: Array<{
    interval: FiatRateInterval;
    points: Array<{ts: number; rate: number}>;
  }>,
): FiatRateSeriesCache => {
  const cache: FiatRateSeriesCache = {};

  for (const entry of entries) {
    cache[getFiatRateSeriesCacheKey('USD', 'btc', entry.interval)] = {
      fetchedOn: entry.points[entry.points.length - 1]?.ts || Date.now(),
      points: entry.points,
    };
  }

  return cache;
};

describe('buildPnlAnalysisSeries ALL timeframe', () => {
  it('uses the narrowest cached interval that still covers the full wallet age window', () => {
    const nowMs = 20 * DAY_MS;
    const snapshotTs = nowMs - 10 * DAY_MS;
    const dependencies: string[] = [];

    const result = buildPnlAnalysisSeries({
      wallets: [
        makeWallet({
          snapshotTs,
          markRate: 100,
          remainingCostBasisFiat: 100,
        }),
      ],
      timeframe: 'ALL',
      quoteCurrency: 'USD',
      fiatRateSeriesCache: makeCache([
        {
          interval: '1M',
          points: [
            {ts: snapshotTs, rate: 130},
            {ts: nowMs, rate: 140},
          ],
        },
        {
          interval: 'ALL',
          points: [
            {ts: snapshotTs, rate: 999},
            {ts: nowMs, rate: 1000},
          ],
        },
      ]),
      nowMs,
      maxPoints: 2,
      onHistoricalRateDependency: cacheKey => {
        dependencies.push(cacheKey);
      },
    });

    expect(dependencies).toEqual([
      getFiatRateSeriesCacheKey('USD', 'btc', '1M'),
    ]);
    expect(result.points[result.points.length - 1]?.totalFiatBalance).toBe(140);
  });

  it('anchors the opening ALL position to the stored snapshot basis and rate', () => {
    const nowMs = 20 * DAY_MS;
    const snapshotTs = nowMs - 10 * DAY_MS;

    const result = buildPnlAnalysisSeries({
      wallets: [
        makeWallet({
          snapshotTs,
          markRate: 100,
          remainingCostBasisFiat: 100,
        }),
      ],
      timeframe: 'ALL',
      quoteCurrency: 'USD',
      fiatRateSeriesCache: makeCache([
        {
          interval: '1M',
          points: [
            {ts: snapshotTs, rate: 150},
            {ts: nowMs, rate: 160},
          ],
        },
      ]),
      nowMs,
      maxPoints: 3,
    });

    expect(result.points[0]?.totalFiatBalance).toBe(100);
    expect(result.points[0]?.totalUnrealizedPnlFiat).toBe(0);
    expect(result.points[0]?.totalPnlPercent).toBe(0);
    expect(
      result.points[result.points.length - 1]?.totalUnrealizedPnlFiat,
    ).toBe(60);
  });

  it('clamps the first ALL point to zero pnl when stored basis was quantized', () => {
    const nowMs = 70 * DAY_MS;
    const snapshotTs = nowMs - 66 * DAY_MS;

    const result = buildPnlAnalysisSeries({
      wallets: [
        makeWallet({
          snapshotTs,
          cryptoBalanceAtomic: '169497',
          markRate: 592.740347,
          remainingCostBasisFiat: 1,
        }),
      ],
      timeframe: 'ALL',
      quoteCurrency: 'USD',
      fiatRateSeriesCache: makeCache([
        {
          interval: 'ALL',
          points: [
            {ts: snapshotTs, rate: 592.740347},
            {ts: nowMs, rate: 461.7},
          ],
        },
      ]),
      nowMs,
      maxPoints: 3,
    });

    expect(result.points[0]?.totalFiatBalance).toBe(1);
    expect(result.points[0]?.totalUnrealizedPnlFiat).toBe(0);
    expect(result.points[0]?.totalPnlPercent).toBe(0);
    expect(result.points[0]?.byWalletId['wallet-1']?.fiatBalance).toBe(1);
    expect(result.points[0]?.byWalletId['wallet-1']?.unrealizedPnlFiat).toBe(0);
    expect(result.points[0]?.byWalletId['wallet-1']?.pnlPercent).toBe(0);
    expect(result.totalSummary.pnlStart).toBe(0);
  });
});
