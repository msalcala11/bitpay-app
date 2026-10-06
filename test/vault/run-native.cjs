// node test/vault/run-native.cjs <compiled-native-api> <scratch-directory> [--baseline]
// Runs the actual production migration. Only native platform boundaries are replaced.
// Core MMKV calls execute in separate processes and therefore reopen the real files.
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process'),
  Module = require('module'),
  crypto = require('crypto');
const binary = path.resolve(process.argv[2]),
  scratch = path.resolve(process.argv[3]);
const baseline = process.argv.includes('--baseline');
const kills = process.argv.includes('--kills');
const alive = () => {
  if (context?.dead) throw Error('modeled process death');
};
const serial = process.env.BIP02_ADB_SERIAL;
const adb = process.env.BIP02_ADB || 'adb';
const remoteRoot =
  process.env.BIP02_REMOTE_ROOT || '/data/local/tmp/bip02-final-repair';
const adbRun = (args, options = {}) =>
  cp.spawnSync(adb, ['-s', serial, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const remoteDir = () => remoteRoot + '/' + path.basename(context.dir);
const physicalSize = () => {
  if (!serial) return fs.statSync(context.file).size;
  const r = adbRun(['shell', '-T', binary, 'stat', remoteDir() + '/mmkv'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw Error('native metadata unavailable');
  return Number(r.stdout.trim());
};
const repo = path.resolve(__dirname, '../..');
const sourceHashes = Object.fromEntries(
  [
    'index.js',
    'src/store/index.ts',
    'src/store/vault-migration.ts',
    'src/store/vault-repair-state.ts',
    'src/store/vault-scrub.ts',
    'src/store/vault-diagnostics.ts',
    'src/store/encryption-key.ts',
    'src/store/backup/vault-files.ts',
    'src/store/transforms/encrypt.ts',
    'src/store/transforms/transforms.ts',
    'src/store/transforms/persist-encryption.ts',
    'test/vault/native-api.cpp',
    'test/vault/run-native.cjs',
    'test/vault/kill-one.py',
    'test/vault/fixtures/legacy-14.32.json',
  ].map(file => [
    file,
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(repo, file)))
      .digest('hex'),
  ]),
);

fs.mkdirSync(scratch, {recursive: true});
const ts = require(path.join(repo, 'node_modules/typescript'));
const originalLoad = Module._load;
let context;
const check = (ok, label) => {
  if (!ok) throw Error(label);
};
const native = (op, key = '', value) => {
  alive();
  const input = path.join(context.dir, 'input');
  if (value !== undefined) fs.writeFileSync(input, value, {mode: 0o600});
  let fileBefore;
  try {
    fileBefore = physicalSize();
  } catch {}
  const opStarted = performance.now();
  const cap =
    context.rejectGrowth && op === 'set' && key === 'bitpay.vault.scrub'
      ? physicalSize()
      : -1;
  let r;
  if (
    context.kill &&
    ((context.kill.phase === 'root-write' &&
      op === 'set' &&
      key === 'persist:root') ||
      (context.kill.phase === 'scrub' && op === 'trim'))
  ) {
    check(!serial, 'kill transport requires local native worker');
    const test = context.kill;
    context.kill = undefined;
    if (op === 'set') {
      const {stringEntrySize} = require(path.join(
        repo,
        'src/store/vault-scrub.ts',
      ));
      check(
        stringEntrySize(key, Buffer.byteLength(value)) >=
          physicalSize() - 4 - Number(native('size')),
        'root write did not require compaction',
      );
    }
    const result = cp.spawnSync(
      'python3',
      [
        path.join(__dirname, 'kill-one.py'),
        String(test.delay),
        path.join(context.dir, 'progress'),
        binary,
        op,
        path.join(context.dir, 'mmkv'),
        key,
        input,
        String(cap),
      ],
      {encoding: 'utf8'},
    );
    check(result.status === 0, 'native kill driver failed');
    context.killResult = JSON.parse(result.stdout);
    context.dead = true;
    throw Error('modeled process death');
  }
  if (serial) {
    const remoteInput = remoteDir() + '/input';
    if (value !== undefined)
      check(
        adbRun(['push', input, remoteInput]).status === 0,
        'native input transfer failed',
        'near-capacity fixture underflow',
        'near-capacity byte calculation',
        'tight-tail case did not defer',
      );
    r = adbRun(
      [
        'shell',
        '-T',
        'env',
        ...(context.failShrink ? ['BIP02_FAIL_SHRINK=1'] : []),
        binary,
        op,
        remoteDir() + '/mmkv',
        key || 'unused',
        remoteInput,
        String(cap),
      ],
      {encoding: 'utf8'},
    );
  } else
    r = cp.spawnSync(
      binary,
      [op, path.join(context.dir, 'mmkv'), key, input, String(cap)],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          BIP02_FAIL_SHRINK: context.failShrink ? '1' : undefined,
        },
      },
    );
  const peak = /PEAK_BYTES=(\d+)/.exec(r.stderr || '');
  if (peak) context.nativePeak = Math.max(context.nativePeak, Number(peak[1]));
  try {
    context.peakFile = Math.max(context.peakFile, physicalSize());
  } catch {}
  if (context.migrating && ['set', 'delete', 'trim', 'clear'].includes(op)) {
    let after;
    try {
      after = physicalSize();
    } catch {}
    context.mutations.push({
      operation:
        op === 'set'
          ? key === 'bitpay.vault.scrub'
            ? 'set-filler'
            : 'set-root'
          : op,
      before: fileBefore,
      after,
      payloadBytes: op === 'set' ? Buffer.byteLength(value) : undefined,
      elapsedMs: Math.round((performance.now() - opStarted) * 1000) / 1000,
    });
  }
  const failures = /SHRINK_FAILURES=(\d+)/.exec(r.stderr || '');
  if (failures) context.shrinkFailures += Number(failures[1]);
  context.calls++;
  if (r.status === 10 && op === 'get') return undefined;
  if (r.status !== 0) throw Error('native call rejected');
  return r.stdout;
};
class Store {
  constructor(options) {
    this.id = options?.id ?? 'mmkv.default';
  }
  get data() {
    alive();
    if (!context.records.has(this.id)) context.records.set(this.id, new Map());
    return context.records.get(this.id);
  }
  get size() {
    return this.id === 'mmkv.default' ? Number(native('size')) : 0;
  }
  getString(k) {
    return this.id === 'mmkv.default' ? native('get', k) : this.data.get(k);
  }
  contains(k) {
    return this.getString(k) !== undefined;
  }
  getAllKeys() {
    return this.id === 'mmkv.default'
      ? native('keys').trim().split('\n').filter(Boolean)
      : [...this.data.keys()];
  }
  set(k, v) {
    if (this.id === 'mmkv.default') {
      native('set', k, v);
      context.operations.push(
        k === 'bitpay.vault.scrub' ? 'set-filler' : 'set-registered',
      );
    } else this.data.set(k, v);
  }
  delete(k) {
    if (this.id === 'mmkv.default') {
      native('delete', k);
      context.operations.push('delete');
    } else this.data.delete(k);
  }
  trim() {
    native('trim');
    context.operations.push('trim');
  }
  clearAll() {
    check(baseline, 'corrected code called clearAll');
    native('clear');
    context.operations.push('clear');
  }
}
const RNFS = {
  get DocumentDirectoryPath() {
    return context.dir;
  },
  get CachesDirectoryPath() {
    return path.join(context.dir, 'cache');
  },
  exists: async p => fs.existsSync(p),
  readFile: async p => fs.readFileSync(p, 'utf8'),
  mkdir: async p => fs.mkdirSync(p, {recursive: true}),
  writeFile: async (p, v) => fs.writeFileSync(p, v, {mode: 0o600}),
  unlink: async p => fs.unlinkSync(p),
  moveFile: async (a, b) => {
    if (fs.existsSync(b)) throw Error('destination exists');
    fs.renameSync(a, b);
  },
  stat: async p => {
    if (serial && p === context.file)
      return {isFile: () => true, size: physicalSize()};
    const s = fs.statSync(p);
    return {isFile: () => s.isFile(), size: s.size};
  },
};
const Keychain = {
  ACCESSIBLE: {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device'},
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'gcm'},
  SECURITY_LEVEL: {SECURE_SOFTWARE: 'software'},
  getGenericPassword: async ({service}) => context.keys.get(service) ?? false,
  setGenericPassword: async (username, password, {service}) => {
    context.keys.set(service, {username, password, storage: 'gcm'});
    return {service, storage: 'gcm'};
  },
  resetGenericPassword: async ({service}) => {
    context.keys.delete(service);
    return true;
  },
};
const asyncStorage = {
  getItem: async k => context.async.get(k) ?? null,
  removeItem: async k => context.async.delete(k),
};
// Preserve a killed process boundary: no subsequent native/mock write runs.
for (const boundary of [RNFS, Keychain, asyncStorage]) {
  for (const name of Object.keys(boundary)) {
    const descriptor = Object.getOwnPropertyDescriptor(boundary, name);
    if (typeof descriptor?.value === 'function') {
      const original = descriptor.value;
      boundary[name] = (...args) => {
        alive();
        return original(...args);
      };
    }
  }
}
const networkSource = fs
  .readFileSync(path.join(repo, 'src/constants/index.ts'), 'utf8')
  .match(/export enum Network \{[^}]+\}/)[0];
