import {PriceAlertQueue, AlertEnvironment} from './price-alerts.queue';
import {PriceAlertsError} from '../../api/price-alerts';
import {selectorKey, DEFAULT_WATCHLIST, buildCoinCatalog} from './coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import type {
  PriceAlert,
  PriceAlertRegistration,
  PriceAlertSelector,
} from '../../api/price-alerts/price-alerts.types';
import type {WatchlistState} from './watchlist.models';

const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
const btc = catalog.byId.get('coin:btc')!;
const usdc = catalog.byId.get('coin:usdc')!;
const tick = async () => {
  for (let n = 0; n < 20; n++) {
    await Promise.resolve();
  }
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
const alert = (
  selector: PriceAlertSelector = {coin: 'btc'},
  thresholdPct: 5 | 10 | 15 | 20 = 10,
  code = 'USD',
): PriceAlert => ({
  ...selector,
  assetKey: selectorKey(selector),
  thresholdPct,
  code,
});

const harness = () => {
  let state: WatchlistState = {
    items: DEFAULT_WATCHLIST.map(symbol => catalog.byId.get(`coin:${symbol}`)!),
    contexts: {},
    order: 0,
    priceAlertsEnabled: true,
    permissionPromptShown: false,
    permissionAllowed: true,
  };
  let env: AlertEnvironment = {
    context: 'public-key-A|url-A',
    externalUserId: 'braze-A',
    pushEnabled: false,
    currency: 'USD',
  };
  let time = 100000;
  let coins = catalog;
  let registration: PriceAlertRegistration = {registered: false};
  const held = new Map<string, PriceAlert>();
  const calls: string[] = [];
  const api = {
    list: jest.fn(async () => {
      calls.push('list');
      return {registration, alerts: [...held.values()]};
    }),
    register: jest.fn(async values => {
      calls.push('register');
      registration = {...registration, ...values, registered: true};
      return registration;
    }),
    save: jest.fn(async (selector, thresholdPct, code) => {
      calls.push('save:' + selectorKey(selector));
      const saved = alert(selector, thresholdPct, code);
      held.set(selectorKey(selector), saved);
      return saved;
    }),
    remove: jest.fn(async selector => {
      calls.push('remove:' + selectorKey(selector));
      held.delete(selectorKey(selector));
      return {disabled: true as const};
    }),
  };
  const queue = new PriceAlertQueue({
    read: () => state,
    write: value => {
      state = value;
    },
    environment: () => env,
    api: () => api,
    catalog: () => coins,
    now: () => time,
  });
  return {
    queue,
    api,
    held,
    calls,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    get env() {
      return env;
    },
    set env(value) {
      env = value;
    },
    get context() {
      return state.contexts[env.context!];
    },
    advance: () => {
      time += 60001;
    },
    setCatalog: (value: typeof catalog) => {
      coins = value;
    },
    register: () => {
      registration = {
        registered: true,
        externalUserId: env.externalUserId!,
        priceAlertsEnabled: state.priceAlertsEnabled,
        pushEnabled: env.pushEnabled,
      };
    },
  };
};

describe('watchlist rules and price-alert queue', () => {
  it('uses defaults, adds at the bottom, refuses 20 or more, and reorders with one-based analytics', () => {
    const h = harness();
    expect(h.state.items.map(item => item.symbol.toLowerCase())).toEqual(
      DEFAULT_WATCHLIST,
    );
    h.queue.add(usdc);
    expect(h.state.items.at(-1)?.id).toBe(usdc.id);
    expect(h.queue.reorder(usdc.id, 0)).toEqual({
      coin: 'usdc',
      from_position: 9,
      to_position: 1,
      moved_into_top_5: true,
    });
    h.state = {
      ...h.state,
      items: Array.from({length: 21}, (_, i) => ({
        ...btc,
        id: `x${i}`,
        selector: {coin: `unknown-${i}`},
        assets: [],
      })),
    };
    expect(() => h.queue.add(usdc)).toThrow(PriceAlertsError);
  });

  it('only probes once per launch and does not register before a save attempt', async () => {
    const h = harness();
    await h.queue.sync();
    h.advance();
    await h.queue.sync();
    h.env = {...h.env, externalUserId: 'new'};
    await h.queue.preferencesChanged();
    expect(h.api.list).toHaveBeenCalledTimes(1);
    expect(h.api.register).not.toHaveBeenCalled();
  });

  it('waits for hydration/identity before requesting', async () => {
    const h = harness();
    h.env = {...h.env, context: undefined};
    await h.queue.sync();
    expect(h.calls).toEqual([]);
  });

  it('registers all fields first, then only changed values; an alert implies watching', async () => {
    const h = harness();
    h.state = {...h.state, priceAlertsEnabled: false};
    h.env = {...h.env, pushEnabled: true};
    await h.queue.save(usdc, 5);
    expect(h.api.register).toHaveBeenCalledWith({
      externalUserId: 'braze-A',
      pushEnabled: true,
      priceAlertsEnabled: false,
    });
    expect(h.state.items.at(-1)?.id).toBe(usdc.id);
    h.env = {...h.env, externalUserId: 'braze-B'};
    await h.queue.preferencesChanged();
    expect(h.api.register).toHaveBeenLastCalledWith({
      externalUserId: 'braze-B',
    });
  });

  it('leaves the mirror unchanged after failed saves and turn-offs', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.save.mockRejectedValueOnce(
      new PriceAlertsError('PRICE_ALERTS_LIMIT', 400),
    );
    await expect(h.queue.save(btc, 20)).rejects.toThrow();
    expect(h.context.alerts[btc.id].alert.thresholdPct).toBe(10);
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    await expect(h.queue.turnOff(btc)).rejects.toThrow();
    expect(h.context.alerts[btc.id].alert.thresholdPct).toBe(10);
    expect(h.context.unknownSelectors['native:btc']).toBe(true);
  });

  it('turns an alert off without removing the watched coin', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    await h.queue.turnOff(btc);
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.state.items.some(item => item.id === btc.id)).toBe(true);
  });

  it('sends pending removals before listing and reconciles missing coins without deleting them', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.queue.remove(btc);
    await tick();
    h.held.set(selectorKey(usdc.selector), alert(usdc.selector));
    h.calls.length = 0;
    await h.queue.sync();
    expect(h.calls.slice(0, 2)).toEqual(['remove:native:btc', 'list']);
    expect(h.state.items.some(item => item.id === usdc.id)).toBe(true);
    expect(h.context.alerts[usdc.id]).toBeDefined();
    expect(h.api.remove).not.toHaveBeenCalledWith(usdc.selector);
  });

  it('preserves an offline removal after re-add and Not Now', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.queue.remove(btc);
    h.queue.add(btc);
    await tick();
    expect(Object.keys(h.context.pendingRemovals)).toEqual(['native:btc']);
    await h.queue.sync();
    expect(h.held.size).toBe(0);
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.state.items.some(item => item.id === btc.id)).toBe(true);
  });

  it('puts a later save after an outstanding removal', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.queue.remove(btc);
    h.queue.add(btc);
    await tick();
    await h.queue.save(btc, 20);
    expect(h.held.get('native:btc')?.thresholdPct).toBe(20);
    expect(h.context.pendingRemovals).toEqual({});
  });

  it('never overlaps a list and a save; a queued save wins', async () => {
    const h = harness();
    h.register();
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const syncing = h.queue.sync();
    await tick();
    const saving = h.queue.save(btc, 20);
    await tick();
    expect(h.api.save).not.toHaveBeenCalled();
    gate.resolve({
      registration: {
        registered: true,
        externalUserId: 'braze-A',
        priceAlertsEnabled: true,
        pushEnabled: false,
      },
      alerts: [alert()],
    });
    await syncing;
    await saving;
    expect(h.context.alerts[btc.id].alert.thresholdPct).toBe(20);
  });

  it('does not restore a coin removed during a list, even without a mirrored alert', async () => {
    const h = harness();
    h.register();
    await h.queue.sync();
    h.advance();
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const syncing = h.queue.sync();
    await tick();
    h.queue.remove(btc);
    h.held.set('native:btc', alert());
    gate.resolve({registration: h.context.registration!, alerts: [alert()]});
    await syncing;
    await tick();
    expect(h.state.items.some(item => item.id === btc.id)).toBe(false);
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.held.size).toBe(0);
  });

  it('does not restore a row or clear a newer removal when a save returns', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    const gate = deferred<PriceAlert>();
    h.api.save.mockReturnValueOnce(gate.promise);
    const saving = h.queue.save(btc, 20);
    await tick();
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.queue.remove(btc);
    gate.resolve(alert({coin: 'btc'}, 20));
    await saving;
    await tick();
    expect(h.state.items.some(item => item.id === btc.id)).toBe(false);
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.context.pendingRemovals['native:btc']).toBeDefined();
  });

  it('a list cannot undo a newer Turn Off intent', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    await h.queue.sync();
    h.advance();
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const syncing = h.queue.sync();
    await tick();
    const off = h.queue.turnOff(btc);
    gate.resolve({registration: h.context.registration!, alerts: [alert()]});
    await syncing;
    await off;
    expect(h.context.alerts[btc.id]).toBeUndefined();
  });

  it('skips currency work queued before Turn Off', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.env = {...h.env, currency: 'EUR'};
    const currency = h.queue.preferencesChanged();
    const off = h.queue.turnOff(btc);
    await currency;
    await off;
    expect(h.api.save).toHaveBeenCalledTimes(1);
    expect(h.held.size).toBe(0);
  });

  it('does not revive a timed-out Turn Off when the server received it', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.remove.mockImplementationOnce(async selector => {
      h.held.delete(selectorKey(selector));
      throw new Error('lost response');
    });
    await expect(h.queue.turnOff(btc)).rejects.toThrow();
    h.env = {...h.env, currency: 'EUR'};
    await h.queue.preferencesChanged();
    expect(h.api.save).toHaveBeenCalledTimes(1);
    await h.queue.sync();
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.context.unknownSelectors).toEqual({});
  });

  it('re-saves confirmed alerts in the display currency, falling back to USD', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.env = {...h.env, currency: 'EUR'};
    await h.queue.preferencesChanged();
    expect(h.held.get('native:btc')?.code).toBe('EUR');
    h.env = {...h.env, currency: 'CHF'};
    await h.queue.preferencesChanged();
    expect(h.held.get('native:btc')?.code).toBe('USD');
  });

  it('settles an unknown alert before currency re-saves', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.save.mockRejectedValueOnce(new Error('lost response'));
    await expect(h.queue.save(btc, 20)).rejects.toThrow();
    h.env = {...h.env, currency: 'EUR'};
    await h.queue.preferencesChanged();
    expect(h.api.save).toHaveBeenCalledTimes(2);
    await h.queue.sync();
    expect(h.held.get('native:btc')?.code).toBe('EUR');
  });

  it('sync may take the list past twenty, and user adds are then refused', async () => {
    const h = harness();
    h.register();
    h.state = {
      ...h.state,
      items: Array.from({length: 20}, (_, i) => ({
        ...btc,
        id: `x${i}`,
        selector: {coin: `unknown-${i}`},
        assets: [],
      })),
    };
    h.held.set('native:btc', alert());
    await h.queue.sync();
    expect(h.state.items).toHaveLength(21);
    expect(() => h.queue.add(usdc)).toThrow();
  });

  it('keeps a backend-restored nonpreferred selector for edits and removals', async () => {
    const h = harness();
    h.register();
    const polygon = {
      chain: 'matic',
      tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    };
    h.held.set(selectorKey(polygon), alert(polygon));
    await h.queue.sync();
    await h.queue.save(usdc, 15);
    await h.queue.turnOff(usdc);
    expect(selectorKey(h.api.save.mock.calls[0][0])).toBe(selectorKey(polygon));
    expect(selectorKey(h.api.remove.mock.calls[0][0])).toBe(
      selectorKey(polygon),
    );
  });

  it('defers unresolved tokens until the registry arrives', async () => {
    const h = harness();
    h.register();
    const selector = {chain: 'eth', tokenAddress: '0xabc'};
    h.held.set(selectorKey(selector), alert(selector));
    await h.queue.sync();
    expect(h.context.unresolved).toHaveLength(1);
    expect(h.api.remove).not.toHaveBeenCalled();
    h.setCatalog(
      buildCoinCatalog(SupportedCurrencyOptions, {
        tokenDataByAddress: {},
        tokenOptionsByAddress: {
          '0xabc_e': {
            name: 'New Coin',
            symbol: 'NEW',
            address: '0xabc',
            decimals: 18,
            logoURI: 'new.png',
          },
        },
      }),
    );
    h.queue.catalogChanged();
    expect(h.context.unresolved).toHaveLength(0);
    expect(h.state.items.at(-1)?.name).toBe('New Coin');
  });

  it('removes duplicate selectors without clearing that pending removal on editing the kept one', async () => {
    const h = harness();
    h.register();
    const polygon = {
      chain: 'matic',
      tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    };
    h.queue.add(usdc);
    h.held.set(selectorKey(polygon), alert(polygon));
    h.held.set(selectorKey(usdc.selector), alert(usdc.selector));
    await h.queue.sync();
    expect(selectorKey(h.context.alerts[usdc.id].alert)).toBe(
      selectorKey(usdc.selector),
    );
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    await h.queue.save(usdc, 20);
    expect(h.context.pendingRemovals[selectorKey(polygon)]).toBeDefined();
  });

  it('recovers an unknown registration from a list and collapses preference changes to their latest values', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.env = {...h.env, externalUserId: 'braze-B'};
    h.api.register.mockRejectedValueOnce(new Error('lost response'));
    await h.queue.preferencesChanged();
    expect(h.context.registrationUnknown).toBe(true);
    h.env = {...h.env, externalUserId: 'braze-C', pushEnabled: true};
    const a = h.queue.preferencesChanged();
    const b = h.queue.preferencesChanged();
    await a;
    await b;
    expect(h.api.register).toHaveBeenLastCalledWith({
      externalUserId: 'braze-C',
      pushEnabled: true,
    });
    expect(h.api.register).toHaveBeenCalledTimes(3);
    expect(h.context.registrationUnknown).toBe(false);
  });

  it('only changes a registered toggle when confirmed, and leaves it on after failure', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    const gate = deferred<PriceAlertRegistration>();
    h.api.register.mockReturnValueOnce(gate.promise);
    const pending = h.queue.setEnabled(false);
    await tick();
    expect(h.state.priceAlertsEnabled).toBe(true);
    gate.reject(new Error('offline'));
    await expect(pending).rejects.toThrow();
    expect(h.state.priceAlertsEnabled).toBe(true);
    await h.queue.setEnabled(false);
    expect(h.state.priceAlertsEnabled).toBe(false);
  });

  it('unregistered settings remain local', async () => {
    const h = harness();
    await h.queue.setEnabled(false);
    expect(h.state.priceAlertsEnabled).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it.each(['public-key-B|url-A', 'public-key-A|url-B'])(
    'isolates registration, mirror, removals and feature status for %s',
    async context => {
      const h = harness();
      await h.queue.save(btc, 10);
      h.api.remove.mockRejectedValueOnce(new Error('offline'));
      h.queue.remove(btc);
      await tick();
      h.env = {...h.env, context};
      await h.queue.preferencesChanged();
      expect(h.context.alerts).toEqual({});
      expect(h.context.pendingRemovals).toEqual({});
      expect(h.context.registration).toBeUndefined();
    },
  );

  it('ignores responses for a previous active context', async () => {
    const h = harness();
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const old = h.queue.sync();
    await tick();
    h.env = {...h.env, context: 'B'};
    await h.queue.preferencesChanged();
    gate.resolve({
      registration: {registered: false},
      alerts: [alert(usdc.selector)],
    });
    await old;
    expect(h.state.items.some(item => item.id === usdc.id)).toBe(false);
    expect(h.context.alerts).toEqual({});
  });

  it('hides alerts for the session only when explicitly disabled; unreachable assumes on', async () => {
    const h = harness();
    h.api.list.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {code: 'PRICE_ALERTS_DISABLED', message: 'private'},
      },
    });
    await h.queue.sync();
    expect(h.context.disabled).toBe(true);
    h.queue.add(usdc);
    expect(h.state.items.at(-1)?.id).toBe(usdc.id);
    const unreachable = harness();
    unreachable.api.list.mockRejectedValueOnce(new Error('offline'));
    await unreachable.queue.sync();
    expect(unreachable.context.disabled).toBe(false);
  });
});

