const mockReplayStartup = jest.fn();
const mockTransfer = jest.fn();
const mockLogStorage = {getString: jest.fn(), set: jest.fn()};
let mockActive = false;
let mockLogsEnabled = true;

jest.mock('./internal-vault-replay', () => ({
  createInternalVaultReplay: () => ({startup: mockReplayStartup}),
}));
jest.mock('./vault-transfer', () => ({
  transferVault: (...args: unknown[]) => mockTransfer(...args),
}));
jest.mock('./vault-storage', () => ({
  modernStorage: {},
  isVaultActive: () => mockActive,
  activateVaultStorage: () => {
    mockActive = true;
  },
}));
jest.mock('../utils/sessionLogs', () => ({
  sessionLogsStorage: mockLogStorage,
  isSessionLogsEnabled: () => mockLogsEnabled,
  PERSISTED_SESSION_LOGS_STORAGE_KEY: 'persist:logs',
}));
jest.mock('./log', () => ({
  LogActions: jest.requireActual('./log/log.actions'),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
};
const load = () => ({
  runtime: require('./vault-runtime') as typeof import('./vault-runtime'),
  logs: require('./log/initLogs') as typeof import('./log/initLogs'),
  reducer: require('./log/log.reducer') as typeof import('./log/log.reducer'),
  manager:
    require('../managers/LogManager') as typeof import('../managers/LogManager'),
  diagnostic:
    require('./vault-diagnostics') as typeof import('./vault-diagnostics'),
});
const drain = (app: ReturnType<typeof load>) =>
  app.logs.drainAndDispatch(action =>
    app.reducer.logReducer(undefined, action),
  );
const messages = (app: ReturnType<typeof load>) =>
  app.manager.logManager.getLogs().map(entry => entry.message);

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockActive = false;
  mockLogsEnabled = true;
  mockReplayStartup.mockReset().mockResolvedValue(undefined);
  mockTransfer.mockReset().mockResolvedValue('synthetic vault key');
  mockLogStorage.getString.mockReset().mockReturnValue(undefined);
  mockLogStorage.set.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('times only transfer and buffers one entry for the Session Log until the store drains', async () => {
  const replay = deferred<void>();
  const transfer = deferred<string>();
  mockReplayStartup.mockReturnValueOnce(replay.promise);
  mockTransfer.mockReturnValueOnce(transfer.promise);
  const app = load();
  const first = app.runtime.prepareModernVault();
  expect(app.runtime.prepareModernVault()).toBe(first);
  jest.advanceTimersByTime(5000);
  expect(mockTransfer).not.toHaveBeenCalled();
  replay.resolve();
  await Promise.resolve();
  expect(mockTransfer).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(250);
  transfer.resolve('synthetic vault key');
  await expect(first).resolves.toBe('synthetic vault key');
  expect(messages(app)).toEqual([]);
  expect(mockLogStorage.set).not.toHaveBeenCalled();

  // Later Redux rehydration and log draining must not inflate the measurement.
  jest.advanceTimersByTime(7000);
  drain(app);
  expect(messages(app)).toEqual([
    'Vault preparation result:success durationMs:250',
  ]);
  expect(mockLogStorage.set).toHaveBeenCalledTimes(1);
  const [key, raw] = mockLogStorage.set.mock.calls[0];
  expect(key).toBe('persist:logs');
  expect(JSON.parse(raw)).toEqual(app.manager.logManager.getLogs());
  expect(app.runtime.prepareModernVault()).toBe(first);
  drain(app);
  expect(mockTransfer).toHaveBeenCalledTimes(1);
  expect(messages(app)).toHaveLength(1);
});

it('buffers a failed attempt without raw details, preserving the error and same-runtime retry', async () => {
  const transfer = deferred<string>();
  mockTransfer.mockReturnValueOnce(transfer.promise);
  const app = load();
  const failure = app.diagnostic.vaultError(
    'INVALID_LEGACY_INPUT',
    'classify',
    'SOURCE_INVALID',
    undefined,
    'D13',
  );
  failure.message = 'synthetic private saved-data message';
  const first = app.runtime.prepareModernVault();
  await Promise.resolve();
  jest.advanceTimersByTime(35);
  transfer.reject(failure);
  await expect(first).rejects.toBe(failure);
  expect(mockActive).toBe(false);
  drain(app);
  expect(messages(app)).toEqual([]);
  expect(mockLogStorage.set).not.toHaveBeenCalled();

  const retry = app.runtime.prepareModernVault();
  expect(retry).not.toBe(first);
  await expect(retry).resolves.toBe('synthetic vault key');
  drain(app);
  expect(messages(app)).toEqual([
    'Vault preparation result:failure durationMs:35',
    'Vault preparation result:success durationMs:0',
  ]);
});

it.each([false, true])(
  'a logging failure cannot change a failed=%s preparation outcome',
  async failed => {
    const app = load();
    const failure = app.diagnostic.vaultError('SOURCE_CONFLICT', 'inventory');
    if (failed) mockTransfer.mockRejectedValueOnce(failure);
    jest.spyOn(app.logs, 'add').mockImplementationOnce(() => {
      throw new Error('synthetic logging failure');
    });
    const result = app.runtime.prepareModernVault();
    if (failed) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBe('synthetic vault key');
    expect(mockActive).toBe(!failed);
  },
);

it('does not report a migration duration when the preceding replay wipe fails', async () => {
  mockReplayStartup.mockRejectedValueOnce(new Error('synthetic wipe failure'));
  const app = load();
  await expect(app.runtime.prepareModernVault()).rejects.toThrow(
    'STARTUP_FAILURE',
  );
  expect(mockTransfer).not.toHaveBeenCalled();
  mockActive = true;
  drain(app);
  expect(messages(app)).toEqual([]);
  expect(mockLogStorage.set).not.toHaveBeenCalled();
});

it('honors the existing session-log opt-in', async () => {
  mockLogsEnabled = false;
  const app = load();
  await app.runtime.prepareModernVault();
  drain(app);
  expect(messages(app)).toEqual([]);
  expect(mockLogStorage.set).not.toHaveBeenCalled();
});
