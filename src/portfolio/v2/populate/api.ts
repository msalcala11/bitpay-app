import {
  createRunId,
  emptyQueue,
  hasItemInQueue,
  loadQueue,
  priorityForPopulateReason,
  saveQueue,
} from './queue';
import type {PopulateQueueReason} from '../model';

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
    pending: [...queue.pending, ...toInsert],
    updatedAt: requestedAtMs,
  });
}