describe('intent ordering before queued requests start', () => {
  it('keeps a queued Turn Off through a sync that has not started its list yet', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.env = {...h.env, currency: 'EUR'};
    const sync = h.queue.sync();
    const off = h.queue.turnOff(btc);
    await sync;
    await off;
    expect(h.api.save).toHaveBeenCalledTimes(1);
    expect(h.held.size).toBe(0);
    expect(h.context.alerts[btc.id]).toBeUndefined();
  });

  it('records the returned selector when the first probe discovers registration after removal', async () => {
    const h = harness();
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const sync = h.queue.sync();
    await tick();
    h.queue.remove(btc);
    h.held.set('native:btc', alert());
    gate.resolve({
      registration: {
        registered: true,
        externalUserId: 'braze-A',
        pushEnabled: false,
        priceAlertsEnabled: true,
      },
      alerts: [alert()],
    });
    await sync;
    await tick();
    expect(h.state.items.some(item => item.id === btc.id)).toBe(false);
    expect(h.context.alerts[btc.id]).toBeUndefined();
    expect(h.held.size).toBe(0);
  });

  it('keeps a pending selector across a persisted-state restart', async () => {
    const h = harness();
    await h.queue.save(btc, 10);
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.queue.remove(btc);
    await tick();
    const restored = harness();
    restored.state = JSON.parse(JSON.stringify(h.state));
    restored.register();
    restored.held.set('native:btc', alert());
    await restored.queue.sync();
    expect(restored.held.size).toBe(0);
    expect(restored.context.pendingRemovals).toEqual({});
  });
});

