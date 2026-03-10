import {getFiatRateSeriesCacheKey} from '../fiatRateSeries';
import {buildPnlAnalysisSeries} from './analysis';
import type {WalletForAnalysis} from './analysis';
import type {BalanceSnapshotStored} from './types';

const BTC_ATOMIC = '100000000';

const makeSnapshot = (
  overrides: Partial<BalanceSnapshotStored> = {},
): BalanceSnapshotStored => ({
  id: 'tx:start-balance',
  walletId: 'wallet-1',
  chain: 'btc',
  coin: 'btc',
  network: 'livenet',
  assetId: 'btc:livenet',
  timestamp: 0,
  eventType: 'tx',
  cryptoBalance: BTC_ATOMIC,
  remainingCostBasisFiat: 0,
  quoteCurrency: 'USD',
  markRate: 0,
  ...overrides,
});

const makeWallet = (snapshots: BalanceSnapshotStored[]): WalletForAnalysis => ({
  walletId: 'wallet-1',
  walletName: 'BTC Wallet',
  currencyAbbreviation: 'btc',
  credentials: {
    coin: 'btc',
    chain: 'btc',
    network: 'livenet',
  },
  snapshots,
});

describe('buildPnlAnalysisSeries', () => {
  it('keeps the first point pinned to zero when the interval start falls between rate samples', () => {
    const nowMs = Date.UTC(2026, 0, 2, 12, 34, 0);
    const firstBalanceTs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const beforeStartMs = firstBalanceTs - 30 * 60 * 1000;
    const afterStartMs = firstBalanceTs + 30 * 60 * 1000;

    const wallet = makeWallet([
      makeSnapshot({
        timestamp: firstBalanceTs,
        markRate: 100,
      }),
    ]);

    const result = buildPnlAnalysisSeries({
      wallets: [wallet],
      timeframe: 'ALL',
      quoteCurrency: 'USD',
      nowMs,
      maxPoints: 3,
      fiatRateSeriesCache: {
        [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
          fetchedOn: nowMs,
          points: [
            {ts: beforeStartMs, rate: 99.99},
            {ts: afterStartMs, rate: 100.01},
          ],
        },
      },
    });

    expect(result.points[0].timestamp).toBe(firstBalanceTs);
    expect(result.points[0].markRate).toBe(99.99);
    expect(result.points[0].ratePercentChange).toBe(0);
    expect(result.points[0].totalUnrealizedPnlFiat).toBe(0);
    expect(result.points[0].totalPnlPercent).toBe(0);
  });
});
