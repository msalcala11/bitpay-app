import {
  computeWorkletAnalysis,
  computeWorkletAnalysisChart,
  computeWorkletAssetRows,
} from './portfolioWorkletAnalysis';
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


  it('returns compact placeholder asset rows without warming rates when snapshots are unavailable', async () => {
    const storage = createStorage();
    const config = {storage, registryKey: '__registry__'};
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;
    const wallet = createStoredWallet();
    wallet.summary.balanceAtomic = '100000000';
    wallet.summary.balanceFormatted = '1';

    const result = await computeWorkletAssetRows(config, {
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      wallets: [wallet],
      quoteCurrency: 'USD',
      timeframe: '1D',
      maxPoints: 91,
      collapseAcrossChains: true,
    });

    expect(result).toMatchObject({
      quoteCurrency: 'USD',
      timeframe: '1D',
      rows: [
        {
          key: 'btc',
          assetId: 'btc:btc',
          currencyAbbreviation: 'btc',
          balanceAtomic: '100000000',
          cryptoAmount: '1',
          fiatValue: 0,
          deltaFiatValue: 0,
          displayPercentRatio: null,
          pnlPercentRatio: null,
          pricePercentRatio: null,
          hasRate: false,
          hasPnl: false,
          hasActivityInWindow: false,
          showPnlPlaceholder: true,
          isPositive: true,
          sortValueFiat: 0,
        },
      ],
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
});
