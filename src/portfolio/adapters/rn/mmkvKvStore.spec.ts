import {
  MmkvKvStore,
  type WorkletMmkvStorageBridge,
} from './mmkvKvStore';

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

describe('MmkvKvStore', () => {
  it('tracks keys through the registry while hiding the registry from listKeys()', async () => {
    const storage = new FakeMmkvStorageBridge();
    const kv = new MmkvKvStore(storage, {
      registryKey: '__test_registry__',
      storageId: 'test-storage',
    });

    await kv.setString('snap:index:v2:w1', 'index');
    await kv.setString('rate:v1:USD:btc:1D', 'rates');

    await expect(kv.listKeys()).resolves.toEqual([
      'rate:v1:USD:btc:1D',
      'snap:index:v2:w1',
    ]);
    await expect(kv.listKeys('snap:')).resolves.toEqual(['snap:index:v2:w1']);
    expect(storage.contains('__test_registry__')).toBe(true);

    await kv.delete('snap:index:v2:w1');
    await expect(kv.listKeys()).resolves.toEqual(['rate:v1:USD:btc:1D']);
  });

  it('clears tracked data and reports stats including the internal registry entry', async () => {
    const storage = new FakeMmkvStorageBridge();
    const kv = new MmkvKvStore(storage, {
      registryKey: '__test_registry__',
    });

    await kv.setString('snap:meta:v2:w1', 'meta');
    await kv.setString('rate:v1:USD:btc:1D', 'rates');
    await kv.setString('custom:key', 'custom');

    await expect(kv.stats()).resolves.toMatchObject({
      totalKeys: 4,
      snapKeys: 1,
      rateKeys: 1,
      otherKeys: 2,
    });

    await kv.clearAll();
    await expect(kv.listKeys()).resolves.toEqual([]);
    expect(storage.contains('__test_registry__')).toBe(false);
    expect(Array.from(storage.data.keys())).toEqual([]);
  });
});
