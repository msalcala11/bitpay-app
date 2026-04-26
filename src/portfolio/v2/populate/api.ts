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
import type {
  PopulateQueueItem,
  PopulateQueuePriority,
  PopulateQueueReason,
} from '../model';
import {populateCancelFlag} from '../sharedState';

const PRIORITY_RANK: Record<PopulateQueuePriority, number> = {
  urgentUserVisible: 0,
  normalUserVisible: 1,
  background: 2,
};

function sortPendingByPriority(
  pending: readonly PopulateQueueItem[],
): PopulateQueueItem[] {
  return pending.slice().sort((a, b) => {
    const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return a.requestedAtMs - b.requestedAtMs;
  });
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

export function startPopulate(args: {
  reason: PopulateQueueReason;
  isFirstPopulate: boolean;
  walletIds?: readonly string[];
  priority?: PopulateQueuePriority;
  /**
   * Phase 1 test seam only. Production trigger code should let startPopulate
   * create run IDs so business-event identity stays owned by the queue helper.
   */
  testRunId?: string;
}): void {
  const queue = args.isFirstPopulate
    ? emptyQueue()
    : loadQueue() ?? emptyQueue();
  const walletIds = args.walletIds ?? [];
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
    pending: sortPendingByPriority([...pendingAfterSupersession, ...toInsert]),
    updatedAt: requestedAtMs,
  });
  populateCancelFlag.value = false;
  kickPopulateLoopIfIdle();
}
