import Aes from 'crypto-js/aes.js';
import isEqual from 'lodash.isequal';
import {createTransform} from 'redux-persist';
import getStoredState from 'redux-persist/lib/getStoredState';
import {decodeSnapshot, reencryptSnapshot, verifySnapshot} from './vault-codec';
import {
  deserializeModernPersistValue,
  decryptValue,
} from './transforms/encrypt';
import {encryptSpecificFields} from './transforms/transforms';
import {unencryptedPersistStores} from './transforms/persist-encryption';

const fixtures = require('../../test/vault/fixtures/legacy-14.32.json').cases;
const oldKey = 'synthetic-legacy-fixture-key';
const newKey = Buffer.alloc(32, 71).toString('base64');
const safeEqual = (actual: unknown, expected: unknown) =>
  expect(isEqual(actual, expected)).toBe(true);

it.each(Object.keys(fixtures))(
  'converts historical %s with complete equality and the actual persistence transforms',
  async name => {
    const {raw, state} = fixtures[name];
    const output = reencryptSnapshot(raw, oldKey, newKey);
    safeEqual(decodeSnapshot(output, newKey).payload, state);
    const loaded = await getStoredState({
      key: 'root',
      storage: {getItem: async () => output},
      transforms: [
        encryptSpecificFields(newKey),
        createTransform(undefined, (value, key) =>
          deserializeModernPersistValue(
            value,
            newKey,
            String(key),
            unencryptedPersistStores.has(String(key)),
          ),
        ),
      ],
    } as any);
    safeEqual(loaded, state);
    expect(() => decodeSnapshot(output, oldKey)).toThrow();
  },
);

it('preserves unknown fields, LOG, caches, order and own __proto__ properties in whole CBC', () => {
  const payload = JSON.parse(JSON.stringify(fixtures.whole.state));
  payload.LOG = {
    logs: ['retain embedded log'],
    extra: [null, false, 5, {nested: 'public'}],
  };
  payload.PORTFOLIO = {
    cache: {
      series: [
        [3, 8],
        [1, 2],
      ],
    },
  };
  Object.defineProperty(payload, '__proto__', {
    value: {unknown: true},
    enumerable: true,
  });
  Object.defineProperty(payload.WALLET, '__proto__', {
    value: {extra: [1, 0]},
    enumerable: true,
  });
  const raw = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).map(([name, value]) => [
        name,
        JSON.stringify(Aes.encrypt(JSON.stringify(value), oldKey).toString()),
      ]),
    ),
  );
  const output = reencryptSnapshot(raw, oldKey, newKey);
  safeEqual(decodeSnapshot(output, newKey).payload, payload);
});

it('decodes nested legacy field encryption inside a whole CBC reducer', () => {
  const raw = JSON.parse(fixtures.plain.raw);
  raw.WALLET = JSON.stringify(
    Aes.encrypt(JSON.parse(raw.WALLET), oldKey).toString(),
  );
  safeEqual(
    decodeSnapshot(
      reencryptSnapshot(JSON.stringify(raw), oldKey, newKey),
      newKey,
    ).payload,
    fixtures.plain.state,
  );
});

it.each(['xPrivKeyEDDSA', 'xPrivKeyEDDSAEncrypted'])(
  'rejects unqualified historical %s and never returns partial output',
  field => {
    const outer = JSON.parse(fixtures.plain.raw);
    const wallet = JSON.parse(JSON.parse(outer.WALLET));
    wallet.keys.fixture.properties[field] = 'not-a-key';
    outer.WALLET = JSON.stringify(JSON.stringify(wallet));
    expect(() =>
      reencryptSnapshot(JSON.stringify(outer), oldKey, newKey),
    ).toThrow('INVALID_LEGACY_INPUT');
  },
);

it('rejects a mixed-key snapshot even when each candidate could decrypt some fields', () => {
  const outer = JSON.parse(fixtures.plain.raw);
  const wallet = JSON.parse(JSON.parse(outer.WALLET));
  wallet.keys.fixture.properties.mnemonic =
    'encrypted:' + Aes.encrypt('synthetic fixture', 'another-key').toString();
  outer.WALLET = JSON.stringify(JSON.stringify(wallet));
  for (const key of [oldKey, 'another-key'])
    expect(() =>
      reencryptSnapshot(JSON.stringify(outer), key, newKey),
    ).toThrow();
});

it('checks exact output bytes and full payload independently', () => {
  const {raw, state} = fixtures.plain;
  const output = reencryptSnapshot(raw, oldKey, newKey);
  expect(() => verifySnapshot(output + ' ', output, state, newKey)).toThrow();
  expect(() =>
    verifySnapshot(output, output, {...state, extra: {}}, newKey),
  ).toThrow();
});

it('ordinary modern reads reject CBC even with the same key', () => {
  const cbc = Aes.encrypt(JSON.stringify({data: 'fixture'}), newKey).toString();
  expect(() =>
    deserializeModernPersistValue(cbc, newKey, 'CONTACT', false),
  ).toThrow();
  expect(() =>
    decryptValue('encrypted:' + cbc, newKey, 'field', true),
  ).toThrow();
});
