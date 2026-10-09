import isEqual from 'lodash.isequal';
import {decodeSnapshot, encodeSnapshot} from './vault-codec';
import {
  digest,
  transferVault,
  parseTransferRecord,
  TransferIO,
  Inventory,
  retirementSlots,
} from './vault-transfer';

const fixture = require('../../test/vault/fixtures/legacy-14.32.json').cases
  .plain;
const oldKey = 'synthetic-legacy-fixture-key';
const newKey = Buffer.alloc(32, 72).toString('base64');
const equal = (a: unknown, b: unknown) => expect(isEqual(a, b)).toBe(true);

function harness(source: 'mmkv' | 'async' | 'fresh' = 'mmkv') {
  let control: string | null = null;
  const destinations: Record<string, string | null> = {
    root: null,
    main: null,
    bak: null,
  };
  const state: Inventory = {
    sources: {
      mmkv: source === 'mmkv' ? fixture.raw : null,
      async:
        source === 'async'
          ? encodeSnapshot(
              {
                ...fixture.state,
                APP: {
                  ...fixture.state.APP,
                  migrationMMKVStorageComplete: false,
                },
              },
              oldKey,
            )
          : null,
      main: null,
      bak: null,
      temp: null,
    },
    keys: source === 'mmkv' ? ['persist:root', 'persist:logs'] : [],
    files: {
      data: source === 'mmkv' ? digest('data') : null,
      crc: source === 'mmkv' ? digest('crc') : null,
    },
  };
  let key: string | null = null;
  let warm = source === 'mmkv';
  const events: string[] = [];
  let fault: string | null = null;
  let faultReached = false;
  const hit = (name: string) => {
    events.push(name);
    if (name === fault) {
      faultReached = true;
      throw new Error('synthetic failure');
    }
  };
  const io: TransferIO = {
    readControl: () => {
      hit('control:read');
      return control;
    },
    writeControl: raw => {
      const phase = JSON.parse(raw).phase;
      hit('control:before:' + phase);
      control = raw;
      hit('control:after:' + phase);
    },
    modernKeys: () => (destinations.root === null ? [] : ['persist:root']),
    modernTempExists: async () => false,
    readDestination: async slot => {
      hit('destination:read:' + slot);
      return destinations[slot];
    },
    writeDestination: async (slot, raw) => {
      hit('destination:before:' + slot);
      destinations[slot] = raw;
      hit('destination:after:' + slot);
    },
    inventory: async () => {
      hit('inventory');
      return JSON.parse(JSON.stringify(state));
    },
    legacyKeys: async () => [oldKey],
    modernKey: async create => {
      hit('key:read');
      if (!key && create) {
        hit('key:create');
        key = newKey;
        hit('key:verify');
      }
      if (!key) throw new Error('missing modern key');
      return key;
    },
    claimColdRetirement: () => !warm,
    retirementIdentity: async slot => {
      hit('retirement:read:' + slot);
      if (slot === 'data' || slot === 'crc') return state.files[slot];
      const raw = state.sources[slot];
      if (raw === undefined) throw new Error('unreadable');
      return raw === null ? null : digest(raw);
    },
    removeSource: async slot => {
      hit('retirement:before:' + slot);
      if (slot === 'data' || slot === 'crc') state.files[slot] = null;
      else state.sources[slot] = null;
      hit('retirement:after:' + slot);
    },
    removeLegacyKey: async () => {
      hit('legacy-key:remove');
    },
    pending: () => {
      events.push('pending');
    },
  };
  return {
    io,
    state,
    destinations,
    events,
    record: () => (control === null ? null : parseTransferRecord(control)),
    setControl: (raw: string | null) => {
      control = raw;
    },
    fault: (name: string | null) => {
      fault = name;
      faultReached = false;
    },
    reached: () => faultReached,
    cold: () => {
      warm = false;
    },
    loseKey: () => {
      key = null;
    },
  };
}

it('transfers genuine AsyncStorage directly and removes only its committed row', async () => {
  const h = harness('async');
  await transferVault(h.io);
  equal(decodeSnapshot(h.destinations.root!, newKey).payload, {
    ...fixture.state,
    APP: {...fixture.state.APP, migrationMMKVStorageComplete: false},
  });
  expect(h.state.sources.mmkv === null).toBe(true);
  expect(h.state.sources.async === null).toBe(true);
  expect(h.record()!.phase).toBe('retired');
});

it('preserves independent main/bak contents and never creates a checkpoint', async () => {
  const h = harness();
  const main = {...fixture.state, UNKNOWN: {snapshot: 'main'}};
  const bak = {...fixture.state, UNKNOWN: {snapshot: 'older'}};
  h.state.sources.main = encodeSnapshot(main, oldKey);
  h.state.sources.bak = encodeSnapshot(bak, oldKey);
  await transferVault(h.io);
  equal(decodeSnapshot(h.destinations.main!, newKey).payload, main);
  equal(decodeSnapshot(h.destinations.bak!, newKey).payload, bak);
  expect(Object.keys(h.destinations).sort()).toEqual(['bak', 'main', 'root']);
});

