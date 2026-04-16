import type {KvStore} from '../kv/types';
import {jsonParseSafe, jsonStringifySafe} from '../kv/types';
import type {WalletSummary, WalletCredentials} from '../types';
import type {BalanceSnapshotEventType, BalanceSnapshotStored} from './types';
import {getAssetIdFromWallet} from './assetId';

/**
 * Storage layout (v2)
 *
 * - Meta key:   snap:meta:v2:<walletId>
 * - Index key:  snap:index:v2:<walletId>
 * - Chunk key:  snap:chunk:v2:<walletId>:<chunkId>
 *
 * Rows are intentionally tiny for analysis:
 *   [timestamp, cryptoBalance]
 *
 * Optional debug data is stored as aligned sidecar arrays.
 */

export type SnapshotPersistDebugMode = 'none' | 'link' | 'full';

export type SnapshotPointV2 = {
  timestamp: number;
  cryptoBalance: string;
};

export type SnapshotPersistInputV2 = Pick<BalanceSnapshotStored, 'timestamp' | 'cryptoBalance'> &
  Partial<
    Pick<
      BalanceSnapshotStored,
      'id' | 'eventType' | 'txIds' | 'remainingCostBasisFiat' | 'markRate' | 'createdAt'
    >
  >;

export type SnapshotRowV2 = [timestamp: number, cryptoBalance: string];

export type SnapshotChunkDebugLinkV2 = {
  mode: 'link';
  idByRow: Array<string | null>;
  eventTypeByRow: Array<0 | 1>;
  txIdsByRow?: Array<string[] | null>;
};

export type SnapshotChunkDebugFullV2 = {
  mode: 'full';
  idByRow: Array<string | null>;
  eventTypeByRow: Array<0 | 1>;
  txIdsByRow?: Array<string[] | null>;
  markRateByRow?: Array<number | null>;
  remainingCostBasisFiatByRow?: Array<number | null>;
  createdAtByRow?: Array<number | null>;
};

export type SnapshotChunkDebugV2 =
  | SnapshotChunkDebugLinkV2
  | SnapshotChunkDebugFullV2;

export type SnapshotChunkV2 = {
  v: 2;
  rows: SnapshotRowV2[];
  debug?: SnapshotChunkDebugV2;
};

export type SnapshotChunkMetaV2 = {
  id: number;
  fromTs: number;
  toTs: number;
  rows: number;
  debugMode: SnapshotPersistDebugMode;
};

export type SnapshotPopulateCheckpointV1 = {
  nextSkip: number;
  recentTxIds?: string[];

  // Simulator state at the end of the last processed tx.
  balanceAtomic: string;
  remainingCostBasisFiat: number;
  lastMarkRate: number;
  lastTimestamp: number;

  // If we're currently compressing an old UTC day, we keep a tiny bit of state.
  daily?: {
    dayIdx: number;
    lastTimestamp: number;
    lastMarkRate: number;
  };

  firstNonZeroTs?: number;
};

export type SnapshotIndexV2 = {
  v: 2;
  walletId: string;
  compressionEnabled: boolean;
  chunkRows: number;
  chunks: SnapshotChunkMetaV2[];
  checkpoint: SnapshotPopulateCheckpointV1;
  updatedAt: number;
};

// Compatibility alias for callers that still import the older name.
export type SnapshotIndexV1 = SnapshotIndexV2;

export type SnapshotWalletMetaV2 = {
  walletId: string;
  chain: string;
  network: string;
  coin: string;
  assetId: string;
  quoteCurrency: string;
};

export type SnapshotStoreWalletMeta = {
  walletId: string;
  chain: string;
  network: string;
  currencyAbbreviation: string;
  tokenAddress?: string;
  quoteCurrency: string;
  compressionEnabled: boolean;
  chunkRows: number;
  snapshotDebugMode?: SnapshotPersistDebugMode;
};

const MAX_CACHED_CHUNKS = 32;

function metaKey(walletId: string): string {
  return `snap:meta:v2:${walletId}`;
}

function indexKey(walletId: string): string {
  return `snap:index:v2:${walletId}`;
}

