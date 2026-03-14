import {getFiatRateSeriesCacheKey} from '../fiatRateSeries';
import {buildPnlAnalysisSeries, buildRateSeries} from './analysis';
import type {WalletForAnalysis} from './analysis';
import type {BalanceSnapshotStored} from './types';

const BTC_ATOMIC = '100000000';
const ETH_ATOMIC = '1000000000000000000';

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

describe('buildRateSeries', () => {
  it('keeps one point before the cutoff for sorted input', () => {
    const result = buildRateSeries(
      [
        {ts: 1000, rate: 10},
        {ts: 2000, rate: 20},
        {ts: 3000, rate: 30},
        {ts: 4000, rate: 40},
      ],
      2500,
    );

    expect(Array.from(result.ts)).toEqual([2000, 3000, 4000]);
    expect(Array.from(result.rate)).toEqual([20, 30, 40]);
  });

  it('sorts unsorted input before applying the cutoff window', () => {
    const result = buildRateSeries(
      [
        {ts: 4000, rate: 40},
        {ts: 1000, rate: 10},
        {ts: 3000, rate: 30},
        {ts: 2000, rate: 20},
      ],
      2500,
    );

    expect(Array.from(result.ts)).toEqual([2000, 3000, 4000]);
    expect(Array.from(result.rate)).toEqual([20, 30, 40]);
  });

  it('uses the first duplicate timestamp at or after the cutoff', () => {
    const result = buildRateSeries(
      [
        {ts: 1000, rate: 10},
        {ts: 2000, rate: 20},
        {ts: 2000, rate: 21},
        {ts: 3000, rate: 30},
      ],
      2000,
    );

    expect(Array.from(result.ts)).toEqual([1000, 2000, 2000, 3000]);
    expect(Array.from(result.rate)).toEqual([10, 20, 21, 30]);
  });

  it('returns an empty series when no points exist at or after the cutoff', () => {
    const result = buildRateSeries(
      [
        {ts: 1000, rate: 10},
        {ts: 2000, rate: 20},
      ],
      3000,
    );

    expect(Array.from(result.ts)).toEqual([]);
    expect(Array.from(result.rate)).toEqual([]);
  });
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

  it('starts ALL at the oldest portfolio snapshot instead of the shortest shared coin history', () => {
    const btcStartMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const ethRateStartMs = Date.UTC(2024, 0, 2, 0, 0, 0);
    const ethWalletStartMs = Date.UTC(2024, 0, 3, 0, 0, 0);
    const endMs = Date.UTC(2024, 0, 4, 0, 0, 0);

    const btcWallet: WalletForAnalysis = {
      walletId: 'wallet-btc',
      walletName: 'BTC Wallet',
      currencyAbbreviation: 'btc',
      credentials: {
        coin: 'btc',
        chain: 'btc',
        network: 'livenet',
      },
      snapshots: [
        makeSnapshot({
          walletId: 'wallet-btc',
          timestamp: btcStartMs,
          markRate: 100,
        }),
      ],
    };

    const ethWallet: WalletForAnalysis = {
      walletId: 'wallet-eth',
      walletName: 'ETH Wallet',
      currencyAbbreviation: 'eth',
      credentials: {
        coin: 'eth',
        chain: 'eth',
        network: 'livenet',
      },
      snapshots: [
        makeSnapshot({
          id: 'tx:eth-start-balance',
          walletId: 'wallet-eth',
          chain: 'eth',
          coin: 'eth',
          assetId: 'eth:livenet',
          timestamp: ethWalletStartMs,
          cryptoBalance: ETH_ATOMIC,
          markRate: 10,
        }),
      ],
    };

    const result = buildPnlAnalysisSeries({
      wallets: [btcWallet, ethWallet],
      timeframe: 'ALL',
      quoteCurrency: 'USD',
      nowMs: endMs,
      maxPoints: 4,
      fiatRateSeriesCache: {
        [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
          fetchedOn: endMs,
          points: [
            {ts: btcStartMs, rate: 100},
            {ts: ethRateStartMs, rate: 110},
            {ts: ethWalletStartMs, rate: 120},
            {ts: endMs, rate: 130},
          ],
        },
        [getFiatRateSeriesCacheKey('USD', 'eth', 'ALL')]: {
          fetchedOn: endMs,
          points: [
            {ts: ethRateStartMs, rate: 10},
            {ts: ethWalletStartMs, rate: 11},
            {ts: endMs, rate: 12},
          ],
        },
      },
    });

    expect(result.points[0].timestamp).toBe(btcStartMs);
    expect(result.points[0].totalFiatBalance).toBe(100);
    expect(result.points[0].byWalletId['wallet-eth']?.fiatBalance).toBe(0);
    expect(result.points[2].byWalletId['wallet-eth']?.fiatBalance).toBe(11);
  });

  it('keeps 5Y pinned to the requested start instead of the shortest shared coin history', () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const startMs = nowMs - 1825 * MS_PER_DAY;
    const ethWalletStartMs = startMs + 730 * MS_PER_DAY;

    const btcWallet: WalletForAnalysis = {
      walletId: 'wallet-btc',
      walletName: 'BTC Wallet',
      currencyAbbreviation: 'btc',
      credentials: {
        coin: 'btc',
        chain: 'btc',
        network: 'livenet',
      },
      snapshots: [
        makeSnapshot({
          walletId: 'wallet-btc',
          timestamp: startMs,
          markRate: 100,
        }),
      ],
    };

    const ethWallet: WalletForAnalysis = {
      walletId: 'wallet-eth',
      walletName: 'ETH Wallet',
      currencyAbbreviation: 'eth',
      credentials: {
        coin: 'eth',
        chain: 'eth',
        network: 'livenet',
      },
      snapshots: [
        makeSnapshot({
          id: 'tx:eth-start-balance',
          walletId: 'wallet-eth',
          chain: 'eth',
          coin: 'eth',
          assetId: 'eth:livenet',
          timestamp: ethWalletStartMs,
          cryptoBalance: ETH_ATOMIC,
          markRate: 10,
        }),
      ],
    };

    const result = buildPnlAnalysisSeries({
      wallets: [btcWallet, ethWallet],
      timeframe: '5Y',
      quoteCurrency: 'USD',
      nowMs,
      maxPoints: 4,
      fiatRateSeriesCache: {
        [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
          fetchedOn: nowMs,
          points: [
            {ts: startMs - MS_PER_DAY, rate: 99},
            {ts: startMs + MS_PER_DAY, rate: 101},
            {ts: ethWalletStartMs, rate: 110},
            {ts: nowMs, rate: 130},
          ],
        },
        [getFiatRateSeriesCacheKey('USD', 'eth', 'ALL')]: {
          fetchedOn: nowMs,
          points: [
            {ts: ethWalletStartMs, rate: 10},
            {ts: nowMs, rate: 12},
          ],
        },
      },
    });

    expect(result.points[0].timestamp).toBe(startMs);
    expect(result.points[0].totalFiatBalance).toBe(99);
    expect(result.points[0].byWalletId['wallet-eth']?.fiatBalance).toBe(0);
  });

  it('extends the final point to now when newer snapshots exist past the latest rate sample', () => {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastRateMs = Date.UTC(2026, 0, 2, 0, 0, 0);
    const nowMs = Date.UTC(2026, 0, 2, 12, 0, 0);

    const wallet = makeWallet([
      makeSnapshot({
        timestamp: startMs,
        markRate: 100,
      }),
      makeSnapshot({
        id: 'tx:receive',
        timestamp: nowMs,
        cryptoBalance: '200000000',
        markRate: 120,
      }),
    ]);

    const result = buildPnlAnalysisSeries({
      wallets: [wallet],
      timeframe: '1D',
      quoteCurrency: 'USD',
      nowMs,
      maxPoints: 3,
      currentRatesByCoin: {
        btc: 120,
      },
      fiatRateSeriesCache: {
        [getFiatRateSeriesCacheKey('USD', 'btc', '1D')]: {
          fetchedOn: nowMs,
          points: [
            {ts: startMs, rate: 100},
            {ts: lastRateMs, rate: 110},
          ],
        },
      },
    });

    expect(result.points[2].timestamp).toBe(nowMs);
    expect(result.points[2].totalFiatBalance).toBe(240);
  });
});
