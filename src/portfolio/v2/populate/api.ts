import {
  createRunId,
  emptyQueue,
  hasItemInQueue,
  loadQueue,
  priorityForPopulateReason,
  saveQueue,
} from './queue';
import type {
  PopulateQueueItem,
  PopulateQueuePriority,
  PopulateQueueReason,
} from '../model';

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

export function startPopulate(args: {
  walletIds: readonly string[];
  reason: PopulateQueueReason;
  runId?: string;
}): void {
  const queue = loadQueue() ?? emptyQueue();
  const runId = args.runId ?? createRunId(args.reason);
  const priority = priorityForPopulateReason(args.reason);
  const requestedAtMs = Date.now();
  const incoming = args.walletIds.map(walletId => ({
    itemId: `${runId}:${walletId}`,
    runId,
    walletId,
    reason: args.reason,
    priority,
    requestedAtMs,
  }));
  const toInsert = incoming.filter(item => !hasItemInQueue(queue, item));
  if (!toInsert.length) {
    return;
  }
  saveQueue({
    ...queue,
    pending: sortPendingByPriority([...queue.pending, ...toInsert]),
    updatedAt: requestedAtMs,
  });
}