const networkModule = new Module('network-enum');
networkModule._compile(
  ts.transpileModule(networkSource, {
    compilerOptions: {module: ts.ModuleKind.CommonJS},
  }).outputText,
  'network-enum',
);
Module._load = function (request, parent, isMain) {
  if (request === 'react-native-mmkv') return {MMKV: Store};
  if (request === 'react-native-fs') return RNFS;
  if (request === 'react-native-keychain') return Keychain;
  if (request === 'react-native')
    return {Platform: {OS: serial ? 'android' : 'ios'}};
  if (request === 'react-native-device-info')
    return {getUniqueId: () => 'synthetic-legacy-fixture-key'};
  if (request === '@react-native-async-storage/async-storage')
    return asyncStorage;
  if (request === '@sentry/react-native') return {captureException: () => {}};
  if (
    /^\.\.\/(\.\.\/)?constants$/.test(request) &&
    parent?.filename.includes('/src/store/')
  )
    return networkModule.exports;
  return originalLoad.apply(this, arguments);
};
require.extensions['.ts'] = (mod, file) => {
  let source = fs.readFileSync(file, 'utf8');
  if (baseline && file === path.join(repo, 'src/store/vault-migration.ts'))
    source = cp.execFileSync(
      'git',
      [
        'show',
        '04486e844a90c4268e31cc2873c3392112a79c55:src/store/vault-migration.ts',
      ],
      {cwd: repo, encoding: 'utf8'},
    );
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    file,
  );
};
const fixture = require('./fixtures/legacy-14.32.json');
const Aes = require(path.join(repo, 'node_modules/crypto-js/aes.js'));
const C = require(path.join(repo, 'node_modules/crypto-js/core.js'));
const {createTransform} = require(path.join(
  repo,
  'node_modules/redux-persist',
));
const getStoredState = require(path.join(
  repo,
  'node_modules/redux-persist/lib/getStoredState',
)).default;
const encryption = require(path.join(repo, 'src/store/transforms/encrypt.ts'));
const {persistEncryptionTransform} = require(path.join(
  repo,
  'src/store/transforms/persist-encryption.ts',
));
const load = (raw, key) =>
  getStoredState({
    key: 'root',
    storage: {getItem: async () => raw},
    transforms: [
      createTransform(undefined, (state, reducer) =>
        reducer === 'WALLET'
          ? encryption.decryptWalletStore(state, key)
          : reducer === 'APP'
          ? encryption.decryptAppStore(state, key)
          : reducer === 'SHOP'
          ? encryption.decryptShopStore(state, key)
          : state,
      ),
      persistEncryptionTransform(key),
    ],
  });
