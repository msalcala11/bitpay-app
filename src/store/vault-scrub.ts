import {MMKV} from 'react-native-mmkv';
import RNFS from 'react-native-fs';
import {VaultCode, vaultError} from './vault-diagnostics';

export const VAULT_SCRUB_KEY = 'bitpay.vault.scrub';
export const SMALL_MMKV_FILE = 64 * 1024;
// Default new MMKV(): iOS Documents/mmkv; Android files/mmkv. This app has no
// custom path, AppGroup, MMKV encryption, expiration, or compare-before-set mode.
const FILE = RNFS.DocumentDirectoryPath + '/mmkv/mmkv.default';
const HEADER = 4;
const PLACEHOLDER = 4;
const MAX_SIZE = 0x7fffffff; // Pinned wrapper exposes actualSize as signed int.

export const varintSize = (value: number): number =>
  value < 128
    ? 1
    : value < 16384
    ? 2
    : value < 2097152
    ? 3
    : value < 268435456
    ? 4
    : 5;

// Pinned set(string): key varint + UTF-8 key + outer value varint +
// nested string varint + UTF-8 value. The dictionary placeholder is separate.
export const stringEntrySize = (key: string, bytes: number): number => {
  const k = Buffer.byteLength(key, 'utf8');
  const value = bytes + varintSize(bytes);
  return varintSize(k) + k + varintSize(value) + value;
};
export const compactedSize = (values: Map<string, string>): number =>
  values.size === 0
    ? 0
    : PLACEHOLDER +
      [...values].reduce(
        (sum, [key, value]) =>
          sum + stringEntrySize(key, Buffer.byteLength(value, 'utf8')),
        0,
      );
const DELETE_BYTES =
  Buffer.byteLength(VAULT_SCRUB_KEY) +
  varintSize(Buffer.byteLength(VAULT_SCRUB_KEY)) +
  1;
const validSize = (size: number) =>
  Number.isSafeInteger(size) && size > 0 && size <= MAX_SIZE;

export type ScrubPlan = {
  mode: 'overfill' | 'tail';
  bytes: number;
  base: number;
  entry: number;
  gap: number;
  maxFile: number;
};

// Exact bound from expandAndWriteBack, not a fixed allocation cap. Native growth
// doubles F until it exceeds lenNeeded + 8 * ceil(lenNeeded / next-key-count).
const growthBound = (
  file: number,
  compact: number,
  incoming: number,
  count: number,
): number => {
  const needed = Math.max(PLACEHOLDER, compact) + HEADER + incoming;
  const target = needed + 8 * Math.ceil(needed / Math.max(1, count + 1));
  let result = file;
  for (let i = 0; i < 32 && result <= target; i++) result *= 2;
  return result;
};

export const planScrub = (
  file: number,
  actual: number,
  values: Map<string, string>,
): ScrubPlan | undefined => {
  const compact = compactedSize(values);
  if (
    !validSize(file) ||
    !Number.isSafeInteger(actual) ||
    actual < 0 ||
    actual > file - HEADER ||
    compact > actual
  )
    return;
  const base = Math.max(PLACEHOLDER, compact);
  if (file <= SMALL_MMKV_FILE) {
    const entry = stringEntrySize(VAULT_SCRUB_KEY, file);
    const maxFile = growthBound(file, compact, entry, values.size);
    if (!validSize(maxFile)) return;
    return {mode: 'overfill', bytes: file, base, entry, gap: 0, maxFile};
  }
  // Empty dictionaries require actualSize=0. Their first insert writes a new
  // four-byte placeholder, so reserve it even though current actualSize is zero.
  if (actual !== compact) return;
  const tail = file - HEADER - base;
  let low = 0;
  let high = Math.max(0, tail);
  for (let i = 0; i < 32 && low < high; i++) {
    const mid = Math.ceil((low + high) / 2);
    if (stringEntrySize(VAULT_SCRUB_KEY, mid) + DELETE_BYTES < tail) low = mid;
    else high = mid - 1;
  }
  const entry = stringEntrySize(VAULT_SCRUB_KEY, low);
  const gap = tail - entry - DELETE_BYTES;
  // E(n) grows by at most 3 at a varint transition. The at-most-three old tail
  // bytes cannot contain a CBC block/envelope or a complete historical EDDSA key.
  // An empty string is a real, encoded MMKV entry (not a deletion). It can be
  // the largest fitting payload near capacity; E(0) and D still overwrite bytes.
  if (gap < 1 || gap > 3) return;
  return {mode: 'tail', bytes: low, base, entry, gap, maxFile: file};
};

