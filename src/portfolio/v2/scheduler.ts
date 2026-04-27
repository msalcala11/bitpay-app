import {
  recomputePortfolioState,
  type FormulaAssetGroupInput,
  type FormulaWalletInput,
  type NormalizedFormulaRecomputeInput,
  type RecomputeRequest,
  type RecomputeScope,
} from './recompute';
import {
  getPortfolioComputeRuntime,
  runOnPortfolioRuntimeAsync,
} from './runtimes';
import {
  getCurrentPortfolioWorkEpoch,
  publishPortfolioState,
  sharedPortfolioState,
} from './sharedState';
import type {PortfolioPublishReason, PortfolioState} from './model';
import {logPortfolioRuntimeError} from './logPortfolioRuntimeError';

const pendingRecomputes: RecomputeRequest[] = [];
let inFlightRecomputeRun:
  | Promise<ScheduledRecomputeRunResult>
  | undefined;
let scheduledRecomputeDrain: ReturnType<typeof setTimeout> | undefined;
let automaticRecomputeDrain: Promise<void> | undefined;
let schedulerGeneration = 0;

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

function maxOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (typeof left !== 'number') {
    return right;
  }
  if (typeof right !== 'number') {
    return left;
  }
  return Math.max(left, right);
}

function mergeOptionalIdentityList<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Array.from(new Set<T>([...left, ...right])).sort((leftValue, rightValue) =>
    leftValue.localeCompare(rightValue),
  );
}

function isRightNewerFormulaInput(args: {
  left: NormalizedFormulaRecomputeInput;
  right: NormalizedFormulaRecomputeInput;
}): boolean {
  return args.right.computedAtMs >= args.left.computedAtMs;
}

function mergeWalletInputs(args: {
  left: readonly FormulaWalletInput[];
  right: readonly FormulaWalletInput[];
  preferRight: boolean;
}): readonly FormulaWalletInput[] {
  const out = new Map<string, FormulaWalletInput>();
  const primary = args.preferRight ? args.right : args.left;
  const secondary = args.preferRight ? args.left : args.right;

  for (const wallet of secondary) {
    out.set(wallet.walletId, wallet);
  }
  for (const wallet of primary) {
    out.set(wallet.walletId, wallet);
  }

  return Array.from(out.values()).sort((left, right) =>
    left.walletId.localeCompare(right.walletId),
  );
}

function mergeAssetGroupInputs(args: {
  left: NormalizedFormulaRecomputeInput;
  right: NormalizedFormulaRecomputeInput;
  newest: NormalizedFormulaRecomputeInput;
}): readonly FormulaAssetGroupInput[] {
  const leftRevision = args.left.orderRevision ?? -1;
  const rightRevision = args.right.orderRevision ?? -1;
  const primary =
    rightRevision > leftRevision
      ? args.right.formula.assetGroups
      : leftRevision > rightRevision
        ? args.left.formula.assetGroups
        : args.newest.formula.assetGroups;
  const secondary =
    primary === args.left.formula.assetGroups
      ? args.right.formula.assetGroups
      : args.left.formula.assetGroups;

  const out = new Map<string, FormulaAssetGroupInput>();
  for (const group of secondary) {
    out.set(group.assetGroupId, group);
  }
  for (const group of primary) {
    out.set(group.assetGroupId, group);
  }

  return Array.from(out.values()).sort((left, right) => {
    const orderDelta = left.orderIndex - right.orderIndex;
    return orderDelta || left.assetGroupId.localeCompare(right.assetGroupId);
  });
}

function mergeByKey<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  keyOf: (value: T) => string,
  preferRight: boolean,
): readonly T[] | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const out = new Map<string, T>();
  const primary = preferRight ? right : left;
  const secondary = preferRight ? left : right;
  for (const value of secondary) {
    out.set(keyOf(value), value);
  }
  for (const value of primary) {
    out.set(keyOf(value), value);
  }
  return Array.from(out.values()).sort((leftValue, rightValue) =>
    keyOf(leftValue).localeCompare(keyOf(rightValue)),
  );
}

