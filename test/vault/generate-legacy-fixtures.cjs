// Run in the application checkout: node test/vault/generate-legacy-fixtures.cjs <isolated-harness-directory>
// The isolated project must use the supplied lockfile (BWC 10.10.0) and the exact
// archived redux-persist-transform-encrypt 3.0.1 patch. No app dependencies change.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const Module = require('module');
const assert = require('assert');
const dir = path.resolve(process.argv[2]);
const req = Module.createRequire(path.join(dir, 'package.json'));
assert.equal(req('bitcore-wallet-client/package.json').version, '10.10.0');
assert.equal(
  req('redux-persist-transform-encrypt/package.json').version,
  '3.0.1',
);
const patched = fs.readFileSync(
  req.resolve('redux-persist-transform-encrypt/lib/sync.js'),
  'utf8',
);
assert(patched.includes('unencryptedStores.includes(_key)'));
const ts = req('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true},
    }).outputText,
    filename,
  );
require.extensions['.source'] = require.extensions['.ts'];
const archivedFile = ['encrypt.ts', 'encrypt.ts.source']
  .map(name => path.join(dir, 'released/v14_32_0', name))
  .find(file => fs.existsSync(file));
const source = cp.execFileSync(
  'git',
  ['show', 'v.14.32.0:src/store/transforms/encrypt.ts'],
  {encoding: 'utf8'},
);
const archived = fs.readFileSync(archivedFile, 'utf8');
assert.equal(
  archived.replace("from '../constants'", "from '../../constants'"),
  source,
);
const e = require(archivedFile);
const {Key} = req('bitcore-wallet-client/ts_build/lib/key');
const {createTransform} = req('redux-persist');
const createPersistoid = req('redux-persist/lib/createPersistoid').default;
const {encryptTransform} = req('redux-persist-transform-encrypt');
const password = 'throwaway-fixture-password';
const legacy = 'synthetic-legacy-fixture-key';
const key = new Key({seedType: 'new'});
const plain = key.toObj();
key.encrypt(password);
const passwordOperation = key.toObj();
const constructorPassword = new Key({seedType: 'new', password}).toObj();
const serialize = async (properties, whole = false) => {
  const state = {
    APP: {migrationMMKVStorageComplete: true},
    WALLET: {keys: {fixture: {id: 'fixture', properties, wallets: []}}},
    SHOP: {giftCards: {livenet: []}},
    CONTACT: {list: []},
    _persist: {version: -1, rehydrated: true},
  };
  let raw;
  const field = createTransform((value, reducer) =>
    reducer === 'WALLET'
      ? e.encryptWalletStore(value, legacy)
      : reducer === 'APP'
      ? e.encryptAppStore(value, legacy)
      : reducer === 'SHOP'
      ? e.encryptShopStore(value, legacy)
      : value,
  );
  const persist = createPersistoid({
    key: 'root',
    storage: {
      setItem: async (_k, v) => {
        raw = v;
      },
    },
    transforms: [
      field,
      encryptTransform({
        secretKey: legacy,
        unencryptedStores: whole
          ? []
          : ['APP', 'RATE', 'SHOP', 'SHOP_CATALOG', 'WALLET'],
      }),
    ],
  });
  persist.update(state);
  await persist.flush();
  return {state, raw};
};
(async () => {
  const cases = {
    plain: await serialize(plain),
    passwordOperation: await serialize(passwordOperation),
    constructorPassword: await serialize(constructorPassword),
    whole: await serialize(plain, true),
  };
  assert(plain.xPrivKeyEDDSA && passwordOperation.xPrivKeyEDDSA);
  assert(
    !passwordOperation.xPrivKeyEDDSAEncrypted &&
      passwordOperation.xPrivKeyEncrypted,
  );
  assert(constructorPassword.xPrivKeyEDDSAEncrypted);
  const fixture = {
    notice:
      'PUBLIC THROWAWAY TEST KEYS. NEVER FUND. Generated in an isolated project; not a captured device save.',
    password,
    cases,
  };
  const out = path.join(process.cwd(), 'test/vault/fixtures/legacy-14.32.json');
  fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
  const digest = b => crypto.createHash('sha256').update(b).digest('hex');
  const provenance = {
    appTag: 'v.14.32.0',
    appCommit: cp
      .execFileSync('git', ['rev-parse', 'v.14.32.0^{commit}'], {
        encoding: 'utf8',
      })
      .trim(),
    walletClient: '10.10.0',
    fieldSourceSha256: digest(source),
    patchedTransformSha256: digest(patched),
    harnessLockSha256: digest(
      fs.readFileSync(path.join(dir, 'package-lock.json')),
    ),
    fixtureSha256: digest(fs.readFileSync(out)),
    cases: {
      plain: 'Library-generated app-path-style state before encrypt(password)',
      passwordOperation:
        'Same throwaway key after the historical encrypt(password) operation; EDDSA remains unwrapped',
      constructorPassword:
        'Library-supported constructor-password defensive fixture; not claimed as a shipped-app creation flow',
      whole:
        'Defensive historical whole-reducer CBC layout using the patched serializer; not claimed as a 14.32.0 creation flow',
    },
  };
  fs.writeFileSync(
    path.join(path.dirname(out), 'provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      fixturesGenerated: 4,
      appPasswordLeavesEddsaUnwrapped: true,
      constructorPasswordDefensiveFixture: true,
    }),
  );
})().catch(() => {
  console.error('Fixture generation failed');
  process.exitCode = 1;
});