it('rechecks the capacity when a queued save actually reaches the backend', async () => {
  const h = harness();
  const gate = deferred<PriceAlertRegistration>();
  h.api.register.mockReturnValueOnce(gate.promise);
  const saving = h.queue.save(usdc, 10);
  await tick();
  h.state = {
    ...h.state,
    items: Array.from({length: 20}, (_, i) => ({
      ...btc,
      id: `x${i}`,
      selector: {coin: `unknown-${i}`},
      assets: [],
    })),
  };
  gate.resolve({
    registered: true,
    externalUserId: 'braze-A',
    priceAlertsEnabled: true,
    pushEnabled: false,
  });
  await expect(saving).rejects.toMatchObject({code: 'WATCHLIST_FULL'});
  expect(h.api.save).not.toHaveBeenCalled();
});

it('removes the stored backend selector after Turn Off followed by an in-flight re-enable', async () => {
  const h = harness();
  h.register();
  const polygon = {
    chain: 'matic',
    tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  };
  h.held.set(selectorKey(polygon), alert(polygon));
  await h.queue.sync();
  await h.queue.turnOff(usdc);
  const gate = deferred<PriceAlert>();
  h.api.save.mockReturnValueOnce(gate.promise);
  const saving = h.queue.save(usdc, 20);
  await tick();
  h.queue.remove(usdc);
  gate.resolve(alert(polygon, 20));
  await saving;
  await tick();
  expect(selectorKey(h.api.remove.mock.calls.at(-1)![0])).toBe(
    selectorKey(polygon),
  );
});

