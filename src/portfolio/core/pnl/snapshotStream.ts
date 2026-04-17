import type {Tx, WalletCredentials, WalletSummary} from '../types';
import {getAtomicDecimals, makeAtomicToUnitNumberConverter, parseAtomicToBigint, ratioBigIntToNumber} from '../format';
import type {FiatRateSeriesCache} from '../fiatRatesShared';
import {getTxHistoryEntryId, getTxHistoryLogicalPageSize} from '../txHistoryPaging';
import {createFiatRateLookup, normalizeFiatRateSeriesCoin} from './rates';
import type {SnapshotPersistDebugMode, SnapshotPersistInputV2} from './snapshotStore';
import type {BalanceSnapshotEventType} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPRESSION_AGE_MS = 90 * DAY_MS;

const utcDayIndex = (tsMs: number): number => Math.floor(tsMs / DAY_MS);
const utcDayKeyFromIndex = (dayIdx: number): string => new Date(dayIdx * DAY_MS).toISOString().slice(0, 10);

const bigIntAbs = (v: bigint): bigint => (v < 0n ? -v : v);

const parseNumberishToBigint = (v: any): bigint => {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;

  if (typeof v === 'number') {
    try {
      return parseAtomicToBigint(v);
    } catch {
      return 0n;
    }
  }

  const s = String(v).trim();
  if (!s) return 0n;
  if (/^0x[0-9a-f]+$/i.test(s)) {
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  }
  try {
    return parseAtomicToBigint(s);
  } catch {
    const m = s.match(/^-?\d+/);
    if (!m) return 0n;
    try {
      return BigInt(m[0]);
    } catch {
      return 0n;
    }
  }
};

const toTxTimestampMs = (tx: Tx): number => {
  const raw = Number((tx as any)?.time);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
};

