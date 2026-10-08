import * as Sentry from '@sentry/react-native';
import {
  reportVaultStartupFailure,
  vaultError,
  vaultDeferredMessage,
  safeVaultError,
  vaultDiagnostic,
  vaultReporter,
} from './vault-diagnostics';
jest.mock('@sentry/react-native', () => ({captureException: jest.fn()}));
beforeEach(() => jest.clearAllMocks());
it.each(['message', 'cause', 'object', 'getter'])(
  'F: startup reporting never forwards sentinel data from %s',
  kind => {
    const sentinel = 'PRIVATE_SENTINEL_NEVER_REPORT';
    const native: any =
      kind === 'object'
        ? {
            message: sentinel,
            code: sentinel,
            phase: sentinel,
            cause: {raw: sentinel},
          }
        : new Error(sentinel);
    native.cause = {message: sentinel, cause: {snapshot: sentinel}};
    if (kind === 'getter')
      Object.defineProperty(native, 'message', {
        get() {
          throw new Error(sentinel);
        },
      });
    reportVaultStartupFailure(native);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, options] = (Sentry.captureException as jest.Mock).mock
      .calls[0];
    expect(
      JSON.stringify({
        message: error.message,
        stack: error.stack,
        ...error,
        options,
      }).includes(sentinel),
    ).toBe(false);
    expect(options.tags).toEqual({
      vaultCode: 'STARTUP_FAILURE',
      vaultPhase: 'startup',
    });
    expect(error.cause).toBeUndefined();
  },
);
it.each([
  'MODERN_KEY_FAILURE',
  'NEW_KEY_VERIFICATION',
  'INVALID_LEGACY_INPUT',
  'SOURCE_CONFLICT',
  'REQUIRED_COPY_FAILURE',
  'PRESERVATION_FAILURE',
] as const)(
  'F: useful safe classification %s reaches the actual Sentry boundary once',
  code => {
    reportVaultStartupFailure(safeVaultError(vaultError(code, 'classify')));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, options] = (Sentry.captureException as jest.Mock).mock
      .calls[0];
    expect(vaultDiagnostic(error)).toEqual({code, phase: 'classify'});
    expect(options.tags.vaultCode).toBe(code);
  },
);
it('F: deferred diagnostics contain only fixed codes and phases', () => {
  expect(vaultDeferredMessage('OPTIONAL_REFRESH_DEFERRED', 'refresh')).toBe(
    'Vault migration deferred: OPTIONAL_REFRESH_DEFERRED (refresh)',
  );
  expect(vaultDeferredMessage('SCRUB_COVERAGE_DEFERRED', 'scrub')).toBe(
    'Vault migration deferred: SCRUB_COVERAGE_DEFERRED (scrub)',
  );
});

it('F: an unknown reporting object with throwing prototype traps is also sanitized', () => {
  const value = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('PRIVATE_PROXY_SENTINEL');
      },
    },
  );
  reportVaultStartupFailure(value);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  const [error, options] = (Sentry.captureException as jest.Mock).mock.calls[0];
  expect(error.message.includes('PRIVATE_PROXY_SENTINEL')).toBe(false);
  expect(options.tags.vaultCode).toBe('STARTUP_FAILURE');
});

it('keeps identity classification but discards subsequently attached reporting data', () => {
  const known = vaultError(
    'PRESERVATION_FAILURE',
    'recovery',
    'COPY_VERIFICATION',
    'mmkv',
  );
  Object.defineProperty(known, 'message', {
    get() {
      throw new Error('PRIVATE_GETTER');
    },
  });
  (known as any).cause = {raw: 'PRIVATE_CAUSE'};
  known.stack = 'PRIVATE_STACK';
  reportVaultStartupFailure(known);
  const [reported, options] = (Sentry.captureException as jest.Mock).mock
    .calls[0];
  expect(reported === known).toBe(false);
  expect(reported.stack).toBeUndefined();
  expect(reported.cause).toBeUndefined();
  expect(options.tags).toEqual({
    vaultCode: 'PRESERVATION_FAILURE',
    vaultPhase: 'recovery',
    vaultReason: 'COPY_VERIFICATION',
    vaultSource: 'mmkv',
  });
});

it('bounds aggregate reports, distinguishes changed failures and tolerates reporting failure', () => {
  const owner = {},
    log = jest.fn();
  for (let retry = 0; retry < 3; retry++) {
    const r = vaultReporter(owner, log);
    r.defer('CLEANUP_DEFERRED', 'cleanup');
    r.defer('CLEANUP_DEFERRED', 'cleanup');
    r.defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
    r.finish();
  }
  expect(log).toHaveBeenCalledTimes(1);
  const changed = vaultReporter(owner, log);
  changed.defer('LEGACY_KEY_UNREADABLE', 'key');
  changed.finish();
  expect(log).toHaveBeenCalledTimes(2);
  const failing = vaultReporter({}, () => {
    throw new Error('PRIVATE_SINK');
  });
  failing.defer('CLEANUP_DEFERRED', 'cleanup');
  expect(() => failing.finish()).not.toThrow();
  (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
    throw new Error('PRIVATE_SINK');
  });
  expect(() => reportVaultStartupFailure({})).not.toThrow();
});

it('does not suppress a materially different fixed source or reason', () => {
  const owner = {},
    log = jest.fn();
  const first = vaultReporter(owner, log);
  first.defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_READ', 'async');
  first.finish();
  const second = vaultReporter(owner, log);
  second.defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_READ', 'main-temp');
  second.finish();
  const same = vaultReporter(owner, log);
  same.defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_READ', 'main-temp');
  same.finish();
  const changed = vaultReporter(owner, log);
  changed.defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_CHANGED', 'main-temp');
  changed.finish();
  expect(log).toHaveBeenCalledTimes(3);
});