const polygonUsdc = {
  chain: 'matic',
  tokenAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
};
const lateTokenCatalog = (polygonLoaded: boolean) =>
  buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xlate_e': {
        name: 'Late Token',
        symbol: 'LATE',
        address: '0xlate',
        decimals: 18,
        logoURI: 'late.png',
      },
      ...(polygonLoaded
        ? {
            '0xlate_m': {
              name: 'Late Token',
              symbol: 'LATE',
              address: '0xlate',
              decimals: 18,
              logoURI: 'late.png',
            },
          }
        : {}),
    },
  });

describe('repair 2.1: selector and whole-coin removals', () => {
  it('retries a failed duplicate DELETE without removing the kept alert', async () => {
    const h = harness();
    h.register();
    h.queue.add(usdc);
    h.held.set(selectorKey(usdc.selector), alert(usdc.selector));
    h.held.set(selectorKey(polygonUsdc), alert(polygonUsdc));
    await h.queue.sync();
    h.api.remove.mockRejectedValueOnce(new Error('offline'));
    h.advance();
    await h.queue.sync();
    expect(h.context.alerts[usdc.id]?.alert).toEqual(alert(usdc.selector));
    expect(Object.keys(h.context.pendingRemovals)).toEqual([
      selectorKey(polygonUsdc),
    ]);
    h.advance();
    await h.queue.sync();
    expect([...h.held.keys()]).toEqual([selectorKey(usdc.selector)]);
    expect(h.context.alerts[usdc.id]?.alert).toEqual(alert(usdc.selector));
  });

  it('retains whole-coin removal reach after a list retires its intent and token details arrive late', async () => {
    const h = harness();
    h.register();
    const early = lateTokenCatalog(false);
    h.setCatalog(early);
    const token = early.fromSelector({chain: 'eth', tokenAddress: '0xlate'})!;
    h.held.set(
      'token:eth:0xlate',
      alert({chain: 'eth', tokenAddress: '0xlate'}),
    );
    h.held.set(
      'token:matic:0xlate',
      alert({chain: 'matic', tokenAddress: '0xlate'}),
    );
    await h.queue.sync();
    h.api.remove.mockRejectedValue(new Error('offline'));
    h.queue.remove(token);
    await tick();
    h.advance();
    await h.queue.sync();
    expect(h.context.intents[token.id]).toBeUndefined();
    // Rehydrate before details arrive: removal reach must be persisted.
    const restored = harness();
    restored.state = JSON.parse(JSON.stringify(h.state));
    restored.setCatalog(lateTokenCatalog(true));
    restored.queue.catalogChanged();
    expect(restored.state.items.some(item => item.id === token.id)).toBe(false);
    expect(restored.context.alerts[token.id]).toBeUndefined();
    expect(
      restored.context.pendingRemovals['token:matic:0xlate'],
    ).toBeDefined();
  });

  it('a newer Save ends older whole-coin reach but retains another selector through sync and restart', async () => {
    const h = harness();
    h.register();
    h.held.set(selectorKey(polygonUsdc), alert(polygonUsdc));
    await h.queue.sync();
    await h.queue.save(usdc, 15);
    expect(selectorKey(h.api.save.mock.calls[0][0])).toBe(
      selectorKey(polygonUsdc),
    );
    h.api.remove.mockRejectedValue(new Error('offline'));
    h.queue.remove(usdc);
    await tick();
    h.queue.add(usdc);
    await h.queue.save(usdc, 20);
    for (let i = 0; i < 2; i++) {
      h.advance();
      await h.queue.sync();
    }
    const check = (target: ReturnType<typeof harness>) => {
      expect(target.context.alerts[usdc.id]?.alert).toEqual(
        alert(usdc.selector, 20),
      );
      expect(Object.keys(target.context.pendingRemovals)).toEqual([
        selectorKey(polygonUsdc),
      ]);
      expect(target.held.get(selectorKey(usdc.selector))?.thresholdPct).toBe(
        20,
      );
    };
    check(h);
    const restored = harness();
    restored.state = JSON.parse(JSON.stringify(h.state));
    restored.register();
    h.held.forEach((value, key) => restored.held.set(key, value));
    restored.api.remove.mockRejectedValueOnce(new Error('offline'));
    await restored.queue.sync();
    check(restored);
    restored.advance();
    await restored.queue.sync();
    expect([...restored.held.keys()]).toEqual([selectorKey(usdc.selector)]);
    expect(restored.context.pendingRemovals).toEqual({});
    expect(restored.context.alerts[usdc.id]?.alert.thresholdPct).toBe(20);
  });

  it('migrates an unmarked saved removal without a remove intent as selector-only', async () => {
    const h = harness();
    h.register();
    h.queue.add(usdc);
    h.held.set(selectorKey(usdc.selector), alert(usdc.selector));
    await h.queue.sync();
    h.context.pendingRemovals[selectorKey(polygonUsdc)] = {
      itemId: usdc.id,
      selector: polygonUsdc,
      order: 1,
    };
    const restored = harness();
    restored.state = JSON.parse(JSON.stringify(h.state));
    restored.register();
    restored.held.set(selectorKey(usdc.selector), alert(usdc.selector));
    restored.held.set(selectorKey(polygonUsdc), alert(polygonUsdc));
    restored.api.remove.mockRejectedValueOnce(new Error('offline'));
    await restored.queue.sync();
    expect(restored.api.remove).toHaveBeenCalledWith(polygonUsdc);
    expect(restored.context.alerts[usdc.id]?.alert).toEqual(
      alert(usdc.selector),
    );
    expect(Object.keys(restored.context.pendingRemovals)).toEqual([
      selectorKey(polygonUsdc),
    ]);
  });
});

