import {
  createInternalVaultReplay,
  createReplayState,
  INTERNAL_VAULT_REPLAY,
  INTERNAL_REPLAY_STORE,
} from './internal-vault-replay';
import {createReplayArmer, ReplayNotice} from './internal-vault-replay-arming';
import {createInternalReplayWriteGate} from './internal-vault-replay-writes';
import type {TransferRecord} from './vault-transfer';
import {createStoreModel} from '../../test/vault/store-model';

const record = (
  source: TransferRecord['copies']['root'] = 'mmkv',
  phase: TransferRecord['phase'] = 'active',
): TransferRecord => ({
  version: 3,
  layout: 'bitpay.wallet.v2',
  phase,
  owned: true,
  copies: {
    root: source,
    main: source === 'main' ? 'main' : null,
    bak: source === 'bak' ? 'bak' : null,
  },
  release: {
    data: source === 'mmkv',
    crc: source === 'mmkv',
    async: source === 'async',
    main: source === 'main',
    bak: source === 'bak',
    temp: true,
  },
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const modern = {
  main: '/cache/bitpay/redux-v2/persist-root.json',
  bak: '/cache/bitpay/redux-v2/persist-root.json.bak',
  temp: '/cache/bitpay/redux-v2/persist-root.json.tmp',
};
const legacy = {
  data: '/mmkv/mmkv.default',
  crc: '/mmkv/mmkv.default.crc',
  main: '/cache/bitpay/redux/persist-root.json',
  bak: '/cache/bitpay/redux/persist-root.json.bak',
};

const model = () => {
  const events: string[] = [];
  const faults = new Map<string, number>();
  const silent = new Set<string>();
  const step = (name: string) => {
    events.push(name);
    const left = faults.get(name);
    if (left !== undefined) {
      if (left === 1) {
        faults.delete(name);
        throw new Error('synthetic interruption');
      }
      faults.set(name, left - 1);
    }
  };
  const store = (id: string) => {
    const values = new Map<string, unknown>();
    return {
      values,
      getString: jest.fn((key: string) => {
        step(id + ':read');
        const value = values.get(key);
        return typeof value === 'string' ? value : undefined;
      }),
      contains: jest.fn((key: string) => {
        step(id + ':contains');
        return values.has(key);
      }),
      getAllKeys: jest.fn(() => {
        step(id + ':keys');
        return [...values.keys()];
      }),
      set: jest.fn((key: string, value: unknown) => {
        step(id + ':set:' + String(value));
        values.set(key, value);
      }),
      delete: jest.fn((key: string) => {
        const label = id + ':delete:' + key;
        step(label);
        if (!silent.has(label)) values.delete(key);
      }),
    };
  };
  const marker = store('marker');
  const wallet = store('wallet');
  const control = store('control');
  wallet.values.set('persist:root', 'current modern wallet');
  wallet.values.set('other-modern-key', 'discard');
  control.values.set('transfer', JSON.stringify(record()));
  control.values.set('extra', 'discard');
  const data = new Map<string, string>(
    [...Object.values(modern), ...Object.values(legacy)].map(path => [
      path,
      'original:' + path,
    ]),
  );
  let retired = false;
  const files = {
    exists: jest.fn(async (path: string) => {
      step('exists:' + path);
      return data.has(path);
    }),
    unlink: jest.fn(async (path: string) => {
      const label = 'unlink:' + path;
      step(label);
      if (!silent.has(label)) data.delete(path);
    }),
  };
  const asyncKeys = jest.fn(async () => {
    step('async:keys');
    return ['persist:root'];
  });
  const access = jest.fn(() => {
    step('access');
    return {
      wallet,
      control,
      legacyPair: () => {
        step('legacy:paths');
        return legacy;
      },
      legacyFiles: () => legacy,
      modernFiles: () => modern,
    };
  });
  const state = createReplayState(() => marker);
  const replay = createInternalVaultReplay(access, {
    state,
    files,
    asyncKeys,
    retirementEnabled: () => {
      step('policy');
      return retired;
    },
  });
  return {
    events,
    marker,
    wallet,
    control,
    data,
    files,
    state,
    replay,
    access,
    asyncKeys,
    silent,
    fail: (name: string, occurrence = 1) => faults.set(name, occurrence),
    setRetired: (value: boolean) => {
      retired = value;
    },
    setRecord: (
      source: TransferRecord['copies']['root'],
      phase: TransferRecord['phase'] = 'active',
    ) => control.values.set('transfer', JSON.stringify(record(source, phase))),
    emptyModern: () => {
      wallet.values.clear();
      control.values.clear();
      Object.values(modern).forEach(path => data.delete(path));
    },
  };
};

afterEach(() => jest.restoreAllMocks());

describe('internal replay eligibility and marker', () => {
  it.each(['mmkv', 'async', 'main', 'bak'] as const)(
    'accepts an active migrated %s source using existence only',
    async source => {
      const m = model();
      m.setRecord(source);
      expect((await m.replay.eligibility()).kind).toBe('passes');
      expect(m.files.unlink).not.toHaveBeenCalled();
      expect(m.wallet.getAllKeys).not.toHaveBeenCalled();
      expect(m.marker.getString).not.toHaveBeenCalled();
    },
  );

  it.each([
    'fresh',
    'retired',
    'preparing',
    'missing-record',
    'retirement-enabled',
  ])('definitely refuses %s', async condition => {
    const m = model();
    if (condition === 'fresh') m.setRecord(null);
    if (condition === 'retired' || condition === 'preparing')
      m.setRecord('mmkv', condition);
    if (condition === 'missing-record') m.control.values.delete('transfer');
    if (condition === 'retirement-enabled') m.setRetired(true);
    const result = await m.replay.eligibility();
    expect(result.kind).toBe('fails');
    expect(result).toHaveProperty('condition', expect.any(String));
    expect(m.files.unlink).not.toHaveBeenCalled();
  });

  it.each([
    ['mmkv', legacy.data],
    ['mmkv', legacy.crc],
    ['main', legacy.main],
    ['bak', legacy.bak],
    ['async', 'row'],
  ] as const)('refuses missing %s location %s', async (source, path) => {
    const m = model();
    m.setRecord(source);
    m.data.delete(path);
    if (source === 'async') m.asyncKeys.mockResolvedValue([]);
    expect((await m.replay.eligibility()).kind).toBe('fails');
  });

  it.each([
    'policy',
    'access',
    'control:read',
    'legacy:paths',
    'exists:' + legacy.data,
    'async:keys',
  ])('reports a throwing %s check as unknown', async failure => {
    const m = model();
    if (failure === 'async:keys') m.setRecord('async');
    m.fail(failure);
    expect((await m.replay.eligibility()).kind).toBe('unknown');
  });

  it.each([false, 'not-json'])(
    'treats unreadable or unparseable transfer record %p as unknown',
    async value => {
      const m = model();
      m.control.values.set('transfer', value);
      expect((await m.replay.eligibility()).kind).toBe('unknown');
    },
  );

  it.each([false, 0, {}, '', 'unexpected'])(
    'stops on present invalid replay state %p without other storage reads',
    async value => {
      const m = model();
      m.marker.values.set('state', value);
      await expect(m.replay.startup()).rejects.toThrow();
      expect(m.access).not.toHaveBeenCalled();
      expect(m.marker.delete).not.toHaveBeenCalled();
      expect(m.files.exists).not.toHaveBeenCalled();
    },
  );

  it.each(['marker:read', 'marker:contains'])(
    'stops when %s rejects, without clearing anything',
    async failure => {
      const m = model();
      m.fail(failure);
      await expect(m.replay.startup()).rejects.toThrow();
      expect(m.access).not.toHaveBeenCalled();
      expect(m.marker.delete).not.toHaveBeenCalled();
    },
  );

  it('an unarmed launch reads only the replay state', async () => {
    const m = model();
    await m.replay.startup();
    expect(m.events).toEqual(['marker:read', 'marker:contains']);
    expect(m.access).not.toHaveBeenCalled();
    expect(INTERNAL_VAULT_REPLAY).toBe(true);
  });

  it('does not interpret an unreadable retirement policy as disabled', async () => {
    const m = model();
    m.setRetired(undefined as any);
    expect((await m.replay.eligibility()).kind).toBe('unknown');
  });
});

describe('startup wipe and recovery', () => {
  it('verifies backups, then wallet keys, then control keys, then marker before migration', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    const legacyBefore = Object.values(legacy).map(path => m.data.get(path));
    const migrate = jest.fn(() => m.events.push('migrate'));
    await m.replay.startup().then(migrate);
    expect(m.files.unlink.mock.calls).toEqual(
      Object.values(modern).map(path => [path]),
    );
    expect(m.wallet.values.size).toBe(0);
    expect(m.control.values.size).toBe(0);
    expect(m.state.read()).toBeNull();
    expect(Object.values(legacy).map(path => m.data.get(path))).toEqual(
      legacyBefore,
    );
    const at = (event: string) => m.events.indexOf(event);
    expect(at('marker:set:wiping')).toBeLessThan(at('unlink:' + modern.main));
    expect(m.events.lastIndexOf('exists:' + modern.temp)).toBeLessThan(
      at('wallet:delete:persist:root'),
    );
    expect(m.events.lastIndexOf('wallet:keys')).toBeLessThan(
      at('control:delete:extra'),
    );
    expect(
      m.events.slice(at('control:keys'), at('marker:delete:state')),
    ).toEqual([
      'control:keys',
      'control:delete:extra',
      'control:keys',
      'control:delete:transfer',
      'control:keys',
    ]);
    expect(m.events.lastIndexOf('control:keys')).toBeLessThan(
      at('marker:delete:state'),
    );
    expect(at('marker:delete:state')).toBeLessThan(at('migrate'));
    expect(m.events.slice(at('marker:delete:state'), at('migrate'))).toEqual([
      'marker:delete:state',
      'marker:read',
      'marker:contains',
    ]);
  });

  it.each(['wallet', 'control'])(
    'detects a silent %s delete and resumes after the failure clears',
    async target => {
      const m = model();
      m.marker.values.set('state', 'armed');
      m.silent.add(
        target +
          ':delete:' +
          (target === 'wallet' ? 'persist:root' : 'transfer'),
      );
      await expect(m.replay.startup()).rejects.toThrow('not verified');
      expect(m.state.read()).toBe('wiping');
      m.silent.clear();
      await m.replay.startup();
      expect(m.state.read()).toBeNull();
    },
  );

  it('preserves the authorization record when deleting an extra control key silently fails', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    const originalRecord = m.control.values.get('transfer');
    m.silent.add('control:delete:extra');
    const migrate = jest.fn();

    await expect(m.replay.startup().then(migrate)).rejects.toThrow(
      'not verified',
    );
    expect(m.state.read()).toBe('wiping');
    expect(m.control.values.get('extra')).toBe('discard');
    expect(m.control.values.get('transfer')).toBe(originalRecord);
    expect(m.control.delete).not.toHaveBeenCalledWith('transfer');
    expect(migrate).not.toHaveBeenCalled();
    expect(m.wallet.values.size).toBe(0);
    expect(Object.values(modern).some(path => m.data.has(path))).toBe(false);

    m.silent.delete('control:delete:extra');
    await m.replay.startup().then(migrate);
    expect(m.wallet.values.size).toBe(0);
    expect(m.control.values.size).toBe(0);
    expect(Object.values(modern).some(path => m.data.has(path))).toBe(false);
    expect(m.state.read()).toBeNull();
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('detects an unlink that leaves a file and never starts wallet deletion early', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    m.silent.add('unlink:' + modern.bak);
    await expect(m.replay.startup()).rejects.toThrow('not verified');
    expect(m.wallet.delete).not.toHaveBeenCalled();
    expect(m.state.read()).toBe('wiping');
  });

  it('verifies the wiping transition before any deletion', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    m.marker.set.mockImplementationOnce(() => {});
    await expect(m.replay.startup()).rejects.toThrow('write was not verified');
    expect(m.state.read()).toBe('armed');
    expect(m.files.unlink).not.toHaveBeenCalled();
    expect(m.wallet.delete).not.toHaveBeenCalled();
    await m.replay.startup();
    expect(m.state.read()).toBeNull();
  });

  it('never starts migration if clearing the replay marker silently fails', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    m.silent.add('marker:delete:state');
    const migrate = jest.fn();
    await expect(m.replay.startup().then(migrate)).rejects.toThrow();
    expect(migrate).not.toHaveBeenCalled();
    expect(m.state.read()).toBe('wiping');
    m.silent.clear();
    await m.replay.startup().then(migrate);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('armed with definite ineligibility cancels without touching modern data', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    m.setRecord(null);
    const migrate = jest.fn();
    await m.replay.startup().then(migrate);
    expect(m.state.read()).toBeNull();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(m.files.unlink).not.toHaveBeenCalled();
    expect(m.wallet.delete).not.toHaveBeenCalled();
    expect(m.control.delete).not.toHaveBeenCalled();
  });

  it('armed with an uncertain check retains the request and stops', async () => {
    const m = model();
    m.marker.values.set('state', 'armed');
    m.fail('exists:' + legacy.data);
    await expect(m.replay.startup()).rejects.toThrow();
    expect(m.state.read()).toBe('armed');
    expect(m.files.unlink).not.toHaveBeenCalled();
  });

  it('wiping with an absent record and empty modern storage finishes before checking eligibility', async () => {
    const m = model();
    m.marker.values.set('state', 'wiping');
    m.emptyModern();
    m.setRetired(true);
    const migrate = jest.fn();
    await m.replay.startup().then(migrate);
    expect(m.state.read()).toBeNull();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(m.events).not.toContain('policy');
    expect(m.events).not.toContain('legacy:paths');
    expect(m.files.unlink).not.toHaveBeenCalled();
  });

  it.each(['wallet', 'control', 'main', 'bak', 'temp'] as const)(
    'absent record with leftover %s stays fenced without inferred deletion',
    async location => {
      const m = model();
      m.marker.values.set('state', 'wiping');
      m.emptyModern();
      if (location === 'wallet' || location === 'control')
        m[location].values.set('leftover', 'keep');
      else m.data.set(modern[location], 'keep');
      await expect(m.replay.startup()).rejects.toThrow('remain');
      expect(m.state.read()).toBe('wiping');
      expect(m.files.unlink).not.toHaveBeenCalled();
      expect(m.wallet.delete).not.toHaveBeenCalled();
      expect(m.control.delete).not.toHaveBeenCalled();
      expect(m.events).not.toContain('policy');
    },
  );

  it.each(['control:read', 'control:contains'])(
    'wiping cannot infer record absence after %s fails',
    async failure => {
      const m = model();
      m.marker.values.set('state', 'wiping');
      m.control.values.delete('transfer');
      m.fail(failure);
      await expect(m.replay.startup()).rejects.toThrow();
      expect(m.state.read()).toBe('wiping');
      expect(m.files.unlink).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'retired', 'throws'])(
    'a partial wipe blocks when eligibility later becomes %s',
    async change => {
      const m = model();
      m.marker.values.set('state', 'armed');
      m.fail('unlink:' + modern.bak);
      await expect(m.replay.startup()).rejects.toThrow();
      expect(m.data.has(modern.main)).toBe(false);
      if (change === 'missing') m.data.delete(legacy.data);
      if (change === 'retired') m.setRetired(true);
      if (change === 'throws') m.fail('exists:' + legacy.data);
      m.files.unlink.mockClear();
      const migrate = jest.fn();
      await expect(m.replay.startup().then(migrate)).rejects.toThrow();
      expect(m.state.read()).toBe('wiping');
      expect(migrate).not.toHaveBeenCalled();
      expect(m.files.unlink).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['marker:set:wiping', 1],
    ['marker:read', 2],
    ['exists:' + modern.main, 1],
    ['unlink:' + modern.main, 1],
    ['unlink:' + modern.bak, 1],
    ['unlink:' + modern.temp, 1],
    ['exists:' + modern.temp, 2],
    ['wallet:keys', 1],
    ['wallet:delete:persist:root', 1],
    ['wallet:keys', 2],
    ['control:keys', 1],
    ['control:delete:extra', 1],
    ['control:keys', 2], // Verify other keys are gone before deleting transfer.
    ['control:delete:transfer', 1],
    ['control:keys', 3], // Verify empty after deleting transfer.
    ['marker:delete:state', 1],
    ['marker:read', 3],
  ] as const)(
    'retains the fence and retries interruption at %s (%s)',
    async (failure, occurrence) => {
      const m = model();
      m.marker.values.set('state', 'armed');
      m.fail(failure, occurrence);
      const originalRecord = m.control.values.get('transfer');
      const migrate = jest.fn();
      await expect(m.replay.startup().then(migrate)).rejects.toThrow();
      expect(['armed', 'wiping']).toContain(m.state.read());
      expect(migrate).not.toHaveBeenCalled();
      if (failure === 'control:keys' && occurrence > 1) {
        expect(m.control.getAllKeys).toHaveBeenCalledTimes(occurrence);
        expect(m.control.values.get('transfer')).toBe(
          occurrence === 2 ? originalRecord : undefined,
        );
        expect(m.control.delete.mock.calls).toEqual(
          occurrence === 2 ? [['extra']] : [['extra'], ['transfer']],
        );
      }
      const retryStart = m.events.length;
      await m.replay.startup().then(migrate);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(m.state.read()).toBeNull();
      if (failure === 'control:keys' && occurrence > 1) {
        // Only the retained-record retry rechecks eligibility; the final-read
        // failure recovers via the absent-record-and-empty-modern branch.
        expect(m.events.slice(retryStart).includes('policy')).toBe(
          occurrence === 2,
        );
      }
    },
  );
});

