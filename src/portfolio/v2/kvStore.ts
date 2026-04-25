import {
  MmkvKvStore,
  type WorkletMmkvStorageBridge,
} from '../adapters/rn/mmkvKvStore';
import {
  getPortfolioMmkvStorageOnRN,
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
} from '../adapters/rn/workletMmkvBridge';
import {
  workletKvDelete,
  workletKvSetString,
  type PortfolioWorkletKvConfig,
} from '../runtime/worklet/portfolioWorkletKv';
import {
  PORTFOLIO_CACHE_INVALID_KEY,
  PORTFOLIO_MMKV_VALUE_WARN_BYTES,
  PORTFOLIO_V2_FLAG_KEY,
  PORTFOLIO_WORK_EPOCH_KEY,
} from './constants';
import {
  approximateStringBytes,
  nowMs,
  recordPortfolioV2Metric,
} from './metrics';
import type {
  PortfolioMmkvPrefixFamily,
  PortfolioMmkvWriteReason,
} from './model';

type RegistryPayloadV1 = {
  v: 1;
  keys: string[];
};

let portfolioKvStore: MmkvKvStore | undefined;

function normalizeKey(key: string): string {
  'worklet';

  const normalized = String(key || '').trim();
  if (!normalized) {
    throw new Error('Portfolio MMKV key is required.');
  }
  return normalized;
}

function localHashKey(key: string): string {
  'worklet';

  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function getPortfolioMmkvPrefixFamily(
  key: string,
): PortfolioMmkvPrefixFamily {
  'worklet';

  if (key.startsWith('portfolio:v2:')) {
    return 'portfolio:v2';
  }
  if (key.startsWith('snap:')) {
    return 'snap';
  }
  if (key.startsWith('rate:v1:')) {
    return 'rate:v1';
  }
  return 'otherPortfolio';
}

function recordMmkvMutationMetric(args: {
  key: string;
  reason: PortfolioMmkvWriteReason;
  approximateBytes: number;
  durationMs: number;
  warning: boolean;
  allowOversize: boolean;
}): void {
  'worklet';

  recordPortfolioV2Metric({
    kind: 'mmkvWrite',
    reason: args.reason,
    localKeyHash: localHashKey(args.key),
    keyLength: args.key.length,
    keyPrefixFamily: getPortfolioMmkvPrefixFamily(args.key),
    approximateBytes: args.approximateBytes,
    durationMs: args.durationMs,
    warning: args.warning,
    allowOversize: args.allowOversize,
  });
}

export function getPortfolioKvStore(): MmkvKvStore {
  if (!portfolioKvStore) {
    portfolioKvStore = new MmkvKvStore(getPortfolioMmkvStorageOnRN(), {
      registryKey: PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
      storageId: PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
    });
  }
  return portfolioKvStore;
}

export function resetPortfolioKvStoreForTesting(): void {
  portfolioKvStore = undefined;
}

export function writePortfolioMmkvString(args: {
  key: string;
  value: string;
  reason: PortfolioMmkvWriteReason;
  allowOversize?: boolean;
}): void {
  const key = normalizeKey(args.key);
  const value = String(args.value ?? '');
  const approximateBytes = approximateStringBytes(value);
  const warning =
    approximateBytes > PORTFOLIO_MMKV_VALUE_WARN_BYTES &&
    args.allowOversize !== true;
  const startedAt = nowMs();

  void getPortfolioKvStore().setString(key, value);

  recordMmkvMutationMetric({
    key,
    reason: args.reason,
    approximateBytes,
    durationMs: Math.max(0, nowMs() - startedAt),
    warning,
    allowOversize: args.allowOversize === true,
  });
}

export function deletePortfolioMmkvKey(args: {
  key: string;
  reason: PortfolioMmkvWriteReason;
}): void {
  const key = normalizeKey(args.key);
  const startedAt = nowMs();

  void getPortfolioKvStore().delete(key);

  recordMmkvMutationMetric({
    key,
    reason: args.reason,
    approximateBytes: 0,
    durationMs: Math.max(0, nowMs() - startedAt),
    warning: false,
    allowOversize: false,
  });
}

export function writePortfolioMmkvStringOnWorklet(
  config: PortfolioWorkletKvConfig,
  args: {
    key: string;
    value: string;
    reason: PortfolioMmkvWriteReason;
    allowOversize?: boolean;
  },
): void {
  'worklet';

  const key = normalizeKey(args.key);
  const value = String(args.value ?? '');
  workletKvSetString(config, key, value);
  recordMmkvMutationMetric({
    key,
    reason: args.reason,
    approximateBytes: approximateStringBytes(value),
    durationMs: 0,
    warning:
      approximateStringBytes(value) > PORTFOLIO_MMKV_VALUE_WARN_BYTES &&
      args.allowOversize !== true,
    allowOversize: args.allowOversize === true,
  });
}

export function deletePortfolioMmkvKeyOnWorklet(
  config: PortfolioWorkletKvConfig,
  args: {
    key: string;
    reason: PortfolioMmkvWriteReason;
  },
): void {
  'worklet';

  const key = normalizeKey(args.key);
  workletKvDelete(config, key);
  recordMmkvMutationMetric({
    key,
    reason: args.reason,
    approximateBytes: 0,
    durationMs: 0,
    warning: false,
    allowOversize: false,
  });
}

export function listRealPortfolioMmkvKeysOnRN(): readonly string[] {
  const storage = getPortfolioMmkvStorageOnRN() as unknown as {
    getAllKeys?: () => string[];
  };
  return typeof storage.getAllKeys === 'function' ? storage.getAllKeys() : [];
}

function decodeRegistryKeys(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as RegistryPayloadV1 | string[];
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
    if (parsed?.v === 1 && Array.isArray(parsed.keys)) {
      return parsed.keys.map(String);
    }
  } catch {
    return [];
  }
  return [];
}

function listRegistryTrackedKeysOnRN(): string[] {
  return decodeRegistryKeys(
    getPortfolioMmkvStorageOnRN().getString(
      PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
    ),
  );
}

function isResetWipeTargetKey(key: string): boolean {
  if (
    key === PORTFOLIO_V2_FLAG_KEY ||
    key === PORTFOLIO_CACHE_INVALID_KEY ||
    key === PORTFOLIO_WORK_EPOCH_KEY
  ) {
    return false;
  }
  return key.startsWith('portfolio:v2:') || key.startsWith('snap:');
}

export function clearPortfolioMmkvKeysForReset(args: {
  reason: Extract<PortfolioMmkvWriteReason, 'reset' | 'wipe'>;
}): void {
  const keys = Array.from(
    new Set([
      ...listRealPortfolioMmkvKeysOnRN(),
      ...listRegistryTrackedKeysOnRN(),
    ]),
  ).filter(isResetWipeTargetKey);

  for (const key of keys) {
    deletePortfolioMmkvKey({key, reason: args.reason});
  }
}

export function createWorkletPortfolioKvConfig(
  storage: WorkletMmkvStorageBridge,
): PortfolioWorkletKvConfig {
  return {
    storage,
    registryKey: PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
  };
}