describe('repair 2.2: catalog updates are not backend snapshots', () => {
  it('keeps a lost Save unknown until a real list settles the new threshold', async () => {
    const h = harness();
    h.register();
    h.held.set('native:btc', alert());
    h.held.set(
      'token:eth:0xlate',
      alert({chain: 'eth', tokenAddress: '0xlate'}),
    );
    await h.queue.sync();
    h.api.save.mockImplementationOnce(async (selector, threshold, code) => {
      h.held.set(selectorKey(selector), alert(selector, threshold, code));
      throw new Error('response lost');
    });
    await expect(h.queue.save(btc, 20)).rejects.toThrow();
    h.context.alerts[btc.id].unknown = true;
    h.setCatalog(lateTokenCatalog(false));
    h.queue.catalogChanged();
    expect(h.context.unknownSelectors['native:btc']).toBe(true);
    expect(h.context.alerts[btc.id].unknown).toBe(true);
    h.env = {...h.env, currency: 'EUR'};
    await h.queue.preferencesChanged();
    expect(
      h.api.save.mock.calls.filter(
        ([selector]) => selectorKey(selector) === 'native:btc',
      ),
    ).toHaveLength(1);
    expect(h.held.get('native:btc')).toMatchObject({
      thresholdPct: 20,
      code: 'USD',
    });
    h.advance();
    await h.queue.sync();
    expect(h.held.get('native:btc')).toMatchObject({
      thresholdPct: 20,
      code: 'EUR',
    });
    expect(
      h.api.save.mock.calls
        .filter(([selector]) => selectorKey(selector) === 'native:btc')
        .at(-1)
        ?.slice(1),
    ).toEqual([20, 'EUR']);
  });

  it('preserves unknown registration and request intents until backend recovery lists first', async () => {
    const h = harness();
    h.register();
    h.held.set(
      'token:eth:0xlate',
      alert({chain: 'eth', tokenAddress: '0xlate'}),
    );
    await h.queue.sync();
    h.env = {...h.env, pushEnabled: true};
    h.api.register.mockRejectedValueOnce(new Error('response lost'));
    await h.queue.preferencesChanged();
    const acknowledged = h.context.registration;
    h.context.intents[btc.id] = {order: 0, kind: 'off'};
    h.setCatalog(lateTokenCatalog(false));
    h.queue.catalogChanged();
    expect(h.context.registrationUnknown).toBe(true);
    expect(h.context.registration).toBe(acknowledged);
    expect(h.context.intents[btc.id]).toEqual({order: 0, kind: 'off'});
    h.calls.length = 0;
    await h.queue.preferencesChanged();
    expect(h.calls.slice(0, 2)).toEqual(['list', 'register']);
  });
});

