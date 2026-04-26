import {
  recomputePortfolioState,
  type RecomputeRequest,
  type RecomputeScope,
} from './recompute';
import {
  getPortfolioComputeRuntime,
  runOnPortfolioRuntimeAsync,
} from './runtimes';
import {
  publishPortfolioState,
  sharedPortfolioState,
} from './sharedState';
import type {PortfolioPublishReason, PortfolioState} from './model';

const pendingRecomputes: RecomputeRequest[] = [];

export type ScheduledRecomputeRunResult =
  | Readonly<{kind: 'idle'}>
  | Readonly<{kind: 'unchanged'}>
  | Readonly<{kind: 'published'; state: PortfolioState}>
  | Readonly<{kind: 'discarded'; state: PortfolioState}>;

function publishReasonForScope(scope: RecomputeScope): PortfolioPublishReason {
  'worklet';

  if (scope === 'full') {
    return 'fullRecompute';
  }

  if (typeof scope !== 'string' && scope.kind === 'liveRateTouch') {
    return 'liveRateTouch';
  }

  return 'walletRecompute';
}

export function scheduleRecompute(request: RecomputeRequest): void {
  pendingRecomputes.push(request);
}

export async function runNextPendingRecompute(): Promise<ScheduledRecomputeRunResult> {
  const request = pendingRecomputes.shift();
  if (!request) {
    return {kind: 'idle'};
  }

  const current = sharedPortfolioState.value;
  const next = await runOnPortfolioRuntimeAsync(
    getPortfolioComputeRuntime(),
    recomputePortfolioState,
    current,
    request,
  );

  if (next === current) {
    return {kind: 'unchanged'};
  }

  publishPortfolioState({
    canonical: next,
    reason: publishReasonForScope(request.scope),
    startEpoch: request.startEpoch,
  });

  return sharedPortfolioState.value === next
    ? {kind: 'published', state: next}
    : {kind: 'discarded', state: next};
}

export function getPendingRecomputesForTesting(): RecomputeRequest[] {
  return pendingRecomputes.slice();
}

export function clearPendingRecomputesForTesting(): void {
  pendingRecomputes.length = 0;
}
