import {ensureWorkletSnapshotRateSeriesCache} from './portfolioWorkletRates';

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

describe('portfolioWorkletRates', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses the default fiat-rate endpoint for native-coin wallet snapshots', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          bch: [
            {ts: 1, rate: 100},
            {ts: 2, rate: 120},
          ],
        }),
    });
    global.fetch = fetchMock as typeof global.fetch;

    await ensureWorkletSnapshotRateSeriesCache({
      storage: createStorage(),
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      wallet: {
        walletId: 'w1',
        walletName: 'BCH Wallet',
        chain: 'bch',
        network: 'livenet',
        currencyAbbreviation: 'bch',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bws.bitpay.com/bws/api/v4/fiatrates/USD?days=1',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('uses explicit chain and tokenAddress params for token wallet snapshots', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify([
          {ts: 1, rate: 1},
          {ts: 2, rate: 1.01},
        ]),
    });
    global.fetch = fetchMock as typeof global.fetch;

    await ensureWorkletSnapshotRateSeriesCache({
      storage: createStorage(),
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      wallet: {
        walletId: 'w2',
        walletName: 'USDC Wallet',
        chain: 'arb',
        network: 'livenet',
        currencyAbbreviation: 'usdc',
        tokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bws.bitpay.com/bws/api/v4/fiatrates/USD?days=1&chain=arb&tokenAddress=0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });
});
