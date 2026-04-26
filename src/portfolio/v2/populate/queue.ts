import {getPortfolioMmkvStorageOnRN} from '../../adapters/rn/workletMmkvBridge';
import {
  POPULATE_QUEUE_KEY,
  PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS,
  PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED,
} from '../constants';
import {writePortfolioMmkvString} from '../kvStore';
import {logPortfolioRuntimeError} from '../logPortfolioRuntimeError';
import type {
  BwsConfig,
  PopulateQueueItem,
  PopulateQueuePriority,
  PopulateQueueReason,
  PopulateQueueV1,
  SnapshotIngestConfig,
} from '../model';

const POPULATE_REASONS: ReadonlySet<string> = new Set([
  'initial',
  'appLaunchIncremental',
  'send',
  'pullToRefresh',
  'keyImport',
  'showPortfolioToggleOn',
  'manual',
]);

const POPULATE_PRIORITIES: ReadonlySet<string> = new Set([
  'urgentUserVisible',
  'normalUserVisible',
  'background',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBwsConfig(value: unknown): value is BwsConfig {
  if (!isPlainObject(value)) {
    return false;
  }
  return value.baseUrl === undefined || typeof value.baseUrl === 'string';
}

function isSnapshotIngestConfig(value: unknown): value is SnapshotIngestConfig {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.compressionEnabled === 'boolean' &&
    isFiniteNumber(value.compressionAgeDays) &&
    value.compressionAgeDays >= 0 &&
    isFiniteNumber(value.pageSize) &&
    value.pageSize > 0
  );
}

function isCompletedRecord(
  value: unknown,
): value is Readonly<Record<string, true>> {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).every(entry => entry === true);
}

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
    POPULATE_REASONS.has(item.reason) &&
    typeof item.priority === 'string' &&
    POPULATE_PRIORITIES.has(item.priority) &&
    isFiniteNumber(item.requestedAtMs)
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
    !isCompletedRecord(candidate.completedInRunItemIds) ||
    !isFiniteNumber(candidate.startedAt) ||
    !isFiniteNumber(candidate.updatedAt) ||
    !isBwsConfig(candidate.cfg) ||
    !isSnapshotIngestConfig(candidate.ingest) ||
    !isFiniteNumber(candidate.pageSize) ||
    candidate.pageSize <= 0
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
    cfg: candidate.cfg,
    ingest: candidate.ingest,
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
