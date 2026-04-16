import {handlePortfolioRequestOnRuntime} from './portfolioRequestWorklet';
import {
  appendWorkletSnapshotChunk,
  buildWorkletWalletMetaForStore,
  ensureWorkletWalletIndex,
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
});
