import type {FiatRateSeriesCache} from '../fiatRatesShared';
import type {KvStore} from '../kv/types';
import type {Tx, WalletCredentials, WalletSummary} from '../types';
import {PortfolioEngine} from './portfolioEngine';
import {compactPnlAnalysisResultForChart} from '../pnl/analysisStreaming';

class MemoryKv implements KvStore {
  private data = new Map<string, string>();

  async getString(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async setString(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.data.keys());
    return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
  }

  async clearAll(): Promise<void> {
    this.data.clear();
  }
}

const mkWallet = (overrides?: Partial<WalletSummary>): WalletSummary => ({
  walletId: 'w1',
  walletName: 'Test Wallet',
  chain: 'btc',
  network: 'livenet',
  currencyAbbreviation: 'btc',
  balanceAtomic: '0',
  balanceFormatted: '0',
  ...overrides,
});

const mkCreds = (
  overrides?: Partial<Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'>>,
): Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> => ({
  walletId: 'w1',
  chain: 'btc',
  network: 'livenet',
  coin: 'btc',
  token: undefined,
  ...overrides,
});

const mkCache = (entries: Array<{key: string; points: Array<{ts: number; rate: number}>}>): FiatRateSeriesCache => {
  const out: FiatRateSeriesCache = {};
  for (const entry of entries) {
    out[entry.key] = {fetchedOn: Date.now(), points: entry.points};
  }
  return out;
};

