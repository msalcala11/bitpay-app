import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  ensurePortfolioRuntimeSigningGlobals,
} from './txHistorySigning';

type PortfolioRuntimeKind = 'compute' | 'populate' | 'rateFetch';

export type RuntimeErrorDetails = {
  message: string;
  stack?: string;
};

export const PORTFOLIO_WORKLET_RUNTIME_NAME = 'bitpay-portfolio-engine-runtime';

export function toRuntimeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function getRuntimeErrorDetails(error: unknown): RuntimeErrorDetails {
  'worklet';

  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown portfolio runtime error.',
      stack: error.stack,
    };
  }

  try {
    return {
      message: JSON.stringify(error),
    };
  } catch {
    return {
      message: String(error),
    };
  }
}

export function buildRuntimeErrorFromDetails(
  message: string,
  stack?: string,
): Error {
  const error = new Error(message || 'Unknown portfolio runtime error.');
  if (stack) {
    error.stack = stack;
  }
  return error;
}

/**
 * Bundle Mode runtime initializer hook.
 *
 * Phase 2 intentionally keeps this light. Phase 3 can extend it with any
 * extra globals needed by the tx-history or fiat-rate adapters.
 */
export function initializePortfolioRuntimeBaseGlobals(): void {
  'worklet';

  ensurePortfolioRuntimeSigningGlobals();
}

export function initializePortfolioPopulateRuntimeGlobals(): void {
  'worklet';

  initializePortfolioRuntimeBaseGlobals();
}

export function initializePortfolioRateFetchRuntimeGlobals(): void {
  'worklet';

  initializePortfolioRuntimeBaseGlobals();
  clearPortfolioTxHistorySigningDispatchContextOnRuntime();
}

export function teardownPortfolioPopulateRuntimeGlobals(): void {
  'worklet';

  clearPortfolioTxHistorySigningDispatchContextOnRuntime();
}

export function teardownPortfolioRateFetchRuntimeGlobals(): void {
  'worklet';

  clearPortfolioTxHistorySigningDispatchContextOnRuntime();
}

export function teardownPortfolioRuntimeGlobals(
  kind: PortfolioRuntimeKind,
): void {
  'worklet';

  switch (kind) {
    case 'populate':
      teardownPortfolioPopulateRuntimeGlobals();
      break;
    case 'rateFetch':
      teardownPortfolioRateFetchRuntimeGlobals();
      break;
    case 'compute':
    default:
      break;
  }

  const globalRef = globalThis as typeof globalThis & {
    __bitpayPortfolioV2RuntimeKind__?: PortfolioRuntimeKind;
  };
  if (globalRef.__bitpayPortfolioV2RuntimeKind__ === kind) {
    delete globalRef.__bitpayPortfolioV2RuntimeKind__;
  }
}

export function initializePortfolioRuntimeGlobals(): void {
  'worklet';

  // Legacy v1 entry point. Portfolio v2 must use the runtime-kind-specific
  // initializers above so rate-fetch never inherits a wallet signing context.
  initializePortfolioPopulateRuntimeGlobals();
}
