import type {KvStore} from '../kv/types';
import {FiatRateStore, type FiatRateProvider} from './fiatRateStore';

class MemoryKvStore implements KvStore {
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

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FiatRateStore.ensureRates', () => {
  it('stores series when BWS returns raw point arrays keyed by coin', async () => {
    const provider: FiatRateProvider = {
      loadSeries: jest.fn().mockResolvedValue({
        btc: [
          {ts: 2, rate: 200},
          {ts: 1, rate: 100},
        ],
      }),
    };
    const store = new FiatRateStore(new MemoryKvStore(), {provider});

    await store.ensureRates({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: ['btc'],
    });

    const series = await store.getSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: '1D',
    });

    expect(provider.loadSeries).toHaveBeenCalledTimes(1);
    expect(series?.points).toEqual([
      {ts: 1, rate: 100},
      {ts: 2, rate: 200},
    ]);
  });

  it('canonicalizes long-window storage to ALL', async () => {
    const provider: FiatRateProvider = {
      loadSeries: jest.fn().mockResolvedValue({
        btc: [
          {ts: 2, rate: 200},
          {ts: 1, rate: 100},
        ],
      }),
    };
    const store = new FiatRateStore(new MemoryKvStore(), {provider});

    await store.ensureRates({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '3M',
      coins: ['btc'],
    });

    const series = await store.getSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: '3M',
    });

    expect(provider.loadSeries).toHaveBeenCalledWith({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: 'ALL',
      coins: ['btc'],
    });
    expect(series?.points).toEqual([
      {ts: 1, rate: 100},
      {ts: 2, rate: 200},
    ]);
  });

  it('derives non-canonical quote series via BTC FX bridge', async () => {
    const store = new FiatRateStore(new MemoryKvStore());

    await store.setSeries({
      quoteCurrency: 'USD',
      coin: 'eth',
      interval: 'ALL',
      series: {
        fetchedOn: 1,
        points: [
          {ts: 1, rate: 2000},
          {ts: 2, rate: 2200},
        ],
      },
    });
    await store.setSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: 'ALL',
      series: {
        fetchedOn: 1,
        points: [
          {ts: 1, rate: 40000},
          {ts: 2, rate: 44000},
        ],
      },
    });
    await store.setSeries({
      quoteCurrency: 'EUR',
      coin: 'btc',
      interval: 'ALL',
      series: {
        fetchedOn: 1,
        points: [
          {ts: 1, rate: 36000},
          {ts: 2, rate: 39600},
        ],
      },
    });

    const series = await store.getSeriesWithFx({
      quoteCurrency: 'EUR',
      coin: 'eth',
      interval: 'ALL',
    });

    expect(series?.points).toEqual([
      {ts: 1, rate: 1800},
      {ts: 2, rate: 1980},
    ]);
  });

  it('stores compact persisted series and reloads them without fetchedOn metadata', async () => {
    const kv = new MemoryKvStore();
    const store = new FiatRateStore(kv);

    await store.setSeries({
      quoteCurrency: 'USD',
      coin: 'btc',
      interval: '1D',
      series: {
        fetchedOn: 123,
        points: [
          {ts: 2, rate: 200},
          {ts: 1, rate: 100},
        ],
      },
    });

    await expect(kv.getString('rate:v1:USD:btc:1D')).resolves.toBe('{"v":2,"p":[[1,100],[2,200]]}');

    store.clearMemoryCache();

    await expect(
      store.getSeries({
        quoteCurrency: 'USD',
        coin: 'btc',
        interval: '1D',
      }),
    ).resolves.toEqual({
      fetchedOn: 0,
      points: [
        {ts: 1, rate: 100},
        {ts: 2, rate: 200},
      ],
    });
  });

  it('reads older persisted series objects for backward compatibility', async () => {
    const kv = new MemoryKvStore();
    await kv.setString(
      'rate:v1:USD:btc:1D',
      JSON.stringify({
        fetchedOn: 456,
        points: [
          {ts: 2, rate: 200},
          {ts: 1, rate: 100},
        ],
      }),
    );
    const store = new FiatRateStore(kv);

    await expect(
      store.getSeries({
        quoteCurrency: 'USD',
        coin: 'btc',
        interval: '1D',
      }),
    ).resolves.toEqual({
      fetchedOn: 456,
      points: [
        {ts: 1, rate: 100},
        {ts: 2, rate: 200},
      ],
    });
  });

  it('stores token rates under asset-specific keys and fetches with explicit asset params', async () => {
    const provider: FiatRateProvider = {
      loadSeries: jest.fn().mockResolvedValue({
        usdt: [
          {ts: 1, rate: 1},
          {ts: 2, rate: 1.01},
        ],
      }),
    };
    const store = new FiatRateStore(new MemoryKvStore(), {provider});

    await store.ensureRates({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: [],
      assets: [
        {
          coin: 'usdt',
          chain: 'arb',
          tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        },
      ],
    });

    const series = await store.getSeries({
      quoteCurrency: 'USD',
      coin: 'usdt',
      interval: '1D',
      chain: 'arb',
      tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    });

    expect(provider.loadSeries).toHaveBeenCalledWith({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: ['usdt'],
      asset: {
        coin: 'usdt',
        chain: 'arb',
        tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      },
    });
    expect(series?.points).toEqual([
      {ts: 1, rate: 1},
      {ts: 2, rate: 1.01},
    ]);
  });

  it('accepts token responses returned as a direct point array', async () => {
    const provider: FiatRateProvider = {
      loadSeries: jest.fn().mockResolvedValue([
        {ts: 2, rate: 1.01},
        {ts: 1, rate: 1},
      ]),
    };
    const store = new FiatRateStore(new MemoryKvStore(), {provider});

    await store.ensureRates({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: [],
      assets: [
        {
          coin: 'usdc.e',
          chain: 'arb',
          tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        },
      ],
    });

    const series = await store.getSeries({
      quoteCurrency: 'USD',
      coin: 'usdc.e',
      interval: '1D',
      chain: 'arb',
      tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    });

    expect(series?.points).toEqual([
      {ts: 1, rate: 1},
      {ts: 2, rate: 1.01},
    ]);
  });

  it('accepts token responses with a single unexpected object key', async () => {
    const provider: FiatRateProvider = {
      loadSeries: jest.fn().mockResolvedValue({
        usdc: [
          {ts: 2, rate: 1.01},
          {ts: 1, rate: 1},
        ],
      }),
    };
    const store = new FiatRateStore(new MemoryKvStore(), {provider});

    await store.ensureRates({
      cfg: {baseUrl: '/bws/api'},
      quoteCurrency: 'USD',
      interval: '1D',
      coins: [],
      assets: [
        {
          coin: 'usdc.e',
          chain: 'arb',
          tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        },
      ],
    });

    const series = await store.getSeries({
      quoteCurrency: 'USD',
      coin: 'usdc.e',
      interval: '1D',
      chain: 'arb',
      tokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    });

    expect(series?.points).toEqual([
      {ts: 1, rate: 1},
      {ts: 2, rate: 1.01},
    ]);
  });
});