describe('PortfolioEngine compute sessions', () => {
  it('can fetch the next tx page inside the session when a page fetcher is injected', async () => {
    const kv = new MemoryKv();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const pages: Tx[][] = [
      [
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
      ],
      [],
    ];

    let callCount = 0;
    const engine = new PortfolioEngine(kv, {
      txHistoryPageFetcher: async args => {
        callCount += 1;
        expect(args.skip).toBe(callCount === 1 ? 0 : 2);
        expect(args.limit).toBe(200);
        expect(args.reverse).toBe(true);
        return pages.shift() ?? [];
      },
    });

    const wallet = mkWallet();
    const credentials = mkCreds();
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
        ],
      },
    ]);

    await engine.prepareWalletSession({
      wallet,
      credentials,
      ingest: {
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
      },
      checkpoint: null,
      fiatRateSeriesCache: cache,
      fetch: {
        cfg: {baseUrl: 'https://bws.invalid'},
        pageSize: 200,
      },
    });

    const first = await engine.processNextPageSession(wallet.walletId);
    expect(first.done).toBe(false);
    expect(first.fetchedTxs).toBe(2);
    expect(first.logicalPageSize).toBe(2);
    expect(first.appendedSnapshots).toBe(2);
    expect(first.checkpoint.nextSkip).toBe(2);
    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0, cryptoBalance: '1000'},
      {timestamp: t1, cryptoBalance: '600'},
    ]);

    const second = await engine.processNextPageSession(wallet.walletId);
    expect(second.done).toBe(true);
    expect(second.fetchedTxs).toBe(0);
    expect(second.appendedSnapshots).toBe(0);

    await expect(engine.getSnapshotIndex(wallet.walletId)).resolves.toMatchObject({
      checkpoint: {nextSkip: 2},
    });
  });

  it('uses the injected measureNow clock for fetch and compute durations', async () => {
    const kv = new MemoryKv();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const marks = [10, 16, 20, 29];

    const engine = new PortfolioEngine(kv, {
      txHistoryPageFetcher: async () => [
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
      ],
      measureNow: () => marks.shift() ?? 0,
    });

    await engine.prepareWalletSession({
      wallet: mkWallet(),
      credentials: mkCreds(),
      ingest: {
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
      },
      checkpoint: null,
      fiatRateSeriesCache: mkCache([
        {
          key: 'USD:btc:ALL',
          points: [{ts: t0, rate: 1}],
        },
      ]),
      fetch: {
        cfg: {baseUrl: 'https://bws.invalid'},
        pageSize: 200,
      },
    });

    const first = await engine.processNextPageSession('w1');
    expect(first.fetchMs).toBe(6);
    expect(first.computeMs).toBe(9);
  });

  it('can split a fetched tx page into multiple emitted snapshot batches', async () => {
    const kv = new MemoryKv();
    const t0 = Date.parse('2024-01-01T00:00:00Z');

    const pages: Tx[][] = [
      [
        {txid: 'a', time: Math.floor((t0 + 0 * 60_000) / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'b', time: Math.floor((t0 + 1 * 60_000) / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'c', time: Math.floor((t0 + 2 * 60_000) / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'd', time: Math.floor((t0 + 3 * 60_000) / 1000), action: 'received', amount: '1000', fees: '0'},
      ],
      [],
    ];

    let callCount = 0;
    const engine = new PortfolioEngine(kv, {
      txHistoryPageFetcher: async () => {
        callCount += 1;
        return pages.shift() ?? [];
      },
    });

    const wallet = mkWallet();
    const credentials = mkCreds();
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t0 + 3 * 60_000, rate: 1},
        ],
      },
    ]);

    await engine.prepareWalletSession({
      wallet,
      credentials,
      ingest: {
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
      },
      checkpoint: null,
      fiatRateSeriesCache: cache,
      fetch: {
        cfg: {baseUrl: 'https://bws.invalid'},
        pageSize: 200,
        emitRows: 2,
      },
    });

    const first = await engine.processNextPageSession(wallet.walletId);
    expect(first.fetchedTxs).toBe(4);
    expect(first.logicalPageSize).toBe(2);
    expect(first.appendedSnapshots).toBe(2);
    expect(first.checkpoint.nextSkip).toBe(2);
    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0 + 0 * 60_000, cryptoBalance: '1000'},
      {timestamp: t0 + 1 * 60_000, cryptoBalance: '2000'},
    ]);

    const second = await engine.processNextPageSession(wallet.walletId);
    expect(second.fetchedTxs).toBe(0);
    expect(second.logicalPageSize).toBe(2);
    expect(second.appendedSnapshots).toBe(2);
    expect(second.checkpoint.nextSkip).toBe(4);
    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0 + 0 * 60_000, cryptoBalance: '1000'},
      {timestamp: t0 + 1 * 60_000, cryptoBalance: '2000'},
      {timestamp: t0 + 2 * 60_000, cryptoBalance: '3000'},
      {timestamp: t0 + 3 * 60_000, cryptoBalance: '4000'},
    ]);

    const third = await engine.processNextPageSession(wallet.walletId);
    expect(third.done).toBe(true);
    expect(third.fetchedTxs).toBe(0);
    expect(third.appendedSnapshots).toBe(0);
    expect(callCount).toBe(2);
  });

  it('does not over-advance session paging when a fetched page contains duplicate tx entries', async () => {
    const kv = new MemoryKv();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');
    const t2 = Date.parse('2024-01-03T00:00:00Z');

    const pages: Tx[][] = [
      [
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
        {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
      ],
      [
        {txid: 'refill', time: Math.floor(t2 / 1000), action: 'received', amount: '250', fees: '0'},
      ],
      [],
    ];

    const requestedSkips: number[] = [];
    const engine = new PortfolioEngine(kv, {
      txHistoryPageFetcher: async args => {
        requestedSkips.push(args.skip);
        return pages.shift() ?? [];
      },
    });

    const wallet = mkWallet();
    const credentials = mkCreds();
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
          {ts: t2, rate: 1},
        ],
      },
    ]);

    await engine.prepareWalletSession({
      wallet,
      credentials,
      ingest: {
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
      },
      checkpoint: null,
      fiatRateSeriesCache: cache,
      fetch: {
        cfg: {baseUrl: 'https://bws.invalid'},
        pageSize: 200,
      },
    });

    const first = await engine.processNextPageSession(wallet.walletId);
    expect(first.logicalPageSize).toBe(2);
    expect(first.checkpoint.nextSkip).toBe(2);
    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0, cryptoBalance: '1000'},
      {timestamp: t1, cryptoBalance: '600'},
    ]);

    const second = await engine.processNextPageSession(wallet.walletId);
    expect(second.logicalPageSize).toBe(1);
    expect(second.checkpoint.nextSkip).toBe(3);
    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0, cryptoBalance: '1000'},
      {timestamp: t1, cryptoBalance: '600'},
      {timestamp: t2, cryptoBalance: '850'},
    ]);

    expect(requestedSkips).toEqual([0, 2]);
  });

  it('flushes a carried tie group when the following fetch returns empty', async () => {
    const kv = new MemoryKv();
    const t0 = Date.parse('2024-01-01T00:00:00Z');

    const pages: Tx[][] = [
      [
        {
          txid: 'spend',
          time: Math.floor(t0 / 1000),
          action: 'sent',
          amount: '400',
          fees: '0',
          blockHeight: 10,
          transactionIndex: 1,
        },
      ],
      [
        {
          txid: 'fund',
          time: Math.floor(t0 / 1000),
          action: 'received',
          amount: '1000',
          fees: '0',
          blockHeight: 10,
          transactionIndex: 0,
        },
      ],
      [],
    ];

    const requestedSkips: number[] = [];
    const engine = new PortfolioEngine(kv, {
      txHistoryPageFetcher: async args => {
        requestedSkips.push(args.skip);
        return pages.shift() ?? [];
      },
    });

    const wallet = mkWallet();
    const credentials = mkCreds();
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [{ts: t0, rate: 1}],
      },
    ]);

    await engine.prepareWalletSession({
      wallet,
      credentials,
      ingest: {
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
      },
      checkpoint: null,
      fiatRateSeriesCache: cache,
      fetch: {
        cfg: {baseUrl: 'https://bws.invalid'},
        pageSize: 200,
      },
    });

    const first = await engine.processNextPageSession(wallet.walletId);
    expect(first.done).toBe(false);
    expect(first.logicalPageSize).toBe(1);
    expect(first.appendedSnapshots).toBe(0);
    expect(first.checkpoint.nextSkip).toBe(1);

    const second = await engine.processNextPageSession(wallet.walletId);
    expect(second.done).toBe(false);
    expect(second.logicalPageSize).toBe(1);
    expect(second.appendedSnapshots).toBe(0);
    expect(second.checkpoint.nextSkip).toBe(2);

    const third = await engine.processNextPageSession(wallet.walletId);
    expect(third.done).toBe(true);
    expect(third.fetchedTxs).toBe(0);
    expect(third.logicalPageSize).toBe(0);
    expect(third.appendedSnapshots).toBe(2);

    await expect(engine.listSnapshots(wallet.walletId)).resolves.toMatchObject([
      {timestamp: t0, cryptoBalance: '1000'},
      {timestamp: t0, cryptoBalance: '600'},
    ]);

    const finish = await engine.finishWalletSession(wallet.walletId);
    expect(finish.appendedSnapshots).toBe(0);

    expect(requestedSkips).toEqual([0, 1, 2]);
  });

  it('computes analysis directly from worker-owned storage', async () => {
    const kv = new MemoryKv();
    const engine = new PortfolioEngine(kv);
    const wallet = mkWallet({balanceAtomic: '200000000', balanceFormatted: '2'});
    const credentials = mkCreds();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    await engine.rateStore.setSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: '1D',
      series: {
        fetchedOn: Date.now(),
        points: [
          {ts: t0, rate: 10000},
          {ts: t1, rate: 11000},
        ],
      },
    });

    await engine.snapshotStore.ensureWalletIndex({
      walletId: wallet.walletId,
      chain: wallet.chain,
      network: wallet.network,
      currencyAbbreviation: wallet.currencyAbbreviation,
      quoteCurrency: 'USD',
      compressionEnabled: false,
      chunkRows: 2000,
      snapshotDebugMode: 'none',
    });
    await engine.snapshotStore.appendChunk({
      meta: {
        walletId: wallet.walletId,
        chain: wallet.chain,
        network: wallet.network,
        currencyAbbreviation: wallet.currencyAbbreviation,
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
        snapshotDebugMode: 'none',
      },
      snapshots: [
        {timestamp: t0, cryptoBalance: '100000000'},
        {timestamp: t1, cryptoBalance: '200000000'},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '200000000',
        remainingCostBasisFiat: 21000,
        lastMarkRate: 11000,
        lastTimestamp: t1,
        firstNonZeroTs: t0,
      },
    });

    const result = await engine.computeAnalysis({
      cfg: {baseUrl: 'https://bws.invalid'},
      wallets: [
        {
          walletId: wallet.walletId,
          summary: wallet,
          credentials,
          addedAt: Date.now(),
        },
      ],
      quoteCurrency: 'USD',
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 5,
    });

    expect(result.points).toHaveLength(5);
    expect(result.points[0]?.totalFiatBalance).toBe(10000);
    const last = result.points[result.points.length - 1];
    expect(last.totalFiatBalance).toBe(22000);
    expect(last.totalRemainingCostBasisFiat).toBe(21000);
    expect(last.totalUnrealizedPnlFiat).toBe(1000);
  });

  it('returns a compact chart-oriented analysis payload for worker clients', async () => {
    const kv = new MemoryKv();
    const engine = new PortfolioEngine(kv);
    const wallet = mkWallet({balanceAtomic: '200000000', balanceFormatted: '2'});
    const credentials = mkCreds();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    await engine.rateStore.setSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: '1D',
      series: {
        fetchedOn: Date.now(),
        points: [
          {ts: t0, rate: 10000},
          {ts: t1, rate: 11000},
        ],
      },
    });

    await engine.snapshotStore.ensureWalletIndex({
      walletId: wallet.walletId,
      chain: wallet.chain,
      network: wallet.network,
      currencyAbbreviation: wallet.currencyAbbreviation,
      quoteCurrency: 'USD',
      compressionEnabled: false,
      chunkRows: 2000,
      snapshotDebugMode: 'none',
    });
    await engine.snapshotStore.appendChunk({
      meta: {
        walletId: wallet.walletId,
        chain: wallet.chain,
        network: wallet.network,
        currencyAbbreviation: wallet.currencyAbbreviation,
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 2000,
        snapshotDebugMode: 'none',
      },
      snapshots: [
        {timestamp: t0, cryptoBalance: '100000000'},
        {timestamp: t1, cryptoBalance: '200000000'},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '200000000',
        remainingCostBasisFiat: 21000,
        lastMarkRate: 11000,
        lastTimestamp: t1,
        firstNonZeroTs: t0,
      },
    });

    const args = {
      cfg: {baseUrl: 'https://bws.invalid'},
      wallets: [
        {
          walletId: wallet.walletId,
          summary: wallet,
          credentials,
          addedAt: Date.now(),
        },
      ],
      quoteCurrency: 'USD',
      timeframe: '1D' as const,
      nowMs: t1,
      maxPoints: 5,
    };

    const full = await engine.computeAnalysis(args);
    const chart = await engine.computeAnalysisChart(args);

    expect(chart).toEqual(compactPnlAnalysisResultForChart(full));
    expect(chart.timestamps).toHaveLength(5);
    expect(chart.totalFiatBalance[0]).toBe(10000);
    expect(chart.totalFiatBalance[chart.totalFiatBalance.length - 1]).toBe(22000);
    expect(chart.driverMarkRate?.[0]).toBe(10000);
    expect(chart.driverMarkRate?.[chart.driverMarkRate.length - 1]).toBe(11000);
  });

  it('clears cached rates without touching snapshot keys', async () => {
    const kv = new MemoryKv();
    const engine = new PortfolioEngine(kv);

    await kv.setString('rate:v1:USD:btc:ALL', JSON.stringify({fetchedOn: 1, points: [{ts: 1, rate: 1}]}));
    await kv.setString('rate:v1:EUR:btc:ALL', JSON.stringify({fetchedOn: 1, points: [{ts: 1, rate: 1}]}));
    await kv.setString('snap:index:v2:w1', JSON.stringify({v: 2}));

    await engine.clearRates({quoteCurrency: 'USD'});

    await expect(kv.getString('rate:v1:USD:btc:ALL')).resolves.toBeNull();
    await expect(kv.getString('rate:v1:EUR:btc:ALL')).resolves.not.toBeNull();
    await expect(kv.getString('snap:index:v2:w1')).resolves.not.toBeNull();
  });

  it('lists compact persisted rates in debug output', async () => {
    const kv = new MemoryKv();
    const engine = new PortfolioEngine(kv);

    await kv.setString('rate:v1:USD:btc:ALL', JSON.stringify({v: 2, p: [[1, 10], [2, 20]]}));

    await expect(engine.listCachedRates({quoteCurrency: 'USD'})).resolves.toEqual([
      {
        key: 'rate:v1:USD:btc:ALL',
        quoteCurrency: 'USD',
        coin: 'btc',
        interval: 'ALL',
        fetchedOn: 0,
        points: 2,
        firstTs: 1,
        lastTs: 2,
        bytes: JSON.stringify({v: 2, p: [[1, 10], [2, 20]]}).length,
      },
    ]);
  });
});
