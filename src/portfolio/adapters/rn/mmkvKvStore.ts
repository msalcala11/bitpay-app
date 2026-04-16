import type {NativeMMKV} from 'react-native-mmkv';

import type {KvStore} from '../../core/kv/types';

export type WorkletMmkvStorageBridge = Pick<
  NativeMMKV,
  'contains' | 'delete' | 'getString' | 'set'
>;

export const DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY =
  '__bitpay.portfolio.engine.registry.v1__';

type StoredKeyRegistryV1 = {
  v: 1;
  keys: string[];
};

type MmkvKvStoreStats = {
  totalKeys: number;
  totalBytes: number;
  snapKeys: number;
  snapBytes: number;
  rateKeys: number;
  rateBytes: number;
  otherKeys: number;
  otherBytes: number;
};

function normalizeKeys(keys: Iterable<string>, registryKey: string): string[] {
  return Array.from(
    new Set(
      Array.from(keys)
        .map(key => String(key || '').trim())
        .filter(Boolean)
        .filter(key => key !== registryKey),
    ),
  ).sort();
}

function encodeRegistry(keys: string[], registryKey: string): string {
  const payload: StoredKeyRegistryV1 = {
    v: 1,
    keys: normalizeKeys(keys, registryKey),
  };
  return JSON.stringify(payload);
}

function decodeRegistry(raw: string | undefined | null, registryKey: string): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredKeyRegistryV1> | string[];
    if (Array.isArray(parsed)) {
      return normalizeKeys(parsed, registryKey);
    }
    if (parsed?.v === 1 && Array.isArray(parsed.keys)) {
      return normalizeKeys(parsed.keys, registryKey);
    }
  } catch {
    // Ignore corrupted registry data and rebuild as new keys are written.
  }

  return [];
}

class PortfolioMmkvKeyRegistry {
  private storage: WorkletMmkvStorageBridge;
  private registryKey: string;
  private cachedKeys: string[] | null = null;
  private cachedRegistryRaw: string | null = null;

  constructor(storage: WorkletMmkvStorageBridge, registryKey: string) {
    this.storage = storage;
    this.registryKey = registryKey;
  }

  getKey(): string {
    return this.registryKey;
  }

  listKeys(prefix?: string): string[] {
    const keys = this.loadKeys();
    if (!prefix) {
      return [...keys];
    }
    return keys.filter(key => key.startsWith(prefix));
  }

  trackKey(key: string): void {
    if (!key || key === this.registryKey) {
      return;
    }

    const keys = this.loadKeys();
    if (keys.includes(key)) {
      return;
    }

    keys.push(key);
    this.persistKeys(keys);
  }

  untrackKey(key: string): void {
    if (!key || key === this.registryKey) {
      return;
    }

    const keys = this.loadKeys();
    if (!keys.includes(key)) {
      return;
    }

    this.persistKeys(keys.filter(existing => existing !== key));
  }

  clearTrackedKeys(): void {
    for (const key of this.loadKeys()) {
      this.storage.delete(key);
    }
    this.storage.delete(this.registryKey);
    this.cachedKeys = [];
    this.cachedRegistryRaw = null;
  }

  getRegistryBytes(): number {
    const raw = this.storage.getString(this.registryKey);
    return raw ? raw.length : 0;
  }

  private loadKeys(): string[] {
    const raw = this.storage.getString(this.registryKey) ?? null;

    if (this.cachedKeys && raw === this.cachedRegistryRaw) {
      return [...this.cachedKeys];
    }

    this.cachedKeys = decodeRegistry(raw, this.registryKey);
    this.cachedRegistryRaw = raw;
    return [...this.cachedKeys];
  }

  private persistKeys(keys: string[]): void {
    const normalized = normalizeKeys(keys, this.registryKey);
    this.cachedKeys = normalized;

    if (!normalized.length) {
      this.storage.delete(this.registryKey);
      this.cachedRegistryRaw = null;
      return;
    }

    const encoded = encodeRegistry(normalized, this.registryKey);
    this.storage.set(this.registryKey, encoded);
    this.cachedRegistryRaw = encoded;
  }
}

export class MmkvKvStore implements KvStore {
  private storage: WorkletMmkvStorageBridge;
  private registry: PortfolioMmkvKeyRegistry;
  readonly storageId?: string;

  constructor(
    storage: WorkletMmkvStorageBridge,
    opts?: {registryKey?: string; storageId?: string},
  ) {
    this.storage = storage;
    this.registry = new PortfolioMmkvKeyRegistry(
      storage,
      opts?.registryKey ?? DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY,
    );
    this.storageId = opts?.storageId;
  }

  async getString(key: string): Promise<string | null> {
    const value = this.storage.getString(key);
    return value == null ? null : value;
  }

  async setString(key: string, value: string): Promise<void> {
    if (key === this.registry.getKey()) {
      throw new Error(
        `${this.registry.getKey()} is reserved for the portfolio MMKV key registry.`,
      );
    }

    this.storage.set(key, value);
    this.registry.trackKey(key);
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
    this.registry.untrackKey(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return this.registry.listKeys(prefix);
  }

  async clearAll(): Promise<void> {
    this.registry.clearTrackedKeys();
  }

  /**
   * Fast-path storage stats consumed by PortfolioEngine.getKvStats().
   *
   * The registry key is intentionally hidden from listKeys() but counted here so
   * total bytes more closely reflect the dedicated MMKV instance footprint.
   */
  async stats(): Promise<MmkvKvStoreStats> {
    const keys = await this.listKeys();
    const out: MmkvKvStoreStats = {
      totalKeys: keys.length,
      totalBytes: 0,
      snapKeys: 0,
      snapBytes: 0,
      rateKeys: 0,
      rateBytes: 0,
      otherKeys: 0,
      otherBytes: 0,
    };

    for (const key of keys) {
      const raw = this.storage.getString(key);
      const bytes = raw ? raw.length : 0;
      out.totalBytes += bytes;

      if (key.startsWith('snap:')) {
        out.snapKeys += 1;
        out.snapBytes += bytes;
      } else if (key.startsWith('rate:')) {
        out.rateKeys += 1;
        out.rateBytes += bytes;
      } else {
        out.otherKeys += 1;
        out.otherBytes += bytes;
      }
    }

    const registryBytes = this.registry.getRegistryBytes();
    if (registryBytes > 0) {
      out.totalKeys += 1;
      out.totalBytes += registryBytes;
      out.otherKeys += 1;
      out.otherBytes += registryBytes;
    }

    return out;
  }
}
