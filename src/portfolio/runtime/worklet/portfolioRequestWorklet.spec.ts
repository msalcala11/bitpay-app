import {handlePortfolioRequestOnRuntime} from './portfolioRequestWorklet';
import {
  appendWorkletSnapshotChunk,
  buildWorkletWalletMetaForStore,
  ensureWorkletWalletIndex,
  listWorkletSnapshots,
} from './portfolioWorkletSnapshots';

type FakeStorage = {
  contains: (key: string) => boolean;
  delete: (key: string) => void;
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
};

const createStorage = (): FakeStorage => {
  const map = new Map<string, string>();
  return {
    contains: key => map.has(key),
    delete: key => {
      map.delete(key);
    },
    getString: key => map.get(key),
    set: (key, value) => {
      map.set(key, String(value));
    },
  };
};

describe('portfolioRequestWorklet', () => {
  it('handles snapshot reads and storage clearing without the class host', async () => {
    const storage = createStorage();
    const config = {
      storage,
      storageId: 'test',
      registryKey: '__registry__',
    };

    const meta = buildWorkletWalletMetaForStore({
      wallet: {
        walletId: 'w1',
        walletName: 'Wallet 1',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w1',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      },
      quoteCurrency: 'USD',
      compressionEnabled: true,
      chunkRows: 100,
      snapshotDebugMode: 'none',
    });

    await ensureWorkletWalletIndex(
      {storage, registryKey: '__registry__'},
      meta,
    );
    await appendWorkletSnapshotChunk({
      storage,
      registryKey: '__registry__',
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

    const indexResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 1,
      method: 'snapshots.getIndex',
      params: {walletId: 'w1'},
    });

    expect(indexResponse.ok).toBe(true);
    if (!indexResponse.ok) {
      return;
    }
    expect(indexResponse.result?.walletId).toBe('w1');

    const clearResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 2,
      method: 'debug.clearAll',
      params: {},
    });
    expect(clearResponse.ok).toBe(true);

    const statsResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 3,
      method: 'debug.kvStats',
      params: {},
    });
    expect(statsResponse.ok).toBe(true);
    if (!statsResponse.ok) {
      return;
    }
    expect(statsResponse.result.totalKeys).toBe(0);
  });

  it('sorts out-of-order worklet snapshots before persisting debug rows', async () => {
    const storage = createStorage();
    const config = {
      storage,
      storageId: 'test',
      registryKey: '__registry__',
    };

    const meta = buildWorkletWalletMetaForStore({
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
      },
      quoteCurrency: 'USD',
      compressionEnabled: true,
      chunkRows: 100,
      snapshotDebugMode: 'full',
    });

    await ensureWorkletWalletIndex(
      {storage, registryKey: '__registry__'},
      meta,
    );
    await appendWorkletSnapshotChunk({
      storage,
      registryKey: '__registry__',
      meta,
      snapshots: [
        {
          id: 'daily:w2:2024-01-02',
          timestamp: 2000,
          eventType: 'daily',
          cryptoBalance: '2',
          txIds: ['b'],
          remainingCostBasisFiat: 2000,
          markRate: 2000,
          createdAt: 2,
        },
        {
          id: 'tx:w2:a',
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

    expect(JSON.parse(storage.getString('snap:chunk:v2:w2:1') || 'null')).toEqual({
      v: 2,
      rows: [
        [1000, '1'],
        [2000, '2'],
      ],
      debug: {
        mode: 'full',
        idByRow: ['tx:w2:a', 'daily:w2:2024-01-02'],
        eventTypeByRow: [0, 1],
        txIdsByRow: [['a'], ['b']],
        markRateByRow: [1000, 2000],
        remainingCostBasisFiatByRow: [1000, 2000],
        createdAtByRow: [1, 2],
      },
    });

    await expect(
      listWorkletSnapshots({storage, registryKey: '__registry__'}, 'w2'),
    ).resolves.toMatchObject([
      {
        id: 'tx:w2:a',
        timestamp: 1000,
        eventType: 'tx',
        txIds: ['a'],
        markRate: 1000,
        remainingCostBasisFiat: 1000,
        createdAt: 1,
      },
      {
        id: 'daily:w2:2024-01-02',
        timestamp: 2000,
        eventType: 'daily',
        txIds: ['b'],
        markRate: 2000,
        remainingCostBasisFiat: 2000,
        createdAt: 2,
      },
    ]);
  });
});
