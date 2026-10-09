import crypto from 'crypto';
import isEqual from 'lodash.isequal';
import {decodeSnapshot, reencryptSnapshot, verifySnapshot} from './vault-codec';
import {safeVaultError, vaultError} from './vault-diagnostics';

export const sourceSlots = ['mmkv', 'async', 'main', 'bak', 'temp'] as const;
export const destinationSlots = ['root', 'main', 'bak'] as const;
export const retirementSlots = [
  'data',
  'crc',
  'async',
  'main',
  'bak',
  'temp',
] as const;
type Source = (typeof sourceSlots)[number];
type Destination = (typeof destinationSlots)[number];
type Retirement = (typeof retirementSlots)[number];
type Identity = string | null;
type Disposition = Identity | 'keep';
export type Inventory = {
  // undefined is an unsuccessful optional backup read, never absence.
  sources: Record<Source, string | null | undefined>;
  files: {data: Identity; crc: Identity};
  keys: string[];
};
type Identities = Record<Source, Identity | 'unreadable'> & {
  data: Identity;
  crc: Identity;
  keys: string;
};
export type TransferRecord = {
  version: 2;
  layout: 'bitpay.wallet.v2';
  phase: 'preparing' | 'active' | 'retired';
  inputs: Identities;
  // All three destinations were observed absent before claiming ownership.
  owned: true;
  copies: Record<Destination, Source | null>;
  release: Record<Retirement, Disposition>;
};
export type TransferIO = {
  readControl(): string | null;
  writeControl(raw: string): void;
  modernKeys(): string[];
  modernTempExists(): Promise<boolean>;
  readDestination(slot: Destination): Promise<string | null>;
  writeDestination(slot: Destination, raw: string): Promise<void>;
  inventory(): Promise<Inventory>;
  legacyKeys(): Promise<string[]>;
  modernKey(create: boolean): Promise<string>;
  claimColdRetirement(): boolean;
  retirementIdentity(slot: Retirement): Promise<Identity>;
  removeSource(slot: Retirement): Promise<void>;
  removeLegacyKey(): Promise<void>;
  pending(): void;
};

export const digest = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
const identity = (value: string | null | undefined) =>
  value === undefined ? 'unreadable' : value === null ? null : digest(value);
const identities = (inventory: Inventory): Identities =>
  ({
    ...Object.fromEntries(
      sourceSlots.map(slot => [slot, identity(inventory.sources[slot])]),
    ),
    ...inventory.files,
    keys: digest(JSON.stringify([...inventory.keys].sort())),
  } as Identities);
const hash = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: any) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: any, keys: readonly string[]) =>
  object(value) && isEqual(Object.keys(value).sort(), [...keys].sort());
const invalid = () =>
  vaultError('STARTUP_FAILURE', 'inventory', 'RECORD_INVALID', 'record');

export const parseTransferRecord = (raw: string): TransferRecord => {
  try {
    if (raw.length > 8192) throw invalid();
    const r = JSON.parse(raw);
    if (
      !exactKeys(r, [
        'version',
        'layout',
        'phase',
        'inputs',
        'owned',
        'copies',
        'release',
      ]) ||
      r.version !== 2 ||
      r.layout !== 'bitpay.wallet.v2' ||
      r.owned !== true ||
      !['preparing', 'active', 'retired'].includes(r.phase) ||
      !exactKeys(r.inputs, [...sourceSlots, 'data', 'crc', 'keys']) ||
      !exactKeys(r.copies, destinationSlots) ||
      !exactKeys(r.release, retirementSlots)
    )
      throw invalid();
    for (const slot of sourceSlots) {
      if (
        r.inputs[slot] !== null &&
        r.inputs[slot] !== 'unreadable' &&
        !hash(r.inputs[slot])
      )
        throw invalid();
    }
    if (
      !hash(r.inputs.keys) ||
      ![r.inputs.data, r.inputs.crc].every(v => v === null || hash(v))
    )
      throw invalid();
    for (const slot of destinationSlots) {
      const source = r.copies[slot];
      if (
        source !== null &&
        (!(sourceSlots as readonly string[]).includes(source) ||
          !hash(r.inputs[source]))
      )
        throw invalid();
      if (slot !== 'root' && source !== null && source !== slot)
        throw invalid();
    }
    if (r.copies.root === 'temp') throw invalid();
    for (const slot of ['mmkv', 'async']) {
      const released =
        slot === 'mmkv'
          ? r.release.data !== 'keep'
          : r.release.async !== 'keep';
      if (
        released &&
        r.inputs[slot] !== null &&
        (r.copies.root === null || r.inputs[slot] !== r.inputs[r.copies.root])
      )
        throw invalid();
    }
    for (const slot of retirementSlots) {
      const permission = r.release[slot];
      if (permission !== 'keep' && permission !== r.inputs[slot])
        throw invalid();
      if (permission !== 'keep' && permission !== null && !hash(permission))
        throw invalid();
    }
    if ((r.release.data === 'keep') !== (r.release.crc === 'keep'))
      throw invalid();
    if (r.release.temp !== 'keep' && r.release.temp !== null) throw invalid();
    for (const slot of ['main', 'bak'] as const) {
      if (hash(r.release[slot]) && r.copies[slot] !== slot) throw invalid();
    }
    if (
      r.phase === 'retired' &&
      retirementSlots.some(slot => r.release[slot] === 'keep')
    )
      throw invalid();
    return r;
  } catch {
    throw invalid();
  }
};