function chunkKey(walletId: string, chunkId: number): string {
  return `snap:chunk:v2:${walletId}:${chunkId}`;
}

function fallbackHydratedSnapshotId(walletId: string, timestamp: number, rowIndex: number): string {
  return `snap:${walletId}:${timestamp}:${rowIndex}`;
}

function normalizeStoredMeta(meta: SnapshotStoreWalletMeta): SnapshotWalletMetaV2 {
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
  };
}

function sameStoredMeta(a: SnapshotWalletMetaV2 | null, b: SnapshotWalletMetaV2): boolean {
  if (!a) return false;
  return (
    a.walletId === b.walletId &&
    a.chain === b.chain &&
    a.network === b.network &&
    a.coin === b.coin &&
    a.assetId === b.assetId &&
    a.quoteCurrency === b.quoteCurrency
  );
}

function toPoint(row: SnapshotRowV2): SnapshotPointV2 {
  return {
    timestamp: Number(row[0]),
    cryptoBalance: String(row[1]),
  };
}

function encodeDebug(
  snapshots: SnapshotPersistInputV2[],
  debugMode: SnapshotPersistDebugMode,
): SnapshotChunkDebugV2 | undefined {
  if (debugMode === 'none') return undefined;

  const eventTypeByRow = snapshots.map(s => (s.eventType === 'daily' ? 1 : 0));
  const idByRow = snapshots.map(s => (s.id ? String(s.id) : null));

  const hasAnyTxIds = snapshots.some(s => Array.isArray(s.txIds) && s.txIds.length > 0);
  const txIdsByRow = hasAnyTxIds
    ? snapshots.map(s => (Array.isArray(s.txIds) && s.txIds.length ? s.txIds.map(String) : null))
    : undefined;

  if (debugMode === 'link') {
    return {
      mode: 'link',
      idByRow,
      eventTypeByRow,
      txIdsByRow,
    };
  }

  const markRateByRow = snapshots.map(s =>
    typeof s.markRate === 'number' && Number.isFinite(s.markRate) ? s.markRate : null,
  );
  const remainingCostBasisFiatByRow = snapshots.map(s =>
    typeof s.remainingCostBasisFiat === 'number' && Number.isFinite(s.remainingCostBasisFiat)
      ? s.remainingCostBasisFiat
      : null,
  );
  const createdAtByRow = snapshots.map(s =>
    typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : null,
  );

  return {
    mode: 'full',
    idByRow,
    eventTypeByRow,
    txIdsByRow,
    markRateByRow,
    remainingCostBasisFiatByRow,
    createdAtByRow,
  };
}

