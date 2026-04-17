import {
  DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY,
  type WorkletMmkvStorageBridge,
} from '../../adapters/rn/mmkvKvStore';

export type PortfolioWorkletKvConfig = {
  storage: WorkletMmkvStorageBridge;
  registryKey?: string;
};

type StoredKeyRegistryV1 = {
  v: 1;
  keys: string[];
};

function resolveRegistryKey(registryKey?: string): string {
  'worklet';
  return registryKey || DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY;
}

function normalizeKeys(keys: Iterable<string>, registryKey: string): string[] {
  'worklet';

  const out = new Set<string>();
  for (const key of Array.from(keys)) {
    const normalized = String(key || '').trim();
    if (!normalized || normalized === registryKey) {
      continue;
    }
    out.add(normalized);
  }

  return Array.from(out).sort();
}

function decodeRegistry(raw: string | undefined | null, registryKey: string): string[] {
  'worklet';

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
    // Ignore malformed registry payloads and rebuild as writes occur.
  }

  return [];
}

function encodeRegistry(keys: string[], registryKey: string): string {
  'worklet';

  const payload: StoredKeyRegistryV1 = {
    v: 1,
    keys: normalizeKeys(keys, registryKey),
  };

  return JSON.stringify(payload);
}

function readRegistryKeys(config: PortfolioWorkletKvConfig): string[] {
  'worklet';

  const registryKey = resolveRegistryKey(config.registryKey);
  return decodeRegistry(config.storage.getString(registryKey), registryKey);
}

function writeRegistryKeys(
  config: PortfolioWorkletKvConfig,
  keys: Iterable<string>,
): void {
  'worklet';

  const registryKey = resolveRegistryKey(config.registryKey);
  const normalized = normalizeKeys(keys, registryKey);

  if (!normalized.length) {
    config.storage.delete(registryKey);
    return;
  }

  config.storage.set(registryKey, encodeRegistry(normalized, registryKey));
}

export function workletKvSetString(
  config: PortfolioWorkletKvConfig,
  key: string,
  value: string,
): void {
  'worklet';

  const normalizedKey = String(key || '').trim();
  const registryKey = resolveRegistryKey(config.registryKey);
  if (!normalizedKey) {
    throw new Error('MMKV key is required.');
  }
  if (normalizedKey === registryKey) {
    throw new Error(`${registryKey} is reserved for the portfolio MMKV key registry.`);
  }

  config.storage.set(normalizedKey, value);
  const keys = readRegistryKeys(config);
  if (!keys.includes(normalizedKey)) {
    keys.push(normalizedKey);
    writeRegistryKeys(config, keys);
  }
}

export function workletKvGetString(
  config: PortfolioWorkletKvConfig,
  key: string,
): string | null {
  'worklet';

  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return null;
  }

  const value = config.storage.getString(normalizedKey);
  return value == null ? null : value;
}

export function workletKvDelete(
  config: PortfolioWorkletKvConfig,
  key: string,
): void {
  'worklet';

  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return;
  }

  config.storage.delete(normalizedKey);
  writeRegistryKeys(
    config,
    readRegistryKeys(config).filter(existing => existing !== normalizedKey),
  );
}

export function workletKvListKeys(
  config: PortfolioWorkletKvConfig,
  prefix?: string,
): string[] {
  'worklet';

  const keys = readRegistryKeys(config);
  if (!prefix) {
    return keys;
  }

  return keys.filter(key => key.startsWith(prefix));
}

export function workletKvClearAll(config: PortfolioWorkletKvConfig): void {
  'worklet';

  for (const key of readRegistryKeys(config)) {
    config.storage.delete(key);
  }

  config.storage.delete(resolveRegistryKey(config.registryKey));
}
