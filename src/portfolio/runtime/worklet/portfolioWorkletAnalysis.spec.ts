import {
  computeWorkletAnalysis,
  computeWorkletAnalysisChart,
} from './portfolioWorkletAnalysis';
import {
  appendWorkletSnapshotChunk,
  buildWorkletWalletMetaForStore,
} from './portfolioWorkletSnapshots';
import {workletKvListKeys} from './portfolioWorkletKv';

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

const createStoredWallet = () =>
  ({
    walletId: 'w1',
    addedAt: 1,
    summary: {
      walletId: 'w1',
      walletName: 'BTC Wallet',
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
  }) as any;

const createStoredTokenWallet = () =>
  ({
    walletId: 'w2',
    addedAt: 2,
    summary: {
      walletId: 'w2',
      walletName: 'Token Wallet',
      chain: 'eth',
      network: 'livenet',
      currencyAbbreviation: 'usdc',
      tokenAddress: '0xmissing',
      balanceAtomic: '0',
      balanceFormatted: '0',
    },
    credentials: {
      walletId: 'w2',
      chain: 'eth',
      network: 'livenet',
      coin: 'usdc',
      token: {
        address: '0xmissing',
        symbol: 'usdc',
      },
    },
  }) as any;

const makeJsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as any;

describe('portfolioWorkletAnalysis', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('does not warm rate cache for analysis when no wallets have stored snapshots', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;

    const result = await computeWorkletAnalysis(config, {
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      wallets: [createStoredWallet()],
      quoteCurrency: 'USD',
      timeframe: '1D',
      maxPoints: 2,
    });

    expect(result).toMatchObject({
      quoteCurrency: 'USD',
      assetIds: [],
      coins: [],
      points: [],
      assetSummaries: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workletKvListKeys(config)).toEqual([]);
  });

  it('does not warm rate cache for chart analysis when no wallets have stored snapshots', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;

    const result = await computeWorkletAnalysisChart(config, {
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      wallets: [createStoredWallet()],
      quoteCurrency: 'USD',
      timeframe: 'ALL',
      maxPoints: 2,
    });

    expect(result).toMatchObject({
      quoteCurrency: 'USD',
      assetIds: [],
      coins: [],
      timestamps: [],
      totalFiatBalance: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workletKvListKeys(config)).toEqual([]);
  });

  it('filters out only assets whose requested rate series are missing', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const btcWallet = createStoredWallet();
    const tokenWallet = createStoredTokenWallet();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const appendWalletSnapshots = async (
      wallet: ReturnType<typeof createStoredWallet>,
      snapshots: Array<{timestamp: number; cryptoBalance: string}>,
    ) => {
      const meta = buildWorkletWalletMetaForStore({
        wallet: wallet.summary,
        credentials: wallet.credentials,
        quoteCurrency: 'USD',
        compressionEnabled: false,
        chunkRows: 128,
      });
      await appendWorkletSnapshotChunk({
        ...config,
        meta,
        snapshots,
        checkpoint: {
          nextSkip: snapshots.length,
          balanceAtomic: snapshots[snapshots.length - 1]?.cryptoBalance ?? '0',
          remainingCostBasisFiat: 0,
          lastMarkRate: 0,
          lastTimestamp: snapshots[snapshots.length - 1]?.timestamp ?? 0,
          firstNonZeroTs: snapshots[0]?.timestamp ?? 0,
        },
      });
    };

    await appendWalletSnapshots(btcWallet, [
      {timestamp: t0, cryptoBalance: '100000000'},
      {timestamp: t1, cryptoBalance: '200000000'},
    ]);
    await appendWalletSnapshots(tokenWallet, [
      {timestamp: t0, cryptoBalance: '1000000'},
      {timestamp: t1, cryptoBalance: '2000000'},
    ]);

    const fetchMock = jest.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('tokenAddress=0xmissing')) {
        return makeJsonResponse({});
      }
      return makeJsonResponse({
        btc: [
          {ts: t0, rate: 10000},
          {ts: t1, rate: 11000},
        ],
      });
    });
    global.fetch = fetchMock as typeof global.fetch;

    const result = await computeWorkletAnalysis(config, {
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      wallets: [btcWallet, tokenWallet],
      quoteCurrency: 'USD',
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 5,
    });

    expect(result.wallets.map(wallet => wallet.walletId)).toEqual(['w1']);
    expect(result.assetIds).toEqual(['btc:btc']);
    expect(result.assetSummaries).toHaveLength(1);
    expect(result.assetSummaries[0]?.coin).toBe('btc');
    expect(result.points).not.toHaveLength(0);
  });

  it('applies current rate overrides to the final streamed worklet analysis point', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const wallet = createStoredWallet();
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    const t1 = Date.parse('2024-01-02T00:00:00Z');

    const meta = buildWorkletWalletMetaForStore({
      wallet: wallet.summary,
      credentials: wallet.credentials,
      quoteCurrency: 'USD',
      compressionEnabled: false,
      chunkRows: 128,
    });
    await appendWorkletSnapshotChunk({
      ...config,
      meta,
      snapshots: [
        {timestamp: t0, cryptoBalance: '100000000'},
        {timestamp: t1, cryptoBalance: '100000000'},
      ],
      checkpoint: {
        nextSkip: 2,
        balanceAtomic: '100000000',
        remainingCostBasisFiat: 0,
        lastMarkRate: 0,
        lastTimestamp: t1,
        firstNonZeroTs: t0,
      },
    });

    const fetchMock = jest.fn(async () =>
      makeJsonResponse({
        btc: [
          {ts: t0, rate: 10000},
          {ts: t1, rate: 11000},
        ],
      }),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const result = await computeWorkletAnalysis(config, {
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      wallets: [wallet],
      quoteCurrency: 'USD',
      timeframe: '1D',
      nowMs: t1,
      maxPoints: 2,
      currentRatesByAssetId: {
        'btc:btc': 15000,
      },
    });

    const last = result.points[result.points.length - 1];

    expect(last?.totalFiatBalance).toBe(15000);
    expect(last?.totalUnrealizedPnlFiat).toBe(5000);
    expect(result.assetSummaries[0]?.rateEnd).toBe(15000);
    expect(result.assetSummaries[0]?.pnlEnd).toBe(5000);
  });
});
