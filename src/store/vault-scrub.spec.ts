import RNFS from 'react-native-fs';
import isEqual from 'lodash.isequal';
import {MMKV} from 'react-native-mmkv';
import {MmkvModel, entry} from '../../test/vault/mmkv-model';
import {
  planScrub,
  compactedSize,
  stringEntrySize,
  SMALL_MMKV_FILE,
  scrubVault,
  VAULT_SCRUB_KEY,
} from './vault-scrub';
import {vaultError} from './vault-diagnostics';
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/test',
  stat: jest.fn(),
}));
jest.mock('@sentry/react-native', () => ({captureException: jest.fn()}));

const setup = (
  page = 4096,
  rootBytes = 200,
  history = 6,
  rootPresent = true,
) => {
  const values = new Map<string, string>();
  const model = new MmkvModel(values, page);
  model.set('persist:logs', '[]');
  for (let i = 0; i < history; i++)
    model.set('persist:root', 'U2FsdGVkX1' + 'L'.repeat(rootBytes) + i);
  const modern = 'modern-é-🧭' + 'G'.repeat(rootBytes);
  model.set('persist:root', modern);
  if (!rootPresent) model.delete('persist:root');
  const expected = new Map(values);
  const codes: string[] = [];
  const storage = {
    get size() {
      return model.actual;
    },
    getAllKeys: () => [...values.keys()],
    contains: (k: string) => values.has(k),
    getString: (k: string) => values.get(k),
    set: jest.fn((k: string, v: string) => model.set(k, v)),
    delete: jest.fn((k: string) => model.delete(k)),
    trim: jest.fn(() => model.trim()),
  } as unknown as MMKV;
  const guard = () => {
    const now = new Map([...values].filter(([k]) => k !== VAULT_SCRUB_KEY));
    if (expected.has('persist:root') && !now.has('persist:root'))
      throw vaultError('PRESERVATION_FAILURE', 'scrub');
    if (!isEqual(now, expected)) {
      codes.push('SCRUB_STATE_CHANGED');
      return false;
    }
    return true;
  };
  (RNFS.stat as jest.Mock).mockImplementation(async () => ({
    isFile: () => true,
    size: model.bytes.length,
  }));
  const run = () =>
    scrubVault(
      storage,
      expected,
      guard,
      code => codes.push(code),
      async () => true,
    );
  return {values, model, storage, expected, codes, run};
};
beforeEach(() => jest.resetAllMocks());
it.each([
  0, 1, 125, 126, 127, 128, 16381, 16382, 16383, 16384, 2097148, 2097150,
  2097151, 2097152,
])(
  'A: encoded UTF-8 lengths match independent byte encoding around %s',
  bytes => {
    for (const key of [
      'persist:root',
      'persist:logs',
      'bitpay.vault.scrub',
      'é🧭',
    ]) {
      const value = 'x'.repeat(bytes);
      expect(stringEntrySize(key, Buffer.byteLength(value))).toBe(
        entry(key, value).length,
      );
    }
    const utf8 = 'é🧭'.repeat(50);
    expect(stringEntrySize('persist:root', Buffer.byteLength(utf8))).toBe(
      entry('persist:root', utf8).length,
    );
  },
);
it.each([65535, 65536, 65537, 131072])(
  'A: threshold boundary %s and strict encoded-tail reserve',
  file => {
    const values = new Map([
      ['persist:root', '🧭'.repeat(80)],
      ['persist:logs', '[]'],
    ]);
    const actual =
      4 + [...values].reduce((n, [k, v]) => n + entry(k, v).length, 0);
    const plan = planScrub(file, actual, values)!;
    expect(plan.mode).toBe(file <= SMALL_MMKV_FILE ? 'overfill' : 'tail');
    if (plan.mode === 'tail') {
      const free = file - 4 - actual;
      const deletion = entry(VAULT_SCRUB_KEY).length;
      expect(
        entry(VAULT_SCRUB_KEY, '0'.repeat(plan.bytes)).length + deletion < free,
      ).toBe(true);
      expect(
        entry(VAULT_SCRUB_KEY, '0'.repeat(plan.bytes + 1)).length + deletion >=
          free,
      ).toBe(true);
      expect(plan.gap >= 1 && plan.gap <= 3).toBe(true);
    }
  },
);
it('A: uncompacted, omitted-entry and stale calculations cannot authorize the large-file branch', () => {
  const values = new Map([
    ['persist:root', 'current'],
    ['persist:logs', 'logs'],
  ]);
  const actual = compactedSize(values);
  expect(planScrub(131072, actual + 10, values)).toBeUndefined();
  expect(
    planScrub(131072, actual, new Map([['persist:root', 'current']])),
  ).toBeUndefined();
  expect(
    planScrub(
      131072,
      actual,
      new Map([
        ['persist:root', 'different length'],
        ['persist:logs', 'logs'],
      ]),
    ),
  ).toBeUndefined();
  expect(planScrub(131072, actual, values)?.mode).toBe('tail');
  expect(planScrub(131072, 0, new Map())?.base).toBe(4);
  expect(planScrub(131072, 4, new Map())).toBeUndefined();
});
it.each([4096, 16384])(
  'A: minimum-capacity no-op trim needs overfill (%s-byte simulated page)',
  async page => {
    const t = setup(page, 100, 4);
    expect(t.model.bytes.length).toBe(page);
    const before = t.model.actual;
    t.model.trim();
    expect(t.model.actual).toBe(before);
    expect(t.model.bytes.includes(Buffer.from('U2FsdGVkX1'))).toBe(true);
    expect(await t.run()).toBe(true);
    expect(t.model.bytes.includes(Buffer.from('U2FsdGVkX1'))).toBe(false);
    expect(isEqual(t.values, t.expected)).toBe(true);
    expect(t.model.peak > page).toBe(true);
  },
);
it.each([true, false])(
  'A: multi-megabyte history obeys its hybrid growth bound (root present=%s)',
  async present => {
    const t = setup(4096, 2 * 1024 * 1024, 6, present);
    t.model.trim();
    const file = t.model.bytes.length;
    const bound = planScrub(file, t.model.actual, t.expected)!.maxFile;
    t.model.peak = file;
    expect(await t.run()).toBe(true);
    // Removing the root can leave only a minimum-capacity log dictionary.
    // That legitimate small-file branch overfills; it is not a no-growth claim.
    expect(t.model.peak <= bound).toBe(true);
    expect(isEqual(t.values, t.expected)).toBe(true);
    expect(t.model.bytes.includes(Buffer.from('U2FsdGVkX1'))).toBe(false);
  },
);
it('A: already compact large layout can pass even when trim is a no-op', async () => {
  const t = setup(4096, 100000, 3);
  t.model.trim();
  t.model.trimNoop = true;
  expect(t.model.actual).toBe(compactedSize(t.expected));
  expect(await t.run()).toBe(true);
});
it('A: uncompacted large layout safely defers without filler allocation', async () => {
  const t = setup(4096, 100000, 3);
  t.model.trimNoop = true;
  expect(t.model.actual).not.toBe(compactedSize(t.expected));
  expect(await t.run()).toBe(false);
  expect(t.storage.set).not.toHaveBeenCalled();
  expect(isEqual(t.values, t.expected)).toBe(true);
});
it.each([true, false])(
  'A: failed shrink remains scrub-able, without assuming truncation succeeded (root=%s)',
  async present => {
    const t = setup(4096, 100000, 5, present);
    t.model.failShrink = true;
    const file = t.model.bytes.length;
    t.model.peak = file;
    expect(await t.run()).toBe(true);
    expect(t.model.peak).toBe(file);
    expect(t.model.bytes.includes(Buffer.from('U2FsdGVkX1'))).toBe(false);
  },
);
it.each([true, false])(
  'A: rejected small-file growth preserves values and retries (root=%s)',
  async present => {
    const t = setup(4096, 200, 3, present);
    t.model.rejectGrowth = true;
    expect(await t.run()).toBe(false);
    expect(isEqual(t.values, t.expected)).toBe(true);
    expect(t.codes).toContain('SCRUB_WRITE_REJECTED');
    t.model.rejectGrowth = false;
    expect(await t.run()).toBe(true);
    expect(isEqual(t.values, t.expected)).toBe(true);
  },
);
it.each(['none', 'filler-only'])(
  'A: zero-entry history and %s restart state are explicit',
  async mode => {
    const t = setup(4096, 60000, 4, false);
    t.model.delete('persist:logs');
    t.expected.clear();
    if (mode === 'filler-only')
      t.model.set(VAULT_SCRUB_KEY, '0'.repeat(100000));
    expect(await t.run()).toBe(true);
    expect(t.values.size).toBe(0);
    expect(t.model.bytes.includes(Buffer.from('U2FsdGVkX1'))).toBe(false);
  },
);
it.each([
  'missing',
  'directory',
  'zero',
  'negative',
  'fraction',
  'infinity',
  'nan',
  'unsafe',
  'string',
])('A: metadata %s defers and retains usable primary', async kind => {
  const t = setup();
  if (kind === 'missing')
    (RNFS.stat as jest.Mock).mockRejectedValueOnce(new Error('missing'));
  else
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({
      isFile: () => kind !== 'directory',
      size: (
        {
          directory: 4096,
          zero: 0,
          negative: -1,
          fraction: 4096.5,
          infinity: Infinity,
          nan: NaN,
          unsafe: Number.MAX_SAFE_INTEGER + 1,
          string: '4096',
        } as any
      )[kind],
    });
  expect(await t.run()).toBe(false);
  expect(isEqual(t.values, t.expected)).toBe(true);
  expect(t.storage.set).not.toHaveBeenCalled();
  expect(t.codes).toContain('SCRUB_MEASUREMENT_DEFERRED');
  expect(await t.run()).toBe(true);
});
it('A: a newer value during measurement is not overwritten by a stale plan', async () => {
  const t = setup();
  (RNFS.stat as jest.Mock).mockImplementationOnce(async () => {
    t.model.set('persist:root', 'newer modern root');
    return {isFile: () => true, size: t.model.bytes.length};
  });
  expect(await t.run()).toBe(false);
  expect(t.values.get('persist:root')).toBe('newer modern root');
  expect(t.storage.set).not.toHaveBeenCalled();
});
it('A: a disappeared primary during measurement stops rather than treating the race as harmless', async () => {
  const t = setup();
  (RNFS.stat as jest.Mock).mockImplementationOnce(async () => {
    t.model.delete('persist:root');
    return {isFile: () => true, size: t.model.bytes.length};
  });
  await expect(t.run()).rejects.toThrow('PRESERVATION_FAILURE');
  expect(t.storage.set).not.toHaveBeenCalled();
});
it('A: physical size changing across measurements invalidates the plan', async () => {
  const t = setup();
  (RNFS.stat as jest.Mock)
    .mockResolvedValueOnce({isFile: () => true, size: 4096})
    .mockResolvedValueOnce({isFile: () => true, size: 8192});
  expect(await t.run()).toBe(false);
  expect(t.storage.set).not.toHaveBeenCalled();
  expect(t.codes).toContain('SCRUB_STATE_CHANGED');
});
it('A: a purged backup after measurement prevents compaction-capable filling', async () => {
  const t = setup();
  expect(
    await scrubVault(
      t.storage,
      t.expected,
      () => true,
      c => t.codes.push(c),
      async () => false,
    ),
  ).toBe(false);
  expect(t.storage.set).not.toHaveBeenCalled();
  expect(isEqual(t.values, t.expected)).toBe(true);
});
it.each([
  ['missing', true],
  ['missing', false],
  ['invalid', true],
  ['invalid', false],
  ['changed', false],
  ['unchanged', false],
] as const)(
  'A: backup-check ordering validates %s primary after backup resolves %s',
  async (state, currentBackup) => {
    const t = setup();
    const calls: string[] = [];
    const guard = () => {
      calls.push('guard');
      const primary = t.values.get('persist:root');
      if (primary === undefined || primary === 'invalid root')
        throw vaultError('PRESERVATION_FAILURE', 'scrub');
      return isEqual(t.values, t.expected);
    };
    const attempt = scrubVault(
      t.storage,
      t.expected,
      guard,
      code => t.codes.push(code),
      async () => {
        await Promise.resolve();
        if (state === 'missing') t.model.delete('persist:root');
        if (state === 'invalid') t.model.set('persist:root', 'invalid root');
        if (state === 'changed') t.model.set('persist:root', 'new valid root');
        calls.push('backup resolved');
        return currentBackup;
      },
    );
    if (state === 'missing' || state === 'invalid')
      await expect(attempt).rejects.toThrow('PRESERVATION_FAILURE');
    else await expect(attempt).resolves.toBe(false);
    expect(calls.slice(-2)).toEqual(['backup resolved', 'guard']);
    expect(t.storage.set).not.toHaveBeenCalled();
    expect(t.storage.delete).not.toHaveBeenCalled();
    expect(t.storage.trim).toHaveBeenCalledTimes(1);
  },
);
it('A: backup-check ordering keeps a rejected backup read strict', async () => {
  const t = setup();
  const failure = new Error('synthetic backup read failure');
  const guard = jest.fn(() => true);
  const defer = jest.fn();
  await expect(
    scrubVault(t.storage, t.expected, guard, defer, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(defer).not.toHaveBeenCalled();
  expect(t.storage.set).not.toHaveBeenCalled();
  expect(t.storage.delete).not.toHaveBeenCalled();
});
it('A: interrupted filler writes resume without the same-key overwrite shortcut or repeated growth', async () => {
  const t = setup(4096, 40000, 5);
  t.model.failShrink = true;
  let maximum = t.model.bytes.length;
  for (let i = 0; i < 4; i++) {
    let calls = 0;
    (RNFS.stat as jest.Mock).mockImplementation(async () => {
      calls++;
      if (calls === 3) throw new Error('interrupted after filler');
      return {isFile: () => true, size: t.model.bytes.length};
    });
    await t.run();
    maximum = Math.max(maximum, t.model.bytes.length);
  }
  (RNFS.stat as jest.Mock).mockImplementation(async () => ({
    isFile: () => true,
    size: t.model.bytes.length,
  }));
  expect(await t.run()).toBe(true);
  expect(t.values.has(VAULT_SCRUB_KEY)).toBe(false);
  expect(isEqual(t.values, t.expected)).toBe(true);
  expect(t.model.peak <= Math.max(maximum, 20 * SMALL_MMKV_FILE + 1024)).toBe(
    true,
  );
});

it('A: an encoded empty filler handles the tightest viable large tail; a smaller tail safely defers', async () => {
  const file = 2 * SMALL_MMKV_FILE;
  const overhead = stringEntrySize('persist:root', file) - file;
  const values = new Map([
    ['persist:root', 'G'.repeat(file - 4 - 4 - overhead - 42)],
  ]);
  const actual = compactedSize(values);
  const plan = planScrub(file, actual, values)!;
  expect(plan.mode).toBe('tail');
  expect(plan.bytes).toBe(0);
  expect(plan.gap).toBe(1);
  expect(
    planScrub(
      file,
      actual + 1,
      new Map([['persist:root', values.get('persist:root')! + 'G']]),
    ),
  ).toBeUndefined();
  const model = new MmkvModel(new Map());
  model.set('persist:root', values.get('persist:root'));
  model.trim();
  expect(model.bytes.length).toBe(file);
  const storage = {
    get size() {
      return model.actual;
    },
    getAllKeys: () => [...model.values.keys()],
    contains: (k: string) => model.values.has(k),
    getString: (k: string) => model.values.get(k),
    set: (k: string, v: string) => model.set(k, v),
    delete: (k: string) => model.delete(k),
    trim: () => model.trim(),
  } as unknown as MMKV;
  (RNFS.stat as jest.Mock).mockImplementation(async () => ({
    isFile: () => true,
    size: model.bytes.length,
  }));
  expect(
    await scrubVault(
      storage,
      values,
      () =>
        isEqual(
          new Map([...model.values].filter(([k]) => k !== VAULT_SCRUB_KEY)),
          values,
        ),
      () => {},
      async () => true,
    ),
  ).toBe(true);
  expect(model.values.has(VAULT_SCRUB_KEY)).toBe(false);
});