const readRecord = (io: TransferIO) => {
  try {
    const raw = io.readControl();
    return raw === null ? null : parseTransferRecord(raw);
  } catch (error) {
    throw safeVaultError(
      error,
      'STARTUP_FAILURE',
      'inventory',
      'RECORD_READ',
      'record',
    );
  }
};
const saveRecord = (io: TransferIO, record: TransferRecord) => {
  try {
    const raw = JSON.stringify(record);
    parseTransferRecord(raw);
    io.writeControl(raw);
    if (io.readControl() !== raw) throw new Error();
  } catch (error) {
    throw safeVaultError(
      error,
      'STARTUP_FAILURE',
      'inventory',
      'RECORD_WRITE',
      'record',
    );
  }
};
const jsonReadable = (raw: string | null | undefined) => {
  if (typeof raw !== 'string') return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};
const decodeWithCandidate = (raw: string, candidates: string[]) => {
  for (const key of [...new Set(candidates)]) {
    try {
      return {key, snapshot: decodeSnapshot(raw, key)};
    } catch {}
  }
  throw vaultError('INVALID_LEGACY_INPUT', 'classify', 'SOURCE_INVALID');
};

function plan(inventory: Inventory, candidates: string[]): TransferRecord {
  const {sources, keys, files} = inventory;
  if (sources.mmkv === undefined || sources.async === undefined) {
    throw vaultError('SOURCE_CONFLICT', 'inventory', 'SOURCE_READ');
  }
  // Released main-before-bak JSON selection, with no decryption-based search.
  const selectedMMKV: Source | null =
    sources.mmkv !== null
      ? 'mmkv'
      : jsonReadable(sources.main)
      ? 'main'
      : jsonReadable(sources.bak)
      ? 'bak'
      : null;
  let selected: Source | null = selectedMMKV;
  if (selectedMMKV) {
    const raw = sources[selectedMMKV]!;
    const current = decodeWithCandidate(raw, candidates).snapshot;
    if (
      sources.async !== null &&
      sources.async !== raw &&
      current.payload.APP?.migrationMMKVStorageComplete !== true
    ) {
      throw vaultError('SOURCE_CONFLICT', 'classify', 'SOURCE_INVALID');
    }
  } else if (sources.async !== null) {
    // Failed or damaged MMKV/recovery observations cannot establish an empty history.
    if (
      sources.mmkv !== null ||
      sources.main !== null ||
      sources.bak !== null
    ) {
      throw vaultError('SOURCE_CONFLICT', 'classify', 'SOURCE_INVALID');
    }
    const historical = decodeWithCandidate(sources.async, candidates).snapshot;
    if (historical.payload.APP?.migrationMMKVStorageComplete === true) {
      throw vaultError('SOURCE_CONFLICT', 'classify', 'SOURCE_INVALID');
    }
    selected = 'async';
  } else if (sourceSlots.some(slot => sources[slot] !== null)) {
    throw vaultError('INVALID_LEGACY_INPUT', 'classify', 'SOURCE_INVALID');
  }
  const inputs = identities(inventory);
  const copies: TransferRecord['copies'] = {
    root: selected,
    main: null,
    bak: null,
  };
  for (const slot of ['main', 'bak'] as const) {
    if (typeof sources[slot] !== 'string') continue;
    try {
      decodeWithCandidate(sources[slot], candidates);
      copies[slot] = slot;
    } catch {}
  }
  const used = (slot: Source) =>
    sources[slot] === null ||
    (selected !== null && sources[slot] === sources[selected]);
  const canRetireMMKV =
    keys.every(key => ['persist:root', 'persist:logs'].includes(key)) &&
    used('mmkv');
  return {
    version: 2,
    layout: 'bitpay.wallet.v2',
    phase: 'preparing',
    owned: true,
    inputs,
    copies,
    release: {
      data: canRetireMMKV ? files.data : 'keep',
      crc: canRetireMMKV ? files.crc : 'keep',
      async: used('async') ? (inputs.async as Identity) : 'keep',
      main:
        copies.main || sources.main === null
          ? (inputs.main as Identity)
          : 'keep',
      bak:
        copies.bak || sources.bak === null ? (inputs.bak as Identity) : 'keep',
      temp: sources.temp === null ? null : 'keep',
    },
  };
}

