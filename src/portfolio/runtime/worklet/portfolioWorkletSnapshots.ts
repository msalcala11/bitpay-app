import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import type {WalletCredentials, WalletSummary} from '../../core/types';
import type {
  BalanceSnapshotEventType,
  BalanceSnapshotStored,
} from '../../core/pnl/types';
import type {SnapshotInvalidHistoryMarkerV1} from '../../core/pnl/invalidHistory';
import {SNAPSHOT_INVALID_HISTORY_VERSION} from '../../core/pnl/invalidHistory';
import type {PortfolioPopulateEmittedSnapshotDebugRow} from '../../core/engine/populateDebug';
import type {
  SnapshotChunkDebugV2,
  SnapshotChunkV2,
  SnapshotIndexV2,
  SnapshotPersistDebugMode,
  SnapshotPersistInputV2,
  SnapshotPointV2,
  SnapshotPopulateCheckpointV1,
  SnapshotStoreWalletMeta,
  SnapshotWalletMetaV2,
} from '../../core/pnl/snapshotStore';
import {
  workletKvDelete,
  workletKvGetString,
  workletKvSetString,
  type PortfolioWorkletKvConfig,
} from './portfolioWorkletKv';
import {
  getSnapshotChunkKey,
  getSnapshotIndexKey,
  getSnapshotMetaKey,
  readPortfolioV2SnapshotChunkOnWorklet,
  readPortfolioV2SnapshotIndexOnWorklet,
  readPortfolioV2SnapshotMetaOnWorklet,
} from '../../v2/workletData/snapshotsKv';

export function getWorkletSnapshotMetaStorageKey(walletId: string): string {
  'worklet';
  return getSnapshotMetaKey(walletId);
}

export function getWorkletSnapshotIndexStorageKey(walletId: string): string {
  'worklet';
  return getSnapshotIndexKey(walletId);
}

export function getWorkletSnapshotChunkStorageKey(
  walletId: string,
  chunkId: number,
): string {
  'worklet';
  return getSnapshotChunkKey({walletId, chunkId});
}

export function getWorkletInvalidHistoryStorageKey(walletId: string): string {
  'worklet';
  return `snap:invalid-history:v1:${walletId}`;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  'worklet';
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  'worklet';
  try {
    return JSON.stringify(value);
  } catch {
    return 'null';
  }
}

function normalizeStoredMeta(
  meta: SnapshotStoreWalletMeta,
): SnapshotWalletMetaV2 {
  'worklet';

  return {
    walletId: meta.walletId,
    chain: String(meta.chain || '').toLowerCase(),
    network: String(meta.network || '').toLowerCase(),
    coin: String(meta.currencyAbbreviation || '').toLowerCase(),
    assetId: getAssetIdFromWallet({
      chain: meta.chain,
      currencyAbbreviation: meta.currencyAbbreviation,
      tokenAddress: meta.tokenAddress,
    } as WalletSummary),
    quoteCurrency: String(meta.quoteCurrency || '').toUpperCase(),
    snapshotDebugMode: meta.snapshotDebugMode ?? 'none',
  };
}

function sameStoredMeta(
  left: SnapshotWalletMetaV2 | null,
  right: SnapshotWalletMetaV2,
): boolean {
  'worklet';

  if (!left) return false;
  return (
    left.walletId === right.walletId &&
    left.chain === right.chain &&
    left.network === right.network &&
    left.coin === right.coin &&
    left.assetId === right.assetId &&
    left.quoteCurrency === right.quoteCurrency &&
    left.snapshotDebugMode === right.snapshotDebugMode
  );
}