// The caller has already verified the current root and its required backup.
// guard() rejects lost/invalid roots, or defers on usable concurrent changes.
// No registered value is ever cleared, restored, or overwritten by this module.
export const scrubVault = async (
  storage: MMKV,
  values: Map<string, string>,
  guard: () => boolean,
  defer: (code: VaultCode) => void,
  backupCurrent: () => Promise<boolean>,
): Promise<boolean> => {
  const reject = (code: VaultCode) => {
    defer(code);
    return false;
  };
  const measure = async (): Promise<number | undefined> => {
    const actual = storage.size;
    let previous: number | undefined;
    for (let i = 0; i < 2; i++) {
      let file: number | undefined;
      try {
        const stat = await RNFS.stat(FILE);
        if (stat.isFile() && validSize(stat.size)) file = stat.size;
      } catch {}
      // This is outside the metadata catch: preservation/read failures are strict.
      const currentBackup = await backupCurrent();
      // Backup deferral cannot bypass primary validation after either await.
      const currentState = guard();
      if (!currentBackup || !currentState) return;
      if (
        actual !== storage.size ||
        (previous !== undefined && previous !== file)
      ) {
        defer('SCRUB_STATE_CHANGED');
        return;
      }
      if (file === undefined) {
        defer('SCRUB_MEASUREMENT_DEFERRED');
        return;
      }
      previous = file;
    }
    return previous;
  };
  if (!guard()) return false;
  if (storage.contains(VAULT_SCRUB_KEY)) {
    const leftover = storage.getString(VAULT_SCRUB_KEY);
    if (leftover === undefined || !/^0*$/.test(leftover))
      return reject('UNKNOWN_STORAGE_KEY');
    const before = await measure();
    if (before === undefined) return false;
    const withFiller = new Map(values).set(VAULT_SCRUB_KEY, leftover);
    const limit = growthBound(
      before,
      compactedSize(withFiller),
      DELETE_BYTES,
      withFiller.size,
    );
    if (!validSize(limit)) return reject('SCRUB_COVERAGE_DEFERRED');
    try {
      storage.delete(VAULT_SCRUB_KEY);
    } catch {
      if (!guard()) return false;
      return reject('SCRUB_WRITE_REJECTED');
    }
    if (!guard()) return false;
    if (storage.contains(VAULT_SCRUB_KEY))
      return reject('SCRUB_WRITE_REJECTED');
    const after = await measure();
    if (after === undefined) return false;
    if (after > limit) return reject('SCRUB_COVERAGE_DEFERRED');
  }
  try {
    storage.trim();
  } catch {
    if (!guard()) return false;
    return reject('SCRUB_WRITE_REJECTED');
  }
  if (!guard()) return false;
  const file = await measure();
  if (file === undefined) return false;
  const plan = planScrub(file, storage.size, values);
  if (!plan) return reject('SCRUB_COVERAGE_DEFERRED');
  let filler: string;
  try {
    filler = '0'.repeat(plan.bytes);
    storage.set(VAULT_SCRUB_KEY, filler);
  } catch {
    if (!guard()) return false;
    return reject('SCRUB_WRITE_REJECTED');
  }
  if (!guard()) return false;
  if (
    storage.getString(VAULT_SCRUB_KEY) !== filler ||
    storage.size !== plan.base + plan.entry
  )
    return reject('SCRUB_COVERAGE_DEFERRED');
  const filledFile = await measure();
  if (filledFile === undefined) return false;
  if (
    filledFile > plan.maxFile ||
    (plan.mode === 'tail' && filledFile !== file)
  )
    return reject('SCRUB_COVERAGE_DEFERRED');
  try {
    storage.delete(VAULT_SCRUB_KEY);
  } catch {
    if (!guard()) return false;
    return reject('SCRUB_WRITE_REJECTED');
  }
  if (!guard()) return false;
  if (
    storage.contains(VAULT_SCRUB_KEY) ||
    storage.size !== plan.base + plan.entry + DELETE_BYTES
  )
    return reject('SCRUB_COVERAGE_DEFERRED');
  const deletedFile = await measure();
  if (deletedFile === undefined) return false;
  if (deletedFile !== filledFile) return reject('SCRUB_COVERAGE_DEFERRED');
  try {
    storage.trim();
  } catch {
    if (!guard()) return false;
    return reject('SCRUB_WRITE_REJECTED');
  }
  if (!guard()) return false;
  const finalFile = await measure();
  if (finalFile === undefined) return false;
  if (finalFile > filledFile) return reject('SCRUB_COVERAGE_DEFERRED');
  if (storage.contains(VAULT_SCRUB_KEY))
    throw vaultError('PRESERVATION_FAILURE', 'scrub');
  return true;
};