async function retire(io: TransferIO, record: TransferRecord) {
  if (record.phase === 'retired') return;
  let pending = false;
  const matches = async (slot: Retirement) => {
    const current = await io.retirementIdentity(slot);
    if (current !== null && current !== record.release[slot]) throw new Error();
    return current;
  };
  const remove = async (slot: Retirement) => {
    if ((await matches(slot)) !== null) await io.removeSource(slot);
    if ((await io.retirementIdentity(slot)) !== null) throw new Error();
  };
  // Claim before inspecting/removing either file. Native guard survives JS reload
  // and refuses every subsequent old-instance open for this process.
  try {
    if (record.release.data === 'keep' || !io.claimColdRetirement())
      pending = true;
    else {
      await matches('data');
      await matches('crc');
      await remove('data');
      await remove('crc');
    }
  } catch {
    pending = true;
  }
  for (const slot of ['async', 'main', 'bak', 'temp'] as const) {
    if (record.release[slot] === 'keep') {
      pending = true;
      continue;
    }
    try {
      await remove(slot);
    } catch {
      pending = true;
    }
  }
  if (!pending) {
    try {
      // Recheck all absence obligations immediately before retiring the key.
      for (const slot of retirementSlots) {
        if ((await io.retirementIdentity(slot)) !== null) throw new Error();
      }
      await io.removeLegacyKey();
      saveRecord(io, {...record, phase: 'retired'});
    } catch {
      pending = true;
    }
  }
  if (pending) {
    try {
      io.pending();
    } catch {
      /* Reporting cannot revoke modern access. */
    }
  }
}

export async function transferVault(io: TransferIO): Promise<string> {
  let record = readRecord(io);
  if (record && record.phase !== 'preparing') {
    const key = await io.modernKey(false);
    await retire(io, record);
    return key;
  }
  if (!record) {
    if (io.modernKeys().length || (await io.modernTempExists()))
      throw invalid();
    for (const slot of destinationSlots) {
      if ((await io.readDestination(slot)) !== null) throw invalid();
    }
  }
  const inventory = await io.inventory();
  const candidates = await io.legacyKeys();
  const proposed = plan(inventory, candidates);
  if (
    record &&
    (!isEqual(record.inputs, proposed.inputs) ||
      !isEqual(record.copies, proposed.copies) ||
      !isEqual(record.release, proposed.release))
  ) {
    throw vaultError('SOURCE_CONFLICT', 'inventory', 'SOURCE_CHANGED');
  }
  const key = await io.modernKey(record === null);
  if (!record) {
    record = proposed;
    saveRecord(io, record);
  }
  const prepared: {
    slot: Destination;
    output: string;
    payload: Record<string, any>;
  }[] = [];
  for (const slot of destinationSlots) {
    const source = record.copies[slot];
    if (source === null) continue;
    const raw = inventory.sources[source]!;
    const decoded = decodeWithCandidate(raw, candidates);
    const output = reencryptSnapshot(raw, decoded.key, key);
    try {
      await io.writeDestination(slot, output);
    } catch {
      throw vaultError('REQUIRED_COPY_FAILURE', 'required-copy', 'COPY_WRITE');
    }
    verifySnapshot(
      await io.readDestination(slot),
      output,
      decoded.snapshot.payload,
      key,
    );
    prepared.push({slot, output, payload: decoded.snapshot.payload});
  }
  if (!isEqual(identities(await io.inventory()), record.inputs)) {
    throw vaultError('SOURCE_CONFLICT', 'inventory', 'SOURCE_CHANGED');
  }
  for (const item of prepared) {
    verifySnapshot(
      await io.readDestination(item.slot),
      item.output,
      item.payload,
      key,
    );
  }
  // Empty/unplanned slots must still be empty. Never activate unowned surprises.
  if (
    io.modernKeys().some(k => k !== 'persist:root') ||
    (await io.modernTempExists())
  )
    throw invalid();
  for (const slot of destinationSlots) {
    if (
      record.copies[slot] === null &&
      (await io.readDestination(slot)) !== null
    )
      throw invalid();
  }
  const active: TransferRecord = {...record, phase: 'active'};
  saveRecord(io, active);
  await retire(io, active);
  return key;
}
