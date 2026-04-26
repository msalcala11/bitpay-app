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
let inFlightRecomputeRun:
  | Promise<ScheduledRecomputeRunResult>
  | undefined;

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

function priorityForScope(scope: RecomputeScope): number {
  if (scope === 'full') {
    return 0;
  }
  if (typeof scope !== 'string') {
    if (scope.kind === 'wallet' || scope.kind === 'wallets') {
      return 1;
    }
    if (scope.kind === 'liveRateTouch') {
      return 2;
    }
    if (scope.kind === 'touchWallet' || scope.kind === 'touchWallets') {
      return 3;
    }
  }

  return 4;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function walletIdsForScope(scope: RecomputeScope): readonly string[] {
  if (typeof scope === 'string') {
    return [];
  }

  switch (scope.kind) {
    case 'wallet':
    case 'touchWallet':
      return [scope.walletId];
    case 'wallets':
    case 'touchWallets':
      return scope.walletIds;
    case 'liveRateTouch':
    default:
      return [];
  }
}

function isWalletScope(scope: RecomputeScope): boolean {
  return (
    typeof scope !== 'string' &&
    (scope.kind === 'wallet' || scope.kind === 'wallets')
  );
}

function isTouchScope(scope: RecomputeScope): boolean {
  return (
    typeof scope !== 'string' &&
    (scope.kind === 'touchWallet' || scope.kind === 'touchWallets')
  );
}

function isLiveRateTouchScope(scope: RecomputeScope): boolean {
  return typeof scope !== 'string' && scope.kind === 'liveRateTouch';
}

function makeWalletScope(walletIds: readonly string[]): RecomputeScope {
  const ids = uniqueSorted(walletIds);
  return ids.length === 1
    ? {kind: 'wallet', walletId: ids[0]}
    : {kind: 'wallets', walletIds: ids};
}

function makeTouchScope(walletIds: readonly string[]): RecomputeScope {
  const ids = uniqueSorted(walletIds);
  return ids.length === 1
    ? {kind: 'touchWallet', walletId: ids[0]}
    : {kind: 'touchWallets', walletIds: ids};
}

function normalizeRequestScope(
  request: RecomputeRequest,
  scope: RecomputeScope,
): RecomputeRequest {
  return {...request, scope};
}

function coalesceLiveRateTouch(
  existing: RecomputeRequest,
  incoming: RecomputeRequest,
): RecomputeRequest {
  const existingIds =
    typeof existing.scope !== 'string' && existing.scope.kind === 'liveRateTouch'
      ? existing.scope.changedAssetIds
      : undefined;
  const incomingIds =
    typeof incoming.scope !== 'string' && incoming.scope.kind === 'liveRateTouch'
      ? incoming.scope.changedAssetIds
      : undefined;

  return {
    ...incoming,
    scope:
      existingIds && incomingIds
        ? {
            kind: 'liveRateTouch',
            changedAssetIds: uniqueSorted([...existingIds, ...incomingIds]),
          }
        : {kind: 'liveRateTouch'},
  };
}

function removeTouchWalletIds(walletIds: readonly string[]): void {
  if (!walletIds.length) {
    return;
  }

  const remove = new Set(walletIds);
  for (let index = pendingRecomputes.length - 1; index >= 0; index -= 1) {
    const pending = pendingRecomputes[index];
    if (!isTouchScope(pending.scope)) {
      continue;
    }

    const remaining = walletIdsForScope(pending.scope).filter(
      walletId => !remove.has(walletId),
    );
    if (!remaining.length) {
      pendingRecomputes.splice(index, 1);
    } else {
      pendingRecomputes[index] = normalizeRequestScope(
        pending,
        makeTouchScope(remaining),
      );
    }
  }
}

function mergeWalletRecompute(incoming: RecomputeRequest): boolean {
  const incomingWalletIds = walletIdsForScope(incoming.scope);
  if (!incomingWalletIds.length) {
    return false;
  }

  removeTouchWalletIds(incomingWalletIds);

  const existingIndex = pendingRecomputes.findIndex(pending =>
    isWalletScope(pending.scope),
  );
  if (existingIndex < 0) {
    return false;
  }

  const existing = pendingRecomputes[existingIndex];
  pendingRecomputes[existingIndex] = normalizeRequestScope(
    incoming,
    makeWalletScope([
      ...walletIdsForScope(existing.scope),
      ...incomingWalletIds,
    ]),
  );
  return true;
}

function mergeTouchRecompute(incoming: RecomputeRequest): boolean {
  const incomingWalletIds = walletIdsForScope(incoming.scope);
  if (!incomingWalletIds.length) {
    return false;
  }

  const walletBuildIds = new Set(
    pendingRecomputes
      .filter(pending => isWalletScope(pending.scope))
      .flatMap(pending => walletIdsForScope(pending.scope)),
  );
  const unsubsumedIds = incomingWalletIds.filter(
    walletId => !walletBuildIds.has(walletId),
  );
  if (!unsubsumedIds.length) {
    return true;
  }

  const existingIndex = pendingRecomputes.findIndex(pending =>
    isTouchScope(pending.scope),
  );
  if (existingIndex < 0) {
    pendingRecomputes.push(
      normalizeRequestScope(incoming, makeTouchScope(unsubsumedIds)),
    );
    return true;
  }

  const existing = pendingRecomputes[existingIndex];
  pendingRecomputes[existingIndex] = normalizeRequestScope(
    incoming,
    makeTouchScope([...walletIdsForScope(existing.scope), ...unsubsumedIds]),
  );
  return true;
}

function nextPendingRecomputeIndex(): number {
  let selectedIndex = -1;
  let selectedPriority = Number.POSITIVE_INFINITY;

  for (let index = 0; index < pendingRecomputes.length; index += 1) {
    const priority = priorityForScope(pendingRecomputes[index].scope);
    if (priority < selectedPriority) {
      selectedPriority = priority;
      selectedIndex = index;
    }
  }

  return selectedIndex;
}

export function scheduleRecompute(request: RecomputeRequest): void {
  if (request.scope === 'full') {
    for (let index = pendingRecomputes.length - 1; index >= 0; index -= 1) {
      if (isLiveRateTouchScope(pendingRecomputes[index].scope)) {
        pendingRecomputes.splice(index, 1);
      }
    }
    pendingRecomputes.push(request);
    return;
  }

  if (isLiveRateTouchScope(request.scope)) {
    if (pendingRecomputes.some(pending => pending.scope === 'full')) {
      return;
    }

    const existingIndex = pendingRecomputes.findIndex(pending =>
      isLiveRateTouchScope(pending.scope),
    );
    if (existingIndex >= 0) {
      pendingRecomputes[existingIndex] = coalesceLiveRateTouch(
        pendingRecomputes[existingIndex],
        request,
      );
    } else {
      pendingRecomputes.push(request);
    }
    return;
  }

  if (isWalletScope(request.scope) && mergeWalletRecompute(request)) {
    return;
  }

  if (isTouchScope(request.scope) && mergeTouchRecompute(request)) {
    return;
  }

  pendingRecomputes.push(request);
}

async function runNextPendingRecomputeOnce(): Promise<ScheduledRecomputeRunResult> {
  const index = nextPendingRecomputeIndex();
  if (index < 0) {
    return {kind: 'idle'};
  }

  const [request] = pendingRecomputes.splice(index, 1);
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

export function runNextPendingRecompute(): Promise<ScheduledRecomputeRunResult> {
  if (inFlightRecomputeRun) {
    return inFlightRecomputeRun;
  }

  inFlightRecomputeRun = runNextPendingRecomputeOnce().finally(() => {
    inFlightRecomputeRun = undefined;
  });
  return inFlightRecomputeRun;
}

export function getPendingRecomputesForTesting(): RecomputeRequest[] {
  return pendingRecomputes.slice();
}

export function clearPendingRecomputesForTesting(): void {
  pendingRecomputes.length = 0;
  inFlightRecomputeRun = undefined;
}