const arming = (m = model(), gate = createInternalReplayWriteGate()) => {
  const notices: ReplayNotice[] = [];
  const notify = (notice: ReplayNotice) => {
    m.events.push('notice:' + notice.kind);
    notices.push(notice);
  };
  const release = jest.fn();
  const suspend = jest.fn(() => {
    m.events.push('suspend');
    const pause = gate.suspend();
    return {
      drained: pause.drained,
      release: () => {
        m.events.push('release');
        release();
        pause.release();
      },
    };
  });
  const confirm = jest.fn(async () => true);
  const restart = jest.fn(() => {
    m.events.push('restart');
  });
  const controller = createReplayArmer({
    replay: m.replay,
    confirm,
    suspend,
    restart,
  });
  return {
    m,
    gate,
    notices,
    notify,
    release,
    suspend,
    confirm,
    restart,
    controller,
  };
};

describe('arming and cancellation', () => {
  it('refuses ineligible state before confirmation or suspension', async () => {
    const a = arming();
    a.m.setRecord(null);
    await a.controller.arm(a.notify);
    expect(a.notices).toEqual([
      {kind: 'refused', message: expect.stringContaining('Fresh installs')},
    ]);
    expect(a.confirm).not.toHaveBeenCalled();
    expect(a.suspend).not.toHaveBeenCalled();
  });
  it('reports an eligibility read failure as unknown, without writes', async () => {
    const a = arming();
    a.m.fail('control:read');
    await a.controller.arm(a.notify);
    expect(a.notices).toEqual([
      {
        kind: 'refused',
        message: expect.stringContaining('Could not determine eligibility'),
      },
    ]);
    expect(a.suspend).not.toHaveBeenCalled();
    expect(a.m.marker.set).not.toHaveBeenCalled();
  });
  it('does nothing if confirmation is declined', async () => {
    const a = arming();
    a.confirm.mockResolvedValue(false);
    await a.controller.arm(a.notify);
    expect(a.suspend).not.toHaveBeenCalled();
    expect(a.m.marker.set).not.toHaveBeenCalled();
    expect(a.restart).not.toHaveBeenCalled();
  });

  it('does not suspend if the initiating UI is cancelled while confirmation is open', async () => {
    const a = arming();
    const confirmation = deferred<boolean>();
    a.confirm.mockReturnValue(confirmation.promise);
    const attempt = a.controller.arm(a.notify);
    await tick();
    a.controller.cancel();
    confirmation.resolve(true);
    await attempt;
    expect(a.suspend).not.toHaveBeenCalled();
    expect(a.m.marker.set).not.toHaveBeenCalled();
  });
  it('drains delayed work, rejects a second attempt and keeps later writes paused after restart returns', async () => {
    const a = arming();
    const pending = deferred();
    const old = a.gate.run(() => pending.promise);
    const attempt = a.controller.arm(a.notify);
    await tick();
    expect(a.suspend).toHaveBeenCalledTimes(1);
    expect(a.restart).not.toHaveBeenCalled();
    await a.controller.arm(a.notify);
    expect(a.confirm).toHaveBeenCalledTimes(1);
    const later = jest.fn(async () => {});
    a.gate.run(later);
    expect(later).not.toHaveBeenCalled();
    pending.resolve();
    await old;
    await attempt;
    expect(a.restart).toHaveBeenCalledTimes(1);
    expect(a.m.state.read()).toBe('armed');
    expect(a.release).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    expect(a.m.files.unlink).not.toHaveBeenCalled();
    expect(a.m.wallet.delete).not.toHaveBeenCalled();
    expect(a.m.events.indexOf('marker:set:armed')).toBeLessThan(
      a.m.events.indexOf('restart'),
    );
    expect(
      a.m.events.slice(
        a.m.events.indexOf('marker:set:armed'),
        a.m.events.indexOf('restart'),
      ),
    ).toContain('marker:read');
  });
  it.each(['write-after-store', 'read-back', 'restart'])(
    'verifies disarming before release/report after %s fails',
    async failure => {
      const a = arming();
      if (failure !== 'restart') {
        const set = a.m.marker.set.getMockImplementation()!;
        a.m.marker.set.mockImplementationOnce((key, value) => {
          set(key, value);
          if (failure === 'write-after-store')
            throw new Error('uncertain marker write');
          a.m.fail('marker:read');
        });
      } else
        a.restart.mockImplementationOnce(() => {
          throw new Error('restart failed');
        });
      await a.controller.arm(a.notify);
      expect(a.m.state.read()).toBeNull();
      expect(a.release).toHaveBeenCalledTimes(1);
      const clear = a.m.events.indexOf('marker:delete:state');
      const release = a.m.events.indexOf('release');
      expect(a.m.events.slice(clear, release)).toEqual([
        'marker:delete:state',
        'marker:read',
        'marker:contains',
      ]);
      expect(release).toBeLessThan(a.m.events.indexOf('notice:cancelled'));
    },
  );
  it.each(['silent-delete', 'clear-read'])(
    'stays suspended without cancellation success when disarming fails: %s',
    async failure => {
      const a = arming();
      a.restart.mockImplementationOnce(() => {
        throw new Error('restart failed');
      });
      if (failure === 'silent-delete') a.m.silent.add('marker:delete:state');
      else {
        const remove = a.m.marker.delete.getMockImplementation()!;
        a.m.marker.delete.mockImplementationOnce(key => {
          remove(key);
          a.m.fail('marker:read');
        });
      }
      await a.controller.arm(a.notify);
      expect(a.release).not.toHaveBeenCalled();
      expect(a.notices.some(n => n.kind === 'cancelled')).toBe(false);
      expect(a.notices.at(-1)).toEqual({
        kind: 'unsafe',
        message: expect.stringContaining('may still be armed'),
      });
      const later = jest.fn(async () => {});
      a.gate.run(later);
      expect(later).not.toHaveBeenCalled();
    },
  );
  it.each(['abort', 'drain-error'])(
    'cancels a %s after suspension only after verified absence',
    async reason => {
      const a = arming();
      const pending = deferred();
      const old = a.gate.run(() => pending.promise).catch(() => {});
      const attempt = a.controller.arm(a.notify);
      await tick();
      if (reason === 'abort') {
        a.controller.cancel();
        pending.resolve();
      } else pending.reject(new Error('root write failed'));
      await old;
      await attempt;
      expect(a.restart).not.toHaveBeenCalled();
      expect(a.m.state.read()).toBeNull();
      expect(a.release).toHaveBeenCalledTimes(1);
      expect(a.m.events.indexOf('marker:contains')).toBeLessThan(
        a.m.events.indexOf('release'),
      );
    },
  );
  it('releases only its own gate lease', async () => {
    const gate = createInternalReplayWriteGate();
    const original = gate.suspend();
    const a = arming(model(), gate);
    a.restart.mockImplementationOnce(() => {
      throw new Error('restart failed');
    });
    await a.controller.arm(a.notify);
    const write = jest.fn(async () => {});
    const waiting = gate.run(write);
    expect(write).not.toHaveBeenCalled();
    original.release();
    await waiting;
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('real runtime and persistence wiring with modeled native boundaries', () => {
  let h: ReturnType<typeof createStoreModel>;
  const fixture = require('../../test/vault/fixtures/legacy-14.32.json').cases
    .plain;
  beforeEach(() => {
    jest.useFakeTimers();
    h = createStoreModel();
    h.active();
  });
  afterEach(() => {
    h.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  const seedLegacy = () => {
    h.data('mmkv.default').set('persist:root', fixture.raw);
    h.data('mmkv.default').set('persist:logs', 'retained logs');
    h.files.set('/mmkv/mmkv.default', 'legacy pair');
    h.files.set('/mmkv/mmkv.default.crc', 'legacy metadata');
    h.credentials.set('bitpay-app-encryption-key', {
      password: 'synthetic-legacy-fixture-key',
    });
  };
  const api = () => {
    const runtime = require('./vault-runtime');
    const replay = require('./internal-vault-replay').createInternalVaultReplay(
      runtime.getInternalVaultReplayAccess,
    );
    const backups = require('./backup/fs-backup');
    return {runtime, replay, backups};
  };
  const makeArmer = (
    replay: ReturnType<typeof createInternalVaultReplay>,
    restart = jest.fn(),
  ) => {
    const controller =
      require('./internal-vault-replay-arming').createReplayArmer({
        replay,
        confirm: async () => true,
        suspend: h.api.suspendPersistenceForInternalVaultReplay,
        restart,
      });
    return {controller, restart};
  };

  it('waits for the actual fire-and-forget backup queue and gates later root/backup writes', async () => {
    seedLegacy();
    const {runtime, replay, backups} = api();
    await runtime.prepareModernVault();
    const started = deferred();
    const finish = deferred();
    h.fs.writeFile.mockImplementationOnce(async (path, value) => {
      started.resolve();
      await finish.promise;
      h.files.set(path, value);
    });
    await h.api.reduxStorage.setItem(
      'persist:root',
      '{"WALLET":{"secretsMigrated":true},"version":"before"}',
    );
    await started.promise;
    const a = makeArmer(replay);
    const notices: ReplayNotice[] = [];
    const attempt = a.controller.arm((n: ReplayNotice) => notices.push(n));
    await tick();
    expect(a.restart).not.toHaveBeenCalled();
    const setCalls = h.instance('bitpay.wallet.v2').set.mock.calls.length;
    const readCalls =
      h.instance('bitpay.wallet.v2').getString.mock.calls.length;
    h.api.reduxStorage.setItem('persist:root', 'later root');
    h.api.reduxStorage.removeItem('persist:root');
    h.api.reduxStorage.getItem('persist:root');
    backups.backupPersistRoot(
      '{"WALLET":{"secretsMigrated":true},"version":"later"}',
    );
    await tick();
    expect(h.instance('bitpay.wallet.v2').set).toHaveBeenCalledTimes(setCalls);
    expect(h.instance('bitpay.wallet.v2').getString).toHaveBeenCalledTimes(
      readCalls,
    );
    expect(h.instance('bitpay.wallet.v2').delete).not.toHaveBeenCalled();
    finish.resolve();
    await attempt;
    await tick();
    expect(a.restart).toHaveBeenCalledTimes(1);
    expect(h.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(h.instance('bitpay.wallet.v2').set).toHaveBeenCalledTimes(setCalls);
    expect(h.data(INTERNAL_REPLAY_STORE).get('state')).toBe('armed');
    expect(notices.at(-1)?.kind).toBe('restarting');
  });

  it('preserves an existing persistence failure, backup suspension, secrets requirement and deferred payload after cancellation', async () => {
    seedLegacy();
    const {runtime, replay, backups} = api();
    await runtime.prepareModernVault();
    const persistor = require('./persistor');
    const readFailure = new Error('existing read failure');
    const pause = jest.fn();
    persistor.setActivePersistor({pause, flush: async () => {}});
    persistor.pausePersistor(readFailure);
    await backups.removePersistRootBackups();
    const deferredRaw =
      '{"WALLET":{"secretsMigrated":true},"retained":"deferred"}';
    await backups.backupPersistRoot(deferredRaw);
    h.fs.writeFile.mockClear();
    const a = makeArmer(
      replay,
      jest.fn(() => {
        throw new Error('restart failed');
      }),
    );
    const notices: ReplayNotice[] = [];
    await a.controller.arm((n: ReplayNotice) => notices.push(n));
    expect(notices.at(-1)?.kind).toBe('cancelled');
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    await expect(persistor.flushPersistor()).rejects.toBe(readFailure);
    expect(pause).toHaveBeenCalledTimes(1);
    await backups.backupPersistRoot('{"WALLET":{"secretsMigrated":false}}');
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    await backups.resumePersistRootBackups();
    expect(h.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(h.fs.writeFile.mock.calls[0][1]).toBe(deferredRaw);
    await backups.backupPersistRoot('{"WALLET":{"secretsMigrated":false}}');
    expect(h.fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads a failed wipe on same-runtime Retry and shares each initialization attempt', async () => {
    seedLegacy();
    const {runtime} = api();
    h.data(INTERNAL_REPLAY_STORE).set('state', 'armed');
    h.files.set(modern.main, 'modern');
    h.fs.unlink.mockRejectedValueOnce(new Error('interrupted unlink'));
    const first = runtime.prepareModernVault();
    expect(runtime.prepareModernVault()).toBe(first);
    await expect(first).rejects.toThrow();
    expect(h.data(INTERNAL_REPLAY_STORE).get('state')).toBe('wiping');
    const retry = runtime.prepareModernVault();
    expect(retry).not.toBe(first);
    expect(runtime.prepareModernVault()).toBe(retry);
    await retry;
    expect(h.data(INTERNAL_REPLAY_STORE).has('state')).toBe(false);
    expect(
      JSON.parse(h.data('bitpay.wallet.transfer.v2').get('transfer')).phase,
    ).toBe('active');
  });

  it('rechecks the encrypted-secrets requirement when releasing queued backup work', async () => {
    seedLegacy();
    const {runtime, backups} = api();
    await runtime.prepareModernVault();
    const pause = backups.suspendAndDrainInternalReplayBackups();
    await pause.drained;
    const waiting = backups.backupPersistRoot(
      '{"WALLET":{"secretsMigrated":false}}',
    );
    // A normal secrets migration can introduce its own suspension while replay waits.
    const cleanup = backups.removePersistRootBackups();
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    pause.release();
    await Promise.all([waiting, cleanup]);
    await backups.resumePersistRootBackups();
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });

  it('arms, recreates JavaScript state, migrates the retained fixture and keeps the exact existing vault key and unrelated stores', async () => {
    seedLegacy();
    const {runtime, replay} = api();
    const key = await runtime.prepareModernVault();
    const current = require('./vault-codec').encodeSnapshot(
      {
        ...fixture.state,
        APP: {...fixture.state.APP, modernOnly: 'discard'},
      },
      key,
    );
    h.data('bitpay.wallet.v2').set('persist:root', current);
    for (const path of Object.values(modern)) h.files.set(path, current);
    h.files.set(legacy.main, fixture.raw);
    h.files.set(legacy.bak, fixture.raw);
    h.files.set(legacy.main + '.tmp', 'retained old temp');
    const retainedFiles = [
      legacy.data,
      legacy.crc,
      legacy.main,
      legacy.bak,
      legacy.main + '.tmp',
    ];
    const fileContents = retainedFiles.map(path => h.files.get(path));
    const rows = new Map([
      ['persist:root', fixture.raw],
      ['unrelated-row', 'retain'],
    ]);
    const asyncStorage = require('@react-native-async-storage/async-storage');
    asyncStorage.getItem.mockImplementation(
      async (name: string) => rows.get(name) ?? null,
    );
    asyncStorage.getAllKeys.mockImplementation(async () => [...rows.keys()]);
    asyncStorage.removeItem.mockImplementation(async (name: string) => {
      rows.delete(name);
    });
    jest.doMock(
      '@react-native-async-storage/async-storage',
      () => asyncStorage,
    );
    const untouched = [
      'mmkv.default',
      'bitpay.session-logs.v1',
      'bitpay.portfolio.engine',
      'account-list-snapshots',
    ];
    for (const id of untouched.slice(1)) h.data(id).set('test', 'retain');
    const before = untouched.map(id => [...h.data(id)]);
    const credentials = JSON.parse(JSON.stringify([...h.credentials]));
    const previousRecord = h.data('bitpay.wallet.transfer.v2').get('transfer');
    const a = makeArmer(replay);
    await a.controller.arm(() => {});
    expect(
      h.MMKV.mock.calls.some(
        ([options]: any[]) => options?.id === 'mmkv.default',
      ),
    ).toBe(false);
    expect(h.files.has(modern.main)).toBe(true);
    expect(h.data('bitpay.wallet.v2').get('persist:root')).toBe(current);
    jest.resetModules();
    // Recreate the JS facade for the same modeled native module/storage.
    const registry = require('react-native').TurboModuleRegistry;
    const originalLookup = registry.getEnforcing;
    jest.spyOn(registry, 'getEnforcing').mockImplementation((name: any) => {
      if (name === 'MmkvPlatformContext')
        return {
          getBaseDirectory: () => '/mmkv',
          getAppGroupDirectory: () => undefined,
        };
      if (name === 'MmkvCxx') return {claimLegacyRetirement: h.claim};
      return originalLookup(name);
    });
    const next = require('./vault-runtime');
    await expect(next.prepareModernVault()).resolves.toBe(key);
    const restored = require('./vault-codec').decodeSnapshot(
      h.data('bitpay.wallet.v2').get('persist:root'),
      key,
    ).payload;
    expect(restored).toEqual(fixture.state);
    expect(
      JSON.parse(h.data('bitpay.wallet.transfer.v2').get('transfer')).phase,
    ).toBe('active');
    expect(h.data(INTERNAL_REPLAY_STORE).has('state')).toBe(false);
    expect(h.data('bitpay.wallet.transfer.v2').get('transfer')).not.toBe(
      previousRecord,
    );
    expect(retainedFiles.map(path => h.files.get(path))).toEqual(fileContents);
    expect(await asyncStorage.getItem('persist:root')).toBe(fixture.raw);
    expect(asyncStorage.removeItem).not.toHaveBeenCalled();
    expect([...h.credentials]).toEqual(credentials);
    expect(h.keychain.setGenericPassword).not.toHaveBeenCalled();
    expect(h.keychain.resetGenericPassword).not.toHaveBeenCalled();
    expect(untouched.map(id => [...h.data(id)])).toEqual(before);
    expect(
      h.MMKV.mock.calls.filter(
        ([options]: any[]) => options?.id === 'mmkv.default',
      ),
    ).toHaveLength(1);
    expect([...h.data('bitpay.wallet.v2').keys()]).toEqual(['persist:root']);
    expect([...h.data('bitpay.wallet.transfer.v2').keys()]).toEqual([
      'transfer',
    ]);
    expect(h.fs.unlink.mock.calls).toEqual(
      Object.values(modern).map(path => [path]),
    );
  });
});
