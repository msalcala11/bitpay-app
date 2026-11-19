import React from 'react';
import {act, render} from '@testing-library/react-native';
import {AppState} from 'react-native';
import {checkNotifications, RESULTS} from 'react-native-permissions';
import {useWatchlistLifecycle} from './useWatchlistLifecycle';
import {initialWatchlistState} from './watchlist.reducer';
import {emptyAlertContext} from './watchlist.models';
import {savePriceAlert, priceAlertsContextKey} from './watchlist.effects';
import {buildCoinCatalog, selectorKey} from './coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';

const mockCatalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
const btc = mockCatalog.byId.get('coin:btc')!;
const LifecycleProbe = () => {
  useWatchlistLifecycle();
  return null;
};
let mockStore: any;
let mockState: any;
const mockAcknowledged = {
  registered: true,
  externalUserId: 'A',
  pushEnabled: true,
  priceAlertsEnabled: true,
};
const mockApi = {
  list: jest.fn(),
  register: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
};
jest.mock('react-redux', () => ({useStore: () => mockStore}));
jest.mock('./coin-registry', () => ({
  getCoinCatalog: () => mockCatalog,
  subscribeCoinCatalog: () => () => {},
}));
jest.mock('../../constants/config', () => ({
  BASE_PRICE_ALERTS_URL: 'https://test.example',
}));
jest.mock('../../api/price-alerts', () => ({
  ...jest.requireActual('../../api/price-alerts'),
  PriceAlertsApi: jest.fn(() => mockApi),
}));
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const pending = () => {
  let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
let publish: () => void;
let foreground: (state: string) => void;
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.list.mockResolvedValue({registration: mockAcknowledged, alerts: []});
  mockApi.register.mockImplementation(async changes => ({
    ...mockAcknowledged,
    ...changes,
  }));
  mockApi.save.mockImplementation(async (selector, thresholdPct, code) => ({
    ...selector,
    assetKey: selectorKey(selector),
    thresholdPct,
    code,
  }));
  const key = priceAlertsContextKey('aa');
  mockState = {
    APP: {
      network: 'livenet',
      identity: {livenet: {pub: 'aa', priv: 'bb'}},
      appWasInit: true,
      brazeEid: 'A',
      notificationsAccepted: true,
      defaultAltCurrency: {isoCode: 'USD'},
    },
    WATCHLIST: {
      ...initialWatchlistState,
      contexts: {
        [key]: {
          ...emptyAlertContext(),
          attemptedSave: true,
          registration: {...mockAcknowledged},
        },
      },
    },
  };
  const listeners = new Set<() => void>();
  publish = () => listeners.forEach(fn => fn());
  mockStore = {
    getState: () => mockState,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch: (action: any): any => {
      if (typeof action === 'function')
        return action(mockStore.dispatch, mockStore.getState, undefined);
      if (action.type === 'WATCHLIST/UPDATE') {
        mockState = {...mockState, WATCHLIST: action.payload};
        publish();
      }
      return action;
    },
  };
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    listener: (state: string) => void,
  ) => {
    foreground = listener;
    return {remove: jest.fn()};
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

describe('repair 2.5: permission initialization', () => {
  it('probes while permission is pending without sending guessed registration preferences', async () => {
    const check = pending();
    (checkNotifications as jest.Mock).mockReturnValue(check.promise);
    render(<LifecycleProbe />);
    await act(tick);
    expect(mockApi.list).toHaveBeenCalledTimes(1);
    expect(mockApi.register).not.toHaveBeenCalled();
    await act(async () => {
      check.resolve({status: RESULTS.GRANTED});
      await tick();
    });
    expect(mockState.WATCHLIST.permissionAllowed).toBe(true);
    expect(mockApi.register).not.toHaveBeenCalled();
  });
  it('does not update matching preferences when permission resolves before app initialization', async () => {
    mockState.APP.appWasInit = false;
    (checkNotifications as jest.Mock).mockResolvedValue({
      status: RESULTS.GRANTED,
    });
    render(<LifecycleProbe />);
    await act(tick);
    expect(mockApi.list).not.toHaveBeenCalled();
    await act(async () => {
      mockState.APP.appWasInit = true;
      publish();
      await tick();
    });
    expect(mockApi.list).toHaveBeenCalledTimes(1);
    expect(mockApi.register).not.toHaveBeenCalled();
  });
  it('does not block the launch probe when the check never completes', async () => {
    (checkNotifications as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(<LifecycleProbe />);
    await act(tick);
    expect(mockApi.list).toHaveBeenCalledTimes(1);
    expect(mockApi.register).not.toHaveBeenCalled();
  });
  it.each(['granted', 'failed'])(
    'a Save waits for the first permission check, including %s',
    async result => {
      const check = pending();
      (checkNotifications as jest.Mock).mockReturnValue(check.promise);
      render(<LifecycleProbe />);
      await act(tick);
      let saving!: Promise<any>;
      await act(async () => {
        saving = mockStore.dispatch(savePriceAlert(btc, 20));
        await tick();
      });
      expect(mockApi.save).not.toHaveBeenCalled();
      expect(mockApi.list).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (result === 'failed')
          check.reject(new Error('permission lookup failed'));
        else check.resolve({status: RESULTS.GRANTED});
        await saving;
      });
      expect(mockApi.save).toHaveBeenCalledTimes(1);
      expect(mockState.WATCHLIST.permissionAllowed).toBe(result === 'granted');
      if (result === 'failed')
        expect(mockApi.register).toHaveBeenCalledWith({pushEnabled: false});
      else expect(mockApi.register).not.toHaveBeenCalled();
    },
  );
  it('keeps a known permission after a later foreground check fails', async () => {
    (checkNotifications as jest.Mock)
      .mockResolvedValueOnce({status: RESULTS.GRANTED})
      .mockRejectedValueOnce(new Error('lookup failed'));
    render(<LifecycleProbe />);
    await act(tick);
    await act(async () => {
      foreground('active');
      await tick();
    });
    expect(mockState.WATCHLIST.permissionAllowed).toBe(true);
  });
});

it('retries a failed initial permission check on the next foreground', async () => {
  (checkNotifications as jest.Mock)
    .mockRejectedValueOnce(new Error('lookup failed'))
    .mockResolvedValueOnce({status: RESULTS.GRANTED});
  render(<LifecycleProbe />);
  await act(tick);
  expect(mockState.WATCHLIST.permissionAllowed).toBe(false);
  await act(async () => {
    foreground('active');
    await tick();
  });
  expect(checkNotifications).toHaveBeenCalledTimes(2);
  expect(mockState.WATCHLIST.permissionAllowed).toBe(true);
});