it('established MMKV preserves an unresolved leftover row', async () => {
  const h = harness();
  h.state.sources.async = 'unreadable leftover';
  await transferVault(h.io);
  expect(h.state.sources.async === 'unreadable leftover').toBe(true);
  expect(h.record()!.release.async === 'keep').toBe(true);
});

it('rejects competing history without authority, with no output or deletion', async () => {
  const h = harness();
  h.state.sources.mmkv = encodeSnapshot(
    {...fixture.state, APP: {migrationMMKVStorageComplete: false}},
    oldKey,
  );
  h.state.sources.async = fixture.raw;
  await fails(() => transferVault(h.io), 'SOURCE_CONFLICT');
  expect(h.destinations.root === null).toBe(true);
  expect(h.events.some(e => e.startsWith('retirement:before'))).toBe(false);
});

it('accepts an exact interrupted duplicate without merging snapshots', async () => {
  const h = harness();
  h.state.sources.mmkv = encodeSnapshot(
    {...fixture.state, APP: {migrationMMKVStorageComplete: false}},
    oldKey,
  );
  h.state.sources.async = h.state.sources.mmkv;
  await transferVault(h.io);
  expect(h.state.sources.async === null).toBe(true);
});

it.each(['main', 'bak'] as const)(
  'retains unreadable non-authoritative %s while activating the wallet',
  async slot => {
    const h = harness();
    h.state.sources[slot] = 'damaged';
    await transferVault(h.io);
    expect(h.record()!.phase).toBe('active');
    expect(h.record()!.release[slot] === 'keep').toBe(true);
    expect(h.state.sources[slot] === 'damaged').toBe(true);
  },
);

it('does not open an empty replacement when the only backup is unconvertible', async () => {
  const h = harness('fresh');
  h.state.sources.main = '{}';
  await fails(() => transferVault(h.io));
  expect(h.destinations.root === null).toBe(true);
});

it('uses main before bak for ordinary fallback and does not search by decryption', async () => {
  const h = harness();
  h.state.sources.mmkv = null;
  h.state.keys = ['persist:logs'];
  h.state.sources.main = '{}';
  h.state.sources.bak = fixture.raw;
  await fails(() => transferVault(h.io));
  h.state.sources.main = 'invalid JSON';
  await transferVault(h.io);
  equal(decodeSnapshot(h.destinations.root!, newKey).payload, fixture.state);
  expect(h.record()!.release.main === 'keep').toBe(true);
});

it.each([
  'control:before:preparing',
  'control:after:preparing',
  'destination:before:root',
  'destination:after:root',
  'control:before:active',
])('preserves inputs at %s and succeeds after that fault clears', async cut => {
  const h = harness();
  const before = JSON.stringify(h.state);
  h.fault(cut);
  await fails(() => transferVault(h.io));
  expect(h.reached()).toBe(true);
  expect(JSON.stringify(h.state) === before).toBe(true);
  h.fault(null);
  await transferVault(h.io);
  equal(decodeSnapshot(h.destinations.root!, newKey).payload, fixture.state);
});

it('observes persisted activation after a failed write acknowledgement, never replaying sources', async () => {
  const h = harness();
  h.fault('control:after:active');
  await fails(() => transferVault(h.io));
  expect(h.reached()).toBe(true);
  h.fault(null);
  h.destinations.root = encodeSnapshot(
    {...fixture.state, AFTER: {save: true}},
    newKey,
  );
  const saved = h.destinations.root;
  h.io.inventory = async () => {
    throw new Error('must not reimport');
  };
  await transferVault(h.io);
  expect(h.destinations.root === saved).toBe(true);
});

it('withholds activation on failed final read-back and retries the owned output', async () => {
  const h = harness();
  const read = h.io.readDestination;
  let damaged = true;
  h.io.readDestination = async slot => {
    const raw = await read(slot);
    return damaged && raw !== null ? raw + ' ' : raw;
  };
  await fails(() => transferVault(h.io), 'REQUIRED_COPY_FAILURE');
  expect(h.record()!.phase).toBe('preparing');
  damaged = false;
  await transferVault(h.io);
  expect(h.record()!.phase).toBe('active');
});

it('a failed supported backup write is required, not an unresolved-backup shortcut', async () => {
  const h = harness();
  h.state.sources.main = fixture.raw;
  h.fault('destination:before:main');
  await fails(() => transferVault(h.io));
  expect(h.reached()).toBe(true);
  expect(h.state.sources.main === fixture.raw).toBe(true);
  h.fault(null);
  await transferVault(h.io);
  expect(h.destinations.main !== null).toBe(true);
});

