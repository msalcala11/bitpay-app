import type {PopulateQueueV1} from '../model';

export function reconcileQueueAfterWalletDeletion(args: {
  queue: PopulateQueueV1;
  deletedWalletIds: readonly string[];
}): PopulateQueueV1 {
  const deleted = new Set(args.deletedWalletIds);
  return {
    ...args.queue,
    pending: args.queue.pending.filter(item => !deleted.has(item.walletId)),
    active:
      args.queue.active && deleted.has(args.queue.active.walletId)
        ? undefined
        : args.queue.active,
  };
}