function mergeNormalizedFormulaInputs(
  left: NormalizedFormulaRecomputeInput | undefined,
  right: NormalizedFormulaRecomputeInput | undefined,
): NormalizedFormulaRecomputeInput | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const preferRight = isRightNewerFormulaInput({left, right});
  const newest = preferRight ? right : left;
  const older = preferRight ? left : right;

  return {
    computedAtMs: Math.max(left.computedAtMs, right.computedAtMs),
    formula: {
      quoteCurrency: newest.formula.quoteCurrency,
      wallets: mergeWalletInputs({
        left: left.formula.wallets,
        right: right.formula.wallets,
        preferRight,
      }),
      assetGroups: mergeAssetGroupInputs({left, right, newest}),
    },
    total: newest.total ?? older.total,
    populatedWalletIds: mergeOptionalIdentityList(
      left.populatedWalletIds,
      right.populatedWalletIds,
    ),
    invalidHistoryWalletIds: mergeOptionalIdentityList(
      left.invalidHistoryWalletIds,
      right.invalidHistoryWalletIds,
    ),
    retryScheduledWalletIds: mergeOptionalIdentityList(
      left.retryScheduledWalletIds,
      right.retryScheduledWalletIds,
    ),
    retryScheduledRateSourceKeys: mergeOptionalIdentityList(
      left.retryScheduledRateSourceKeys,
      right.retryScheduledRateSourceKeys,
    ),
    staleReasons: mergeOptionalIdentityList(left.staleReasons, right.staleReasons),
    orderRevision: maxOptionalNumber(left.orderRevision, right.orderRevision),
    scopes: mergeByKey(
      left.scopes,
      right.scopes,
      scope => scope.scopeKey,
      preferRight,
    ),
    scopedSlices: mergeByKey(
      left.scopedSlices,
      right.scopedSlices,
      scopedSlice => scopedSlice.walletIdsKey,
      preferRight,
    ),
    protectedScopedWalletIdsKeys: mergeOptionalIdentityList(
      left.protectedScopedWalletIdsKeys,
      right.protectedScopedWalletIdsKeys,
    ),
    evictScopedWalletIds: mergeOptionalIdentityList(
      left.evictScopedWalletIds,
      right.evictScopedWalletIds,
    ),
  };
}

function mergeRequests(
  existing: RecomputeRequest,
  incoming: RecomputeRequest,
  scope: RecomputeScope,
): RecomputeRequest {
  if (existing.startEpoch !== incoming.startEpoch) {
    return {...incoming, scope};
  }

  return {
    ...existing,
    ...incoming,
    startEpoch: existing.startEpoch,
    computedAtMs: maxOptionalNumber(existing.computedAtMs, incoming.computedAtMs),
    accessTouchWalletIds: mergeOptionalIdentityList(
      existing.accessTouchWalletIds,
      incoming.accessTouchWalletIds,
    ),
    normalizedFormulaInput: mergeNormalizedFormulaInputs(
      existing.normalizedFormulaInput,
      incoming.normalizedFormulaInput,
    ),
    scope,
  };
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

function withAccessTouchWalletIds(
  request: RecomputeRequest,
  walletIds: readonly string[],
): RecomputeRequest {
  return {
    ...request,
    accessTouchWalletIds: mergeOptionalIdentityList(
      request.accessTouchWalletIds,
      uniqueSorted(walletIds),
    ),
  };
}

function prunePendingRecomputesForEpoch(startEpoch: number): void {
  for (let index = pendingRecomputes.length - 1; index >= 0; index -= 1) {
    if (pendingRecomputes[index].startEpoch !== startEpoch) {
      pendingRecomputes.splice(index, 1);
    }
  }
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
    ...mergeRequests(existing, incoming, {kind: 'liveRateTouch'}),
    scope:
      existingIds && incomingIds
        ? {
            kind: 'liveRateTouch',
            changedAssetIds: uniqueSorted([...existingIds, ...incomingIds]),
          }
        : {kind: 'liveRateTouch'},
  };
}

