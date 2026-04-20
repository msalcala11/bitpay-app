import type {WalletCredentials} from '../types';
import type {SnapshotPointV2} from './snapshotStore';
import {
  buildPnlAnalysisChartSeriesFromStreamed,
  buildPnlAnalysisSeriesFromStreamed,
  buildPnlAnalysisSeriesFromPreloaded,
  compactPnlAnalysisResultForChart,
  resolvePnlAnalysisPreloadWindow,
  type SnapshotPointStream,
  type WalletForAnalysisMeta,
} from './analysisStreaming';
import {getAssetIdFromWallet} from './assetId';
import {normalizeFiatRateSeriesCoin} from './rates';

const mkWallet = (overrides?: Partial<WalletForAnalysisMeta>): WalletForAnalysisMeta => {
  const wallet = {
    walletId: 'w1',
    walletName: 'Wallet 1',
    currencyAbbreviation: 'eth',
    chain: 'eth',
    tokenAddress: undefined,
    credentials: {chain: 'eth', coin: 'eth', network: 'livenet'} as WalletCredentials,
    ...overrides,
  };

  return {
    ...wallet,
    assetId:
      overrides?.assetId ??
      getAssetIdFromWallet({
        chain: wallet.chain ?? '',
        currencyAbbreviation: wallet.currencyAbbreviation,
        tokenAddress: wallet.tokenAddress,
      }),
    rateCoin: overrides?.rateCoin ?? normalizeFiatRateSeriesCoin(wallet.currencyAbbreviation),
  };
};

const mkPoint = (timestamp: number, cryptoBalance: string): SnapshotPointV2 => ({
  timestamp,
  cryptoBalance,
});

function emitPoints(points: SnapshotPointV2[]): SnapshotPointStream {
  let index = 0;
  return {
    next: async () => {
      if (index >= points.length) {
        return {done: true, value: undefined};
      }
      const value = points[index++];
      return {done: false, value};
    },
  };
}