const mergeEth = {chain: 'eth', tokenAddress: '0xmergeeth'};
const mergePolygon = {chain: 'matic', tokenAddress: '0xmergepolygon'};
const groupCatalog = (merged: boolean, previous: typeof catalog.coins = []) =>
  buildCoinCatalog(
    SupportedCurrencyOptions,
    {
      tokenDataByAddress: {},
      tokenOptionsByAddress: {
        '0xmergeeth_e': {
          name: 'Merge Token',
          symbol: 'MRG',
          address: mergeEth.tokenAddress,
          decimals: 18,
          logoURI: 'eth.png',
        },
        '0xmergepolygon_m': {
          name: 'Merge Token',
          symbol: 'MRG',
          address: mergePolygon.tokenAddress,
          decimals: 18,
          logoURI: merged ? 'eth.png' : 'polygon.png',
        },
      },
    },
    previous,
  );
const groups = () => {
  const split = groupCatalog(false);
  const eth = split.fromSelector(mergeEth)!;
  const polygon = split.fromSelector(mergePolygon)!;
  const merged = groupCatalog(true, split.coins);
  const coin = merged.fromSelector(mergeEth)!;
  expect(coin.id).toBe(eth.id);
  expect(coin.id).not.toBe(polygon.id);
  return {split, eth, polygon, merged, coin};
};

