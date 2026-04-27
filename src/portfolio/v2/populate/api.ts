import {
  createRunId,
  emptyQueue,
  hasItemInQueue,
  loadQueue,
  priorityForPopulateReason,
  saveQueue,
} from './queue';
import {kickPopulateLoopIfIdle} from './populateLoop';
import {logPortfolioRuntimeError} from '../logPortfolioRuntimeError';
import {getPopulateEligibleWalletIdsFromStore} from '../reduxAccess';
import type {
  PopulateQueueItem,
  PopulateQueuePriority,
  PopulateQueueReason,
} from '../model';
import {populateCancelFlag} from '../sharedState';

type StartPopulateArgs = Readonly<{
  reason: PopulateQueueReason;
  isFirstPopulate: boolean;
  walletIds?: readonly string[];
  priority?: PopulateQueuePriority;
}>;

type StartPopulateInternalArgs = StartPopulateArgs &
  Readonly<{
    testRunId?: string;
  }>;

function priorityLane(
  items: readonly PopulateQueueItem[],
  priority: PopulateQueuePriority,
): PopulateQueueItem[] {
  return items.filter(item => item.priority === priority);
}

function insertPendingItemsByPriority(args: {
  existing: readonly PopulateQueueItem[];
  incoming: readonly PopulateQueueItem[];
}): PopulateQueueItem[] {
  return [
    ...priorityLane(args.existing, 'urgentUserVisible'),
    ...priorityLane(args.incoming, 'urgentUserVisible'),
    ...priorityLane(args.existing, 'normalUserVisible'),
    ...priorityLane(args.incoming, 'normalUserVisible'),
    ...priorityLane(args.existing, 'background'),
    ...priorityLane(args.incoming, 'background'),
  ];
}

function supersedeOlderUnstartedSameWalletItems(args: {
  pending: readonly PopulateQueueItem[];
  incoming: readonly PopulateQueueItem[];
}): PopulateQueueItem[] {
  const urgentIncomingWalletIds = new Set(
    args.incoming
      .filter(item => item.priority === 'urgentUserVisible')
      .map(item => item.walletId),
  );

  if (!urgentIncomingWalletIds.size) {
    return args.pending.slice();
  }

  return args.pending.filter(item => {
    if (!urgentIncomingWalletIds.has(item.walletId)) {
      return true;
    }
    return item.priority === 'urgentUserVisible';
  });
}

function startPopulateInternal(args: StartPopulateInternalArgs): void {
  const queue = args.isFirstPopulate
    ? emptyQueue()
    : loadQueue() ?? emptyQueue();
  let walletIds: readonly string[] = [];
  try {
    walletIds = args.walletIds?.length
      ? args.walletIds
      : args.isFirstPopulate
        ? getPopulateEligibleWalletIdsFromStore()
        : [];
  } catch (error: unknown) {
    logPortfolioRuntimeError(error, {
      tag: 'startPopulate',
      reason: 'populateEligibilityUnavailable',
    });
    walletIds = [];
  }
  if (!walletIds.length) {
    logPortfolioRuntimeError(new Error('No populate wallet IDs supplied'), {
      tag: 'startPopulate',
      reason: 'missingWalletIds',
    });
    if (queue.pending.length || queue.active) {
      populateCancelFlag.value = false;
      kickPopulateLoopIfIdle();
    }
    return;
  }
  const runId = args.testRunId ?? createRunId(args.reason);
  const priority = args.priority ?? priorityForPopulateReason(args.reason);
  const requestedAtMs = Date.now();
  const incoming = walletIds.map(walletId => ({
    itemId: `${runId}:${walletId}`,
    runId,
    walletId,
    reason: args.reason,
    priority,
    requestedAtMs,
  }));
  const toInsert = incoming.filter(item => !hasItemInQueue(queue, item));
  if (!toInsert.length) {
    if (queue.pending.length || queue.active) {
      populateCancelFlag.value = false;
      kickPopulateLoopIfIdle();
    }
    return;
  }
  const pendingAfterSupersession = supersedeOlderUnstartedSameWalletItems({
    pending: queue.pending,
    incoming: toInsert,
  });
  saveQueue({
    ...queue,
    pending: insertPendingItemsByPriority({
      existing: pendingAfterSupersession,
      incoming: toInsert,
    }),
    updatedAt: requestedAtMs,
  });
  populateCancelFlag.value = false;
  kickPopulateLoopIfIdle();
}

export function startPopulate(args: StartPopulateArgs): void {
  startPopulateInternal(args);
}

export function startPopulateForTesting(
  args: StartPopulateArgs & {testRunId?: string},
): void {
  startPopulateInternal(args);
}
