import {stringifyStoredFiatRateSeries} from '../../core/pnl/storedFiatRateSeries';
import {
  createPortfolioV2RateReader,
  getRateKey,
  getRateSourceKey,
  readPortfolioV2RateSeries,
  readPortfolioV2RateSeriesOnWorklet,
} from './ratesKv';

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

const ethAllRequest = {
  quoteCurrency: 'USD',
  asset: {coin: 'ETH'},
  storedInterval: 'ALL' as const,
};

const series = {
  fetchedOn: 123,
  points: [
    {ts: 10, rate: 100},
    {ts: 20, rate: 125},
  ],
};

describe('portfolio v2 rate kv readers', () => {
  it('builds normalized rate keys and source keys', () => {
    expect(
      getRateKey({
        quoteCurrency: 'usd',
        asset: {coin: 'USDC', chain: 'ETH', tokenAddress: '0xABC'},
        storedInterval: 'ALL',
      }),
    ).toBe('rate:v1:USD:usdc:ALL:eth:0xabc');
    expect(
      getRateSourceKey({
        coin: 'USDC',
        chain: 'ETH',
        tokenAddress: '0xABC',
      }),
    ).toBe('usdc:eth:0xabc');
  });

  it('rejects display intervals before they can become persisted rate keys', () => {
    expect(() =>
      getRateKey({
        quoteCurrency: 'USD',
        asset: {coin: 'btc'},
        storedInterval: '1Y' as any,
      }),
    ).toThrow(/must be resolved to a stored interval/);
  });

  it('reads stored rate series through the v2-owned async reader', async () => {
    const store = new MemoryStringStore();
    const key = getRateKey(ethAllRequest);
    store.data.set(key, stringifyStoredFiatRateSeries(series));

    await expect(
      readPortfolioV2RateSeries({
        store,
        ...ethAllRequest,
      }),
    ).resolves.toEqual(series);

    await expect(
      createPortfolioV2RateReader(store).loadSeries(ethAllRequest),
    ).resolves.toEqual(series);
  });

  it('returns null for missing or malformed stored rate series', async () => {
    const store = new MemoryStringStore();
    await expect(
      readPortfolioV2RateSeries({
        store,
        ...ethAllRequest,
      }),
    ).resolves.toBeNull();

    store.data.set(getRateKey(ethAllRequest), '{"v":3,"p":[]}');
    await expect(
      readPortfolioV2RateSeries({
        store,
        ...ethAllRequest,
      }),
    ).resolves.toBeNull();
  });

  it('exposes a worklet-compatible v2 rate reader for retained worklet callers', async () => {
    const storage = new WorkletMemoryStorage();
    storage.set(
      getRateKey(ethAllRequest),
      stringifyStoredFiatRateSeries(series),
    );

    await expect(
      readPortfolioV2RateSeriesOnWorklet({storage}, ethAllRequest),
    ).resolves.toEqual(series);
  });
});
