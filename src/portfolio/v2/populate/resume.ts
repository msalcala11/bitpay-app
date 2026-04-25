import {loadQueue, saveQueue} from './queue';

export function normalizeActiveQueueItemForResume(): void {
  const queue = loadQueue();
  if (!queue?.active) {
    return;
  }

  saveQueue({
    ...queue,
    pending: [queue.active, ...queue.pending],
    active: undefined,
    updatedAt: Date.now(),
  });
}
