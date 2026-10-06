import {Alert, AppState, Linking} from 'react-native';
import {vaultStartupAlert} from './vault-startup-alert';
import {vaultError} from './vault-diagnostics';
let mockListener: (state: string) => void;
const mockListeners = new Map<string, (...args: any[]) => void>();
const mockRemove = jest.fn();
jest.mock('react-native', () => ({
  Alert: {alert: jest.fn()},
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn((event, listener) => {
      mockListeners.set(event, listener);
      if (event === 'change') mockListener = listener;
      return {remove: mockRemove};
    }),
  },
  Linking: {openURL: jest.fn(async () => {})},
  Platform: {OS: 'android'},
}));
jest.mock('i18next', () => ({
  t: (key: string, values?: {id: string}) =>
    values ? `${key}: ${values.id}` : key,
}));
jest.mock('../constants', () => ({
  URL: {HELP_AND_SUPPORT: 'https://support.bitpay.com/hc/en-us'},
}));
const alert = Alert.alert as jest.Mock;
const buttons = () => alert.mock.calls[alert.mock.calls.length - 1][2];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  jest.advanceTimersByTime(0);
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const appState = (value: string) => {
  (AppState as any).currentState = value;
  mockListener(value);
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockListeners.clear();
  (AppState as any).currentState = 'active';
  (Linking.openURL as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());
it('uses one fixed safe diagnostic, Retry and the fixed support URL', async () => {
  const retry = jest.fn();
  const dispose = vaultStartupAlert(new Error('PRIVATE_SENTINEL'), retry);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(alert.mock.calls).includes('PRIVATE_SENTINEL')).toBe(
    false,
  );
  expect(buttons().map((b: any) => b.text)).toEqual([
    'Retry',
    'Help & Support',
  ]);
  const click = buttons()[0].onPress;
  click();
  click();
  expect(retry).toHaveBeenCalledTimes(1);
  expect(mockRemove).toHaveBeenCalledTimes(mockListeners.size);
  dispose();
  expect(mockRemove).toHaveBeenCalledTimes(mockListeners.size);
});
it.each(['resolve-before-return', 'return-before-resolve', 'reject', 'throw'])(
  'support lifecycle retains Retry without bootstrapping: %s',
  async mode => {
    let resolve!: () => void, reject!: () => void;
    (Linking.openURL as jest.Mock).mockImplementation(() => {
      if (mode === 'throw') throw new Error('PRIVATE_SENTINEL');
      return new Promise<void>((ok, no) => {
        resolve = ok;
        reject = () => no(new Error('PRIVATE_SENTINEL'));
      });
    });
    const retry = jest.fn();
    const dispose = vaultStartupAlert(
      vaultError('MODERN_KEY_FAILURE', 'key'),
      retry,
    );
    buttons()[1].onPress();
    await flush();
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://support.bitpay.com/hc/en-us',
    );
    if (mode === 'reject') reject();
    else if (mode !== 'throw') {
      appState('background');
      if (mode === 'return-before-resolve') appState('active');
      resolve();
      await flush();
      if (mode === 'resolve-before-return') appState('active');
    }
    await flush();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(JSON.stringify(alert.mock.calls).includes('PRIVATE_SENTINEL')).toBe(
      false,
    );
    buttons()[0].onPress();
    expect(retry).toHaveBeenCalledTimes(1);
    dispose();
  },
);
it('cancels late support callbacks and app-state events on success/unmount', async () => {
  let reject!: () => void;
  (Linking.openURL as jest.Mock).mockImplementation(
    () =>
      new Promise((_ok, no) => {
        reject = () => no(new Error('private'));
      }),
  );
  const retry = jest.fn();
  const dispose = vaultStartupAlert({}, retry);
  const oldButtons = buttons();
  oldButtons[1].onPress();
  await flush();
  dispose();
  reject();
  appState('background');
  appState('active');
  await flush();
  oldButtons[0].onPress();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
  expect(mockRemove).toHaveBeenCalledTimes(mockListeners.size);
});
it('does not double-open support or present a speculative dialog before browser departure', async () => {
  const dispose = vaultStartupAlert({}, jest.fn());
  const click = buttons()[1].onPress;
  click();
  click();
  await flush();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledTimes(1);
  appState('background');
  appState('active');
  await flush();
  expect(alert).toHaveBeenCalledTimes(2);
  dispose();
});

