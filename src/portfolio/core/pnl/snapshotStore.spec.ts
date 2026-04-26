import type {KvStore} from '../kv/types';
import {SnapshotStore, buildWalletMetaForStore} from './snapshotStore';

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

class NoListKeysKv extends MemoryKv {
  async listKeys(): Promise<string[]> {
    throw new Error('SnapshotStore.clearWallet should not scan keys.');
  }
}

class CountingKv extends MemoryKv {
  readonly getCounts = new Map<string, number>();

  async getString(key: string): Promise<string | null> {
    this.getCounts.set(key, (this.getCounts.get(key) ?? 0) + 1);
    return super.getString(key);
  }

  resetGetCounts(): void {
    this.getCounts.clear();
  }
}

describe('SnapshotStore v2', () => {
  it('stores compact point rows and serves point queries without debug sidecars', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w1',
        walletName: 'Wallet 1',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w1',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {timestamp: 1000, cryptoBalance: '1', id: 'tx:w1:a', eventType: 'tx', markRate: 1000},
        {timestamp: 2000, cryptoBalance: '2', id: 'tx:w1:b', eventType: 'tx', markRate: 1100},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '2',
        remainingCostBasisFiat: 0,
        lastMarkRate: 1100,
        lastTimestamp: 2000,
      },
    });

    const idx = await store.loadIndex('w1');
    expect(idx?.v).toBe(2);
    // New index save persists revision 1; appending the first chunk bumps it to 2.
    expect(idx?.revision).toBe(2);
    expect(idx?.chunks).toHaveLength(1);
    expect(idx?.chunks[0]?.debugMode).toBe('none');

    await expect(store.listPoints('w1')).resolves.toEqual([
      {timestamp: 1000, cryptoBalance: '1'},
      {timestamp: 2000, cryptoBalance: '2'},
    ]);

    await expect(store.getLatestPoint('w1')).resolves.toEqual({
      timestamp: 2000,
      cryptoBalance: '2',
    });

    await expect(store.findLastPointAtOrBefore('w1', 1500)).resolves.toEqual({
      timestamp: 1000,
      cryptoBalance: '1',
    });

    const hydrated = await store.getLatestSnapshot('w1');
    expect(hydrated?.walletId).toBe('w1');
    expect(hydrated?.quoteCurrency).toBe('USD');
    expect(hydrated?.cryptoBalance).toBe('2');
    expect(hydrated?.markRate).toBe(0);
    expect(hydrated?.remainingCostBasisFiat).toBe(0);
  });

  it('normalizes legacy snapshot indexes without revision to revision 1', async () => {
    const kv = new MemoryKv();
    await kv.setString(
      'snap:index:v2:w-legacy-index',
      JSON.stringify({
        v: 2,
        walletId: 'w-legacy-index',
        compressionEnabled: true,
        chunkRows: 500,
        chunks: [],
        checkpoint: {
          nextSkip: 0,
          balanceAtomic: '0',
          remainingCostBasisFiat: 0,
          lastMarkRate: 0,
          lastTimestamp: 0,
        },
        updatedAt: 123,
      }),
    );

    const store = new SnapshotStore(kv);
    await expect(store.loadIndex('w-legacy-index')).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('increments snapshot index revision on each index save', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-revision',
        walletName: 'Wallet Revision',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-revision',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
    });

    const created = await store.ensureWalletIndex(meta);
    expect(created.revision).toBe(1);

    const checkpoint = {
      nextSkip: 1,
      balanceAtomic: '1',
      remainingCostBasisFiat: 0,
      lastMarkRate: 0,
      lastTimestamp: 1000,
    };

    const checkpointOnly = await store.updateCheckpoint({
      walletId: 'w-revision',
      checkpoint,
    });
    expect(checkpointOnly.revision).toBe(2);

    const withChunk = await store.appendChunk({
      meta,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint,
    });
    expect(withChunk.revision).toBe(3);
  });

  it('defaults snapshot debug storage to none when callers omit the mode', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-default',
        walletName: 'Wallet Default',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-default',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {
          timestamp: 1000,
          cryptoBalance: '1',
          id: 'tx:w-default:a',
          eventType: 'tx',
          txIds: ['a'],
          markRate: 1000,
          remainingCostBasisFiat: 1000,
          createdAt: 1234,
        },
      ],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '1',
        remainingCostBasisFiat: 1000,
        lastMarkRate: 1000,
        lastTimestamp: 1000,
      },
    });

    const idx = await store.loadIndex('w-default');
    expect(idx?.chunks[0]?.debugMode).toBe('none');

    const rawChunk = await kv.getString('snap:chunk:v2:w-default:1');
    expect(rawChunk).toBeTruthy();
    expect(JSON.parse(rawChunk as string)).toEqual({
      v: 2,
      rows: [[1000, '1']],
    });

    const latest = await store.getLatestSnapshot('w-default');
    expect(latest).toMatchObject({
      id: 'snap:w-default:1000:0',
      eventType: 'tx',
      markRate: 0,
      remainingCostBasisFiat: 0,
    });
    expect(latest?.txIds).toBeUndefined();
  });

  it('hydrates full debug fields when requested', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w2',
        walletName: 'Wallet 2',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w2',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: false,
      chunkRows: 500,
      snapshotDebugMode: 'full',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {
          id: 'tx:w2:fund',
          timestamp: 1000,
          eventType: 'tx',
          cryptoBalance: '100000000',
          remainingCostBasisFiat: 1000,
          markRate: 1000,
          createdAt: 9000,
        },
        {
          id: 'daily:w2:2024-01-02',
          timestamp: 2000,
          eventType: 'daily',
          cryptoBalance: '150000000',
          remainingCostBasisFiat: 1200,
          markRate: 1200,
          createdAt: 9001,
          txIds: ['b', 'c'],
        },
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '150000000',
        remainingCostBasisFiat: 1200,
        lastMarkRate: 1200,
        lastTimestamp: 2000,
      },
    });

    const snapshots = await store.listSnapshots('w2');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      id: 'tx:w2:fund',
      eventType: 'tx',
      markRate: 1000,
      remainingCostBasisFiat: 1000,
      createdAt: 9000,
    });
    expect(snapshots[1]).toMatchObject({
      id: 'daily:w2:2024-01-02',
      eventType: 'daily',
      markRate: 1200,
      remainingCostBasisFiat: 1200,
      createdAt: 9001,
      txIds: ['b', 'c'],
    });
  });

  it('sorts out-of-order snapshots while keeping debug rows aligned', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w2-ordered',
        walletName: 'Wallet 2 Ordered',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w2-ordered',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
      snapshotDebugMode: 'full',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {
          id: 'daily:w2-ordered:2024-01-02',
          timestamp: 2000,
          eventType: 'daily',
          cryptoBalance: '2',
          txIds: ['b'],
          remainingCostBasisFiat: 2000,
          markRate: 2000,
          createdAt: 2,
        },
        {
          id: 'tx:w2-ordered:a',
          timestamp: 1000,
          eventType: 'tx',
          cryptoBalance: '1',
          txIds: ['a'],
          remainingCostBasisFiat: 1000,
          markRate: 1000,
          createdAt: 1,
        },
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '2',
        remainingCostBasisFiat: 2000,
        lastMarkRate: 2000,
        lastTimestamp: 2000,
      },
    });

    expect(JSON.parse((await kv.getString('snap:chunk:v2:w2-ordered:1')) as string)).toEqual({
      v: 2,
      rows: [
        [1000, '1'],
        [2000, '2'],
      ],
      debug: {
        mode: 'full',
        idByRow: ['tx:w2-ordered:a', 'daily:w2-ordered:2024-01-02'],
        eventTypeByRow: [0, 1],
        txIdsByRow: [['a'], ['b']],
        markRateByRow: [1000, 2000],
        remainingCostBasisFiatByRow: [1000, 2000],
        createdAtByRow: [1, 2],
      },
    });

    await expect(store.listSnapshots('w2-ordered')).resolves.toMatchObject([
      {
        id: 'tx:w2-ordered:a',
        timestamp: 1000,
        eventType: 'tx',
        txIds: ['a'],
        markRate: 1000,
        remainingCostBasisFiat: 1000,
        createdAt: 1,
      },
      {
        id: 'daily:w2-ordered:2024-01-02',
        timestamp: 2000,
        eventType: 'daily',
        txIds: ['b'],
        markRate: 2000,
        remainingCostBasisFiat: 2000,
        createdAt: 2,
      },
    ]);
  });

  it('backfills missing v2 meta without resetting stored chunks', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w3',
        walletName: 'Wallet 3',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w3',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '1',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 1000,
      },
    });

    await kv.delete('snap:meta:v2:w3');
    store.clearMemoryCache();

    const before = await store.listPoints('w3');
    expect(before).toEqual([{timestamp: 1000, cryptoBalance: '1'}]);

    const idx = await store.ensureWalletIndex(meta);
    expect(idx.chunks).toHaveLength(1);

    const after = await store.listPoints('w3');
    expect(after).toEqual([{timestamp: 1000, cryptoBalance: '1'}]);

    const storedMeta = await store.loadMeta('w3');
    expect(storedMeta?.quoteCurrency).toBe('USD');
  });

  it('rebuilds wallet storage when snapshot debug mode changes', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const baseArgs = {
      wallet: {
        walletId: 'w-debug-mode',
        walletName: 'Wallet Debug Mode',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-debug-mode',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
    };

    const metaNone = buildWalletMetaForStore({
      ...baseArgs,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta: metaNone,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '1',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 1000,
      },
    });

    const metaLink = buildWalletMetaForStore({
      ...baseArgs,
      snapshotDebugMode: 'link',
    });
    const rebuiltIndex = await store.ensureWalletIndex(metaLink);

    expect(rebuiltIndex.chunks).toEqual([]);
    expect(rebuiltIndex.checkpoint.nextSkip).toBe(0);
    await expect(store.listPoints('w-debug-mode')).resolves.toEqual([]);
    await expect(store.loadMeta('w-debug-mode')).resolves.toMatchObject({
      snapshotDebugMode: 'link',
    });
  });

  it('clears indexed wallet chunks without scanning storage keys', async () => {
    const kv = new NoListKeysKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-clear',
        walletName: 'Wallet Clear',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-clear',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 1,
    });

    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '1',
        remainingCostBasisFiat: 0,
        lastMarkRate: 1000,
        lastTimestamp: 1000,
      },
    });
    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 2000, cryptoBalance: '2'}],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '2',
        remainingCostBasisFiat: 0,
        lastMarkRate: 1100,
        lastTimestamp: 2000,
      },
    });
    await kv.setString('snap:chunk:v2:other-wallet:1', JSON.stringify({v: 2, rows: [[1, '9']]}));

    await store.clearWallet('w-clear');

    await expect(store.loadIndex('w-clear')).resolves.toBeNull();
    await expect(store.loadMeta('w-clear')).resolves.toBeNull();
    await expect(kv.getString('snap:chunk:v2:w-clear:1')).resolves.toBeNull();
    await expect(kv.getString('snap:chunk:v2:w-clear:2')).resolves.toBeNull();
    await expect(kv.getString('snap:chunk:v2:other-wallet:1')).resolves.not.toBeNull();
  });

  it('reuses cached meta, index, and chunk reads across repeated snapshot access', async () => {
    const kv = new CountingKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-cache',
        walletName: 'Wallet Cache',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-cache',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: false,
      chunkRows: 500,
      snapshotDebugMode: 'full',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {
          id: 'tx:w-cache:fund',
          timestamp: 1000,
          eventType: 'tx',
          cryptoBalance: '100000000',
          remainingCostBasisFiat: 1000,
          markRate: 1000,
          createdAt: 1234,
        },
      ],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '100000000',
        remainingCostBasisFiat: 1000,
        lastMarkRate: 1000,
        lastTimestamp: 1000,
      },
    });

    store.clearMemoryCache();
    kv.resetGetCounts();

    await expect(store.getLatestSnapshot('w-cache')).resolves.toMatchObject({
      id: 'tx:w-cache:fund',
      cryptoBalance: '100000000',
    });

    expect(kv.getCounts.get('snap:index:v2:w-cache')).toBe(1);
    expect(kv.getCounts.get('snap:meta:v2:w-cache')).toBe(1);
    expect(kv.getCounts.get('snap:chunk:v2:w-cache:1')).toBe(1);

    await expect(store.getLatestSnapshot('w-cache')).resolves.toMatchObject({
      id: 'tx:w-cache:fund',
      cryptoBalance: '100000000',
    });

    expect(kv.getCounts.get('snap:index:v2:w-cache')).toBe(1);
    expect(kv.getCounts.get('snap:meta:v2:w-cache')).toBe(1);
    expect(kv.getCounts.get('snap:chunk:v2:w-cache:1')).toBe(1);
  });

  it('preserves the invalid-history marker when requested during wallet cleanup', async () => {
    const kv = new CountingKv();
    const store = new SnapshotStore(kv);

    await store.saveInvalidHistoryMarker({
      v: 1,
      walletId: 'w-clear',
      reason: 'negative_balance',
      detectedAt: 1000,
      retryAfter: 2000,
      message: 'Invalid tx history',
      source: 'test',
      txId: 'tx-1',
      balanceAtomic: '-1',
    });

    await store.clearWallet('w-clear', {preserveInvalidHistoryMarker: true});
    await expect(store.loadInvalidHistoryMarker('w-clear')).resolves.toMatchObject({
      walletId: 'w-clear',
      reason: 'negative_balance',
      message: 'Invalid tx history',
    });

    await store.clearWallet('w-clear');
    await expect(store.loadInvalidHistoryMarker('w-clear')).resolves.toBeNull();
  });

  it('returns cloned meta and index values so callers cannot mutate cached state', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-clone',
        walletName: 'Wallet Clone',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-clone',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: true,
      chunkRows: 500,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint: {
        nextSkip: 1,
        balanceAtomic: '1',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 1000,
      },
    });

    const idx1 = await store.loadIndex('w-clone');
    const meta1 = await store.loadMeta('w-clone');

    expect(idx1).not.toBeNull();
    expect(meta1).not.toBeNull();

    idx1!.checkpoint.nextSkip = 999;
    idx1!.chunks.push({id: 99, fromTs: 0, toTs: 0, rows: 0, debugMode: 'none'});
    meta1!.coin = 'mutated';

    await expect(store.loadIndex('w-clone')).resolves.toMatchObject({
      checkpoint: {nextSkip: 1},
      chunks: [{id: 1}],
    });
    await expect(store.loadMeta('w-clone')).resolves.toMatchObject({
      coin: 'eth',
    });
  });

  it('streams points through a manual async iterator without Symbol.asyncIterator', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-iter',
        walletName: 'Wallet Iter',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-iter',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: false,
      chunkRows: 2,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {timestamp: 1000, cryptoBalance: '1'},
        {timestamp: 2000, cryptoBalance: '2'},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '2',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 2000,
      },
    });
    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 3000, cryptoBalance: '3'}],
      checkpoint: {
        nextSkip: 3,
        balanceAtomic: '3',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 3000,
      },
    });

    const iterator = store.iteratePoints({
      walletId: 'w-iter',
      fromExclusive: 1000,
      toInclusive: 3000,
    }) as any;

    expect(iterator[Symbol.asyncIterator]).toBeUndefined();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {timestamp: 2000, cryptoBalance: '2'},
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {timestamp: 3000, cryptoBalance: '3'},
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('streams snapshots through a manual async iterator without Symbol.asyncIterator', async () => {
    const kv = new MemoryKv();
    const store = new SnapshotStore(kv);
    const meta = buildWalletMetaForStore({
      wallet: {
        walletId: 'w-snap-iter',
        walletName: 'Wallet Snap Iter',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'eth',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w-snap-iter',
        chain: 'eth',
        network: 'livenet',
        coin: 'eth',
      } as any,
      quoteCurrency: 'usd',
      compressionEnabled: false,
      chunkRows: 2,
      snapshotDebugMode: 'none',
    });

    await store.appendChunk({
      meta,
      snapshots: [
        {timestamp: 1000, cryptoBalance: '1'},
        {timestamp: 2000, cryptoBalance: '2'},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '2',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 2000,
      },
    });
    await store.appendChunk({
      meta,
      snapshots: [{timestamp: 3000, cryptoBalance: '3'}],
      checkpoint: {
        nextSkip: 3,
        balanceAtomic: '3',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: 3000,
      },
    });

    const iterator = store.iterateSnapshots({
      walletId: 'w-snap-iter',
      fromExclusive: 1000,
      toInclusive: 3000,
    }) as any;

    expect(iterator[Symbol.asyncIterator]).toBeUndefined();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {timestamp: 2000, cryptoBalance: '2'},
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {timestamp: 3000, cryptoBalance: '3'},
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