describe('repair 2.4: catalog group identity changes', () => {
  it('re-keys a watched retired group and refuses a second add', () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.queue.add(g.polygon);
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    expect(h.state.items.at(-1)).toEqual({...g.coin, selector: mergePolygon});
    expect(h.queue.add(g.coin)).toBe(false);
    expect(h.state.items.filter(item => item.id === g.coin.id)).toHaveLength(1);
  });
  it('moves the alert mirror and intents with the watched row', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.held.set(selectorKey(mergePolygon), alert(mergePolygon));
    await h.queue.sync();
    h.context.intents[g.polygon.id] = {kind: 'save', order: 7};
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    expect(h.context.alerts[g.polygon.id]).toBeUndefined();
    expect(h.context.alerts[g.coin.id]?.alert).toEqual(alert(mergePolygon));
    expect(h.context.intents[g.coin.id]).toEqual({kind: 'save', order: 7});
  });
  it('merges watched rows at their earlier position and keeps that row’s alert through failed duplicate cleanup', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.queue.add(g.polygon);
    h.queue.add(g.eth);
    h.held.set(selectorKey(mergeEth), alert(mergeEth));
    h.held.set(selectorKey(mergePolygon), alert(mergePolygon, 15));
    await h.queue.sync();
    h.context.alerts[g.polygon.id].unknown = true;
    h.context.unknownSelectors[selectorKey(mergePolygon)] = true;
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    expect(h.state.items).toHaveLength(9);
    expect(h.state.items[8]).toEqual({...g.coin, selector: mergePolygon});
    expect(h.context.alerts[g.coin.id]).toMatchObject({
      alert: alert(mergePolygon, 15),
      unknown: true,
    });
    expect(h.context.unknownSelectors[selectorKey(mergePolygon)]).toBe(true);
    expect(Object.keys(h.context.pendingRemovals)).toEqual([
      selectorKey(mergeEth),
    ]);
    h.api.remove.mockRejectedValue(new Error('offline'));
    for (let n = 0; n < 2; n++) {
      h.advance();
      await h.queue.sync();
    }
    expect(h.state.items).toHaveLength(9);
    expect(h.context.alerts[g.coin.id]?.alert).toEqual(alert(mergePolygon, 15));
    expect(Object.keys(h.context.pendingRemovals)).toEqual([
      selectorKey(mergeEth),
    ]);
  });
  it('follows the stored selector on split even when the old id survives on the other half', () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.merged);
    h.queue.add({...g.coin, selector: mergePolygon});
    const splitAgain = groupCatalog(false, g.merged.coins);
    expect(splitAgain.fromSelector(mergeEth)?.id).toBe(g.coin.id);
    h.setCatalog(splitAgain);
    h.queue.catalogChanged();
    expect(h.state.items.at(-1)).toEqual({
      ...splitAgain.fromSelector(mergePolygon),
      selector: mergePolygon,
    });
    expect(h.state.items.at(-1)?.id).not.toBe(g.coin.id);
  });
  it('applies an in-flight Save to the row’s current id', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.queue.add(g.polygon);
    const gate = deferred<PriceAlert>();
    h.api.save.mockReturnValueOnce(gate.promise);
    const saving = h.queue.save(g.polygon, 20);
    await tick();
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    gate.resolve(alert(mergePolygon, 20));
    await saving;
    expect(h.state.items.filter(item => item.symbol === 'MRG')).toHaveLength(1);
    expect(h.context.alerts[g.coin.id]?.alert).toEqual(alert(mergePolygon, 20));
    expect(h.context.alerts[g.polygon.id]).toBeUndefined();
  });
  it('keeps a removal newer than an in-flight Save through re-keying', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.queue.add(g.polygon);
    const gate = deferred<PriceAlert>();
    h.api.save.mockReturnValueOnce(gate.promise);
    const saving = h.queue.save(g.polygon, 20);
    await tick();
    h.api.remove.mockRejectedValue(new Error('offline'));
    h.queue.remove(g.polygon);
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    gate.resolve(alert(mergePolygon, 20));
    await saving;
    await tick();
    expect(h.state.items.some(item => item.symbol === 'MRG')).toBe(false);
    expect(h.context.alerts[g.coin.id]).toBeUndefined();
    expect(h.context.alerts[g.polygon.id]).toBeUndefined();
    expect(h.context.pendingRemovals[selectorKey(mergePolygon)]).toMatchObject({
      itemId: g.coin.id,
      scope: 'coin',
    });
  });
  it('updates an open Edit sheet so Turn Off uses the moved row', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.held.set(selectorKey(mergePolygon), alert(mergePolygon));
    await h.queue.sync();
    h.state = {
      ...h.state,
      alertSheet: {
        coin: g.polygon,
        context: 'Watchlist',
        nonce: 1,
        isEdit: true,
        open: true,
      },
    };
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    expect(h.state.alertSheet?.coin.id).toBe(g.coin.id);
    await h.queue.turnOff(h.state.alertSheet!.coin);
    expect(h.held.size).toBe(0);
    expect(h.context.alerts).toEqual({});
    expect(h.state.items.at(-1)?.id).toBe(g.coin.id);
  });
  it('keeps an in-flight Turn Off attached to the current id', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.held.set(selectorKey(mergePolygon), alert(mergePolygon));
    await h.queue.sync();
    const gate = deferred<{disabled: true}>();
    h.api.remove.mockReturnValueOnce(gate.promise);
    const off = h.queue.turnOff(g.polygon);
    await tick();
    h.setCatalog(g.merged);
    h.queue.catalogChanged();
    gate.resolve({disabled: true});
    await off;
    expect(h.state.items.at(-1)?.id).toBe(g.coin.id);
    expect(h.context.alerts).toEqual({});
  });
  it('re-keys before a real list can append a second row and preserves a queued Save', async () => {
    const h = harness(),
      g = groups();
    h.setCatalog(g.split);
    h.register();
    h.queue.add(g.polygon);
    const gate = deferred<{
      registration: PriceAlertRegistration;
      alerts: PriceAlert[];
    }>();
    h.api.list.mockReturnValueOnce(gate.promise);
    const sync = h.queue.sync();
    await tick();
    const saving = h.queue.save(g.polygon, 20);
    // Deliberately let a list observe the new catalog before its subscription callback.
    h.setCatalog(g.merged);
    gate.resolve({
      registration: {
        registered: true,
        externalUserId: 'braze-A',
        pushEnabled: false,
        priceAlertsEnabled: true,
      },
      alerts: [alert(mergePolygon)],
    });
    await sync;
    await saving;
    expect(h.state.items.filter(item => item.symbol === 'MRG')).toHaveLength(1);
    expect(h.context.alerts[g.coin.id]?.alert.thresholdPct).toBe(20);
  });
});