function removeTouchWalletIds(
  walletIds: readonly string[],
  request: RecomputeRequest,
): RecomputeRequest {
  if (!walletIds.length) {
    return request;
  }

  let mergedRequest = request;
  const remove = new Set(walletIds);
  for (let index = pendingRecomputes.length - 1; index >= 0; index -= 1) {
    const pending = pendingRecomputes[index];
    if (!isTouchScope(pending.scope)) {
      continue;
    }

    const pendingWalletIds = walletIdsForScope(pending.scope);
    const foldedWalletIds = pendingWalletIds.filter(walletId =>
      remove.has(walletId),
    );
    if (foldedWalletIds.length) {
      mergedRequest = mergeRequests(
        withAccessTouchWalletIds(pending, foldedWalletIds),
        mergedRequest,
        mergedRequest.scope,
      );
    }

    const remaining = pendingWalletIds.filter(walletId => !remove.has(walletId));
    if (!remaining.length) {
      pendingRecomputes.splice(index, 1);
    } else {
      pendingRecomputes[index] = normalizeRequestScope(
        pending,
        makeTouchScope(remaining),
      );
    }
  }

  return mergedRequest;
}

function mergeWalletRecompute(incoming: RecomputeRequest): boolean {
  const incomingWalletIds = walletIdsForScope(incoming.scope);
  if (!incomingWalletIds.length) {
    return false;
  }

  const mergedIncoming = removeTouchWalletIds(incomingWalletIds, incoming);

  const existingIndex = pendingRecomputes.findIndex(pending =>
    isWalletScope(pending.scope),
  );
  if (existingIndex < 0) {
    if (mergedIncoming !== incoming) {
      pendingRecomputes.push(mergedIncoming);
      return true;
    }
    return false;
  }

  const existing = pendingRecomputes[existingIndex];
  pendingRecomputes[existingIndex] = mergeRequests(
    existing,
    mergedIncoming,
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

  const walletBuildIds = new Set<string>();
  for (let index = 0; index < pendingRecomputes.length; index += 1) {
    const pending = pendingRecomputes[index];
    if (!isWalletScope(pending.scope)) {
      continue;
    }

    const buildIds = walletIdsForScope(pending.scope);
    const foldedWalletIds = buildIds.filter(walletId =>
      incomingWalletIds.includes(walletId),
    );
    if (foldedWalletIds.length) {
      pendingRecomputes[index] = mergeRequests(
        pending,
        withAccessTouchWalletIds(incoming, foldedWalletIds),
        pending.scope,
      );
    }
    for (const walletId of buildIds) {
      walletBuildIds.add(walletId);
    }
  }
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
  pendingRecomputes[existingIndex] = mergeRequests(
    existing,
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

function clearScheduledRecomputeDrain(): void {
  if (scheduledRecomputeDrain === undefined) {
    return;
  }

  clearTimeout(scheduledRecomputeDrain);
  scheduledRecomputeDrain = undefined;
}

async function drainPendingRecomputes(generation: number): Promise<void> {
  while (generation === schedulerGeneration && pendingRecomputes.length) {
    const result = await runNextPendingRecompute();
    if (result.kind === 'idle') {
      return;
    }
  }
}

function startScheduledRecomputeDrain(): void {
  if (automaticRecomputeDrain) {
    return;
  }

  const drainGeneration = schedulerGeneration;
  const drain = drainPendingRecomputes(drainGeneration)
    .catch(error => {
      if (drainGeneration === schedulerGeneration) {
        logPortfolioRuntimeError(error, {
          tag: 'scheduledRecomputeDrain',
        });
      }
    })
    .finally(() => {
      if (automaticRecomputeDrain !== drain) {
        return;
      }
      automaticRecomputeDrain = undefined;
      if (drainGeneration === schedulerGeneration && pendingRecomputes.length) {
        queueScheduledRecomputeDrain();
      }
    });
  automaticRecomputeDrain = drain;
}

function queueScheduledRecomputeDrain(): void {
  if (scheduledRecomputeDrain !== undefined || automaticRecomputeDrain) {
    return;
  }

  scheduledRecomputeDrain = setTimeout(() => {
    scheduledRecomputeDrain = undefined;
    startScheduledRecomputeDrain();
  }, 0);
}

export function scheduleRecompute(request: RecomputeRequest): void {
  if (request.startEpoch !== getCurrentPortfolioWorkEpoch()) {
    return;
  }

  prunePendingRecomputesForEpoch(request.startEpoch);

  if (request.scope === 'full') {
    let mergedRequest = request;
    for (let index = pendingRecomputes.length - 1; index >= 0; index -= 1) {
      if (isLiveRateTouchScope(pendingRecomputes[index].scope)) {
        mergedRequest = mergeRequests(
          pendingRecomputes[index],
          mergedRequest,
          'full',
        );
        pendingRecomputes.splice(index, 1);
      }
    }
    const existingFullIndex = pendingRecomputes.findIndex(
      pending => pending.scope === 'full',
    );
    if (existingFullIndex >= 0) {
      pendingRecomputes[existingFullIndex] = mergeRequests(
        pendingRecomputes[existingFullIndex],
        mergedRequest,
        'full',
      );
    } else {
      pendingRecomputes.push(mergedRequest);
    }
    queueScheduledRecomputeDrain();
    return;
  }

  if (isLiveRateTouchScope(request.scope)) {
    const pendingFullIndex = pendingRecomputes.findIndex(
      pending => pending.scope === 'full',
    );
    if (pendingFullIndex >= 0) {
      pendingRecomputes[pendingFullIndex] = mergeRequests(
        pendingRecomputes[pendingFullIndex],
        request,
        'full',
      );
      queueScheduledRecomputeDrain();
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
    queueScheduledRecomputeDrain();
    return;
  }

  if (isWalletScope(request.scope) && mergeWalletRecompute(request)) {
    queueScheduledRecomputeDrain();
    return;
  }

  if (isTouchScope(request.scope) && mergeTouchRecompute(request)) {
    queueScheduledRecomputeDrain();
    return;
  }

  pendingRecomputes.push(request);
  queueScheduledRecomputeDrain();
}

async function runNextPendingRecomputeOnce(
  generation: number,
): Promise<ScheduledRecomputeRunResult> {
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

  if (generation !== schedulerGeneration) {
    return {kind: 'discarded', state: next};
  }

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

  const runGeneration = schedulerGeneration;
  const run = runNextPendingRecomputeOnce(runGeneration).finally(() => {
    if (inFlightRecomputeRun === run) {
      inFlightRecomputeRun = undefined;
    }
    if (runGeneration === schedulerGeneration && !pendingRecomputes.length) {
      clearScheduledRecomputeDrain();
    }
  });
  inFlightRecomputeRun = run;
  return run;
}

export async function awaitAutomaticRecomputeDrainForTesting(): Promise<void> {
  while (scheduledRecomputeDrain !== undefined || automaticRecomputeDrain) {
    if (scheduledRecomputeDrain !== undefined) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const drain = automaticRecomputeDrain;
    if (drain) {
      await drain;
    }
  }
}

export function getPendingRecomputesForTesting(): RecomputeRequest[] {
  return pendingRecomputes.slice();
}

export function clearPendingRecomputesForTesting(): void {
  schedulerGeneration += 1;
  pendingRecomputes.length = 0;
  inFlightRecomputeRun = undefined;
  automaticRecomputeDrain = undefined;
  clearScheduledRecomputeDrain();
}