function hydrateRowToSnapshot(args: {
  meta: SnapshotWalletMetaV2;
  row: SnapshotRowV2;
  debug?: SnapshotChunkDebugV2;
  rowIndex: number;
}): BalanceSnapshotStored {
  const {meta, row, debug, rowIndex} = args;

  const timestamp = Number(row[0]);
  const cryptoBalance = String(row[1]);
  const id = debug?.idByRow?.[rowIndex] ?? fallbackHydratedSnapshotId(meta.walletId, timestamp, rowIndex);
  const eventType: BalanceSnapshotEventType = debug?.eventTypeByRow?.[rowIndex] === 1 ? 'daily' : 'tx';

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

function cloneCachedValue<T>(value: T): T {
  const structuredCloneFn = (globalThis as any)?.structuredClone;
  if (typeof structuredCloneFn === 'function') {
    return structuredCloneFn(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SnapshotStore {
  private kv: KvStore;
  private metaCache = new Map<string, SnapshotWalletMetaV2>();
  private indexCache = new Map<string, SnapshotIndexV2>();
  private chunkCache = new Map<string, SnapshotChunkV2>();

  constructor(kv: KvStore) {
    this.kv = kv;
  }

  clearMemoryCache(): void {
    this.metaCache.clear();
    this.indexCache.clear();
    this.chunkCache.clear();
  }

  private invalidateWalletCache(walletId: string): void {
    this.metaCache.delete(walletId);
    this.indexCache.delete(walletId);

    const prefix = `snap:chunk:v2:${walletId}:`;
    for (const key of this.chunkCache.keys()) {
      if (key.startsWith(prefix)) {
        this.chunkCache.delete(key);
      }
    }
  }

  private rememberChunkInCache(walletId: string, chunkId: number, chunk: SnapshotChunkV2): SnapshotChunkV2 {
    const key = chunkKey(walletId, chunkId);
    if (this.chunkCache.has(key)) {
      this.chunkCache.delete(key);
    }
    this.chunkCache.set(key, chunk);
    while (this.chunkCache.size > MAX_CACHED_CHUNKS) {
      const oldestKey = this.chunkCache.keys().next().value;
      if (!oldestKey) break;
      this.chunkCache.delete(oldestKey);
    }
    return chunk;
  }

  private async readMetaCached(walletId: string): Promise<SnapshotWalletMetaV2 | null> {
    const cached = this.metaCache.get(walletId);
    if (cached) return cached;

    const raw = await this.kv.getString(metaKey(walletId));
    const meta = jsonParseSafe<SnapshotWalletMetaV2 | null>(raw, null);
    if (!meta || meta.walletId !== walletId) {
      this.metaCache.delete(walletId);
      return null;
    }

    this.metaCache.set(walletId, meta);
    return meta;
  }

  async loadMeta(walletId: string): Promise<SnapshotWalletMetaV2 | null> {
    const meta = await this.readMetaCached(walletId);
    return meta ? cloneCachedValue(meta) : null;
  }

  private async readIndexCached(walletId: string): Promise<SnapshotIndexV2 | null> {
    const cached = this.indexCache.get(walletId);
    if (cached) return cached;

    const raw = await this.kv.getString(indexKey(walletId));
    const idx = jsonParseSafe<SnapshotIndexV2 | null>(raw, null);
    if (!idx || idx.v !== 2 || idx.walletId !== walletId) {
      this.indexCache.delete(walletId);
      return null;
    }

    this.indexCache.set(walletId, idx);
    return idx;
  }

  async loadIndex(walletId: string): Promise<SnapshotIndexV2 | null> {
    const idx = await this.readIndexCached(walletId);
    return idx ? cloneCachedValue(idx) : null;
  }

  private async saveMeta(meta: SnapshotWalletMetaV2): Promise<void> {
    await this.kv.setString(metaKey(meta.walletId), jsonStringifySafe(meta));
    this.metaCache.set(meta.walletId, cloneCachedValue(meta));
  }

  private async saveIndex(idx: SnapshotIndexV2): Promise<void> {
    idx.updatedAt = Date.now();
    await this.kv.setString(indexKey(idx.walletId), jsonStringifySafe(idx));
    this.indexCache.set(idx.walletId, cloneCachedValue(idx));
  }

  private async loadChunk(walletId: string, chunkId: number): Promise<SnapshotChunkV2 | null> {
    const key = chunkKey(walletId, chunkId);
    const cached = this.chunkCache.get(key);
    if (cached) {
      this.chunkCache.delete(key);
      this.chunkCache.set(key, cached);
      return cached;
    }

    const raw = await this.kv.getString(chunkKey(walletId, chunkId));
    const chunk = jsonParseSafe<SnapshotChunkV2 | null>(raw, null);
    if (!chunk || chunk.v !== 2 || !Array.isArray(chunk.rows)) return null;
    return this.rememberChunkInCache(walletId, chunkId, chunk);
  }

  private fallbackMeta(walletId: string): SnapshotWalletMetaV2 {
    return {
      walletId,
      chain: '',
      network: '',
      coin: '',
      assetId: '',
      quoteCurrency: '',
    };
  }

  async ensureWalletIndex(meta: SnapshotStoreWalletMeta): Promise<SnapshotIndexV2> {
    const existing = await this.readIndexCached(meta.walletId);
    const existingMeta = await this.readMetaCached(meta.walletId);
    const storedMeta = normalizeStoredMeta(meta);

    if (
      existing &&
      (!existingMeta || sameStoredMeta(existingMeta, storedMeta)) &&
      existing.compressionEnabled === meta.compressionEnabled &&
      existing.chunkRows === meta.chunkRows
    ) {
      if (!existingMeta) {
        await this.saveMeta(storedMeta);
      }
      return cloneCachedValue(existing);
    }

    if (existing || existingMeta) {
      await this.clearWallet(meta.walletId);
    }

    const idx: SnapshotIndexV2 = {
      v: 2,
      walletId: meta.walletId,
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

    await this.saveMeta(storedMeta);
    await this.saveIndex(idx);
    return cloneCachedValue(idx);
  }

  async clearWallet(walletId: string): Promise<void> {
    const idx = await this.readIndexCached(walletId);
    for (const chunk of idx?.chunks ?? []) {
      await this.kv.delete(chunkKey(walletId, chunk.id));
    }

    await this.kv.delete(`snap:index:v1:${walletId}`);
    await this.kv.delete(indexKey(walletId));
    await this.kv.delete(metaKey(walletId));
    this.invalidateWalletCache(walletId);
  }

  async appendChunk(args: {
    meta: SnapshotStoreWalletMeta;
    snapshots: SnapshotPersistInputV2[];
    checkpoint: SnapshotPopulateCheckpointV1;
  }): Promise<SnapshotIndexV2> {
    const {meta, snapshots, checkpoint} = args;
    if (!snapshots.length) {
      return this.updateCheckpoint({walletId: meta.walletId, checkpoint});
    }

    const idx = await this.ensureWalletIndex(meta);
    const debugMode = meta.snapshotDebugMode ?? 'none';
    const nextId = idx.chunks.length ? idx.chunks[idx.chunks.length - 1].id + 1 : 1;

    const rows: SnapshotRowV2[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const timestamp = Math.trunc(Number(s.timestamp));
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid snapshot timestamp at row ${i}`);
      }
      if (i > 0 && timestamp < rows[i - 1][0]) {
        throw new Error('Snapshots must be appended in ascending timestamp order.');
      }
      rows.push([timestamp, String(s.cryptoBalance)]);
    }

    const chunk: SnapshotChunkV2 = {
      v: 2,
      rows,
    };
    const debug = encodeDebug(snapshots, debugMode);
    if (debug) chunk.debug = debug;

    await this.kv.setString(chunkKey(meta.walletId, nextId), jsonStringifySafe(chunk));
    // Chunks are treated as immutable once built, so cache the constructed object directly
    // instead of paying for a deep clone on the ingest hot path.
    this.rememberChunkInCache(meta.walletId, nextId, chunk);

    idx.chunks.push({
      id: nextId,
      fromTs: rows[0][0],
      toTs: rows[rows.length - 1][0],
      rows: rows.length,
      debugMode,
    });
    idx.checkpoint = checkpoint;
    await this.saveIndex(idx);
    return cloneCachedValue(idx);
  }

  async updateCheckpoint(args: {walletId: string; checkpoint: SnapshotPopulateCheckpointV1}): Promise<SnapshotIndexV2> {
    const idx = await this.loadIndex(args.walletId);
    if (!idx) {
      throw new Error(`Snapshot index missing for walletId=${args.walletId}`);
    }
    idx.checkpoint = args.checkpoint;
    await this.saveIndex(idx);
    return cloneCachedValue(idx);
  }

  async getCheckpoint(walletId: string): Promise<SnapshotPopulateCheckpointV1 | null> {
    const idx = await this.readIndexCached(walletId);
    return idx?.checkpoint ? cloneCachedValue(idx.checkpoint) : null;
  }

  async getLatestPoint(walletId: string): Promise<SnapshotPointV2 | null> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return null;
    const last = idx.chunks[idx.chunks.length - 1];
    const chunk = await this.loadChunk(walletId, last.id);
    const row = chunk?.rows?.[chunk.rows.length - 1];
    return row ? toPoint(row) : null;
  }

  async listPoints(walletId: string): Promise<SnapshotPointV2[]> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return [];

    const out: SnapshotPointV2[] = [];
    for (const meta of idx.chunks) {
      const chunk = await this.loadChunk(walletId, meta.id);
      if (!chunk?.rows?.length) continue;
      for (const row of chunk.rows) out.push(toPoint(row));
    }
    return out;
  }

  async findLastPointAtOrBefore(walletId: string, tsMs: number): Promise<SnapshotPointV2 | null> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return null;

    let lo = 0;
    let hi = idx.chunks.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = idx.chunks[mid];
      if (c.toTs >= tsMs) {
        candidate = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const chunkIndex = candidate >= 0 ? candidate : idx.chunks.length - 1;
    const chunkMeta = idx.chunks[chunkIndex];
    if (chunkIndex === 0 && chunkMeta.fromTs > tsMs) return null;

    const chunk = await this.loadChunk(walletId, chunkMeta.id);
    if (!chunk?.rows?.length) return null;

    let best: SnapshotRowV2 | null = null;
    for (const row of chunk.rows) {
      if (row[0] <= tsMs) best = row;
      else break;
    }

    if (best) return toPoint(best);

    if (chunkIndex > 0) {
      const prevMeta = idx.chunks[chunkIndex - 1];
      const prev = await this.loadChunk(walletId, prevMeta.id);
      const lastRow = prev?.rows?.[prev.rows.length - 1];
      return lastRow ? toPoint(lastRow) : null;
    }
    return null;
  }

  iteratePoints(args: {
    walletId: string;
    fromExclusive: number;
    toInclusive: number;
  }): AsyncIterator<SnapshotPointV2, void, void> {
    const {walletId, fromExclusive, toInclusive} = args;
    let initialized = false;
    let done = false;
    let idx: SnapshotIndexV2 | null = null;
    let chunkCursor = 0;
    let rows: SnapshotRowV2[] | null = null;
    let rowCursor = 0;

    const initialize = async (): Promise<void> => {
      if (initialized) return;
      initialized = true;

      idx = await this.readIndexCached(walletId);
      if (!idx || !idx.chunks.length) {
        done = true;
        return;
      }

      while (chunkCursor < idx.chunks.length && idx.chunks[chunkCursor].toTs <= fromExclusive) {
        chunkCursor++;
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

        const chunk = await this.loadChunk(walletId, meta.id);
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

  async getLatestSnapshot(walletId: string): Promise<BalanceSnapshotStored | null> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return null;
    const meta = (await this.readMetaCached(walletId)) ?? this.fallbackMeta(walletId);
    const last = idx.chunks[idx.chunks.length - 1];
    const chunk = await this.loadChunk(walletId, last.id);
    const rowIndex = chunk?.rows?.length ? chunk.rows.length - 1 : -1;
    const row = rowIndex >= 0 ? chunk?.rows?.[rowIndex] : null;
    if (!row) return null;
    return hydrateRowToSnapshot({meta, row, debug: chunk?.debug, rowIndex});
  }

  async listSnapshots(walletId: string): Promise<BalanceSnapshotStored[]> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return [];

    const meta = (await this.readMetaCached(walletId)) ?? this.fallbackMeta(walletId);
    const out: BalanceSnapshotStored[] = [];
    for (const chunkMeta of idx.chunks) {
      const chunk = await this.loadChunk(walletId, chunkMeta.id);
      if (!chunk?.rows?.length) continue;
      for (let ri = 0; ri < chunk.rows.length; ri++) {
        out.push(hydrateRowToSnapshot({meta, row: chunk.rows[ri], debug: chunk.debug, rowIndex: ri}));
      }
    }
    return out;
  }

  async findLastSnapshotAtOrBefore(walletId: string, tsMs: number): Promise<BalanceSnapshotStored | null> {
    const idx = await this.readIndexCached(walletId);
    if (!idx || !idx.chunks.length) return null;

    let lo = 0;
    let hi = idx.chunks.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = idx.chunks[mid];
      if (c.toTs >= tsMs) {
        candidate = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const chunkIndex = candidate >= 0 ? candidate : idx.chunks.length - 1;
    const chunkMeta = idx.chunks[chunkIndex];
    if (chunkIndex === 0 && chunkMeta.fromTs > tsMs) return null;

    const meta = (await this.readMetaCached(walletId)) ?? this.fallbackMeta(walletId);
    const chunk = await this.loadChunk(walletId, chunkMeta.id);
    if (!chunk?.rows?.length) return null;

    let bestIndex = -1;
    for (let i = 0; i < chunk.rows.length; i++) {
      if (chunk.rows[i][0] <= tsMs) bestIndex = i;
      else break;
    }

    if (bestIndex >= 0) {
      return hydrateRowToSnapshot({
        meta,
        row: chunk.rows[bestIndex],
        debug: chunk.debug,
        rowIndex: bestIndex,
      });
    }

    if (chunkIndex > 0) {
      const prevMeta = idx.chunks[chunkIndex - 1];
      const prev = await this.loadChunk(walletId, prevMeta.id);
      const lastIndex = prev?.rows?.length ? prev.rows.length - 1 : -1;
      if (prev && lastIndex >= 0) {
        return hydrateRowToSnapshot({
          meta,
          row: prev.rows[lastIndex],
          debug: prev.debug,
          rowIndex: lastIndex,
        });
      }
    }
    return null;
  }

  iterateSnapshots(args: {
    walletId: string;
    fromExclusive: number;
    toInclusive: number;
  }): AsyncIterator<BalanceSnapshotStored, void, void> {
    const {walletId, fromExclusive, toInclusive} = args;
    let initialized = false;
    let done = false;
    let idx: SnapshotIndexV2 | null = null;
    let meta: SnapshotWalletMetaV2 | null = null;
    let chunkCursor = 0;
    let chunk: SnapshotChunkV2 | null = null;
    let rowCursor = 0;

    const initialize = async (): Promise<void> => {
      if (initialized) return;
      initialized = true;

      idx = await this.readIndexCached(walletId);
      if (!idx || !idx.chunks.length) {
        done = true;
        return;
      }

      meta = (await this.readMetaCached(walletId)) ?? this.fallbackMeta(walletId);
      while (chunkCursor < idx.chunks.length && idx.chunks[chunkCursor].toTs <= fromExclusive) {
        chunkCursor++;
      }

      if (chunkCursor >= idx.chunks.length) {
        done = true;
      }
    };

    const loadNextChunk = async (): Promise<boolean> => {
      if (!idx) return false;

      while (chunkCursor < idx.chunks.length) {
        const chunkMeta = idx.chunks[chunkCursor++];
        if (chunkMeta.fromTs > toInclusive) {
          done = true;
          return false;
        }

        const nextChunk = await this.loadChunk(walletId, chunkMeta.id);
        if (!nextChunk?.rows?.length) continue;

        chunk = nextChunk;
        rowCursor = 0;
        return true;
      }

      done = true;
      return false;
    };

    return {
      next: async (): Promise<IteratorResult<BalanceSnapshotStored, void>> => {
        if (done) return {done: true, value: undefined};

        await initialize();
        if (done || !meta) return {done: true, value: undefined};

        while (true) {
          if (!chunk || rowCursor >= chunk.rows.length) {
            const hasChunk = await loadNextChunk();
            if (!hasChunk) return {done: true, value: undefined};
          }

          while (chunk && rowCursor < chunk.rows.length) {
            const currentRowIndex = rowCursor;
            const row = chunk.rows[rowCursor++];
            if (row[0] <= fromExclusive) continue;
            if (row[0] > toInclusive) {
              done = true;
              chunk = null;
              return {done: true, value: undefined};
            }
            return {
              done: false,
              value: hydrateRowToSnapshot({
                meta,
                row,
                debug: chunk.debug,
                rowIndex: currentRowIndex,
              }),
            };
          }
        }
      },
    };
  }
}

export function buildWalletMetaForStore(args: {
  wallet: WalletSummary;
  credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'>;
  quoteCurrency: string;
  compressionEnabled: boolean;
  chunkRows: number;
  snapshotDebugMode?: SnapshotPersistDebugMode;
}): SnapshotStoreWalletMeta {
  const {wallet, credentials, quoteCurrency, compressionEnabled, chunkRows, snapshotDebugMode = 'none'} = args;
  return {
    walletId: wallet.walletId,
    chain: String(wallet.chain || credentials.chain || ''),
    network: String(wallet.network || credentials.network || ''),
    currencyAbbreviation: String(wallet.currencyAbbreviation || credentials.coin || ''),
    tokenAddress: wallet.tokenAddress,
    quoteCurrency,
    compressionEnabled,
    chunkRows,
    snapshotDebugMode,
  };
}