it('rechecks changed source identities before committing', async () => {
  const h = harness();
  let reads = 0;
  const inventory = h.io.inventory;
  h.io.inventory = async () => {
    if (++reads === 2) h.state.files.crc = digest('changed');
    return inventory();
  };
  await fails(() => transferVault(h.io), 'SOURCE_CONFLICT');
  expect(h.record()!.phase).toBe('preparing');
});

it('unknown old entries keep the entire instance and credential', async () => {
  const h = harness();
  h.state.keys.push('unknown');
  await transferVault(h.io);
  h.cold();
  await transferVault(h.io);
  expect(h.record()!.release.data === 'keep').toBe(true);
  expect(h.events.includes('legacy-key:remove')).toBe(false);
});

it('defers warm removal, preserves changed cold sources, and retries a partial file pair', async () => {
  const h = harness();
  await transferVault(h.io);
  expect(h.state.files.data !== null).toBe(true);
  h.cold();
  const crc = h.state.files.crc;
  h.state.files.crc = digest('changed after activation');
  await transferVault(h.io);
  expect(h.state.files.data !== null).toBe(true);
  h.state.files.crc = crc;
  h.fault('retirement:after:data');
  await transferVault(h.io);
  expect(h.reached()).toBe(true);
  expect(h.state.files.data === null).toBe(true);
  expect(h.state.files.crc !== null).toBe(true);
  h.fault(null);
  await transferVault(h.io);
  expect(h.record()!.phase).toBe('retired');
});

it('deletion and credential verification failures leave access usable and pending', async () => {
  const h = harness('async');
  h.fault('retirement:before:async');
  await transferVault(h.io);
  expect(h.reached()).toBe(true);
  h.fault('legacy-key:remove');
  await transferVault(h.io);
  expect(h.reached()).toBe(true);
  expect(h.record()!.phase).toBe('active');
  h.fault(null);
  await transferVault(h.io);
  expect(h.record()!.phase).toBe('retired');
});

it('keeps ordinary total-loss behavior with a key and never reimports after activation', async () => {
  const h = harness();
  await transferVault(h.io);
  h.destinations.root = null;
  h.io.inventory = async () => {
    throw new Error('forbidden');
  };
  await transferVault(h.io);
  expect(h.destinations.root === null).toBe(true);
  h.loseKey();
  await fails(() => transferVault(h.io), 'missing modern key');
});

it('fresh installation activates without fabricating a root or backup', async () => {
  const h = harness('fresh');
  await transferVault(h.io);
  expect(Object.values(h.destinations).every(v => v === null)).toBe(true);
  expect(h.record()!.phase).toBe('retired');
});

it.each(['absent-control-data', 'corrupt-control', 'failed-control-read'])(
  'preserves modern bytes for %s',
  async kind => {
    const h = harness();
    if (kind === 'absent-control-data') h.destinations.root = 'unowned';
    if (kind === 'corrupt-control') h.setControl('{bad');
    if (kind === 'failed-control-read') h.fault('control:read');
    const before = {...h.destinations};
    await fails(() => transferVault(h.io));
    equal(h.destinations, before);
    expect(h.events.includes('key:create')).toBe(false);
  },
);

it('rejects arbitrary paths and invalid control permissions', async () => {
  const h = harness();
  await transferVault(h.io);
  const record = h.record()!;
  expect(() =>
    parseTransferRecord(JSON.stringify({...record, path: '/unrelated'})),
  ).toThrow();
  for (const slot of retirementSlots) {
    expect(() =>
      parseTransferRecord(
        JSON.stringify({
          ...record,
          release: {...record.release, [slot]: '/unrelated'},
        }),
      ),
    ).toThrow();
  }
});

it('does not revive an AsyncStorage row that records completed MMKV history', async () => {
  const h = harness('async');
  h.state.sources.async = fixture.raw;
  await fails(() => transferVault(h.io), 'SOURCE_CONFLICT');
  expect(h.destinations.root === null).toBe(true);
  expect(h.state.sources.async === fixture.raw).toBe(true);
});
it('existing malformed primary keeps the released failure behavior', async () => {
  const h = harness();
  h.state.sources.mmkv = 'invalid JSON';
  h.state.sources.main = fixture.raw;
  await fails(() => transferVault(h.io));
  expect(h.destinations.root === null).toBe(true);
});

// Never let Jest render a resolved key, ciphertext, payload, or source digest.
const fails = async (operation: () => Promise<unknown>, code?: string) => {
  let failed = false;
  try {
    await operation();
  } catch (error) {
    failed =
      code === undefined ||
      (error instanceof Error && error.message.includes(code));
  }
  expect(failed).toBe(true);
};
