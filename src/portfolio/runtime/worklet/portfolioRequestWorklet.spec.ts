import {handlePortfolioRequestOnRuntime} from './portfolioRequestWorklet';
import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
} from '../../adapters/rn/txHistorySigning';
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

type FakeNitroRequest = {
  url: string;
  method?: string;
  headers?: Array<{key: string; value: string}>;
  timeoutMs?: number;
  followRedirects?: boolean;
};

type FakeNitroResponse = {
  ok: boolean;
  status: number;
  bodyString?: string;
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

function installNitroFetchMock(
  handler: (request: FakeNitroRequest) => FakeNitroResponse,
) {
  const requestSync = jest.fn((request: FakeNitroRequest) => handler(request));
  const request = jest.fn(async (requestArgs: FakeNitroRequest) =>
    handler(requestArgs),
  );

  setPortfolioTxHistorySigningDispatchContextOnRuntime({
    nitroFetchClient: {
      request,
      requestSync,
    },
  } as any);

  return requestSync;
}

describe('portfolioRequestWorklet', () => {
  afterEach(() => {
    clearPortfolioTxHistorySigningDispatchContextOnRuntime();
    jest.restoreAllMocks();
  });

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
        token: undefined,
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
    expect((indexResponse.result as any)?.walletId).toBe('w1');

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
    expect((statsResponse.result as any)?.totalKeys).toBe(0);
  });

  it('returns null when no populate wallet trace has been captured yet', async () => {
    const storage = createStorage();
    const config = {
      storage,
      storageId: 'test',
      registryKey: '__registry__',
    };

    const response = await handlePortfolioRequestOnRuntime(config, {
      id: 4,
      method: 'debug.getPopulateWalletTrace',
      params: {walletId: 'missing-wallet'},
    });

    expect(response).toEqual({
      id: 4,
      ok: true,
      result: null,
    });
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
        token: undefined,
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

  it('handles prepared analysis session requests on the worklet runtime', async () => {
    const storage = createStorage();
    const config = {
      storage,
      storageId: 'test',
      registryKey: '__registry__',
    };
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const meta = buildWorkletWalletMetaForStore({
      wallet: {
        walletId: 'w3',
        walletName: 'Wallet 3',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w3',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
        token: undefined,
      },
      quoteCurrency: 'USD',
      compressionEnabled: false,
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

    installNitroFetchMock(() => ({
      ok: true,
      status: 200,
      bodyString: JSON.stringify({
        btc: [
          {ts: t0, rate: 10000},
          {ts: t1, rate: 11000},
        ],
      }),
    }));

    const wallet = {
      walletId: 'w3',
      addedAt: 1,
      summary: {
        walletId: 'w3',
        walletName: 'Wallet 3',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
      credentials: {
        walletId: 'w3',
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      },
    };

    const prepareResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 10,
      method: 'analysis.prepareSession',
      params: {
        cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
        wallets: [wallet],
        quoteCurrency: 'USD',
        timeframe: '1D',
        nowMs: t1,
        maxPoints: 5,
      },
    });

    expect(prepareResponse.ok).toBe(true);
    if (!prepareResponse.ok) {
      return;
    }

    const computeResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 11,
      method: 'analysis.computeSessionScope',
      params: {
        sessionId: (prepareResponse.result as any).sessionId,
        walletIds: ['w3'],
      },
    });

    expect(computeResponse.ok).toBe(true);
    if (!computeResponse.ok) {
      return;
    }
    expect((computeResponse.result as any)?.assetIds).toEqual(['btc:btc']);

    const disposeResponse = await handlePortfolioRequestOnRuntime(config, {
      id: 12,
      method: 'analysis.disposeSession',
      params: {
        sessionId: (prepareResponse.result as any).sessionId,
      },
    });

    expect(disposeResponse).toEqual({
      id: 12,
      ok: true,
      result: undefined,
    });
  });
});