const scan = () => {
  let decryptable = 0,
    markers = 0,
    plainEddsa = 0,
    unwrappedPasswordEddsa = 0;
  const files = [
    context.file,
    context.file + '.crc',
    path.join(context.dir, 'cache/bitpay/redux/persist-root.json'),
    path.join(context.dir, 'cache/bitpay/redux/persist-root.json.bak'),
  ];
  const rows = [];
  for (const f of files) {
    let data;
    if (serial && (f === context.file || f === context.file + '.crc')) {
      const r = adbRun([
        'exec-out',
        'cat',
        remoteDir() + '/mmkv/' + path.basename(f),
      ]);
      if (r.status !== 0) throw Error('native scan unavailable');
      data = r.stdout;
    } else {
      if (!fs.existsSync(f)) continue;
      data = fs.readFileSync(f);
    }
    const text = data.toString('latin1');
    let d = 0;
    const candidates = text.match(/U2FsdGVkX1[A-Za-z0-9+/=]+/g) || [];
    for (const candidate of candidates) {
      try {
        if (
          Aes.decrypt(candidate, 'synthetic-legacy-fixture-key').toString(
            C.enc.Utf8,
          ).length
        )
          d++;
      } catch {}
    }
    const eddsa =
      text.split(
        fixture.cases.plain.state.WALLET.keys.fixture.properties.xPrivKeyEDDSA,
      ).length - 1;
    const passwordCt = JSON.parse(
      fixture.cases.constructorPassword.state.WALLET.keys.fixture.properties
        .xPrivKeyEDDSAEncrypted,
    ).ct;
    const opaque = text.split(passwordCt).length - 1;
    unwrappedPasswordEddsa += opaque;
    rows.push({
      unwrappedEddsaPasswordCiphertextOccurrences: opaque,
      file: path.relative(context.dir, f),
      markerCount: candidates.length,
      identifierDecryptableCandidates: d,
      plaintextEddsaOccurrences: eddsa,
    });
    decryptable += d;
    markers += candidates.length;
    plainEddsa += eddsa;
  }
  return {
    decryptable,
    markers,
    plainEddsa,
    unwrappedPasswordEddsa,
    files: rows,
  };
};
const normalCases = baseline
  ? [{name: 'rejected-growth', bytes: 64, variant: 'whole', reject: true}]
  : [
      {name: 'minimum-capacity', bytes: 64, variant: 'plain'},
      {
        name: 'root-absent-no-live-source',
        bytes: 100000,
        variant: 'plain',
        drop: 'all',
        noLive: true,
      },
      {name: 'minimum-root-removed', bytes: 64, variant: 'plain', drop: 'root'},
      {name: 'two-megabyte', bytes: 2 * 1024 * 1024, variant: 'plain'},
      {
        name: 'four-megabyte',
        bytes: 4 * 1024 * 1024,
        variant: 'passwordOperation',
      },
      {
        name: 'large-root-removed',
        bytes: 100000,
        variant: 'plain',
        drop: 'root',
      },
      {name: 'no-key-history', bytes: 100000, variant: 'plain', drop: 'all'},
      {
        name: 'constructor-password-defensive',
        bytes: 100000,
        variant: 'constructorPassword',
      },
      {
        name: 'near-capacity-zero-filler',
        bytes: 64,
        variant: 'plain',
        tight: 'zero',
      },
      {
        name: 'near-capacity-deferral-retry',
        bytes: 64,
        variant: 'plain',
        tight: 'defer',
      },
      {name: 'rejected-growth', bytes: 64, variant: 'plain', reject: true},
      {
        name: 'failed-shrink-large',
        bytes: 100000,
        variant: 'plain',
        failShrink: true,
      },
      {
        name: 'failed-shrink-no-keys',
        bytes: 100000,
        variant: 'plain',
        drop: 'all',
        failShrink: true,
      },
      {
        name: 'leftover-filler-only',
        bytes: 100000,
        variant: 'plain',
        drop: 'all',
        leftover: true,
      },
    ];