it('re-presents after delayed background even when openURL settled while still active', async () => {
  const retry = jest.fn();
  const dispose = vaultStartupAlert({}, retry);
  const old = buttons();
  old[1].onPress();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(alert).toHaveBeenCalledTimes(1);
  appState('background');
  jest.runOnlyPendingTimers();
  expect(alert).toHaveBeenCalledTimes(1);
  appState('active');
  await flush();
  expect(alert).toHaveBeenCalledTimes(2);
  old[0].onPress();
  old[1].onPress();
  expect(retry).not.toHaveBeenCalled();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  buttons()[0].onPress();
  expect(retry).toHaveBeenCalledTimes(1);
  dispose();
});

it('review: restores reachable Retry after successful Support with no lifecycle events', async () => {
  const retry = jest.fn();
  const dispose = vaultStartupAlert({}, retry);
  const old = buttons();
  old[1].onPress();
  await flush();
  expect(alert).toHaveBeenCalledTimes(1); // Never present on fulfillment alone.
  jest.advanceTimersByTime(1000);
  expect(alert).toHaveBeenCalledTimes(2);
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  old[0].onPress();
  expect(retry).not.toHaveBeenCalled();
  const click = buttons()[0].onPress;
  click();
  click();
  expect(retry).toHaveBeenCalledTimes(1);
  dispose();
});

it('review: handles Android focus return without any AppState departure', async () => {
  const dispose = vaultStartupAlert({}, jest.fn());
  buttons()[1].onPress();
  await flush();
  mockListeners.get('focus')?.(); // Original dialog dismissal is not browser return.
  await flush();
  expect(alert).toHaveBeenCalledTimes(1);
  mockListeners.get('blur')?.();
  jest.advanceTimersByTime(1000);
  expect(alert).toHaveBeenCalledTimes(1);
  mockListeners.get('focus')?.();
  await flush();
  expect(alert).toHaveBeenCalledTimes(2);
  dispose();
});

it('review: invalidates a fallback dialog if the browser departs later, then restores Retry', async () => {
  const retry = jest.fn();
  const dispose = vaultStartupAlert({}, retry);
  buttons()[1].onPress();
  await flush();
  jest.advanceTimersByTime(1000);
  expect(alert).toHaveBeenCalledTimes(2);
  const fallback = buttons();
  appState('background');
  fallback[0].onPress();
  fallback[1].onPress();
  expect(retry).not.toHaveBeenCalled();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  appState('active');
  await flush();
  expect(alert).toHaveBeenCalledTimes(3);
  buttons()[0].onPress();
  expect(retry).toHaveBeenCalledTimes(1);
  dispose();
});

it('review: cancels the no-event fallback on disposal without polling or bootstrap', async () => {
  const retry = jest.fn();
  const dispose = vaultStartupAlert({}, retry);
  buttons()[1].onPress();
  await flush();
  dispose();
  jest.runAllTimers();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('review: retains the return listener if the app backgrounds before the queued Alert', async () => {
  const dispose = vaultStartupAlert({}, jest.fn());
  buttons()[1].onPress();
  await flush();
  appState('background');
  appState('active');
  appState('background');
  await flush();
  expect(alert).toHaveBeenCalledTimes(1);
  appState('active');
  await flush();
  expect(alert).toHaveBeenCalledTimes(2);
  dispose();
});

it('review: presents a startup failure first received in background on activation', async () => {
  (AppState as any).currentState = 'background';
  const dispose = vaultStartupAlert({}, jest.fn());
  expect(alert).not.toHaveBeenCalled();
  appState('active');
  await flush();
  expect(alert).toHaveBeenCalledTimes(1);
  dispose();
});