describe('analysisStreaming preload helpers', () => {
  it('computes pnl from preloaded bounded snapshot points and rate points', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');
    const t2 = Date.parse('2024-01-01T02:00:00Z');
    const t3 = Date.parse('2024-01-01T03:00:00Z');

    const res = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 91,
      startTs: t0,
      endTs: t3,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 1000},
          {ts: t1, rate: 1100},
          {ts: t2, rate: 1200},
          {ts: t3, rate: 1300},
        ],
      },
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: [],
        },
        {
          wallet: mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
          basePoint: null,
          points: [mkPoint(t2, '2000000000000000000')],
        },
      ],
    });

    expect(res.points).toHaveLength(91);
    expect(res.points[0]?.timestamp).toBe(t0);
    expect(res.points[0]?.totalFiatBalance).toBe(1000);
    expect(res.points[0]?.totalRemainingCostBasisFiat).toBe(1000);

    const last = res.points[res.points.length - 1];
    expect(last.timestamp).toBe(t3);
    expect(last.totalFiatBalance).toBe(3900);
    expect(last.totalRemainingCostBasisFiat).toBe(3400);
    expect(last.totalUnrealizedPnlFiat).toBe(500);
    expect(last.totalPnlPercent).toBeCloseTo((500 / 3400) * 100, 8);
  });

  it('resolves ALL-timeframe preload windows from the first non-zero timestamp', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');
    const t2 = Date.parse('2024-01-03T00:00:00Z');

    const resolved = resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: 'USD'},
      wallets: [mkWallet()],
      timeframe: 'ALL',
      nowMs: t2,
      firstNonZeroTs: t1,
      maxPoints: 5,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 900},
          {ts: t1, rate: 1000},
          {ts: t2, rate: 1100},
        ],
      },
    });

    expect(resolved.startTs).toBe(t1);
    expect(resolved.endTs).toBe(t2);
    expect(resolved.timeline).toHaveLength(5);
    expect(resolved.timeline[0]).toBe(t1);
  });

  it('accepts engine-prepared windows and sorted wallet points without re-normalizing', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');
    const t2 = Date.parse('2024-01-01T02:00:00Z');
    const t3 = Date.parse('2024-01-01T03:00:00Z');

    const resolved = resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: 'USD'},
      wallets: [mkWallet({walletId: 'w1'})],
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 1000},
          {ts: t1, rate: 1100},
          {ts: t2, rate: 1200},
          {ts: t3, rate: 1300},
        ],
      },
    });

    const res = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: resolved.startTs,
      endTs: resolved.endTs,
      resolvedWindow: resolved,
      walletPointsArePrepared: true,
      ratePointsByAssetId: resolved.rawPointsByAssetId,
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: [mkPoint(t2, '2000000000000000000')],
        },
      ],
    });

    expect(res.points).toHaveLength(5);
    expect(res.points[0]?.timestamp).toBe(t0);
    expect(res.points[0]?.totalFiatBalance).toBe(1000);
    expect(res.points[res.points.length - 1]?.totalFiatBalance).toBe(2600);
  });

  it('applies current rate overrides to the final point and asset summary', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');

    const res = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 2,
      startTs: t0,
      endTs: t1,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 100},
          {ts: t1, rate: 110},
        ],
      },
      currentRatesByAssetId: {
        'eth:eth': 150,
      },
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: [],
        },
      ],
    });

    const last = res.points[res.points.length - 1];
    const chart = compactPnlAnalysisResultForChart(res);

    expect(res.analysisWindow).toEqual({
      startTs: t0,
      endTs: t1,
      nowMs: t1,
    });
    expect(chart.analysisWindow).toEqual({
      startTs: t0,
      endTs: t1,
      nowMs: t1,
    });
    expect(last.totalFiatBalance).toBe(150);
    expect(last.totalUnrealizedPnlFiat).toBe(50);
    expect(last.totalPnlChange).toBe(50);
    expect(last.totalPnlPercent).toBe(50);
    expect(last.byWalletId.w1?.markRate).toBe(150);
    expect(res.assetSummaries[0]?.rateEnd).toBe(150);
    expect(res.assetSummaries[0]?.fiatBalanceEnd).toBe(150);
    expect(res.assetSummaries[0]?.pnlEnd).toBe(50);
    expect(res.assetSummaries[0]?.pnlChange).toBe(50);
    expect(chart.totalFiatBalance[chart.totalFiatBalance.length - 1]).toBe(150);
    expect(
      chart.totalUnrealizedPnlFiat[chart.totalUnrealizedPnlFiat.length - 1],
    ).toBe(50);
    expect(chart.totalPnlChange[chart.totalPnlChange.length - 1]).toBe(50);
    expect(chart.lastSpotRatesByRateKey).toEqual({eth: 150});
    expect(chart.latestHoldingsByRateKey).toEqual({
      eth: {units: 1},
    });
    expect(chart.latestRemainingCostBasisFiatTotal).toBe(100);
  });

  it('uses the overridden current rate for basis updates on end-timestamp balance changes', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');

    const res = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 2,
      startTs: t0,
      endTs: t1,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 100},
          {ts: t1, rate: 110},
        ],
      },
      currentRatesByAssetId: {
        'eth:eth': 150,
      },
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: null,
          points: [mkPoint(t1, '1000000000000000000')],
        },
      ],
    });

    const last = res.points[res.points.length - 1];

    expect(last.totalFiatBalance).toBe(150);
    expect(last.totalRemainingCostBasisFiat).toBe(150);
    expect(last.totalUnrealizedPnlFiat).toBe(0);
    expect(last.byWalletId.w1?.remainingCostBasisFiat).toBe(150);
    expect(last.byWalletId.w1?.unrealizedPnlFiat).toBe(0);
  });

  it('matches preloaded analysis when the engine streams prepared wallet points', async () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');
    const t2 = Date.parse('2024-01-01T02:00:00Z');
    const t3 = Date.parse('2024-01-01T03:00:00Z');

    const resolved = resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: 'USD'},
      wallets: [
        mkWallet({walletId: 'w1'}),
        mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
      ],
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 1000},
          {ts: t1, rate: 1100},
          {ts: t2, rate: 1200},
          {ts: t3, rate: 1300},
        ],
      },
    });

    const wallet1Points = [mkPoint(t1, '1500000000000000000'), mkPoint(t3, '1000000000000000000')];
    const wallet2Points = [mkPoint(t2, '2000000000000000000')];

    const preloaded = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: resolved.startTs,
      endTs: resolved.endTs,
      resolvedWindow: resolved,
      walletPointsArePrepared: true,
      ratePointsByAssetId: resolved.rawPointsByAssetId,
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: wallet1Points,
        },
        {
          wallet: mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
          basePoint: null,
          points: wallet2Points,
        },
      ],
    });

    const streamed = await buildPnlAnalysisSeriesFromStreamed({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: resolved.startTs,
      endTs: resolved.endTs,
      resolvedWindow: resolved,
      ratePointsByAssetId: resolved.rawPointsByAssetId,
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: emitPoints(wallet1Points),
        },
        {
          wallet: mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
          basePoint: null,
          points: emitPoints(wallet2Points),
        },
      ],
    });

    expect(streamed).toEqual(preloaded);
  });

  it('matches compacted full streamed analysis when building chart-native streamed output', async () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');
    const t2 = Date.parse('2024-01-01T02:00:00Z');
    const t3 = Date.parse('2024-01-01T03:00:00Z');

    const resolved = resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: 'USD'},
      wallets: [
        mkWallet({walletId: 'w1'}),
        mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
      ],
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 1000},
          {ts: t1, rate: 1100},
          {ts: t2, rate: 1200},
          {ts: t3, rate: 1300},
        ],
      },
    });

    const wallet1Points = [mkPoint(t1, '1500000000000000000'), mkPoint(t3, '1000000000000000000')];
    const wallet2Points = [mkPoint(t2, '2000000000000000000')];

    const full = await buildPnlAnalysisSeriesFromStreamed({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: resolved.startTs,
      endTs: resolved.endTs,
      resolvedWindow: resolved,
      ratePointsByAssetId: resolved.rawPointsByAssetId,
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: emitPoints(wallet1Points),
        },
        {
          wallet: mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
          basePoint: null,
          points: emitPoints(wallet2Points),
        },
      ],
    });

    const chart = await buildPnlAnalysisChartSeriesFromStreamed({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: resolved.startTs,
      endTs: resolved.endTs,
      resolvedWindow: resolved,
      ratePointsByAssetId: resolved.rawPointsByAssetId,
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: emitPoints(wallet1Points),
        },
        {
          wallet: mkWallet({walletId: 'w2', walletName: 'Wallet 2'}),
          basePoint: null,
          points: emitPoints(wallet2Points),
        },
      ],
    });

    expect(chart).toEqual(compactPnlAnalysisResultForChart(full));
  });

  it('makes 1D no-transaction pnl percent match rate percent change naturally', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const result = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 2,
      startTs: t0,
      endTs: t1,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 100},
          {ts: t1, rate: 120},
        ],
      },
      currentRatesByAssetId: {
        'eth:eth': 125,
      },
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '2000000000000000000'),
          points: [],
        },
      ],
    });

    const summary = result.assetSummaries[0];
    const last = result.points[result.points.length - 1];

    expect(summary?.pnlChange).toBe(50);
    expect(summary?.pnlPercent).toBe(25);
    expect(summary?.ratePercentChange).toBe(25);
    expect(last.totalPnlChange).toBe(50);
    expect(last.totalPnlPercent).toBe(25);
    expect(result.totalSummary.pnlPercent).toBe(25);
  });

  it('keeps same-symbol assets separate by asset id during analysis', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');

    const ethUsdc = mkWallet({
      walletId: 'eth-usdc',
      walletName: 'Ethereum USDC',
      chain: 'eth',
      currencyAbbreviation: 'usdc',
      tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      credentials: {
        chain: 'eth',
        coin: 'eth',
        network: 'livenet',
        token: {symbol: 'USDC', decimals: 6, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
      } as WalletCredentials,
    });
    const arbUsdc = mkWallet({
      walletId: 'arb-usdc',
      walletName: 'Arbitrum USDC',
      chain: 'arb',
      currencyAbbreviation: 'usdc',
      tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      credentials: {
        chain: 'arb',
        coin: 'eth',
        network: 'livenet',
        token: {symbol: 'USDC', decimals: 6, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
      } as WalletCredentials,
    });

    const result = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 2,
      startTs: t0,
      endTs: t1,
      ratePointsByAssetId: {
        [ethUsdc.assetId]: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 2},
        ],
        [arbUsdc.assetId]: [
          {ts: t0, rate: 10},
          {ts: t1, rate: 20},
        ],
      },
      wallets: [
        {
          wallet: ethUsdc,
          basePoint: mkPoint(t0, '1000000'),
          points: [],
        },
        {
          wallet: arbUsdc,
          basePoint: mkPoint(t0, '1000000'),
          points: [],
        },
      ],
    });

    const last = result.points[result.points.length - 1];
    const summariesByAssetId = Object.fromEntries(result.assetSummaries.map(summary => [summary.assetId, summary]));
    const chart = compactPnlAnalysisResultForChart(result);

    expect(result.assetIds.slice().sort()).toEqual([arbUsdc.assetId, ethUsdc.assetId].sort());
    expect(result.coins).toEqual(['usdc']);
    expect(result.assetSummaries).toHaveLength(2);
    expect(result.driverAssetId).toBe([arbUsdc.assetId, ethUsdc.assetId].sort()[0]);
    expect(summariesByAssetId[ethUsdc.assetId]?.pnlEnd).toBe(1);
    expect(summariesByAssetId[arbUsdc.assetId]?.pnlEnd).toBe(10);
    expect(summariesByAssetId[ethUsdc.assetId]?.displaySymbol).not.toBe(summariesByAssetId[arbUsdc.assetId]?.displaySymbol);
    expect(last.totalFiatBalance).toBe(22);
    expect(last.totalUnrealizedPnlFiat).toBe(11);
    expect(chart.singleAsset).toBe(false);
    expect(chart.assetIds.slice().sort()).toEqual([arbUsdc.assetId, ethUsdc.assetId].sort());
  });

  it('compacts a single-asset analysis result into aligned chart arrays', () => {
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T01:00:00Z');
    const t2 = Date.parse('2024-01-01T02:00:00Z');
    const t3 = Date.parse('2024-01-01T03:00:00Z');

    const result = buildPnlAnalysisSeriesFromPreloaded({
      cfg: {quoteCurrency: 'USD'},
      timeframe: '1D',
      nowMs: t3,
      maxPoints: 5,
      startTs: t0,
      endTs: t3,
      ratePointsByAssetId: {
        'eth:eth': [
          {ts: t0, rate: 1000},
          {ts: t1, rate: 1100},
          {ts: t2, rate: 1200},
          {ts: t3, rate: 1300},
        ],
      },
      wallets: [
        {
          wallet: mkWallet({walletId: 'w1'}),
          basePoint: mkPoint(t0, '1000000000000000000'),
          points: [mkPoint(t2, '2000000000000000000')],
        },
      ],
    });

    const chart = compactPnlAnalysisResultForChart(result);

    expect(chart.singleAsset).toBe(true);
    expect(chart.timestamps).toEqual([t0, t0 + 45 * 60_000, t1 + 30 * 60_000, t2 + 15 * 60_000, t3]);
    expect(chart.totalFiatBalance).toEqual([1000, 1075, 1150, 2450, 2600]);
    expect(chart.totalRemainingCostBasisFiat).toEqual([1000, 1000, 1000, 2200, 2200]);
    expect(chart.totalUnrealizedPnlFiat).toEqual([0, 75, 150, 250, 400]);
    expect(chart.totalPnlChange).toEqual([0, 75, 150, 250, 400]);
    expect(chart.totalPnlPercent[chart.totalPnlPercent.length - 1]).toBeCloseTo((400 / 2200) * 100, 8);
    expect(chart.driverMarkRate).toEqual([1000, 1075, 1150, 1225, 1300]);
    expect(chart.driverRatePercentChange).toEqual([0, 7.5, 15, 22.5, 30]);
  });
});
