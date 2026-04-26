import {
  appendWorkletSnapshotChunk,
  ensureWorkletWalletIndex,
  loadWorkletSnapshotIndex,
  updateWorkletSnapshotCheckpoint,
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

const makeMeta = () => ({
  walletId: 'w-worklet-revision',
  chain: 'eth',
  network: 'livenet',
  currencyAbbreviation: 'eth',
  quoteCurrency: 'usd',
  compressionEnabled: true,
  chunkRows: 500,
  snapshotDebugMode: 'none' as const,
});

const checkpoint = {
  nextSkip: 1,
  balanceAtomic: '1',
  remainingCostBasisFiat: 0,
  lastMarkRate: 0,
  lastTimestamp: 1000,
};

describe('portfolioWorkletSnapshots', () => {
  it('normalizes legacy worklet indexes without revision to revision 1', async () => {
    const storage = createStorage();
    storage.set(
      'snap:index:v2:w-legacy-worklet-index',
      JSON.stringify({
        v: 2,
        walletId: 'w-legacy-worklet-index',
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

    await expect(
      loadWorkletSnapshotIndex(
        {storage, registryKey: '__registry__'},
        'w-legacy-worklet-index',
      ),
    ).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('increments worklet snapshot index revision on each index save', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const meta = makeMeta();

    const created = await ensureWorkletWalletIndex(config, meta);
    expect(created.revision).toBe(1);

    const checkpointOnly = await updateWorkletSnapshotCheckpoint({
      ...config,
      walletId: meta.walletId,
      checkpoint,
    });
    expect(checkpointOnly.revision).toBe(2);

    const withChunk = await appendWorkletSnapshotChunk({
      ...config,
      meta,
      snapshots: [{timestamp: 1000, cryptoBalance: '1'}],
      checkpoint,
    });
    expect(withChunk.revision).toBe(3);

    await expect(
      loadWorkletSnapshotIndex(config, meta.walletId),
    ).resolves.toMatchObject({
      revision: 3,
      chunks: [{id: 1}],
    });
  });
});
