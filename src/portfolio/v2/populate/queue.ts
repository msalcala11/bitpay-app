import {getPortfolioMmkvStorageOnRN} from '../../adapters/rn/workletMmkvBridge';
import {
  POPULATE_QUEUE_KEY,
  PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS,
  PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED,
} from '../constants';
import {writePortfolioMmkvString} from '../kvStore';
import {logPortfolioRuntimeError} from '../logPortfolioRuntimeError';
import type {
  PopulateQueueItem,
  PopulateQueuePriority,
  PopulateQueueReason,
  PopulateQueueV1,
} from '../model';

export function priorityForPopulateReason(
  reason: PopulateQueueReason,
): PopulateQueuePriority {
  switch (reason) {
    case 'send':
    case 'pullToRefresh':
      return 'urgentUserVisible';
    case 'keyImport':
    case 'manual':
    case 'showPortfolioToggleOn':
      return 'normalUserVisible';
    case 'initial':
    case 'appLaunchIncremental':
    default:
      return 'background';
  }
}

export function createRunId(reason: PopulateQueueReason): string {
  return `${reason}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function emptyQueue(now = Date.now()): PopulateQueueV1 {
  return {
    schemaVersion: 1,
    pending: [],
    completedInRunItemIds: {},
    startedAt: now,
    updatedAt: now,
    cfg: {},
    ingest: {
      compressionEnabled: PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED,
      compressionAgeDays: PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS,
      pageSize: 1000,
    },
    pageSize: 1000,
  };
}

function isQueueItem(value: unknown): value is PopulateQueueItem {
  const item = value as Partial<PopulateQueueItem> | undefined;
  return (
    !!item &&
    typeof item.itemId === 'string' &&
    typeof item.runId === 'string' &&
    typeof item.walletId === 'string' &&
    typeof item.reason === 'string' &&
    typeof item.priority === 'string' &&
    typeof item.requestedAtMs === 'number'
  );
}

export function validateQueue(value: unknown): PopulateQueueV1 | null {
  const candidate = value as Partial<PopulateQueueV1> | undefined;
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.pending) ||
    !candidate.pending.every(isQueueItem) ||
    (candidate.active !== undefined && !isQueueItem(candidate.active)) ||
    !candidate.completedInRunItemIds ||
    typeof candidate.completedInRunItemIds !== 'object' ||
    typeof candidate.startedAt !== 'number' ||
    typeof candidate.updatedAt !== 'number' ||
    typeof candidate.pageSize !== 'number'
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    pending: candidate.pending.slice(),
    active: candidate.active,
    completedInRunItemIds: {...candidate.completedInRunItemIds},
    startedAt: candidate.startedAt,
    updatedAt: candidate.updatedAt,
    cfg: candidate.cfg || {},
    ingest: candidate.ingest || emptyQueue().ingest,
    pageSize: candidate.pageSize,
  };
}

export function loadQueue(): PopulateQueueV1 | null {
  const raw = getPortfolioMmkvStorageOnRN().getString(POPULATE_QUEUE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = validateQueue(parsed);
    if (!validated) {
      logPortfolioRuntimeError(new Error('Invalid populate queue'), {
        tag: 'loadQueue',
        reason: 'invalidSchema',
      });
      return null;
    }
    return validated;
  } catch (err) {
    logPortfolioRuntimeError(err, {tag: 'loadQueue', reason: 'parseError'});
    return null;
  }
}

export function saveQueue(queue: PopulateQueueV1): void {
  writePortfolioMmkvString({
    key: POPULATE_QUEUE_KEY,
    value: JSON.stringify(queue),
    reason: 'queue',
  });
}

export function hasItemInQueue(
  queue: PopulateQueueV1,
  item: PopulateQueueItem,
): boolean {
  return (
    queue.pending.some(pending => pending.itemId === item.itemId) ||
    queue.active?.itemId === item.itemId ||
    queue.completedInRunItemIds[item.itemId] === true
  );
}
