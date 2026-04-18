import type {FiatRateSeriesCache} from '../fiatRatesShared';
import type {Tx, WalletCredentials, WalletSummary} from '../types';
import {extractTxIdFromSnapshotId} from './snapshotHelpers';
import {BalanceSnapshotStreamBuilder} from './snapshotStream';

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

const mkCache = (entries: Array<{key: string; points: Array<{ts: number; rate: number}>}>): FiatRateSeriesCache => {
  const out: FiatRateSeriesCache = {};
  for (const entry of entries) {
    out[entry.key] = {fetchedOn: Date.now(), points: entry.points};
  }
  return out;
};

describe('BalanceSnapshotStreamBuilder', () => {
  it('dedupes duplicate txids within a single fetched page and advances by logical tx count', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
        ],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-03T00:00:00Z'),
    });

    const page: Tx[] = [
      {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
      {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
      {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
    ];

    const snapshots = builder.ingestPage(page);

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(snapshots[0].cryptoBalance).toBe('1000');
    expect(snapshots[1].cryptoBalance).toBe('600');

    expect(builder.getCheckpoint().nextSkip).toBe(2);
  });

  it('dedupes overlapping txids across adjacent pages while still advancing the cursor', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');
    const t2 = Date.parse('2024-01-03T00:00:00Z');

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

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-04T00:00:00Z'),
    });

    const page1: Tx[] = [
      {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
      {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
      {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
      {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
    ];
    const page2: Tx[] = [
      {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
      {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
      {txid: 'refill', time: Math.floor(t2 / 1000), action: 'received', amount: '250', fees: '0'},
      {txid: 'refill', time: Math.floor(t2 / 1000), action: 'received', amount: '250', fees: '0'},
    ];

    const page1Snapshots = builder.ingestPage(page1);
    const resumed = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-04T00:00:00Z'),
      checkpoint: builder.getCheckpoint(),
    });
    const page2Snapshots = resumed.ingestPage(page2);

    expect(page1Snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(page2Snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['refill']);
    expect(page2Snapshots[0].cryptoBalance).toBe('850');
    expect(resumed.getCheckpoint().nextSkip).toBe(4);
  });

  it('carries trailing tie groups across page boundaries and flushes them on finish', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [{ts: t0, rate: 1}],
      },
    ]);

    const first = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-02T00:00:00Z'),
    });

    const firstPage = first.ingestPageWithSnapshotLimit([
      {
        txid: 'spend',
        time: Math.floor(t0 / 1000),
        action: 'sent',
        amount: '400',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 1,
      },
    ]);
    expect(firstPage.snapshots).toEqual([]);
    expect(first.getCheckpoint().nextSkip).toBe(1);
    expect(first.getCheckpoint().carryoverGroup).toHaveLength(1);

    const resumed = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-02T00:00:00Z'),
      checkpoint: first.getCheckpoint(),
    });

    const secondPage = resumed.ingestPageWithSnapshotLimit([
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 0,
      },
    ]);
    expect(secondPage.snapshots).toEqual([]);
    expect(resumed.getCheckpoint().nextSkip).toBe(2);
    expect(resumed.getCheckpoint().carryoverGroup).toHaveLength(2);

    const finished = resumed.finish();
    expect(finished.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(finished.map(s => s.cryptoBalance)).toEqual(['1000', '600']);
    expect(resumed.getCheckpoint().carryoverGroup).toBeUndefined();
  });

  it('reuses normalized page entries when tracking recent tx ids for partial page consumption', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');
    const t2 = Date.parse('2024-01-03T00:00:00Z');

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

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-04T00:00:00Z'),
    });

    const result = builder.ingestPageWithSnapshotLimit(
      [
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
        {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
        {txid: 'spend', time: Math.floor(t1 / 1000), action: 'sent', amount: '400', fees: '0'},
        {txid: 'refill', time: Math.floor(t2 / 1000), action: 'received', amount: '250', fees: '0'},
      ],
      2,
    );

    expect(result.snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(result.logicalPageSize).toBe(2);
    expect(result.consumedRawCount).toBe(3);
    expect(builder.getCheckpoint().recentTxIds).toEqual(['fund', 'spend']);
  });

  it('keeps deterministic tie-group order when the sorted batch already avoids underflow', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [{ts: t0, rate: 1}],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-02T00:00:00Z'),
    });

    const snapshots = builder.ingestPage([
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 0,
      },
      {
        txid: 'spend',
        time: Math.floor(t0 / 1000),
        action: 'sent',
        amount: '400',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 1,
      },
    ]);

    expect(snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(snapshots.map(s => s.cryptoBalance)).toEqual(['1000', '600']);
  });

  it('reorders tie-group txs when the sorted batch would underflow', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [{ts: t0, rate: 1}],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      nowMs: Date.parse('2024-01-02T00:00:00Z'),
    });

    const snapshots = builder.ingestPage([
      {
        txid: 'spend',
        time: Math.floor(t0 / 1000),
        action: 'sent',
        amount: '400',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 0,
      },
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        fees: '0',
        blockHeight: 10,
        transactionIndex: 1,
      },
    ]);

    expect(snapshots.map(s => extractTxIdFromSnapshotId(s.id ?? ''))).toEqual(['fund', 'spend']);
    expect(snapshots.map(s => s.cryptoBalance)).toEqual(['1000', '600']);
  });

  it('emits compact persist inputs when snapshot debug mode is none', () => {
    const wallet = mkWallet();
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [{ts: t0, rate: 1}],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'none',
      nowMs: Date.parse('2024-01-02T00:00:00Z'),
    });

    const snapshots = builder.ingestPage([
      {txid: 'fund', time: Math.floor(t0 / 1000), action: 'received', amount: '1000', fees: '0'},
    ]);

    expect(snapshots).toEqual([
      {
        timestamp: t0,
        cryptoBalance: '1000',
      },
    ]);
  });

  it('captures the prior daily balance before a newer compressed-day tx mutates builder state', () => {
    const wallet = mkWallet();
    const credentials: Pick<
      WalletCredentials,
      'walletId' | 'chain' | 'network' | 'coin' | 'token'
    > = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');
    const nowMs = Date.parse('2024-05-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
        ],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'full',
      compressionEnabled: true,
      nowMs,
    });

    const snapshots = builder.ingestPage([
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        fees: '0',
      },
      {
        txid: 'spend',
        time: Math.floor(t1 / 1000),
        action: 'sent',
        amount: '400',
        fees: '0',
      },
    ]);

    expect(snapshots).toMatchObject([
      {
        eventType: 'daily',
        cryptoBalance: '1000',
        remainingCostBasisFiat: 0.00001,
        txIds: ['fund'],
      },
    ]);

    expect(builder.finish()).toMatchObject([
      {
        eventType: 'daily',
        cryptoBalance: '600',
        remainingCostBasisFiat: 0.000006,
        txIds: ['spend'],
      },
    ]);
  });

  it('persists daily tx ids across checkpoint resume for compressed history', () => {
    const wallet = mkWallet();
    const credentials: Pick<
      WalletCredentials,
      'walletId' | 'chain' | 'network' | 'coin' | 'token'
    > = {
      walletId: 'w1',
      chain: 'btc',
      network: 'livenet',
      coin: 'btc',
      token: undefined,
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-01T12:00:00Z');
    const nowMs = Date.parse('2024-05-01T00:00:00Z');
    const cache = mkCache([
      {
        key: 'USD:btc:ALL',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
        ],
      },
    ]);

    const first = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      compressionEnabled: true,
      nowMs,
    });

    const firstSnapshots = first.ingestPage([
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        fees: '0',
      },
    ]);
    expect(firstSnapshots).toEqual([]);
    expect(first.getCheckpoint().daily?.txIds).toEqual(['fund']);
    expect(first.getCheckpoint().daily?.balanceAtomic).toBe('1000');
    expect(first.getCheckpoint().daily?.remainingCostBasisFiat).toBe(0.00001);

    const resumed = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      snapshotDebugMode: 'link',
      compressionEnabled: true,
      nowMs,
      checkpoint: first.getCheckpoint(),
    });

    const secondSnapshots = resumed.ingestPage([
      {
        txid: 'spend',
        time: Math.floor(t1 / 1000),
        action: 'sent',
        amount: '400',
        fees: '0',
      },
    ]);
    expect(secondSnapshots).toEqual([]);
    expect(resumed.getCheckpoint().daily?.txIds).toEqual(['fund', 'spend']);
    expect(resumed.getCheckpoint().daily?.balanceAtomic).toBe('600');
    expect(resumed.getCheckpoint().daily?.remainingCostBasisFiat).toBe(
      0.000006,
    );

    const finished = resumed.finish();
    expect(finished).toMatchObject([
      {
        eventType: 'daily',
        cryptoBalance: '600',
        txIds: ['fund', 'spend'],
      },
    ]);
  });

  it('skips fee parsing for token wallets while preserving token balance snapshots', () => {
    const wallet = mkWallet({
      chain: 'eth',
      currencyAbbreviation: 'usdc',
      tokenAddress: '0xabc123',
    });
    const credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'> = {
      walletId: 'w1',
      chain: 'eth',
      network: 'livenet',
      coin: 'usdc',
      token: {address: '0xabc123', symbol: 'USDC'},
    };

    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const cache = mkCache([
      {
        key: 'USD:usdc:ALL:eth:0xabc123',
        points: [
          {ts: t0, rate: 1},
          {ts: t1, rate: 1},
        ],
      },
    ]);

    const builder = new BalanceSnapshotStreamBuilder({
      wallet,
      credentials,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: cache,
      nowMs: Date.parse('2024-01-03T00:00:00Z'),
    });

    const page: Tx[] = [
      {
        txid: 'fund',
        time: Math.floor(t0 / 1000),
        action: 'received',
        amount: '1000',
        receipt: {
          get gasUsed() {
            throw new Error('token balance snapshots should not parse gasUsed');
          },
        },
      },
      {
        txid: 'spend',
        time: Math.floor(t1 / 1000),
        action: 'sent',
        amount: '400',
        receipt: {
          status: '1',
          get gasUsed() {
            throw new Error('token balance snapshots should not parse gasUsed');
          },
        },
      },
    ];

    const snapshots = builder.ingestPage(page);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].cryptoBalance).toBe('1000');
    expect(snapshots[1].cryptoBalance).toBe('600');
  });
});
