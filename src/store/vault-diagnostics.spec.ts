import * as Sentry from '@sentry/react-native';
import {
  reportVaultStartupFailure,
  vaultError,
  vaultDeferredMessage,
  safeVaultError,
  vaultDiagnostic,
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
