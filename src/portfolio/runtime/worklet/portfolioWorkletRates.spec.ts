import {
  ensureWorkletRates,
  ensureWorkletSnapshotRateSeriesCache,
  parseWorkletStoredFiatRateSeries,
} from './portfolioWorkletRates';

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

  it('stores compact persisted series with fetchedOn metadata and reloads them', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(321);
    const storage = createStorage();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          bch: [
            {ts: 2, rate: 120},
            {ts: 1, rate: 100},
          ],
        }),
    });
    global.fetch = fetchMock as typeof global.fetch;

    const cache = await ensureWorkletSnapshotRateSeriesCache({
      storage,
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      wallet: {
        walletId: 'w-fetched-on',
        walletName: 'BCH Wallet',
        chain: 'bch',
        network: 'livenet',
        currencyAbbreviation: 'bch',
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
    });

    const raw = storage.getString('rate:v1:USD:bch:1D');
    expect(raw).toBe('{"v":3,"f":321,"p":[[1,100],[2,120]]}');
    expect(parseWorkletStoredFiatRateSeries(raw ?? null)).toEqual({
      fetchedOn: 321,
      points: [
        {ts: 1, rate: 100},
        {ts: 2, rate: 120},
      ],
    });
    expect(cache['USD:bch:1D']).toEqual({
      fetchedOn: 321,
      points: [
        {ts: 1, rate: 100},
        {ts: 2, rate: 120},
      ],
    });
  });

  it('refreshes legacy compact series without fetchedOn metadata on ensureWorkletRates', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(654);
    const storage = createStorage();
    storage.set('rate:v1:USD:btc:1D', '{"v":2,"p":[[2,200],[1,100]]}');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          btc: [
            {ts: 2, rate: 200},
            {ts: 1, rate: 100},
          ],
        }),
    });
    global.fetch = fetchMock as typeof global.fetch;

    await ensureWorkletRates({
      storage,
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: ['btc'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.getString('rate:v1:USD:btc:1D')).toBe(
      '{"v":3,"f":654,"p":[[1,100],[2,200]]}',
    );
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

  it('preserves Solana token address case for token wallet snapshot requests', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify([
          {ts: 1, rate: 1},
          {ts: 2, rate: 1.01},
        ]),
    });
    global.fetch = fetchMock as typeof global.fetch;
    const tokenAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    await ensureWorkletSnapshotRateSeriesCache({
      storage: createStorage(),
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      wallet: {
        walletId: 'w-sol',
        walletName: 'USDC SOL Wallet',
        chain: 'sol',
        network: 'livenet',
        currencyAbbreviation: 'usdc',
        tokenAddress,
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://bws.bitpay.com/bws/api/v4/fiatrates/USD?days=1&chain=sol&tokenAddress=${tokenAddress}`,
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('continues fetching later intervals for a token when earlier rate requests fail', async () => {
    const tokenAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('days=1') || url.includes('days=7')) {
        throw new Error('token rate unavailable');
      }

      return {
        ok: true,
        text: async () =>
          JSON.stringify([
            {ts: 1, rate: 1},
            {ts: 2, rate: 1.01},
          ]),
      };
    });
    global.fetch = fetchMock as typeof global.fetch;

    const cache = await ensureWorkletSnapshotRateSeriesCache({
      storage: createStorage(),
      registryKey: '__registry__',
      cfg: {baseUrl: 'https://bws.bitpay.com/bws/api'},
      quoteCurrency: 'USD',
      wallet: {
        walletId: 'w-sol-retry',
        walletName: 'USDC SOL Wallet',
        chain: 'sol',
        network: 'livenet',
        currencyAbbreviation: 'usdc',
        tokenAddress,
        balanceAtomic: '0',
        balanceFormatted: '0',
      },
    });

    expect(Object.keys(cache)).toContain(`USD:usdc:1M:sol:${tokenAddress}`);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).includes('days=30')),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).includes('days=7')),
    ).toBe(true);
  });

  it('aliases the legacy ethereum matic token to native POL rates', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          pol: [
            {ts: 1, rate: 0.9},
            {ts: 2, rate: 1.1},
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
        walletId: 'w3',
        walletName: 'Legacy Matic Token',
        chain: 'eth',
        network: 'livenet',
        currencyAbbreviation: 'matic',
        tokenAddress: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
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
    expect(
      fetchMock.mock.calls.some(call =>
        String(call[0]).includes(
          'tokenAddress=0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
        ),
      ),
    ).toBe(false);
  });
});
