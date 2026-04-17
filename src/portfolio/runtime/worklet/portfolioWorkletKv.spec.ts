import {
  workletKvClearAll,
  workletKvDelete,
  workletKvGetString,
  workletKvListKeys,
  workletKvSetString,
} from './portfolioWorkletKv';

describe('portfolioWorkletKv', () => {
  const createStorage = () => {
    const map = new Map<string, string>();
    return {
      contains: (key: string) => map.has(key),
      delete: (key: string) => {
        map.delete(key);
      },
      getString: (key: string) => map.get(key),
      set: (key: string, value: string) => {
        map.set(key, value);
      },
    };
  };

  it('tracks keys in the registry and removes them on delete', () => {
    const storage = createStorage();
    const config = {
      storage,
      registryKey: '__test_registry__',
    };

    workletKvSetString(config, 'snap:index:v2:wallet-1', '{}');
    workletKvSetString(config, 'rate:v1:USD:btc:1D', '{}');

    expect(workletKvGetString(config, 'snap:index:v2:wallet-1')).toBe('{}');
    expect(workletKvListKeys(config)).toEqual([
      'rate:v1:USD:btc:1D',
      'snap:index:v2:wallet-1',
    ]);

    workletKvDelete(config, 'snap:index:v2:wallet-1');

    expect(workletKvListKeys(config)).toEqual(['rate:v1:USD:btc:1D']);
  });

  it('clears tracked keys and the registry', () => {
    const storage = createStorage();
    const config = {
      storage,
      registryKey: '__test_registry__',
    };

    workletKvSetString(config, 'snap:index:v2:wallet-1', '{}');
    workletKvSetString(config, 'snap:chunk:v2:wallet-1:1', '{}');

    workletKvClearAll(config);

    expect(workletKvListKeys(config)).toEqual([]);
    expect(storage.getString('__test_registry__')).toBeUndefined();
  });
});