function encodeDebug(
  snapshots: SnapshotPersistInputV2[],
  debugMode: SnapshotPersistDebugMode,
): SnapshotChunkDebugV2 | undefined {
  'worklet';

  if (debugMode === 'none') return undefined;

  const eventTypeByRow = snapshots.map(snapshot =>
    snapshot.eventType === 'daily' ? 1 : 0,
  ) as Array<0 | 1>;
  const idByRow = snapshots.map(snapshot =>
    snapshot.id ? String(snapshot.id) : null,
  );

  const hasAnyTxIds = snapshots.some(
    snapshot => Array.isArray(snapshot.txIds) && snapshot.txIds.length > 0,
  );
  const txIdsByRow = hasAnyTxIds
    ? snapshots.map(snapshot =>
        Array.isArray(snapshot.txIds) && snapshot.txIds.length
          ? snapshot.txIds.map(String)
          : null,
      )
    : undefined;

  if (debugMode === 'link') {
    return {
      mode: 'link',
      idByRow,
      eventTypeByRow,
      txIdsByRow,
    } as SnapshotChunkDebugV2;
  }

  return {
    mode: 'full',
    idByRow,
    eventTypeByRow,
    txIdsByRow,
    markRateByRow: snapshots.map(snapshot =>
      typeof snapshot.markRate === 'number' &&
      Number.isFinite(snapshot.markRate)
        ? snapshot.markRate
        : null,
    ),
    remainingCostBasisFiatByRow: snapshots.map(snapshot =>
      typeof snapshot.remainingCostBasisFiat === 'number' &&
      Number.isFinite(snapshot.remainingCostBasisFiat)
        ? snapshot.remainingCostBasisFiat
        : null,
    ),
    createdAtByRow: snapshots.map(snapshot =>
      typeof snapshot.createdAt === 'number' &&
      Number.isFinite(snapshot.createdAt)
        ? snapshot.createdAt
        : null,
    ),
  } as SnapshotChunkDebugV2;
}

type OrderedSnapshotInput = {
  snapshot: SnapshotPersistInputV2;
  timestamp: number;
  originalIndex: number;
};

