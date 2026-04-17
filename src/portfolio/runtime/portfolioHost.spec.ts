import {MmkvKvStore, type WorkletMmkvStorageBridge} from '../adapters/rn/mmkvKvStore';
import {
  PortfolioRuntimeHost,
  resetPortfolioRuntimeHostSingleton,
} from './portfolioHost';

class FakeMmkvStorageBridge implements WorkletMmkvStorageBridge {
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

describe('PortfolioRuntimeHost', () => {
  afterEach(() => {
    resetPortfolioRuntimeHostSingleton();
  });

  it('routes storage-backed debug helpers through the MMKV KV adapter', async () => {
    const storage = new FakeMmkvStorageBridge();
    const registryKey = '__portfolio_runtime_registry__';
    const preloadKv = new MmkvKvStore(storage, {registryKey});

    await preloadKv.setString('snap:index:v2:w1', 'index');
    await preloadKv.setString('rate:v1:USD:btc:1D', 'rates');

    const host = new PortfolioRuntimeHost({
      storage,
      storageId: 'test-host-storage',
      registryKey,
    });

    const stats = await host.handle({
      id: 1,
      method: 'debug.kvStats',
      params: {},
    } as any);

    expect(stats).toMatchObject({
      id: 1,
      ok: true,
    });
    expect((stats as any).result).toMatchObject({
      totalKeys: 3,
      snapKeys: 1,
      rateKeys: 1,
      otherKeys: 1,
    });

    const cleared = await host.handle({
      id: 2,
      method: 'debug.clearAll',
      params: {},
    } as any);

    expect(cleared).toEqual({
      id: 2,
      ok: true,
      result: undefined,
    });
    await expect(preloadKv.listKeys()).resolves.toEqual([]);
    expect(storage.contains(registryKey)).toBe(false);
  });

  it('returns structured worker errors instead of throwing for unknown methods', async () => {
    const host = new PortfolioRuntimeHost({
      storage: new FakeMmkvStorageBridge(),
      storageId: 'test-host-storage',
      registryKey: '__portfolio_runtime_registry__',
    });

    const response = await host.handle({
      id: 99,
      method: 'not-a-real-method',
      params: {},
    } as any);

    expect(response.id).toBe(99);
    expect(response.ok).toBe(false);
    expect((response as any).error).toContain('Unknown method');
  });
});