const getTxBlockHeight = (tx: Tx): number | null => {
  const raw = Number((tx as any)?.blockheight ?? (tx as any)?.blockHeight ?? (tx as any)?.block_height);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

const getTxTransactionIndex = (tx: Tx): number | null => {
  const raw = Number((tx as any)?.receipt?.transactionIndex ?? (tx as any)?.transactionIndex);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const getTxNonce = (tx: Tx): number | null => {
  const raw = Number((tx as any)?.nonce);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const isTxFailed = (tx: Tx): boolean => {
  const status = (tx as any)?.receipt?.status;
  if (status === null || status === undefined) return false;
  if (typeof status === 'boolean') return status === false;
  if (typeof status === 'number') return status === 0;
  if (typeof status === 'bigint') return status === 0n;

  const s = String(status).trim().toLowerCase();
  if (!s) return false;
  if (s === 'false' || s === '0' || s === '0x0') return true;
  if (s === 'true' || s === '1' || s === '0x1') return false;
  try {
    if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s) === 0n;
    return BigInt(s) === 0n;
  } catch {
    return false;
  }
};

/** OP Stack chains charge an additional "L1 data fee" (often surfaced as receipt.l1Fee). */
const getTxL1DataFeeAtomic = (tx: Tx): bigint => {
  const receipt = (tx as any)?.receipt;
  const l1Fee = parseNumberishToBigint(
    receipt?.l1Fee ?? receipt?.l1DataFee ?? receipt?.l1_data_fee ?? (tx as any)?.l1Fee ?? (tx as any)?.l1FeePaid,
  );
  return bigIntAbs(l1Fee);
};

/** Some OP Stack forks include an operator fee. */
const getTxOperatorFeeAtomic = (tx: Tx): bigint => {
  const receipt = (tx as any)?.receipt;
  const opFee = parseNumberishToBigint(receipt?.operatorFee ?? receipt?.opFee ?? (tx as any)?.operatorFee);
  return bigIntAbs(opFee);
};

/**
 * Best-effort fee calculation:
 * - If receipt.gasUsed + (effectiveGasPrice|gasPrice) exists, use gasUsed * price.
 * - Add L1 fee + operator fee if present.
 * - Else fallback to tx.fees.
 */
const computeTxNetworkFeeAtomic = (tx: Tx): bigint => {
  const receipt = (tx as any)?.receipt;
  const gasUsed = parseNumberishToBigint(receipt?.gasUsed);
  if (gasUsed > 0n) {
    const price = parseNumberishToBigint(receipt?.effectiveGasPrice ?? receipt?.gasPrice ?? (tx as any)?.gasPrice);
    if (price > 0n) {
      const l2Fee = gasUsed * price;
      const l1Fee = getTxL1DataFeeAtomic(tx);
      const operatorFee = getTxOperatorFeeAtomic(tx);
      return l2Fee + l1Fee + operatorFee;
    }
  }
  return bigIntAbs(parseNumberishToBigint((tx as any)?.fees ?? 0));
};

type NormalizedTx = {
  originalIndex: number;
  id: string;
  tsMs: number;
  blockHeight: number | null;
  txIndex: number | null;
  nonce: number | null;
  action: 'received' | 'sent' | 'moved' | 'unknown';
  absAmountAtomic: bigint;
  failed: boolean;
  baseFeeAtomic: bigint;
};

type SnapshotCarryoverTx = {
  id: string;
  tsMs: number;
  blockHeight: number | null;
  txIndex: number | null;
  nonce: number | null;
  action: NormalizedTx['action'];
  absAmountAtomic: string;
  failed: boolean;
  baseFeeAtomic: string;
};

function normalizeTx(args: {tx: Tx; originalIndex: number; applyFeesToBalance: boolean}): NormalizedTx | null {
  const {tx, originalIndex, applyFeesToBalance} = args;
  const id = getTxHistoryEntryId(tx);
  const tsMs = toTxTimestampMs(tx);
  if (!tsMs) return null;

  const actionRaw = String((tx as any)?.action || (tx as any)?.type || '').toLowerCase();
  const action: NormalizedTx['action'] =
    actionRaw === 'received' || actionRaw === 'receive'
      ? 'received'
      : actionRaw === 'sent' || actionRaw === 'send'
        ? 'sent'
        : actionRaw === 'moved' || actionRaw === 'move'
          ? 'moved'
          : 'unknown';

  const rawAmountAtomic = parseAtomicToBigint((tx as any)?.amount ?? 0);
  const absAmountAtomic = bigIntAbs(rawAmountAtomic);
  const failed = isTxFailed(tx);
  const baseFeeAtomic = applyFeesToBalance ? computeTxNetworkFeeAtomic(tx) : 0n;

  return {
    originalIndex,
    id,
    tsMs,
    blockHeight: getTxBlockHeight(tx),
    txIndex: getTxTransactionIndex(tx),
    nonce: getTxNonce(tx),
    action,
    absAmountAtomic,
    failed,
    baseFeeAtomic,
  };
}

function dedupeNormalizedTxPage(txs: NormalizedTx[]): NormalizedTx[] {
  if (txs.length <= 1) return txs;

  // Keep the first occurrence of each normalized tx ID within the fetched response.
  // This matches the sync builder's txid-based dedupe without growing checkpoint state.
  const seen = new Set<string>();
  const out: NormalizedTx[] = [];
  for (const tx of txs) {
    if (!tx.id) continue;
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    out.push(tx);
  }
  return out;
}

function extractRecentTxIdsFromNormalizedPage(
  normalizedPage: NormalizedTx[],
  consumedRawCount: number,
): string[] {
  if (consumedRawCount <= 0) return [];
  return normalizedPage
    .filter(tx => tx.originalIndex < consumedRawCount)
    .map(tx => tx.id)
    .filter(Boolean);
}

function getNormalizedTxGroupKey(tx: Pick<NormalizedTx, 'tsMs' | 'blockHeight'>): string {
  return `${tx.tsMs}:${tx.blockHeight ?? ''}`;
}

function shouldCarryGroupAcrossPageBoundary(group: NormalizedTx[]): boolean {
  if (!group.length) return false;
  return group.some(tx => tx.blockHeight !== null);
}

function serializeCarryoverGroup(group: NormalizedTx[]): SnapshotCarryoverTx[] {
  return group.map(tx => ({
    id: tx.id,
    tsMs: tx.tsMs,
    blockHeight: tx.blockHeight,
    txIndex: tx.txIndex,
    nonce: tx.nonce,
    action: tx.action,
    absAmountAtomic: tx.absAmountAtomic.toString(),
    failed: tx.failed,
    baseFeeAtomic: tx.baseFeeAtomic.toString(),
  }));
}

function restoreCarryoverGroup(raw: SnapshotCarryoverTx[] | undefined): NormalizedTx[] {
  if (!Array.isArray(raw) || !raw.length) return [];

  return raw.map((entry, index) => ({
    originalIndex: index,
    id: String(entry.id || ''),
    tsMs: Number(entry.tsMs),
    blockHeight: Number.isFinite(Number(entry.blockHeight)) ? Number(entry.blockHeight) : null,
    txIndex: Number.isFinite(Number(entry.txIndex)) ? Number(entry.txIndex) : null,
    nonce: Number.isFinite(Number(entry.nonce)) ? Number(entry.nonce) : null,
    action:
      entry.action === 'received' ||
      entry.action === 'sent' ||
      entry.action === 'moved' ||
      entry.action === 'unknown'
        ? entry.action
        : 'unknown',
    absAmountAtomic: bigIntAbs(parseAtomicToBigint(entry.absAmountAtomic ?? '0')),
    failed: !!entry.failed,
    baseFeeAtomic: bigIntAbs(parseAtomicToBigint(entry.baseFeeAtomic ?? '0')),
  }));
}

function reorderTxBatchToPreventUnderflow(args: {
  txs: NormalizedTx[];
  startingBalanceAtomic: bigint;
  getDeltaAtomic: (t: NormalizedTx) => bigint;
}): NormalizedTx[] {
  const {txs, startingBalanceAtomic, getDeltaAtomic} = args;
  if (txs.length <= 1) return txs;

  // First, sort deterministically within the group.
  const sorted = [...txs].sort((a, b) => {
    const bhA = a.blockHeight ?? -1;
    const bhB = b.blockHeight ?? -1;
    if (bhA !== bhB) return bhA - bhB;

    const tiA = a.txIndex ?? -1;
    const tiB = b.txIndex ?? -1;
    if (tiA !== tiB) return tiA - tiB;

    const nA = a.nonce ?? -1;
    const nB = b.nonce ?? -1;
    if (nA !== nB) return nA - nB;

    return a.originalIndex - b.originalIndex;
  });

  let bal = startingBalanceAtomic;
  let sortedOrderAvoidsUnderflow = true;
  for (const tx of sorted) {
    const delta = getDeltaAtomic(tx);
    if (bal + delta < 0n) {
      sortedOrderAvoidsUnderflow = false;
      break;
    }
    bal += delta;
  }
  if (sortedOrderAvoidsUnderflow) {
    return sorted;
  }

  // Slow path: attempt a greedy pick to avoid balance underflow.
  const out: NormalizedTx[] = [];
  bal = startingBalanceAtomic;
  const pending = [...sorted];
  let guard = 0;
  while (pending.length && guard++ < 10_000) {
    let placed = false;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      const delta = getDeltaAtomic(t);
      if (bal + delta >= 0n) {
        out.push(t);
        bal += delta;
        pending.splice(i, 1);
        placed = true;
        break;
      }
    }
    if (!placed) {
      out.push(...pending);
      break;
    }
  }
  return out;
}

function classifyTxFlow(args: {
  tx: NormalizedTx;
  applyFeesToBalance: boolean;
  feePaidByWallet: boolean;
}): {acquisitionAtomic: bigint; outflowAtomic: bigint} {
  const {tx, applyFeesToBalance, feePaidByWallet} = args;
  const fee = applyFeesToBalance && feePaidByWallet ? tx.baseFeeAtomic : 0n;

  // Reverted EVM tx: pay fee, but do not move value.
  if (tx.failed && tx.action === 'sent') {
    return {acquisitionAtomic: 0n, outflowAtomic: fee};
  }

  if (tx.action === 'received') {
    return {acquisitionAtomic: tx.absAmountAtomic, outflowAtomic: 0n};
  }

  if (tx.action === 'sent') {
    return {acquisitionAtomic: 0n, outflowAtomic: tx.absAmountAtomic + fee};
  }

  if (tx.action === 'moved') {
    return {acquisitionAtomic: 0n, outflowAtomic: fee};
  }

  return {acquisitionAtomic: 0n, outflowAtomic: 0n};
}

export type SnapshotStreamCheckpoint = {
  nextSkip: number;
  recentTxIds?: string[];
  carryoverGroup?: SnapshotCarryoverTx[];
  balanceAtomic: string;
  remainingCostBasisFiat: number;
  lastMarkRate: number;
  lastTimestamp: number;
  daily?: {
    dayIdx: number;
    lastTimestamp: number;
    lastMarkRate: number;
  };
  firstNonZeroTs?: number;
};

export class BalanceSnapshotStreamBuilder {
  private wallet: WalletSummary;
  private snapshotDebugMode: SnapshotPersistDebugMode;
  private applyFeesToBalance: boolean;
  private rateLookup: ReturnType<typeof createFiatRateLookup>;
  private nowMs: number;
  private compressionEnabled: boolean;
  private atomicToUnitNumber: (atomic: bigint) => number;

  private balanceAtomic: bigint;
  private remainingCostBasisFiat: number;
  private lastMarkRate: number;
  private lastTimestamp: number;
  private firstNonZeroTs?: number;
  private dailyState: SnapshotStreamCheckpoint['daily'];

  private nextSkip: number;
  private recentTxIds: string[];
  private carryoverGroup: NormalizedTx[];

  constructor(args: {
    wallet: WalletSummary;
    credentials: Pick<WalletCredentials, 'walletId' | 'chain' | 'network' | 'coin' | 'token'>;
    quoteCurrency: string;
    fiatRateSeriesCache: FiatRateSeriesCache;
    nowMs?: number;
    compressionEnabled?: boolean;
    snapshotDebugMode?: SnapshotPersistDebugMode;
    checkpoint?: SnapshotStreamCheckpoint | null;
  }) {
    this.wallet = args.wallet;
    this.snapshotDebugMode = args.snapshotDebugMode ?? 'none';
    this.applyFeesToBalance = !args.wallet.tokenAddress;
    this.nowMs = args.nowMs ?? Date.now();
    this.compressionEnabled = !!args.compressionEnabled;
    this.atomicToUnitNumber = makeAtomicToUnitNumberConverter(getAtomicDecimals(args.credentials));

    const normalizedCoin = normalizeFiatRateSeriesCoin(args.wallet.currencyAbbreviation);
    this.rateLookup = createFiatRateLookup({
      quoteCurrency: args.quoteCurrency,
      coin: normalizedCoin,
      chain: this.wallet.chain,
      tokenAddress: this.wallet.tokenAddress,
      cache: args.fiatRateSeriesCache,
      nowMs: this.nowMs,
    });

    const cp = args.checkpoint;
    this.nextSkip = Number(cp?.nextSkip ?? 0);
    this.recentTxIds = Array.isArray(cp?.recentTxIds)
      ? cp.recentTxIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    this.carryoverGroup = restoreCarryoverGroup(cp?.carryoverGroup);
    this.balanceAtomic = parseAtomicToBigint(cp?.balanceAtomic ?? '0');
    this.remainingCostBasisFiat = Number(cp?.remainingCostBasisFiat ?? 0) || 0;
    this.lastMarkRate = Number(cp?.lastMarkRate ?? 0) || 0;
    this.lastTimestamp = Number(cp?.lastTimestamp ?? 0) || 0;
    this.dailyState = cp?.daily;
    this.firstNonZeroTs = cp?.firstNonZeroTs;
  }

  getCheckpoint(): SnapshotStreamCheckpoint {
    return {
      nextSkip: this.nextSkip,
      recentTxIds: this.recentTxIds,
      carryoverGroup: this.carryoverGroup.length ? serializeCarryoverGroup(this.carryoverGroup) : undefined,
      balanceAtomic: this.balanceAtomic.toString(),
      remainingCostBasisFiat: this.remainingCostBasisFiat,
      lastMarkRate: this.lastMarkRate,
      lastTimestamp: this.lastTimestamp,
      daily: this.dailyState,
      firstNonZeroTs: this.firstNonZeroTs,
    };
  }

  ingestPage(txs: Tx[]): SnapshotPersistInputV2[] {
    return this.ingestPageInternal(txs, undefined, false).snapshots;
  }

  ingestPageWithSnapshotLimit(
    txs: Tx[],
    maxSnapshots?: number,
  ): {snapshots: SnapshotPersistInputV2[]; logicalPageSize: number; consumedRawCount: number} {
    return this.ingestPageInternal(txs, maxSnapshots, true);
  }

  private ingestPageInternal(
    txs: Tx[],
    maxSnapshots: number | undefined,
    allowTrailingCarryover: boolean,
  ): {snapshots: SnapshotPersistInputV2[]; logicalPageSize: number; consumedRawCount: number} {
    const out: SnapshotPersistInputV2[] = [];
    const normalizedPage = dedupeNormalizedTxPage(
      txs
        .map((tx, i) => normalizeTx({tx, originalIndex: i, applyFeesToBalance: this.applyFeesToBalance}))
        .filter((tx): tx is NormalizedTx => !!tx),
    );
    const recentTxIds = new Set(this.recentTxIds);
    const filteredPage = recentTxIds.size
      ? normalizedPage.filter(tx => !recentTxIds.has(tx.id))
      : normalizedPage;
    const limit = Number.isFinite(Number(maxSnapshots)) && Number(maxSnapshots) > 0 ? Math.trunc(Number(maxSnapshots)) : null;

    if (!filteredPage.length) {
      const logicalPageSize = getTxHistoryLogicalPageSize(txs);
      this.nextSkip += logicalPageSize;
      this.recentTxIds = normalizedPage.map(tx => tx.id).filter(Boolean);
      return {
        snapshots: out,
        logicalPageSize,
        consumedRawCount: txs.length,
      };
    }

    let group: NormalizedTx[] = this.carryoverGroup.length ? this.carryoverGroup.slice() : [];
    this.carryoverGroup = [];
    let groupKey: string | null = group.length ? getNormalizedTxGroupKey(group[0]) : null;
    let groupMaxOriginalIndex = -1;
    let consumedRawCount = 0;
    let endedAtInputBoundary = true;

    const flushCurrentGroup = (): void => {
      if (!group.length) return;
      out.push(...this.processGroup(group));
      consumedRawCount = groupMaxOriginalIndex + 1;
      group = [];
      groupKey = null;
      groupMaxOriginalIndex = -1;
    };

    for (const ntx of filteredPage) {
      const key = getNormalizedTxGroupKey(ntx);
      if (groupKey === null) {
        groupKey = key;
      }
      if (key !== groupKey) {
        flushCurrentGroup();
        if (limit !== null && out.length >= limit) {
          endedAtInputBoundary = false;
          break;
        }
        groupKey = key;
      }
      group.push(ntx);
      if (ntx.originalIndex > groupMaxOriginalIndex) {
        groupMaxOriginalIndex = ntx.originalIndex;
      }
    }

    if (group.length) {
      if (
        allowTrailingCarryover &&
        endedAtInputBoundary &&
        groupMaxOriginalIndex >= 0 &&
        shouldCarryGroupAcrossPageBoundary(group)
      ) {
        this.carryoverGroup = group;
        const logicalPageSize = getTxHistoryLogicalPageSize(txs);
        this.nextSkip += logicalPageSize;
        this.recentTxIds = normalizedPage.map(tx => tx.id).filter(Boolean);
        return {
          snapshots: out,
          logicalPageSize,
          consumedRawCount: txs.length,
        };
      }
      flushCurrentGroup();
    }

    const consumedRaw = txs.slice(0, consumedRawCount);
    const logicalPageSize = getTxHistoryLogicalPageSize(consumedRaw);

    this.nextSkip += logicalPageSize;
    this.recentTxIds = extractRecentTxIdsFromNormalizedPage(normalizedPage, consumedRawCount);
    return {
      snapshots: out,
      logicalPageSize,
      consumedRawCount,
    };
  }

  finish(): SnapshotPersistInputV2[] {
    const out: SnapshotPersistInputV2[] = [];
    out.push(...this.flushPendingCarryoverGroup());
    if (this.dailyState) {
      const d = this.dailyState;
      out.push(this.makeDailySnapshot(d.dayIdx, d.lastTimestamp, d.lastMarkRate));
      this.dailyState = undefined;
    }
    return out;
  }

  hasPendingCarryoverGroup(): boolean {
    return this.carryoverGroup.length > 0;
  }

  flushPendingCarryoverGroup(): SnapshotPersistInputV2[] {
    if (!this.carryoverGroup.length) return [];
    const group = this.carryoverGroup;
    this.carryoverGroup = [];
    return this.processGroup(group);
  }

  private processGroup(group: NormalizedTx[]): SnapshotPersistInputV2[] {
    if (!group.length) return [];

    const orderedGroup = group.map((tx, index) =>
      tx.originalIndex === index ? tx : {...tx, originalIndex: index},
    );
    const startingBalance = this.balanceAtomic;
    const reordered = reorderTxBatchToPreventUnderflow({
      txs: orderedGroup,
      startingBalanceAtomic: startingBalance,
      getDeltaAtomic: t => {
        const flow = classifyTxFlow({tx: t, applyFeesToBalance: this.applyFeesToBalance, feePaidByWallet: true});
        return flow.acquisitionAtomic - flow.outflowAtomic;
      },
    });

    const out: SnapshotPersistInputV2[] = [];
    for (const t of reordered) {
      out.push(...this.processTx(t));
    }
    return out;
  }

  private processTx(tx: NormalizedTx): SnapshotPersistInputV2[] {
    const out: SnapshotPersistInputV2[] = [];
    const markRate = this.getMarkRate(tx.tsMs);

    const {acquisitionAtomic, outflowAtomic} = classifyTxFlow({
      tx,
      applyFeesToBalance: this.applyFeesToBalance,
      feePaidByWallet: true,
    });

    if (acquisitionAtomic > 0n) {
      let acquisitionRemainder = acquisitionAtomic;

      // If we are below zero, the first portion of any inflow only offsets the deficit.
      if (this.balanceAtomic < 0n) {
        const deficit = -this.balanceAtomic;
        const cover = acquisitionRemainder > deficit ? deficit : acquisitionRemainder;
        this.balanceAtomic += cover;
        acquisitionRemainder -= cover;
      }

      if (acquisitionRemainder > 0n) {
        this.balanceAtomic += acquisitionRemainder;
        this.remainingCostBasisFiat += this.atomicToUnit(acquisitionRemainder) * markRate;
      }
    }

    if (outflowAtomic > 0n) {
      const before = this.balanceAtomic;
      if (before <= 0n) {
        this.balanceAtomic = before - outflowAtomic;
        this.remainingCostBasisFiat = 0;
      } else {
        const disposeAgainstHoldings = outflowAtomic > before ? before : outflowAtomic;
        const ratio = ratioBigIntToNumber(disposeAgainstHoldings, before);
        this.remainingCostBasisFiat -= this.remainingCostBasisFiat * ratio;
        this.balanceAtomic = before - outflowAtomic;
        if (this.balanceAtomic <= 0n) {
          this.remainingCostBasisFiat = 0;
        }
      }
    }

    if (!Number.isFinite(this.remainingCostBasisFiat) || this.remainingCostBasisFiat < 0) {
      this.remainingCostBasisFiat = 0;
    }

    this.lastMarkRate = markRate;
    this.lastTimestamp = tx.tsMs;
    if (this.firstNonZeroTs === undefined && this.balanceAtomic > 0n) {
      this.firstNonZeroTs = tx.tsMs;
    }

    const compressBefore = this.nowMs - COMPRESSION_AGE_MS;
    const shouldCompress = this.compressionEnabled && tx.tsMs < compressBefore;

    if (shouldCompress) {
      const dayIdx = utcDayIndex(tx.tsMs);
      if (!this.dailyState) {
        this.dailyState = {dayIdx, lastTimestamp: tx.tsMs, lastMarkRate: markRate};
      } else if (this.dailyState.dayIdx !== dayIdx) {
        const prev = this.dailyState;
        out.push(this.makeDailySnapshot(prev.dayIdx, prev.lastTimestamp, prev.lastMarkRate));
        this.dailyState = {dayIdx, lastTimestamp: tx.tsMs, lastMarkRate: markRate};
      } else {
        this.dailyState.lastTimestamp = tx.tsMs;
        this.dailyState.lastMarkRate = markRate;
      }
      return out;
    }

    if (this.dailyState) {
      const d = this.dailyState;
      out.push(this.makeDailySnapshot(d.dayIdx, d.lastTimestamp, d.lastMarkRate));
      this.dailyState = undefined;
    }

    out.push(this.makeTxSnapshot(tx.id, tx.tsMs, markRate));
    return out;
  }

  private makeTxSnapshot(txid: string, timestamp: number, markRate: number): SnapshotPersistInputV2 {
    return this.makePersistSnapshot({
      id: `tx:${this.wallet.walletId}:${txid}`,
      eventType: 'tx',
      timestamp,
      markRate,
    });
  }

  private makeDailySnapshot(dayIdx: number, timestamp: number, markRate: number): SnapshotPersistInputV2 {
    return this.makePersistSnapshot({
      id: `daily:${this.wallet.walletId}:${utcDayKeyFromIndex(dayIdx)}`,
      eventType: 'daily',
      timestamp,
      markRate,
    });
  }

  private makePersistSnapshot(args: {
    id: string;
    eventType: BalanceSnapshotEventType;
    timestamp: number;
    markRate: number;
  }): SnapshotPersistInputV2 {
    const snapshot: SnapshotPersistInputV2 = {
      timestamp: args.timestamp,
      cryptoBalance: this.balanceAtomic.toString(),
    };

    if (this.snapshotDebugMode !== 'none') {
      snapshot.id = args.id;
      snapshot.eventType = args.eventType;
    }

    if (this.snapshotDebugMode === 'full') {
      snapshot.remainingCostBasisFiat = this.remainingCostBasisFiat;
      snapshot.markRate = args.markRate;
      snapshot.createdAt = Date.now();
    }

    return snapshot;
  }

  private atomicToUnit(atomic: bigint): number {
    return this.atomicToUnitNumber(atomic);
  }

  private getMarkRate(tsMs: number): number {
    const r = this.rateLookup.getNearestRate(tsMs);
    if (r === undefined) {
      return Number.isFinite(this.lastMarkRate) && this.lastMarkRate > 0 ? this.lastMarkRate : 0;
    }
    return r;
  }
}