it('applies an in-flight currency re-save under the current catalog id', async () => {
  const h = harness(),
    g = groups();
  h.setCatalog(g.split);
  h.register();
  h.held.set(selectorKey(mergePolygon), alert(mergePolygon));
  await h.queue.sync();
  h.env = {...h.env, currency: 'EUR'};
  const gate = deferred<PriceAlert>();
  h.api.save.mockReturnValueOnce(gate.promise);
  const resaving = h.queue.preferencesChanged();
  await tick();
  h.setCatalog(g.merged);
  h.queue.catalogChanged();
  gate.resolve(alert(mergePolygon, 10, 'EUR'));
  await resaving;
  expect(h.context.alerts[g.coin.id]?.alert.code).toBe('EUR');
  expect(h.context.alerts[g.polygon.id]).toBeUndefined();
});

it('a Save waiting outside the queue keeps its original order and yields to a newer removal', async () => {
  const h = harness();
  h.register();
  h.env = {...h.env, pushEnabled: undefined};
  const saving = h.queue.save(btc, 20);
  await tick();
  const saveOrder = h.context.intents[btc.id].order;
  h.queue.remove(btc);
  await h.queue.sync();
  expect(h.state.order).toBeGreaterThan(saveOrder);
  expect(h.api.list).toHaveBeenCalledTimes(1);
  h.env = {...h.env, pushEnabled: true};
  h.queue.permissionChanged();
  await saving;
  expect(h.api.save).not.toHaveBeenCalled();
  expect(h.state.items.some(item => item.id === btc.id)).toBe(false);
});

it('keeps a restored Polygon USDC selector for editing and whole-coin removal', async () => {
  const h = harness();
  h.register();
  h.held.set(selectorKey(polygonUsdc), alert(polygonUsdc));
  await h.queue.sync();
  await h.queue.save(usdc, 20);
  h.queue.remove(usdc);
  await tick();
  expect(selectorKey(h.api.save.mock.calls.at(-1)![0])).toBe(
    selectorKey(polygonUsdc),
  );
  expect(selectorKey(h.api.remove.mock.calls.at(-1)![0])).toBe(
    selectorKey(polygonUsdc),
  );
});
it('keeps an existing Ethereum WETH alert instead of switching to its new default', async () => {
  const h = harness();
  h.register();
  const ethereum = {
    chain: 'eth',
    tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  };
  const loaded = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      [ethereum.tokenAddress + '_e']: {
        name: 'Wrapped Ether',
        symbol: 'WETH',
        address: ethereum.tokenAddress,
        decimals: 18,
        logoURI: 'weth.png',
      },
    },
  });
  h.setCatalog(loaded);
  h.held.set(selectorKey(ethereum), alert(ethereum));
  await h.queue.sync();
  const weth = loaded.byId.get('coin:weth')!;
  await h.queue.save(weth, 15);
  await h.queue.turnOff(weth);
  expect(selectorKey(h.api.save.mock.calls.at(-1)![0])).toBe(
    selectorKey(ethereum),
  );
  expect(selectorKey(h.api.remove.mock.calls.at(-1)![0])).toBe(
    selectorKey(ethereum),
  );
});