function orderSnapshotsForAppend(
  snapshots: SnapshotPersistInputV2[],
): OrderedSnapshotInput[] {
  'worklet';

  const ordered = snapshots.map((snapshot, originalIndex) => {
    const timestamp = Math.trunc(Number(snapshot.timestamp));
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid snapshot timestamp at row ${originalIndex}`);
    }

    return {
      snapshot,
      timestamp,
      originalIndex,
    };
  });

  let alreadyAscending = true;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].timestamp < ordered[i - 1].timestamp) {
      alreadyAscending = false;
      break;
    }
  }

  if (alreadyAscending) {
    return ordered;
  }

  return ordered.slice().sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.originalIndex - right.originalIndex;
  });
}

export function buildOrderedWorkletSnapshotDebugRows(args: {
  snapshots: SnapshotPersistInputV2[];
  startingRowIndex?: number;
}): PortfolioPopulateEmittedSnapshotDebugRow[] {
  'worklet';

  const start = Math.max(1, Math.trunc(Number(args.startingRowIndex || 1)));
  return orderSnapshotsForAppend(args.snapshots).map(
    ({snapshot, timestamp}, index) => ({
      rowIndex: start + index,
      eventType: snapshot.eventType === 'daily' ? 'daily' : 'tx',
      id: String(snapshot.id || ''),
      txIds: Array.isArray(snapshot.txIds)
        ? snapshot.txIds.map(String)
        : undefined,
      timestamp,
      cryptoBalance: String(snapshot.cryptoBalance || '0'),
    }),
  );
}

function fallbackHydratedSnapshotId(
  walletId: string,
  timestamp: number,
  rowIndex: number,
): string {
  'worklet';
  return `snap:${walletId}:${timestamp}:${rowIndex}`;
}

function toPoint(row: [number, string]): SnapshotPointV2 {
  'worklet';
  return {
    timestamp: Number(row[0]),
    cryptoBalance: String(row[1]),
  };
}

function hydrateRowToSnapshot(args: {
  meta: SnapshotWalletMetaV2;
  row: [number, string];
  debug?: SnapshotChunkDebugV2;
  rowIndex: number;
}): BalanceSnapshotStored {
  'worklet';

  const {meta, row, debug, rowIndex} = args;

  const timestamp = Number(row[0]);
  const cryptoBalance = String(row[1]);
  const id =
    debug?.idByRow?.[rowIndex] ??
    fallbackHydratedSnapshotId(meta.walletId, timestamp, rowIndex);
  const eventType: BalanceSnapshotEventType =
    debug?.eventTypeByRow?.[rowIndex] === 1 ? 'daily' : 'tx';

  const out: BalanceSnapshotStored = {
    id,
    walletId: meta.walletId,
    chain: meta.chain,
    network: meta.network,
    coin: meta.coin,
    assetId: meta.assetId,
    quoteCurrency: meta.quoteCurrency,
    timestamp,
    eventType,
    cryptoBalance,
    remainingCostBasisFiat: 0,
    markRate: 0,
  };

  const txIds = debug?.txIdsByRow?.[rowIndex];
  if (Array.isArray(txIds) && txIds.length) {
    out.txIds = txIds;
  }

  if (debug?.mode === 'full') {
    const markRate = debug.markRateByRow?.[rowIndex];
    if (typeof markRate === 'number' && Number.isFinite(markRate)) {
      out.markRate = markRate;
    }

    const basis = debug.remainingCostBasisFiatByRow?.[rowIndex];
    if (typeof basis === 'number' && Number.isFinite(basis)) {
      out.remainingCostBasisFiat = basis;
    }

    const createdAt = debug.createdAtByRow?.[rowIndex];
    if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
      out.createdAt = createdAt;
    }
  }

  return out;
}

function fallbackMeta(walletId: string): SnapshotWalletMetaV2 {
  'worklet';
  return {
    walletId,
    chain: '',
    network: '',
    coin: '',
    assetId: '',
    quoteCurrency: '',
    snapshotDebugMode: 'none',
  };
}

export function buildWorkletWalletMetaForStore(args: {
  wallet: WalletSummary;
  credentials: Pick<
    WalletCredentials,
    'walletId' | 'chain' | 'network' | 'coin' | 'token'
  >;
  quoteCurrency: string;
  compressionEnabled: boolean;
  chunkRows: number;
  snapshotDebugMode?: SnapshotPersistDebugMode;
}): SnapshotStoreWalletMeta {
  'worklet';

  return {
    walletId: args.wallet.walletId,
    chain: String(args.wallet.chain || args.credentials.chain || ''),
    network: String(args.wallet.network || args.credentials.network || ''),
    currencyAbbreviation: String(
      args.wallet.currencyAbbreviation || args.credentials.coin || '',
    ),
    tokenAddress: args.wallet.tokenAddress,
    quoteCurrency: args.quoteCurrency,
    compressionEnabled: args.compressionEnabled,
    chunkRows: args.chunkRows,
    snapshotDebugMode: args.snapshotDebugMode ?? 'none',
  };
}

export async function loadWorkletSnapshotIndex(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<SnapshotIndexV2 | null> {
  'worklet';

  return readPortfolioV2SnapshotIndexOnWorklet(config, walletId);
}

export async function loadWorkletSnapshotMeta(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<SnapshotWalletMetaV2 | null> {
  'worklet';

  return readPortfolioV2SnapshotMetaOnWorklet(config, walletId);
}

export async function loadWorkletSnapshotChunk(
  args: PortfolioWorkletKvConfig & {
    walletId: string;
    chunkId: number;
  },
): Promise<SnapshotChunkV2 | null> {
  'worklet';

  return readPortfolioV2SnapshotChunkOnWorklet(args, {
    walletId: args.walletId,
    chunkId: args.chunkId,
  });
}

async function saveWorkletSnapshotMeta(
  config: PortfolioWorkletKvConfig,
  meta: SnapshotWalletMetaV2,
): Promise<void> {
  'worklet';
  workletKvSetString(
    config,
    getWorkletSnapshotMetaStorageKey(meta.walletId),
    stringifyJson(meta),
  );
}

async function saveWorkletSnapshotIndex(
  config: PortfolioWorkletKvConfig,
  index: SnapshotIndexV2,
): Promise<void> {
  'worklet';
  const previousRevision = Math.trunc(Number(index.revision));
  index.revision =
    (Number.isFinite(previousRevision) && previousRevision > 0
      ? previousRevision
      : 0) + 1;
  index.updatedAt = Date.now();
  workletKvSetString(
    config,
    getWorkletSnapshotIndexStorageKey(index.walletId),
    stringifyJson(index),
  );
}

export async function clearWorkletWalletSnapshots(
  config: PortfolioWorkletKvConfig,
  walletId: string,
  opts?: {preserveInvalidHistoryMarker?: boolean},
): Promise<void> {
  'worklet';

  const index = await loadWorkletSnapshotIndex(config, walletId);
  for (const chunk of index?.chunks ?? []) {
    workletKvDelete(
      config,
      getWorkletSnapshotChunkStorageKey(walletId, chunk.id),
    );
  }

  workletKvDelete(config, `snap:index:v1:${walletId}`);
  workletKvDelete(config, getWorkletSnapshotIndexStorageKey(walletId));
  workletKvDelete(config, getWorkletSnapshotMetaStorageKey(walletId));
  if (opts?.preserveInvalidHistoryMarker !== true) {
    workletKvDelete(config, getWorkletInvalidHistoryStorageKey(walletId));
  }
}

export async function ensureWorkletWalletIndex(
  config: PortfolioWorkletKvConfig,
  meta: SnapshotStoreWalletMeta,
): Promise<SnapshotIndexV2> {
  'worklet';

  const existingIndex = await loadWorkletSnapshotIndex(config, meta.walletId);
  const existingMeta = await loadWorkletSnapshotMeta(config, meta.walletId);
  const storedMeta = normalizeStoredMeta(meta);

  if (
    existingIndex &&
    (!existingMeta || sameStoredMeta(existingMeta, storedMeta)) &&
    existingIndex.compressionEnabled === meta.compressionEnabled &&
    existingIndex.chunkRows === meta.chunkRows
  ) {
    if (!existingMeta) {
      await saveWorkletSnapshotMeta(config, storedMeta);
    }
    return existingIndex;
  }

  if (existingIndex || existingMeta) {
    await clearWorkletWalletSnapshots(config, meta.walletId, {
      preserveInvalidHistoryMarker: true,
    });
  }

  const index: SnapshotIndexV2 = {
    v: 2,
    walletId: meta.walletId,
    revision: 0,
    compressionEnabled: meta.compressionEnabled,
    chunkRows: meta.chunkRows,
    chunks: [],
    checkpoint: {
      nextSkip: 0,
      balanceAtomic: '0',
      remainingCostBasisFiat: 0,
      lastMarkRate: 0,
      lastTimestamp: 0,
    },
    updatedAt: Date.now(),
  };

  await saveWorkletSnapshotMeta(config, storedMeta);
  await saveWorkletSnapshotIndex(config, index);
  return index;
}

export async function loadWorkletInvalidHistoryMarker(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<SnapshotInvalidHistoryMarkerV1 | null> {
  'worklet';

  const raw = workletKvGetString(
    config,
    getWorkletInvalidHistoryStorageKey(walletId),
  );
  const parsed = parseJson<SnapshotInvalidHistoryMarkerV1 | null>(raw, null);
  if (!parsed || parsed.v !== SNAPSHOT_INVALID_HISTORY_VERSION) {
    return null;
  }
  if (String(parsed.walletId || '') !== String(walletId || '')) {
    return null;
  }
  if (parsed.reason !== 'negative_balance') {
    return null;
  }
  if (
    !Number.isFinite(Number(parsed.detectedAt)) ||
    !Number.isFinite(Number(parsed.retryAfter))
  ) {
    return null;
  }

  return {
    ...parsed,
    walletId: String(parsed.walletId || ''),
    reason: 'negative_balance',
    detectedAt: Number(parsed.detectedAt),
    retryAfter: Number(parsed.retryAfter),
    message: String(parsed.message || ''),
    source: parsed.source ? String(parsed.source) : undefined,
    txId: parsed.txId ? String(parsed.txId) : undefined,
    balanceAtomic: parsed.balanceAtomic
      ? String(parsed.balanceAtomic)
      : undefined,
  };
}

export async function saveWorkletInvalidHistoryMarker(
  config: PortfolioWorkletKvConfig,
  marker: SnapshotInvalidHistoryMarkerV1,
): Promise<void> {
  'worklet';

  workletKvSetString(
    config,
    getWorkletInvalidHistoryStorageKey(marker.walletId),
    stringifyJson({
      ...marker,
      v: SNAPSHOT_INVALID_HISTORY_VERSION,
      walletId: String(marker.walletId || ''),
      reason: 'negative_balance',
      detectedAt: Number(marker.detectedAt || Date.now()),
      retryAfter: Number(marker.retryAfter || Date.now()),
      message: String(marker.message || ''),
      source: marker.source ? String(marker.source) : undefined,
      txId: marker.txId ? String(marker.txId) : undefined,
      balanceAtomic: marker.balanceAtomic
        ? String(marker.balanceAtomic)
        : undefined,
    }),
  );
}

export async function clearWorkletInvalidHistoryMarker(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<void> {
  'worklet';

  workletKvDelete(config, getWorkletInvalidHistoryStorageKey(walletId));
}

export async function updateWorkletSnapshotCheckpoint(
  args: PortfolioWorkletKvConfig & {
    walletId: string;
    checkpoint: SnapshotPopulateCheckpointV1;
  },
): Promise<SnapshotIndexV2> {
  'worklet';

  const index = await loadWorkletSnapshotIndex(args, args.walletId);
  if (!index) {
    throw new Error(`Snapshot index missing for walletId=${args.walletId}`);
  }

  index.checkpoint = args.checkpoint;
  await saveWorkletSnapshotIndex(args, index);
  return index;
}

export async function appendWorkletSnapshotChunk(
  args: PortfolioWorkletKvConfig & {
    meta: SnapshotStoreWalletMeta;
    snapshots: SnapshotPersistInputV2[];
    checkpoint: SnapshotPopulateCheckpointV1;
  },
): Promise<SnapshotIndexV2> {
  'worklet';

  const {meta, snapshots, checkpoint} = args;
  if (!snapshots.length) {
    return updateWorkletSnapshotCheckpoint({
      storage: args.storage,
      registryKey: args.registryKey,
      walletId: meta.walletId,
      checkpoint,
    });
  }

  const index = await ensureWorkletWalletIndex(args, meta);
  const debugMode = meta.snapshotDebugMode ?? 'none';
  const nextId = index.chunks.length
    ? index.chunks[index.chunks.length - 1].id + 1
    : 1;
  const orderedSnapshots = orderSnapshotsForAppend(snapshots);
  const rows: Array<[number, string]> = orderedSnapshots.map(
    ({snapshot, timestamp}) => [timestamp, String(snapshot.cryptoBalance)],
  );

  const chunk: SnapshotChunkV2 = {
    v: 2,
    rows,
  };
  const debug = encodeDebug(
    orderedSnapshots.map(({snapshot}) => snapshot),
    debugMode,
  );
  if (debug) {
    (chunk as SnapshotChunkV2).debug = debug;
  }

  workletKvSetString(
    args,
    getWorkletSnapshotChunkStorageKey(meta.walletId, nextId),
    stringifyJson(chunk),
  );

  index.chunks.push({
    id: nextId,
    fromTs: rows[0][0],
    toTs: rows[rows.length - 1][0],
    rows: rows.length,
    debugMode,
  });
  index.checkpoint = checkpoint;
  await saveWorkletSnapshotIndex(args, index);
  return index;
}

export async function getWorkletLatestSnapshot(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<BalanceSnapshotStored | null> {
  'worklet';

  const idx = await loadWorkletSnapshotIndex(config, walletId);
  if (!idx || !idx.chunks.length) return null;
  const meta =
    (await loadWorkletSnapshotMeta(config, walletId)) ?? fallbackMeta(walletId);
  const last = idx.chunks[idx.chunks.length - 1];
  const chunk = await loadWorkletSnapshotChunk({
    storage: config.storage,
    registryKey: config.registryKey,
    walletId,
    chunkId: last.id,
  });
  const rowIndex = chunk?.rows?.length ? chunk.rows.length - 1 : -1;
  const row = rowIndex >= 0 ? chunk?.rows?.[rowIndex] : null;
  if (!row) return null;
  return hydrateRowToSnapshot({meta, row, debug: chunk?.debug, rowIndex});
}

export async function listWorkletSnapshots(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<BalanceSnapshotStored[]> {
  'worklet';

  const idx = await loadWorkletSnapshotIndex(config, walletId);
  if (!idx || !idx.chunks.length) return [];

  const meta =
    (await loadWorkletSnapshotMeta(config, walletId)) ?? fallbackMeta(walletId);
  const out: BalanceSnapshotStored[] = [];
  for (const chunkMeta of idx.chunks) {
    const chunk = await loadWorkletSnapshotChunk({
      storage: config.storage,
      registryKey: config.registryKey,
      walletId,
      chunkId: chunkMeta.id,
    });
    if (!chunk?.rows?.length) continue;
    for (let ri = 0; ri < chunk.rows.length; ri += 1) {
      out.push(
        hydrateRowToSnapshot({
          meta,
          row: chunk.rows[ri],
          debug: chunk.debug,
          rowIndex: ri,
        }),
      );
    }
  }
  return out;
}

export async function findWorkletLastPointAtOrBefore(
  args: PortfolioWorkletKvConfig & {
    walletId: string;
    tsMs: number;
  },
): Promise<SnapshotPointV2 | null> {
  'worklet';

  const idx = await loadWorkletSnapshotIndex(args, args.walletId);
  if (!idx || !idx.chunks.length) return null;

  let lo = 0;
  let hi = idx.chunks.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const chunkMeta = idx.chunks[mid];
    if (chunkMeta.toTs >= args.tsMs) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const chunkIndex = candidate >= 0 ? candidate : idx.chunks.length - 1;
  const chunkMeta = idx.chunks[chunkIndex];
  if (chunkIndex === 0 && chunkMeta.fromTs > args.tsMs) return null;

  const chunk = await loadWorkletSnapshotChunk({
    storage: args.storage,
    registryKey: args.registryKey,
    walletId: args.walletId,
    chunkId: chunkMeta.id,
  });
  if (!chunk?.rows?.length) return null;

  let best: [number, string] | null = null;
  for (const row of chunk.rows) {
    if (row[0] <= args.tsMs) best = row;
    else break;
  }

  if (best) return toPoint(best);

  if (chunkIndex > 0) {
    const prevMeta = idx.chunks[chunkIndex - 1];
    const prev = await loadWorkletSnapshotChunk({
      storage: args.storage,
      registryKey: args.registryKey,
      walletId: args.walletId,
      chunkId: prevMeta.id,
    });
    const lastRow = prev?.rows?.[prev.rows.length - 1];
    return lastRow ? toPoint(lastRow) : null;
  }
  return null;
}

export function iterateWorkletPoints(
  args: PortfolioWorkletKvConfig & {
    walletId: string;
    fromExclusive: number;
    toInclusive: number;
  },
): AsyncIterator<SnapshotPointV2, void, void> {
  'worklet';

  const {walletId, fromExclusive, toInclusive} = args;
  let initialized = false;
  let done = false;
  let idx: SnapshotIndexV2 | null = null;
  let chunkCursor = 0;
  let rows: Array<[number, string]> | null = null;
  let rowCursor = 0;

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;

    idx = await loadWorkletSnapshotIndex(args, walletId);
    if (!idx || !idx.chunks.length) {
      done = true;
      return;
    }

    while (
      chunkCursor < idx.chunks.length &&
      idx.chunks[chunkCursor].toTs <= fromExclusive
    ) {
      chunkCursor += 1;
    }

    if (chunkCursor >= idx.chunks.length) {
      done = true;
    }
  };

  const loadNextChunk = async (): Promise<boolean> => {
    if (!idx) return false;

    while (chunkCursor < idx.chunks.length) {
      const meta = idx.chunks[chunkCursor++];
      if (meta.fromTs > toInclusive) {
        done = true;
        return false;
      }

      const chunk = await loadWorkletSnapshotChunk({
        storage: args.storage,
        registryKey: args.registryKey,
        walletId,
        chunkId: meta.id,
      });
      if (!chunk?.rows?.length) continue;

      rows = chunk.rows;
      rowCursor = 0;
      return true;
    }

    done = true;
    return false;
  };

  return {
    next: async (): Promise<IteratorResult<SnapshotPointV2, void>> => {
      if (done) return {done: true, value: undefined};

      await initialize();
      if (done) return {done: true, value: undefined};

      while (true) {
        if (!rows || rowCursor >= rows.length) {
          const hasChunk = await loadNextChunk();
          if (!hasChunk) return {done: true, value: undefined};
        }

        while (rows && rowCursor < rows.length) {
          const row = rows[rowCursor++];
          if (row[0] <= fromExclusive) continue;
          if (row[0] > toInclusive) {
            done = true;
            rows = null;
            return {done: true, value: undefined};
          }
          return {done: false, value: toPoint(row)};
        }
      }
    },
  };
}
