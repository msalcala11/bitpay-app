import {
  createWorkletRuntime,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';

import {initializePortfolioRuntimeGlobals as initializeLegacyPortfolioRuntimeGlobals} from '../adapters/rn/workletRuntimeShared';
import {logPortfolioRuntimeError} from './logPortfolioRuntimeError';
import type {PortfolioRuntimeKind} from './model';

export const PORTFOLIO_COMPUTE_RUNTIME_NAME = 'portfolio-compute';
export const PORTFOLIO_POPULATE_RUNTIME_NAME = 'portfolio-populate';
export const PORTFOLIO_RATE_FETCH_RUNTIME_NAME = 'portfolio-rate-fetch';

let computeRuntime: WorkletRuntime | undefined;
let populateRuntime: WorkletRuntime | undefined;
let rateFetchRuntime: WorkletRuntime | undefined;

export function initializePortfolioRuntimeGlobals(
  kind: PortfolioRuntimeKind,
): void {
  'worklet';

  const globalRef = globalThis as typeof globalThis & {
    __bitpayPortfolioV2RuntimeKind__?: PortfolioRuntimeKind;
  };
  globalRef.__bitpayPortfolioV2RuntimeKind__ = kind;

  switch (kind) {
    case 'compute':
      return;
    case 'populate':
    case 'rateFetch':
      initializeLegacyPortfolioRuntimeGlobals();
      return;
    default:
      return;
  }
}

function createPortfolioRuntime(args: {
  kind: PortfolioRuntimeKind;
  name: string;
}): WorkletRuntime {
  return createWorkletRuntime({
    name: args.name,
    initializer: () => {
      'worklet';
      initializePortfolioRuntimeGlobals(args.kind);
    },
    enableEventLoop: true,
  });
}

export function getPortfolioComputeRuntime(): WorkletRuntime {
  if (!computeRuntime) {
    computeRuntime = createPortfolioRuntime({
      kind: 'compute',
      name: PORTFOLIO_COMPUTE_RUNTIME_NAME,
    });
  }
  return computeRuntime;
}

export function getPortfolioPopulateRuntime(): WorkletRuntime {
  if (!populateRuntime) {
    populateRuntime = createPortfolioRuntime({
      kind: 'populate',
      name: PORTFOLIO_POPULATE_RUNTIME_NAME,
    });
  }
  return populateRuntime;
}

export function getPortfolioRateFetchRuntime(): WorkletRuntime {
  if (!rateFetchRuntime) {
    rateFetchRuntime = createPortfolioRuntime({
      kind: 'rateFetch',
      name: PORTFOLIO_RATE_FETCH_RUNTIME_NAME,
    });
  }
  return rateFetchRuntime;
}

export function runOnPortfolioRuntimeAsync<
  TArgs extends readonly unknown[],
  TResult,
>(
  runtime: WorkletRuntime,
  workletFn: (...args: TArgs) => TResult,
  ...args: TArgs
): Promise<TResult> {
  return runOnRuntimeAsync(runtime, workletFn, ...args) as Promise<TResult>;
}

export function logFireAndForgetRuntimeError(
  tag: string,
): (err: unknown) => void {
  return err => logPortfolioRuntimeError(err, {tag});
}

export function resetPortfolioV2RuntimesForTesting(): void {
  computeRuntime = undefined;
  populateRuntime = undefined;
  rateFetchRuntime = undefined;
}
