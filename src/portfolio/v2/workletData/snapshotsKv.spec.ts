import type {
  SnapshotChunkV2,
  SnapshotIndexV2,
  SnapshotWalletMetaV2,
} from '../../core/pnl/snapshotStore';
import {
  createPortfolioV2SnapshotReader,
  getSnapshotChunkKey,
  getSnapshotIndexKey,
  getSnapshotMetaKey,
  readPortfolioV2SnapshotChunkOnWorklet,
  readPortfolioV2SnapshotIndex,
  readPortfolioV2SnapshotIndexOnWorklet,
} from './snapshotsKv';

class MemoryStringStore {
  readonly data = new Map<string, string>();

  async getString(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
}

class WorkletMemoryStorage {
  readonly data = new Map<string, string>();

  contains(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const checkpoint = {
  nextSkip: 0,
  balanceAtomic: '0',
  remainingCostBasisFiat: 0,
  lastMarkRate: 0,
  lastTimestamp: 0,
};

function makeIndex(overrides: Partial<SnapshotIndexV2> = {}): SnapshotIndexV2 {
  return {
    v: 2,
    walletId: 'wallet-1',
    revision: 0,
    compressionEnabled: false,
    chunkRows: 2,
    chunks: [
      {
        id: 1,
        fromTs: 10,
        toTs: 20,
        rows: 2,
        debugMode: 'none',
      },
    ],
    checkpoint,
    updatedAt: 123,
    ...overrides,
  };
}

const meta: SnapshotWalletMetaV2 = {
  walletId: 'wallet-1',
  chain: 'eth',
  network: 'livenet',
  coin: 'eth',
  assetId: 'eth:eth',
  quoteCurrency: 'USD',
  snapshotDebugMode: 'none',
};

const chunk: SnapshotChunkV2 = {
  v: 2,
  rows: [
    [10, '1'],
    [20, '2'],
  ],
};

describe('portfolio v2 snapshot kv readers', () => {
  it('builds the v2 snapshot storage keys', () => {
    expect(getSnapshotMetaKey('wallet-1')).toBe('snap:meta:v2:wallet-1');
    expect(getSnapshotIndexKey('wallet-1')).toBe('snap:index:v2:wallet-1');
    expect(getSnapshotChunkKey({walletId: 'wallet-1', chunkId: 3})).toBe(
      'snap:chunk:v2:wallet-1:3',
    );
  });

  it('requires explicit chunk ids for snapshot chunk keys', () => {
    expect(() => getSnapshotChunkKey({walletId: 'wallet-1'} as any)).toThrow(
      /chunkId is required/,
    );
  });

  it('reads meta, index, and chunks through the v2-owned async reader', async () => {
    const store = new MemoryStringStore();
    store.data.set(getSnapshotMetaKey('wallet-1'), JSON.stringify(meta));
    store.data.set(
      getSnapshotIndexKey('wallet-1'),
      JSON.stringify(makeIndex()),
    );
    store.data.set(
      getSnapshotChunkKey({walletId: 'wallet-1', chunkId: 1}),
      JSON.stringify(chunk),
    );

    const reader = createPortfolioV2SnapshotReader(store);

    await expect(reader.loadMeta('wallet-1')).resolves.toEqual(meta);
    await expect(reader.loadIndex('wallet-1')).resolves.toEqual(
      makeIndex({revision: 1}),
    );
    await expect(
      reader.loadChunk({walletId: 'wallet-1', chunkId: 1}),
    ).resolves.toEqual(chunk);
  });

  it('returns null for mismatched or malformed snapshot payloads', async () => {
    const store = new MemoryStringStore();
    store.data.set(
      getSnapshotIndexKey('wallet-1'),
      JSON.stringify(makeIndex({walletId: 'other-wallet'})),
    );

    await expect(
      readPortfolioV2SnapshotIndex({store, walletId: 'wallet-1'}),
    ).resolves.toBeNull();

    store.data.set(getSnapshotIndexKey('wallet-1'), JSON.stringify({v: 1}));
    await expect(
      readPortfolioV2SnapshotIndex({store, walletId: 'wallet-1'}),
    ).resolves.toBeNull();
  });

  it('exposes worklet-compatible v2 snapshot readers for retained worklet callers', async () => {
    const storage = new WorkletMemoryStorage();
    storage.set(getSnapshotIndexKey('wallet-1'), JSON.stringify(makeIndex()));
    storage.set(
      getSnapshotChunkKey({walletId: 'wallet-1', chunkId: 1}),
      JSON.stringify(chunk),
    );

    await expect(
      readPortfolioV2SnapshotIndexOnWorklet({storage}, 'wallet-1'),
    ).resolves.toEqual(makeIndex({revision: 1}));
    await expect(
      readPortfolioV2SnapshotChunkOnWorklet(
        {storage},
        {walletId: 'wallet-1', chunkId: 1},
      ),
    ).resolves.toEqual(chunk);
  });
});
