import {
  createWorkletRuntime,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';

import {
  initializePortfolioPopulateRuntimeGlobals,
  initializePortfolioRateFetchRuntimeGlobals,
  teardownPortfolioRuntimeGlobals,
} from '../adapters/rn/workletRuntimeShared';
import {logPortfolioRuntimeError} from './logPortfolioRuntimeError';
import type {PortfolioRuntimeKind} from './model';

export const PORTFOLIO_COMPUTE_RUNTIME_NAME = 'portfolio-compute';
export const PORTFOLIO_POPULATE_RUNTIME_NAME = 'portfolio-populate';
export const PORTFOLIO_RATE_FETCH_RUNTIME_NAME = 'portfolio-rate-fetch';

let computeRuntime: WorkletRuntime | undefined;
let populateRuntime: WorkletRuntime | undefined;
let rateFetchRuntime: WorkletRuntime | undefined;
const runtimeKinds = new WeakMap<object, PortfolioRuntimeKind>();

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
      initializePortfolioPopulateRuntimeGlobals();
      return;
    case 'rateFetch':
      initializePortfolioRateFetchRuntimeGlobals();
      return;
    default:
      return;
  }
}

function createPortfolioRuntime(args: {
  kind: PortfolioRuntimeKind;
  name: string;
}): WorkletRuntime {
  const runtime = createWorkletRuntime({
    name: args.name,
    initializer: () => {
      'worklet';
      initializePortfolioRuntimeGlobals(args.kind);
    },
    enableEventLoop: true,
  });
  runtimeKinds.set(runtime as object, args.kind);
  return runtime;
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

function getPortfolioRuntimeKind(
  runtime: WorkletRuntime,
): PortfolioRuntimeKind | undefined {
  const trackedKind = runtimeKinds.get(runtime as object);
  if (trackedKind) {
    return trackedKind;
  }

  const name = String((runtime as {name?: unknown}).name || '');
  switch (name) {
    case PORTFOLIO_COMPUTE_RUNTIME_NAME:
      return 'compute';
    case PORTFOLIO_POPULATE_RUNTIME_NAME:
      return 'populate';
    case PORTFOLIO_RATE_FETCH_RUNTIME_NAME:
      return 'rateFetch';
    default:
      return undefined;
  }
}

export function runOnPortfolioRuntimeAsync<
  TArgs extends readonly unknown[],
  TResult,
>(
  runtime: WorkletRuntime,
  workletFn: (...args: TArgs) => TResult,
  ...args: TArgs
): Promise<TResult> {
  const runtimeKind = getPortfolioRuntimeKind(runtime);
  if (!runtimeKind) {
    return runOnRuntimeAsync(runtime, workletFn, ...args) as Promise<TResult>;
  }

  return runOnRuntimeAsync(
    runtime,
    async (
      kind: PortfolioRuntimeKind,
      fn: (...fnArgs: TArgs) => TResult,
      fnArgs: TArgs,
    ): Promise<TResult> => {
      'worklet';

      initializePortfolioRuntimeGlobals(kind);
      try {
        return await fn(...fnArgs);
      } finally {
        teardownPortfolioRuntimeGlobals(kind);
      }
    },
    runtimeKind,
    workletFn,
    args,
  ) as Promise<TResult>;
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