const delays = [0, 0.00025, 0.0005, 0.001, 0.002, 0.004, 0.008, 0.012];
const cases = kills
  ? [
      ...['current', 'older', 'none', 'async'].flatMap(recovery =>
        delays.map((delay, trial) => ({
          name: `root-write-${recovery}-${trial}`,
          bytes: 8 * 1024 * 1024,
          variant: 'whole',
          phase: 'root-write',
          recovery,
          delay,
        })),
      ),
      ...[false, true].flatMap(purge =>
        delays.map((delay, trial) => ({
          name: `scrub-${purge ? 'purged' : 'kept'}-${trial}`,
          bytes: 8 * 1024 * 1024,
          variant: 'whole',
          phase: 'scrub',
          purge,
          recovery: 'current',
          delay,
        })),
      ),
    ]
  : normalCases;
(async () => {
  const results = [];
  for (const test of cases) {
    const dir = fs.mkdtempSync(path.join(scratch, test.name + '-'));
    fs.mkdirSync(path.join(dir, 'mmkv'));
    context = {
      dir,
      file: path.join(dir, 'mmkv/mmkv.default'),
      records: new Map(),
      keys: new Map(),
      async: new Map(),
      calls: 0,
      peakFile: 0,
      nativePeak: 0,
      operations: [],
      mutations: [],
      migrating: false,
      rejectGrowth: false,
      failShrink: false,
      shrinkFailures: 0,
    };
    if (serial)
      check(
        adbRun(['shell', 'mkdir', '-p', remoteDir() + '/mmkv']).status === 0,
        'native directory creation failed',
      );
    // Constants are evaluated per fresh module import, exactly as per-process app startup.
    for (const name of ['vault-migration', 'vault-scrub', 'backup/vault-files'])
      delete require.cache[path.join(repo, 'src/store', name + '.ts')];
    const {migrateVault} = require(path.join(
      repo,
      'src/store/vault-migration.ts',
    ));
    const store = new Store();
    const source = fixture.cases[test.variant];
    const state = JSON.parse(JSON.stringify(source.state));
    state.APP.padding = 'é🧭'.repeat(Math.ceil(test.bytes / 6));
    const outer = JSON.parse(source.raw);
    outer.APP = JSON.stringify(JSON.stringify(state.APP));
    const olderRaw = JSON.stringify(outer);
    if (test.phase) {
      const extra = JSON.parse(
        JSON.stringify(
          fixture.cases.constructorPassword.state.WALLET.keys.fixture,
        ),
      );
      extra.id = 'extra';
      state.WALLET.keys.extra = extra;
      outer.WALLET = JSON.stringify(
        Aes.encrypt(
          JSON.stringify(state.WALLET),
          'synthetic-legacy-fixture-key',
        ).toString(),
      );
    }
    const raw = JSON.stringify(outer);
    store.set('persist:logs', '[]');
    for (let i = 0; i < (test.phase ? 7 : 6); i++)
      store.set('persist:root', raw);
    if (test.drop) store.delete('persist:root');
    if (test.drop === 'all') store.delete('persist:logs');
    fs.mkdirSync(path.join(dir, 'cache/bitpay/redux'), {recursive: true});
    if (
      !test.noLive &&
      (!test.phase || test.recovery === 'current' || test.recovery === 'older')
    )
      fs.writeFileSync(
        path.join(dir, 'cache/bitpay/redux/persist-root.json'),
        test.recovery === 'older' ? olderRaw : raw,
        {mode: 0o600},
      );
    if (test.recovery === 'async') context.async.set('persist:root', raw);
    context.keys.set('bitpay-app-encryption-key', {
      password: 'synthetic-legacy-fixture-key',
      storage: 'gcm',
    });
    if (test.leftover) store.set('bitpay.vault.scrub', '0'.repeat(100000));
    context.failShrink = !!test.failShrink;
    const before = scan();
    check(before.decryptable > 0, 'seed contains no decryptable candidate');
    context.migrating = true;
    if (test.tight) {
      store.set('test.defer', 'setup');
      const key = await migrateVault(store);
      store.delete('test.defer');
      const live = JSON.parse(store.getString('persist:root'));
      const app = JSON.parse(JSON.parse(live.APP));
      app.padding = '';
      live.APP = JSON.stringify(JSON.stringify(app));
      const baseBytes = Buffer.byteLength(JSON.stringify(live));
      const {stringEntrySize} = require(path.join(
        repo,
        'src/store/vault-scrub.ts',
      ));
      const deletion = Buffer.byteLength('bitpay.vault.scrub') + 1 + 1;
      const tail =
        stringEntrySize('bitpay.vault.scrub', 0) +
        deletion +
        (test.tight === 'zero' ? 1 : 0);
      const F = 128 * 1024;
      const logEntry = stringEntrySize('persist:logs', 2);
      let low = 0,
        high = F;
      for (let i = 0; i < 32 && low < high; i++) {
        const n = Math.ceil((low + high) / 2);
        if (4 + logEntry + stringEntrySize('persist:root', n) <= F - 4 - tail)
          low = n;
        else high = n - 1;
      }
      check(low >= baseBytes, 'near-capacity fixture underflow');
      app.padding = 'G'.repeat(low - baseBytes);
      live.APP = JSON.stringify(JSON.stringify(app));
      const tightRaw = JSON.stringify(live);
      check(
        Buffer.byteLength(tightRaw) === low,
        'near-capacity byte calculation',
      );
      store.set('persist:root', tightRaw);
      context.primedKey = key;
    }
    context.rejectGrowth = !!test.reject;
    const started = performance.now();
    if (test.phase) context.kill = {phase: test.phase, delay: test.delay};
    let key;
    try {
      key = await migrateVault(store);
    } catch (e) {
      if (!test.reject && !test.phase) throw e;
    }
    if (test.phase) {
      context.dead = false;
      check(
        !!context.killResult?.operationMarkerObserved,
        'native operation marker missing',
      );
      const survivingPrimary = store.getString('persist:root');
      if (test.purge)
        for (const file of fs.readdirSync(path.join(dir, 'cache/bitpay/redux')))
          fs.unlinkSync(path.join(dir, 'cache/bitpay/redux', file));
      const storedKey = context.keys.get('bitpay-app-vault-key-v1').password;
      const usable = async raw => {
        if (!raw) return false;
        try {
          await load(raw, storedKey);
          return true;
        } catch {
          return false;
        }
      };
      const backupPath = path.join(dir, 'cache/bitpay/redux/persist-root.json');
      const recoverySource = (await usable(survivingPrimary))
        ? 'primary'
        : (await usable(
            fs.existsSync(backupPath)
              ? fs.readFileSync(backupPath, 'utf8')
              : undefined,
          ))
        ? 'main-backup'
        : 'none';
      let recoveryRejected = false;
      try {
        key = await migrateVault(store);
      } catch {
        recoveryRejected = true;
        check(
          test.phase === 'scrub' && test.purge && recoverySource === 'none',
          'unexpected recovery stop',
        );
        key = storedKey;
      }
      const primary = store.getString('persist:root');
      const backup = path.join(dir, 'cache/bitpay/redux/persist-root.json');
      const rawRecovered =
        primary ??
        (fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : undefined);
      const restored = (await usable(rawRecovered))
        ? await load(rawRecovered, key)
        : undefined;
      const count = Object.keys(restored?.WALLET?.keys ?? {}).length;
      const expected = recoverySource === 'none' ? 0 : 2;
      check(count === expected, 'unexpected recovered protected contents');
      if (expected > 0)
        check(
          JSON.stringify(restored.WALLET) === JSON.stringify(state.WALLET),
          'recovered signing material differs',
        );
      else check(recoveryRejected, 'lost converted wallet was admitted');
      if (!context.killResult.killed)
        check(count === 2, 'completed native operation lost data');
      const result = {
        ...test,
        ...context.killResult,
        recoverySource,
        recoveryRejected,
        recoveredKeys: count,
        newerProtectedMaterialPresent: !!restored?.WALLET?.keys?.extra,
        fullRecovery: count === 2,
        scenarioAssertionsPassed: true,
        elapsedMs: Math.round(performance.now() - started),
      };
      results.push(result);
      console.log(JSON.stringify(result));
      continue;
    }
    if (test.tight === 'defer') {
      const record = JSON.parse(
        context.records.get('bitpay.vault.migration').get('migration'),
      );
      check(
        record.status === 'started' && !record.wipeDone,
        'tight-tail case did not defer',
      );
      const live = JSON.parse(store.getString('persist:root'));
      const app = JSON.parse(JSON.parse(live.APP));
      app.padding = app.padding.slice(0, -64);
      live.APP = JSON.stringify(JSON.stringify(app));
      store.set('persist:root', JSON.stringify(live));
      key = await migrateVault(store);
    }
    if (test.reject) {
      // This assertion is RED against the unchanged starting implementation.
      check(store.contains('persist:root'), 'rejected scrub lost primary');
      const record = JSON.parse(
        context.records.get('bitpay.vault.migration').get('migration'),
      );
      check(
        !record.wipeDone && record.status === 'started',
        'rejected growth completed',
      );
      const backup = path.join(dir, 'cache/bitpay/redux/persist-root.json');
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      check(
        store.contains('persist:root'),
        'cache purge lost preserved primary',
      );
      context.rejectGrowth = false;
      key = await migrateVault(store);
    }
    if (test.noLive) check(!store.contains('persist:root'), 'fabricated root');
    else {
      const active =
        store.getString('persist:root') ??
        fs.readFileSync(
          path.join(dir, 'cache/bitpay/redux/persist-root.json'),
          'utf8',
        );
      const restored = await load(active, key);
      check(
        JSON.stringify(restored.WALLET) === JSON.stringify(state.WALLET),
        'recovered protected contents differ',
      );
    }
    const after = scan();
    check(
      after.decryptable === 0 &&
        after.plainEddsa === 0 &&
        after.unwrappedPasswordEddsa === 0,
      'recoverable legacy data remains',
    );
    check(!store.contains('bitpay.vault.scrub'), 'filler remains');
    const record = JSON.parse(
      context.records.get('bitpay.vault.migration').get('migration'),
    );
    check(record.status === 'complete' && record.wipeDone, 'not complete');
    if (test.failShrink)
      check(context.shrinkFailures > 0, 'shrink failure was not exercised');
    const result = {
      ...test,
      passed: true,
      before,
      after,
      elapsedMs: Math.round(performance.now() - started),
      peakFileBytes: context.peakFile,
      finalFileBytes: physicalSize(),
      nativeWorkerPeakBytes: context.nativePeak,
      nativeShrinkFailures: context.shrinkFailures,
      nodeProcessPeakRssKiB: process.resourceUsage().maxRSS,
      nativeCalls: context.calls,
      mutations: context.mutations,
    };
    results.push(result);
    console.log(
      JSON.stringify({
        case: test.name,
        passed: true,
        afterDecryptable: after.decryptable,
        afterPlaintextEddsa: after.plainEddsa,
      }),
    );
  }
  fs.writeFileSync(
    path.join(scratch, 'results.json'),
    JSON.stringify(
      {
        platform: serial
          ? 'Android core (host-controlled platform mocks)'
          : process.platform,
        arch: process.arch,
        pageBytes: Number(
          serial
            ? adbRun(['shell', 'getconf', 'PAGE_SIZE'], {encoding: 'utf8'})
                .stdout
            : cp.execFileSync('getconf', ['PAGESIZE'], {encoding: 'utf8'}),
        ),
        sourceHashes,
        baseline,
        results,
      },
      null,
      2,
    ) + '\n',
  );
})().catch(e => {
  const allowed = [
    'rejected scrub lost primary',
    'rejected growth completed',
    'cache purge lost preserved primary',
    'recovered protected contents differ',
    'recoverable legacy data remains',
    'filler remains',
    'not complete',
    'seed contains no decryptable candidate',
    'shrink failure was not exercised',
    'root write did not require compaction',
    'native kill driver failed',
    'native operation marker missing',
    'unexpected recovered protected contents',
    'unexpected recovery stop',
    'lost converted wallet was admitted',
    'fabricated root',
    'recovered signing material differs',
    'unexpected empty replacement',
    'completed native operation lost data',
  ];
  console.error(
    JSON.stringify({
      failed: true,
      reason: allowed.includes(e.message)
        ? e.message
        : 'native harness failure',
    }),
  );
  process.exitCode = 1;
});
