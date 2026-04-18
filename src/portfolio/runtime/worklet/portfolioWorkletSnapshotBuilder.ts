import type {FiatRateSeriesCache} from '../../core/fiatRatesShared';
import {
  getAtomicDecimals,
  makeAtomicToUnitNumberConverter,
  parseAtomicToBigint,
  ratioBigIntToNumber,
} from '../../core/format';
import type {Tx, WalletCredentials, WalletSummary} from '../../core/types';
import {
  getTxHistoryEntryId,
  getTxHistoryLogicalPageSize,
} from '../../core/txHistoryPaging';
import {
  createFiatRateLookup,
  normalizeFiatRateSeriesCoin,
} from '../../core/pnl/rates';
import type {
  SnapshotPersistDebugMode,
  SnapshotPersistInputV2,
} from '../../core/pnl/snapshotStore';
import type {BalanceSnapshotEventType} from '../../core/pnl/types';
import type {
  PortfolioPopulateCarryoverDecisionDebugRow,
  PortfolioPopulateDirectVsHelperParityDebugRow,
  PortfolioPopulateFlushDirectResetWitnessDebugRow,
  PortfolioPopulateFlushCurrentGroupDebugRow,
  PortfolioPopulateFlushReturnWitnessDebugRow,
  PortfolioPopulateGroupAssemblyDebugRow,
  PortfolioPopulateIngestLoopMutationDebugRow,
  PortfolioPopulateLocalMutationCanaryDebugRow,
  PortfolioPopulateNormalizedFilteredPageKeyDebugRow,
  PortfolioPopulateStateMutationControlDebugRow,
  PortfolioPopulateWalletDebugTrace,
} from '../../core/engine/populateDebug';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPRESSION_AGE_MS = 90 * DAY_MS;

const utcDayIndex = (tsMs: number): number => {
  'worklet';
  return Math.floor(tsMs / DAY_MS);
};
const utcDayKeyFromIndex = (dayIdx: number): string => {
  'worklet';
  return new Date(dayIdx * DAY_MS).toISOString().slice(0, 10);
};

const bigIntAbs = (value: bigint): bigint => {
  'worklet';
  return value < 0n ? -value : value;
};

const parseNumberishToBigint = (value: any): bigint => {
  'worklet';

  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    try {
      return parseAtomicToBigint(value);
    } catch {
      return 0n;
    }
  }

  const text = String(value).trim();
  if (!text) return 0n;
  if (/^0x[0-9a-f]+$/i.test(text)) {
    try {
      return BigInt(text);
    } catch {
      return 0n;
    }
  }

  try {
    return parseAtomicToBigint(text);
  } catch {
    const match = text.match(/^-?\d+/);
    if (!match) return 0n;
    try {
      return BigInt(match[0]);
    } catch {
      return 0n;
    }
  }
};

const toTxTimestampMs = (tx: Tx): number => {
  'worklet';

  const raw = Number((tx as any)?.time);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
};

const getTxBlockHeight = (tx: Tx): number | null => {
  'worklet';

  const raw = Number(
    (tx as any)?.blockheight ??
      (tx as any)?.blockHeight ??
      (tx as any)?.block_height,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

const getTxTransactionIndex = (tx: Tx): number | null => {
  'worklet';

  const raw = Number(
    (tx as any)?.receipt?.transactionIndex ?? (tx as any)?.transactionIndex,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const getTxNonce = (tx: Tx): number | null => {
  'worklet';

  const raw = Number((tx as any)?.nonce);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const isTxFailed = (tx: Tx): boolean => {
  'worklet';

  const status = (tx as any)?.receipt?.status;
  if (status === null || status === undefined) return false;
  if (typeof status === 'boolean') return status === false;
  if (typeof status === 'number') return status === 0;
  if (typeof status === 'bigint') return status === 0n;

  const text = String(status).trim().toLowerCase();
  if (!text) return false;
  if (text === 'false' || text === '0' || text === '0x0') return true;
  if (text === 'true' || text === '1' || text === '0x1') return false;

  try {
    if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text) === 0n;
    return BigInt(text) === 0n;
  } catch {
    return false;
  }
};

const getTxL1DataFeeAtomic = (tx: Tx): bigint => {
  'worklet';

  const receipt = (tx as any)?.receipt;
  const l1Fee = parseNumberishToBigint(
    receipt?.l1Fee ??
      receipt?.l1DataFee ??
      receipt?.l1_data_fee ??
      (tx as any)?.l1Fee ??
      (tx as any)?.l1FeePaid,
  );
  return bigIntAbs(l1Fee);
};

const getTxOperatorFeeAtomic = (tx: Tx): bigint => {
  'worklet';

  const receipt = (tx as any)?.receipt;
  const operatorFee = parseNumberishToBigint(
    receipt?.operatorFee ?? receipt?.opFee ?? (tx as any)?.operatorFee,
  );
  return bigIntAbs(operatorFee);
};

const computeTxNetworkFeeAtomic = (tx: Tx): bigint => {
  'worklet';

  const receipt = (tx as any)?.receipt;
  const gasUsed = parseNumberishToBigint(receipt?.gasUsed);
  if (gasUsed > 0n) {
    const price = parseNumberishToBigint(
      receipt?.effectiveGasPrice ??
        receipt?.gasPrice ??
        (tx as any)?.gasPrice,
    );
    if (price > 0n) {
      return (
        gasUsed * price +
        getTxL1DataFeeAtomic(tx) +
        getTxOperatorFeeAtomic(tx)
      );
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

export type SnapshotCarryoverTx = {
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

function normalizeTx(args: {
  tx: Tx;
  originalIndex: number;
  applyFeesToBalance: boolean;
}): NormalizedTx | null {
  'worklet';

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

  return {
    originalIndex,
    id,
    tsMs,
    blockHeight: getTxBlockHeight(tx),
    txIndex: getTxTransactionIndex(tx),
    nonce: getTxNonce(tx),
    action,
    absAmountAtomic,
    failed: isTxFailed(tx),
    baseFeeAtomic: applyFeesToBalance ? computeTxNetworkFeeAtomic(tx) : 0n,
  };
}

function dedupeNormalizedTxPage(txs: NormalizedTx[]): NormalizedTx[] {
  'worklet';

  if (txs.length <= 1) return txs;

  const seen = new Set<string>();
  const out: NormalizedTx[] = [];
  for (const tx of txs) {
    if (!tx.id || seen.has(tx.id)) continue;
    seen.add(tx.id);
    out.push(tx);
  }
  return out;
}

function extractRecentTxIdsFromNormalizedPage(
  normalizedPage: NormalizedTx[],
  consumedRawCount: number,
): string[] {
  'worklet';

  if (consumedRawCount <= 0) return [];
  return normalizedPage
    .filter(tx => tx.originalIndex < consumedRawCount)
    .map(tx => tx.id)
    .filter(Boolean);
}

function getNormalizedTxGroupKey(
  tx: Pick<NormalizedTx, 'tsMs' | 'blockHeight'>,
): string {
  'worklet';

  return `${tx.tsMs}:${tx.blockHeight ?? ''}`;
}

function shouldCarryGroupAcrossPageBoundary(group: NormalizedTx[]): boolean {
  'worklet';

  return group.some(tx => tx.blockHeight !== null);
}

function serializeCarryoverGroup(group: NormalizedTx[]): SnapshotCarryoverTx[] {
  'worklet';

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
  'worklet';

  if (!Array.isArray(raw) || !raw.length) return [];

  return raw.map((entry, index) => ({
    originalIndex: index,
    id: String(entry.id || ''),
    tsMs: Number(entry.tsMs),
    blockHeight: Number.isFinite(Number(entry.blockHeight))
      ? Number(entry.blockHeight)
      : null,
    txIndex: Number.isFinite(Number(entry.txIndex))
      ? Number(entry.txIndex)
      : null,
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
  getDeltaAtomic: (tx: NormalizedTx) => bigint;
}): NormalizedTx[] {
  'worklet';

  const {txs, startingBalanceAtomic, getDeltaAtomic} = args;
  if (txs.length <= 1) return txs;

  const sorted = [...txs].sort((a, b) => {
    const blockHeightA = a.blockHeight ?? -1;
    const blockHeightB = b.blockHeight ?? -1;
    if (blockHeightA !== blockHeightB) return blockHeightA - blockHeightB;

    const txIndexA = a.txIndex ?? -1;
    const txIndexB = b.txIndex ?? -1;
    if (txIndexA !== txIndexB) return txIndexA - txIndexB;

    const nonceA = a.nonce ?? -1;
    const nonceB = b.nonce ?? -1;
    if (nonceA !== nonceB) return nonceA - nonceB;

    return a.originalIndex - b.originalIndex;
  });

  let balanceAtomic = startingBalanceAtomic;
  let sortedOrderAvoidsUnderflow = true;
  for (const tx of sorted) {
    const delta = getDeltaAtomic(tx);
    if (balanceAtomic + delta < 0n) {
      sortedOrderAvoidsUnderflow = false;
      break;
    }
    balanceAtomic += delta;
  }
  if (sortedOrderAvoidsUnderflow) {
    return sorted;
  }

  const out: NormalizedTx[] = [];
  balanceAtomic = startingBalanceAtomic;
  const pending = [...sorted];
  let guard = 0;
  while (pending.length && guard++ < 10_000) {
    let placed = false;
    for (let i = 0; i < pending.length; i += 1) {
      const tx = pending[i];
      const delta = getDeltaAtomic(tx);
      if (balanceAtomic + delta >= 0n) {
        out.push(tx);
        balanceAtomic += delta;
        pending.splice(i, 1);
        placed = true;
        break;
      }
    }
    if (!placed) {
      out.push(...pending);
      pending.length = 0;
      break;
    }
  }

  if (pending.length) {
    out.push(...pending);
  }

  return out;
}

function classifyTxFlow(args: {
  tx: NormalizedTx;
  applyFeesToBalance: boolean;
  feePaidByWallet: boolean;
}): {acquisitionAtomic: bigint; outflowAtomic: bigint} {
  'worklet';

  const {tx, applyFeesToBalance, feePaidByWallet} = args;
  const fee = applyFeesToBalance && feePaidByWallet ? tx.baseFeeAtomic : 0n;

  if (tx.failed && tx.action === 'sent') {
    return {acquisitionAtomic: 0n, outflowAtomic: fee};
  }

  if (tx.action === 'received') {
    return {acquisitionAtomic: tx.absAmountAtomic, outflowAtomic: 0n};
  }

  if (tx.action === 'sent') {
    return {
      acquisitionAtomic: 0n,
      outflowAtomic: tx.absAmountAtomic + fee,
    };
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
    balanceAtomic: string;
    remainingCostBasisFiat: number;
    txIds?: string[];
  };
  firstNonZeroTs?: number;
};

export type PortfolioSnapshotBuilderState = {
  wallet: WalletSummary;
  snapshotDebugMode: SnapshotPersistDebugMode;
  debugTrace?: PortfolioPopulateWalletDebugTrace;
  debugStateMutationControlCounter: number;
  debugStateMutationControlLastStage: string;
  applyFeesToBalance: boolean;
  rateLookup: ReturnType<typeof createFiatRateLookup>;
  nowMs: number;
  compressionEnabled: boolean;
  atomicToUnitNumber: (atomic: bigint) => number;
  balanceAtomic: bigint;
  remainingCostBasisFiat: number;
  lastMarkRate: number;
  lastTimestamp: number;
  firstNonZeroTs?: number;
  dailyState?: SnapshotStreamCheckpoint['daily'];
  nextSkip: number;
  recentTxIds: string[];
  carryoverGroup: NormalizedTx[];
};

export function createPortfolioSnapshotBuilderState(args: {
  wallet: WalletSummary;
  credentials: Pick<
    WalletCredentials,
    'walletId' | 'chain' | 'network' | 'coin' | 'token'
  >;
  quoteCurrency: string;
  fiatRateSeriesCache: FiatRateSeriesCache;
  nowMs?: number;
  compressionEnabled?: boolean;
  snapshotDebugMode?: SnapshotPersistDebugMode;
  debugTrace?: PortfolioPopulateWalletDebugTrace;
  checkpoint?: SnapshotStreamCheckpoint | null;
}): PortfolioSnapshotBuilderState {
  'worklet';

  const checkpoint = args.checkpoint;
  const normalizedCoin = normalizeFiatRateSeriesCoin(
    args.wallet.currencyAbbreviation,
  );

  return {
    wallet: args.wallet,
    snapshotDebugMode: args.snapshotDebugMode ?? 'none',
    debugTrace: args.debugTrace,
    debugStateMutationControlCounter: 0,
    debugStateMutationControlLastStage: '',
    applyFeesToBalance: !args.wallet.tokenAddress,
    rateLookup: createFiatRateLookup({
      quoteCurrency: args.quoteCurrency,
      coin: normalizedCoin,
      chain: args.wallet.chain,
      tokenAddress: args.wallet.tokenAddress,
      cache: args.fiatRateSeriesCache,
      nowMs: args.nowMs ?? Date.now(),
    }),
    nowMs: args.nowMs ?? Date.now(),
    compressionEnabled: !!args.compressionEnabled,
    atomicToUnitNumber: makeAtomicToUnitNumberConverter(
      getAtomicDecimals(args.credentials),
    ),
    balanceAtomic: parseAtomicToBigint(checkpoint?.balanceAtomic ?? '0'),
    remainingCostBasisFiat: Number(checkpoint?.remainingCostBasisFiat ?? 0) || 0,
    lastMarkRate: Number(checkpoint?.lastMarkRate ?? 0) || 0,
    lastTimestamp: Number(checkpoint?.lastTimestamp ?? 0) || 0,
    firstNonZeroTs: checkpoint?.firstNonZeroTs,
    dailyState: checkpoint?.daily
      ? {
          ...checkpoint.daily,
          balanceAtomic: String(
            checkpoint.daily.balanceAtomic ?? checkpoint.balanceAtomic ?? '0',
          ),
          remainingCostBasisFiat:
            Number(
              checkpoint.daily.remainingCostBasisFiat ??
                checkpoint.remainingCostBasisFiat ??
                0,
            ) || 0,
          txIds: Array.isArray(checkpoint.daily.txIds)
            ? checkpoint.daily.txIds.slice()
            : undefined,
        }
      : undefined,
    nextSkip: Number(checkpoint?.nextSkip ?? 0),
    recentTxIds: Array.isArray(checkpoint?.recentTxIds)
      ? checkpoint.recentTxIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : [],
    carryoverGroup: restoreCarryoverGroup(checkpoint?.carryoverGroup),
  };
}

export function getPortfolioSnapshotBuilderCheckpoint(
  state: PortfolioSnapshotBuilderState,
): SnapshotStreamCheckpoint {
  'worklet';

  return {
    nextSkip: state.nextSkip,
    recentTxIds: state.recentTxIds,
    carryoverGroup: state.carryoverGroup.length
      ? serializeCarryoverGroup(state.carryoverGroup)
      : undefined,
    balanceAtomic: state.balanceAtomic.toString(),
    remainingCostBasisFiat: state.remainingCostBasisFiat,
    lastMarkRate: state.lastMarkRate,
    lastTimestamp: state.lastTimestamp,
    daily: state.dailyState
      ? {
          ...state.dailyState,
          txIds: Array.isArray(state.dailyState.txIds)
            ? state.dailyState.txIds.slice()
            : undefined,
        }
      : undefined,
    firstNonZeroTs: state.firstNonZeroTs,
  };
}

export function portfolioSnapshotBuilderHasPendingCarryoverGroup(
  state: PortfolioSnapshotBuilderState,
): boolean {
  'worklet';

  return state.carryoverGroup.length > 0;
}

function makePersistSnapshot(
  state: PortfolioSnapshotBuilderState,
  args: {
    id: string;
    eventType: BalanceSnapshotEventType;
    timestamp: number;
    markRate: number;
    balanceAtomic?: string;
    remainingCostBasisFiat?: number;
  },
  txIds?: string[],
): SnapshotPersistInputV2 {
  'worklet';

  const snapshot: SnapshotPersistInputV2 = {
    timestamp: args.timestamp,
    cryptoBalance: args.balanceAtomic ?? state.balanceAtomic.toString(),
  };

  if (state.snapshotDebugMode !== 'none') {
    snapshot.id = args.id;
    snapshot.eventType = args.eventType;
  }

  if (state.snapshotDebugMode === 'full') {
    snapshot.remainingCostBasisFiat =
      args.remainingCostBasisFiat ?? state.remainingCostBasisFiat;
    snapshot.markRate = args.markRate;
    snapshot.createdAt = Date.now();
  }

  if (args.eventType === 'daily' && Array.isArray(txIds) && txIds.length) {
    snapshot.txIds = txIds.slice();
  }

  return snapshot;
}

function makeTxSnapshot(
  state: PortfolioSnapshotBuilderState,
  txId: string,
  timestamp: number,
  markRate: number,
): SnapshotPersistInputV2 {
  'worklet';

  return makePersistSnapshot(state, {
    id: `tx:${state.wallet.walletId}:${txId}`,
    eventType: 'tx',
    timestamp,
    markRate,
  });
}

function makeDailySnapshot(
  state: PortfolioSnapshotBuilderState,
  dailyState: NonNullable<SnapshotStreamCheckpoint['daily']>,
): SnapshotPersistInputV2 {
  'worklet';

  return makePersistSnapshot(state, {
    id: `daily:${state.wallet.walletId}:${utcDayKeyFromIndex(dailyState.dayIdx)}`,
    eventType: 'daily',
    timestamp: dailyState.lastTimestamp,
    markRate: dailyState.lastMarkRate,
    balanceAtomic: dailyState.balanceAtomic,
    remainingCostBasisFiat: dailyState.remainingCostBasisFiat,
  }, dailyState.txIds);
}

function getMarkRate(
  state: PortfolioSnapshotBuilderState,
  timestamp: number,
): number {
  'worklet';

  const rate = state.rateLookup.getNearestRate(timestamp);
  if (rate === undefined) {
    return Number.isFinite(state.lastMarkRate) && state.lastMarkRate > 0
      ? state.lastMarkRate
      : 0;
  }
  return rate;
}

function captureGroupAssemblyRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateGroupAssemblyDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.groupAssemblyRows.push({
    ...row,
    carryoverSeedTxIds: Array.isArray(row.carryoverSeedTxIds)
      ? row.carryoverSeedTxIds.slice()
      : undefined,
    pageTxIdsAdded: Array.isArray(row.pageTxIdsAdded)
      ? row.pageTxIdsAdded.slice()
      : undefined,
    inputTxIdsBeforeReorder: Array.isArray(row.inputTxIdsBeforeReorder)
      ? row.inputTxIdsBeforeReorder.slice()
      : undefined,
    reorderedTxIds: Array.isArray(row.reorderedTxIds)
      ? row.reorderedTxIds.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureNormalizedFilteredPageKeyRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateNormalizedFilteredPageKeyDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.normalizedFilteredPageKeyRows.push({...row});
  state.debugTrace.capturedAtMs = Date.now();
}

function captureIngestLoopMutationRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateIngestLoopMutationDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.ingestLoopMutationRows.push({
    ...row,
    groupTxIdsBefore: Array.isArray(row.groupTxIdsBefore)
      ? row.groupTxIdsBefore.slice()
      : undefined,
    groupTxIdsAfter: Array.isArray(row.groupTxIdsAfter)
      ? row.groupTxIdsAfter.slice()
      : undefined,
    pageTxIdsAddedBefore: Array.isArray(row.pageTxIdsAddedBefore)
      ? row.pageTxIdsAddedBefore.slice()
      : undefined,
    pageTxIdsAddedAfter: Array.isArray(row.pageTxIdsAddedAfter)
      ? row.pageTxIdsAddedAfter.slice()
      : undefined,
    carryoverSeedTxIdsBefore: Array.isArray(row.carryoverSeedTxIdsBefore)
      ? row.carryoverSeedTxIdsBefore.slice()
      : undefined,
    carryoverSeedTxIdsAfter: Array.isArray(row.carryoverSeedTxIdsAfter)
      ? row.carryoverSeedTxIdsAfter.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureFlushCurrentGroupRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateFlushCurrentGroupDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.flushCurrentGroupRows.push({
    ...row,
    groupTxIdsBeforeReset: Array.isArray(row.groupTxIdsBeforeReset)
      ? row.groupTxIdsBeforeReset.slice()
      : undefined,
    pageTxIdsAddedBeforeReset: Array.isArray(row.pageTxIdsAddedBeforeReset)
      ? row.pageTxIdsAddedBeforeReset.slice()
      : undefined,
    carryoverSeedTxIdsBeforeReset: Array.isArray(
      row.carryoverSeedTxIdsBeforeReset,
    )
      ? row.carryoverSeedTxIdsBeforeReset.slice()
      : undefined,
    groupTxIdsAfterReset: Array.isArray(row.groupTxIdsAfterReset)
      ? row.groupTxIdsAfterReset.slice()
      : undefined,
    pageTxIdsAddedAfterReset: Array.isArray(row.pageTxIdsAddedAfterReset)
      ? row.pageTxIdsAddedAfterReset.slice()
      : undefined,
    carryoverSeedTxIdsAfterReset: Array.isArray(
      row.carryoverSeedTxIdsAfterReset,
    )
      ? row.carryoverSeedTxIdsAfterReset.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureFlushDirectResetWitnessRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateFlushDirectResetWitnessDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.flushDirectResetWitnessRows.push({
    ...row,
    pageTxIdsAddedHeadDirect: Array.isArray(row.pageTxIdsAddedHeadDirect)
      ? row.pageTxIdsAddedHeadDirect.slice()
      : undefined,
    carryoverSeedHeadDirect: Array.isArray(row.carryoverSeedHeadDirect)
      ? row.carryoverSeedHeadDirect.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureFlushReturnWitnessRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateFlushReturnWitnessDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.flushReturnWitnessRows.push({
    ...row,
    pageTxIdsAddedHeadDirect: Array.isArray(row.pageTxIdsAddedHeadDirect)
      ? row.pageTxIdsAddedHeadDirect.slice()
      : undefined,
    carryoverSeedHeadDirect: Array.isArray(row.carryoverSeedHeadDirect)
      ? row.carryoverSeedHeadDirect.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureLocalMutationCanaryRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateLocalMutationCanaryDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.localMutationCanaryRows.push({
    ...row,
    localArrayCanaryHead: Array.isArray(row.localArrayCanaryHead)
      ? row.localArrayCanaryHead.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureStateMutationControlRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateStateMutationControlDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.stateMutationControlRows.push({...row});
  state.debugTrace.capturedAtMs = Date.now();
}

function captureDirectVsHelperParityRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateDirectVsHelperParityDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.directVsHelperParityRows.push({
    ...row,
    pageHeadDirect: Array.isArray(row.pageHeadDirect)
      ? row.pageHeadDirect.slice()
      : undefined,
    pageHeadViaSnapshot: Array.isArray(row.pageHeadViaSnapshot)
      ? row.pageHeadViaSnapshot.slice()
      : undefined,
    carryoverSeedHeadDirect: Array.isArray(row.carryoverSeedHeadDirect)
      ? row.carryoverSeedHeadDirect.slice()
      : undefined,
    carryoverSeedHeadViaSnapshot: Array.isArray(row.carryoverSeedHeadViaSnapshot)
      ? row.carryoverSeedHeadViaSnapshot.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function captureCarryoverDecisionRow(
  state: PortfolioSnapshotBuilderState,
  row: PortfolioPopulateCarryoverDecisionDebugRow,
): void {
  'worklet';

  if (!state.debugTrace) {
    return;
  }

  state.debugTrace.carryoverDecisionRows.push({
    ...row,
    groupTxIdsBeforeAssign: Array.isArray(row.groupTxIdsBeforeAssign)
      ? row.groupTxIdsBeforeAssign.slice()
      : undefined,
    pageTxIdsAdded: Array.isArray(row.pageTxIdsAdded)
      ? row.pageTxIdsAdded.slice()
      : undefined,
    carryoverSeedTxIds: Array.isArray(row.carryoverSeedTxIds)
      ? row.carryoverSeedTxIds.slice()
      : undefined,
    stateCarryoverTxIdsBeforeAssign: Array.isArray(
      row.stateCarryoverTxIdsBeforeAssign,
    )
      ? row.stateCarryoverTxIdsBeforeAssign.slice()
      : undefined,
    stateCarryoverTxIdsAfterAssign: Array.isArray(row.stateCarryoverTxIdsAfterAssign)
      ? row.stateCarryoverTxIdsAfterAssign.slice()
      : undefined,
    recentTxIdsAfterAssign: Array.isArray(row.recentTxIdsAfterAssign)
      ? row.recentTxIdsAfterAssign.slice()
      : undefined,
  });
  state.debugTrace.capturedAtMs = Date.now();
}

function toDebugTxIds(txs: Pick<NormalizedTx, 'id'>[]): string[] {
  'worklet';

  return txs.map(tx => tx.id).filter(Boolean);
}

function toDebugTxIdHead(values: string[], limit = 10): string[] {
  'worklet';

  if (!values.length) {
    return [];
  }
  return values.slice(0, Math.max(1, Math.trunc(Number(limit) || 1)));
}

type IngestLoopStateSnapshot = {
  groupKey: string;
  groupTxIds: string[];
  pageTxIdsAdded: string[];
  carryoverSeedTxIds: string[];
  groupMaxOriginalIndex: number | null;
  consumedRawCount: number;
  endedAtInputBoundary: boolean;
};

type IngestLoopLocalState = {
  group: NormalizedTx[];
  groupKey: string | null;
  groupIndex: number;
  carryoverSeedTxIds: string[];
  pageTxIdsAdded: string[];
  groupMaxOriginalIndex: number;
  consumedRawCount: number;
  groupInstanceSeq: number;
  flushInvocationSeq: number;
  localScalarCanary: number;
  localArrayCanary: string[];
  localStringCanary: string;
};

function snapshotIngestLoopState(args: {
  group: NormalizedTx[];
  groupKey: string | null;
  pageTxIdsAdded: string[];
  carryoverSeedTxIds: string[];
  groupMaxOriginalIndex: number;
  consumedRawCount: number;
  endedAtInputBoundary: boolean;
}): IngestLoopStateSnapshot {
  'worklet';

  return {
    groupKey: args.groupKey ?? '',
    groupTxIds: toDebugTxIds(args.group),
    pageTxIdsAdded: args.pageTxIdsAdded.slice(),
    carryoverSeedTxIds: args.carryoverSeedTxIds.slice(),
    groupMaxOriginalIndex:
      args.groupMaxOriginalIndex >= 0 ? args.groupMaxOriginalIndex : null,
    consumedRawCount: args.consumedRawCount,
    endedAtInputBoundary: args.endedAtInputBoundary,
  };
}

function processTx(
  state: PortfolioSnapshotBuilderState,
  tx: NormalizedTx,
): SnapshotPersistInputV2[] {
  'worklet';

  const out: SnapshotPersistInputV2[] = [];
  const markRate = getMarkRate(state, tx.tsMs);
  const preBalanceAtomic = state.balanceAtomic;

  const {acquisitionAtomic, outflowAtomic} = classifyTxFlow({
    tx,
    applyFeesToBalance: state.applyFeesToBalance,
    feePaidByWallet: true,
  });
  const normalizedDeltaAtomic = acquisitionAtomic - outflowAtomic;

  if (acquisitionAtomic > 0n) {
    let acquisitionRemainder = acquisitionAtomic;

    if (state.balanceAtomic < 0n) {
      const deficit = -state.balanceAtomic;
      const cover = acquisitionRemainder > deficit ? deficit : acquisitionRemainder;
      state.balanceAtomic += cover;
      acquisitionRemainder -= cover;
    }

    if (acquisitionRemainder > 0n) {
      state.balanceAtomic += acquisitionRemainder;
      state.remainingCostBasisFiat +=
        state.atomicToUnitNumber(acquisitionRemainder) * markRate;
    }
  }

  if (outflowAtomic > 0n) {
    const before = state.balanceAtomic;
    if (before <= 0n) {
      state.balanceAtomic = before - outflowAtomic;
      state.remainingCostBasisFiat = 0;
    } else {
      const disposeAgainstHoldings = outflowAtomic > before ? before : outflowAtomic;
      const ratio = ratioBigIntToNumber(disposeAgainstHoldings, before);
      state.remainingCostBasisFiat -= state.remainingCostBasisFiat * ratio;
      state.balanceAtomic = before - outflowAtomic;
      if (state.balanceAtomic <= 0n) {
        state.remainingCostBasisFiat = 0;
      }
    }
  }

  if (
    !Number.isFinite(state.remainingCostBasisFiat) ||
    state.remainingCostBasisFiat < 0
  ) {
    state.remainingCostBasisFiat = 0;
  }

  state.lastMarkRate = markRate;
  state.lastTimestamp = tx.tsMs;
  if (state.firstNonZeroTs === undefined && state.balanceAtomic > 0n) {
    state.firstNonZeroTs = tx.tsMs;
  }

  if (state.debugTrace) {
    state.debugTrace.processedTxRows.push({
      seq: state.debugTrace.processedTxRows.length + 1,
      txid: tx.id,
      timestamp: tx.tsMs,
      action: tx.action,
      amountAtomic: tx.absAmountAtomic.toString(),
      feeAtomic: tx.baseFeeAtomic.toString(),
      normalizedDeltaAtomic: normalizedDeltaAtomic.toString(),
      preBalanceAtomic: preBalanceAtomic.toString(),
      postBalanceAtomic: state.balanceAtomic.toString(),
      blockHeight: tx.blockHeight,
    });
    state.debugTrace.capturedAtMs = Date.now();
  }

  const compressBefore = state.nowMs - COMPRESSION_AGE_MS;
  const shouldCompress = state.compressionEnabled && tx.tsMs < compressBefore;

  if (shouldCompress) {
    const dayIdx = utcDayIndex(tx.tsMs);
    if (!state.dailyState) {
      state.dailyState = {
        dayIdx,
        lastTimestamp: tx.tsMs,
        lastMarkRate: markRate,
        balanceAtomic: state.balanceAtomic.toString(),
        remainingCostBasisFiat: state.remainingCostBasisFiat,
        txIds: [tx.id],
      };
    } else if (state.dailyState.dayIdx !== dayIdx) {
      const dailyState = state.dailyState;
      out.push(makeDailySnapshot(state, dailyState));
      state.dailyState = {
        dayIdx,
        lastTimestamp: tx.tsMs,
        lastMarkRate: markRate,
        balanceAtomic: state.balanceAtomic.toString(),
        remainingCostBasisFiat: state.remainingCostBasisFiat,
        txIds: [tx.id],
      };
    } else {
      state.dailyState.lastTimestamp = tx.tsMs;
      state.dailyState.lastMarkRate = markRate;
      state.dailyState.balanceAtomic = state.balanceAtomic.toString();
      state.dailyState.remainingCostBasisFiat = state.remainingCostBasisFiat;
      if (!Array.isArray(state.dailyState.txIds)) {
        state.dailyState.txIds = [];
      }
      state.dailyState.txIds.push(tx.id);
    }

    return out;
  }

  if (state.dailyState) {
    const dailyState = state.dailyState;
    out.push(makeDailySnapshot(state, dailyState));
    state.dailyState = undefined;
  }

  out.push(makeTxSnapshot(state, tx.id, tx.tsMs, markRate));
  return out;
}

function processGroup(
  state: PortfolioSnapshotBuilderState,
  group: NormalizedTx[],
  debugMeta?: {
    requestId: string;
    stepSeq?: number;
    groupIndex: number;
    groupInstanceSeq?: number;
    groupKey: string;
    carryoverSeedTxIds?: string[];
    pageTxIdsAdded?: string[];
    flushReason: string;
  },
): SnapshotPersistInputV2[] {
  'worklet';

  if (!group.length) return [];

  const orderedGroup = group.map((tx, index) =>
    tx.originalIndex === index ? tx : {...tx, originalIndex: index},
  );
  const reordered = reorderTxBatchToPreventUnderflow({
    txs: orderedGroup,
    startingBalanceAtomic: state.balanceAtomic,
    getDeltaAtomic: tx => {
      'worklet';

      const flow = classifyTxFlow({
        tx,
        applyFeesToBalance: state.applyFeesToBalance,
        feePaidByWallet: true,
      });
      return flow.acquisitionAtomic - flow.outflowAtomic;
    },
  });

  if (debugMeta?.requestId) {
    captureGroupAssemblyRow(state, {
      requestId: debugMeta.requestId,
      stepSeq: debugMeta.stepSeq,
      groupIndex: debugMeta.groupIndex,
      groupInstanceSeq: debugMeta.groupInstanceSeq,
      groupKey: debugMeta.groupKey,
      carryoverSeedTxIds: debugMeta.carryoverSeedTxIds,
      pageTxIdsAdded: debugMeta.pageTxIdsAdded,
      inputTxIdsBeforeReorder: orderedGroup.map(tx => tx.id).filter(Boolean),
      reorderedTxIds: reordered.map(tx => tx.id).filter(Boolean),
      flushReason: debugMeta.flushReason,
    });
  }

  const out: SnapshotPersistInputV2[] = [];
  for (const tx of reordered) {
    out.push(...processTx(state, tx));
  }
  return out;
}

export function portfolioSnapshotBuilderFlushPendingCarryoverGroup(
  state: PortfolioSnapshotBuilderState,
  debugRequestId?: string,
): SnapshotPersistInputV2[] {
  'worklet';

  debugRequestId = debugRequestId && state.debugTrace ? debugRequestId : undefined;

  if (!state.carryoverGroup.length) return [];
  const group = state.carryoverGroup;
  state.carryoverGroup = [];
  return processGroup(
    state,
    group,
    debugRequestId
      ? {
          requestId: debugRequestId,
          groupIndex: 1,
          groupKey: getNormalizedTxGroupKey(group[0]),
          carryoverSeedTxIds: group.map(tx => tx.id).filter(Boolean),
          pageTxIdsAdded: [],
          flushReason: 'pending_carryover_flush',
        }
      : undefined,
  );
}

export function portfolioSnapshotBuilderFinish(
  state: PortfolioSnapshotBuilderState,
  debugRequestId?: string,
): SnapshotPersistInputV2[] {
  'worklet';

  debugRequestId = debugRequestId && state.debugTrace ? debugRequestId : undefined;

  const out: SnapshotPersistInputV2[] = [];
  out.push(
    ...portfolioSnapshotBuilderFlushPendingCarryoverGroup(state, debugRequestId),
  );
  if (state.dailyState) {
    const dailyState = state.dailyState;
    out.push(makeDailySnapshot(state, dailyState));
    state.dailyState = undefined;
  }
  return out;
}

export function portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
  state: PortfolioSnapshotBuilderState,
  txs: Tx[],
  maxSnapshots?: number,
  debugRequestId?: string,
): {
  snapshots: SnapshotPersistInputV2[];
  logicalPageSize: number;
  consumedRawCount: number;
} {
  'worklet';

  debugRequestId = debugRequestId && state.debugTrace ? debugRequestId : undefined;

  const out: SnapshotPersistInputV2[] = [];
  const normalizedPage = dedupeNormalizedTxPage(
    txs
      .map((tx, originalIndex) =>
        normalizeTx({
          tx,
          originalIndex,
          applyFeesToBalance: state.applyFeesToBalance,
        }),
      )
      .filter((tx): tx is NormalizedTx => !!tx),
  );

  const recentTxIds = new Set(state.recentTxIds);
  const filteredPage = recentTxIds.size
    ? normalizedPage.filter(tx => !recentTxIds.has(tx.id))
    : normalizedPage;
  const limit =
    Number.isFinite(Number(maxSnapshots)) && Number(maxSnapshots) > 0
      ? Math.trunc(Number(maxSnapshots))
      : null;

  if (!filteredPage.length) {
    const logicalPageSize = getTxHistoryLogicalPageSize(txs);
    state.nextSkip += logicalPageSize;
    state.recentTxIds = normalizedPage.map(tx => tx.id).filter(Boolean);
    return {
      snapshots: out,
      logicalPageSize,
      consumedRawCount: txs.length,
    };
  }

  if (debugRequestId) {
    let previousGroupKey = '';
    for (let index = 0; index < filteredPage.length; index += 1) {
      const tx = filteredPage[index];
      const groupKey = getNormalizedTxGroupKey(tx);
      captureNormalizedFilteredPageKeyRow(state, {
        requestId: debugRequestId,
        filteredIndex: index + 1,
        originalIndex: tx.originalIndex,
        txid: tx.id,
        timestamp: tx.tsMs,
        blockHeight: tx.blockHeight,
        groupKey,
        startsNewGroup: index === 0 || groupKey !== previousGroupKey,
      });
      previousGroupKey = groupKey;
    }
  }

  let group = state.carryoverGroup.length ? state.carryoverGroup.slice() : [];
  state.carryoverGroup = [];
  let groupKey: string | null = group.length
    ? getNormalizedTxGroupKey(group[0])
    : null;
  let groupIndex = 0;
  let carryoverSeedTxIds = toDebugTxIds(group);
  let pageTxIdsAdded: string[] = [];
  let groupMaxOriginalIndex = -1;
  let consumedRawCount = 0;
  let endedAtInputBoundary = true;
  let stepSeq = 0;
  let groupInstanceSeq = 1;
  let flushInvocationSeq = 0;
  let localScalarCanary = 0;
  let localArrayCanary: string[] = [];
  let localStringCanary = '';

  const nextStepSeq = (): number => {
    'worklet';

    stepSeq += 1;
    return stepSeq;
  };

  const bumpStateMutationControl = (stage: string): void => {
    'worklet';

    state.debugStateMutationControlCounter += 1;
    state.debugStateMutationControlLastStage = stage;
  };

  const captureLoopMutation = (args: {
    loopIndex?: number;
    mutation: string;
    tx?: NormalizedTx;
    txGroupKey?: string;
    before: IngestLoopStateSnapshot;
    after: IngestLoopStateSnapshot;
    note?: string;
  }): void => {
    'worklet';

    if (!debugRequestId) {
      return;
    }

    captureIngestLoopMutationRow(state, {
      requestId: debugRequestId,
      stepSeq: nextStepSeq(),
      loopIndex: args.loopIndex ?? null,
      mutation: args.mutation,
      txid: args.tx?.id ?? '',
      txGroupKey:
        args.txGroupKey ??
        (args.tx ? getNormalizedTxGroupKey(args.tx) : ''),
      groupInstanceSeq,
      groupKeyBefore: args.before.groupKey,
      groupKeyAfter: args.after.groupKey,
      groupTxIdsBefore: args.before.groupTxIds,
      groupTxIdsAfter: args.after.groupTxIds,
      pageTxIdsAddedBefore: args.before.pageTxIdsAdded,
      pageTxIdsAddedAfter: args.after.pageTxIdsAdded,
      carryoverSeedTxIdsBefore: args.before.carryoverSeedTxIds,
      carryoverSeedTxIdsAfter: args.after.carryoverSeedTxIds,
      groupMaxOriginalIndexBefore: args.before.groupMaxOriginalIndex,
      groupMaxOriginalIndexAfter: args.after.groupMaxOriginalIndex,
      consumedRawCountBefore: args.before.consumedRawCount,
      consumedRawCountAfter: args.after.consumedRawCount,
      endedAtInputBoundary: args.after.endedAtInputBoundary,
      note: args.note,
    });
  };

  if (debugRequestId) {
    const initialState = snapshotIngestLoopState({
      group,
      groupKey,
      pageTxIdsAdded,
      carryoverSeedTxIds,
      groupMaxOriginalIndex,
      consumedRawCount,
      endedAtInputBoundary,
    });
    captureLoopMutation({
      mutation: 'ingest_init',
      before: initialState,
      after: initialState,
      note: group.length ? 'seeded_from_builder_carryover' : 'fresh_local_group',
    });
  }

  const flushCurrentGroup = (
    current: IngestLoopLocalState,
    flushReason: string,
  ): IngestLoopLocalState => {
    'worklet';

    /* eslint-disable @typescript-eslint/no-shadow */
    let {
      group,
      groupKey,
      groupIndex,
      carryoverSeedTxIds,
      pageTxIdsAdded,
      groupMaxOriginalIndex,
      consumedRawCount,
      groupInstanceSeq,
      flushInvocationSeq,
      localScalarCanary,
      localArrayCanary,
      localStringCanary,
    } = current;
    /* eslint-enable @typescript-eslint/no-shadow */

    if (!group.length) {
      return {
        group,
        groupKey,
        groupIndex,
        carryoverSeedTxIds,
        pageTxIdsAdded,
        groupMaxOriginalIndex,
        consumedRawCount,
        groupInstanceSeq,
        flushInvocationSeq,
        localScalarCanary,
        localArrayCanary,
        localStringCanary,
      };
    }
    flushInvocationSeq += 1;
    const activeFlushInvocationSeq = flushInvocationSeq;
    const beforeReset = snapshotIngestLoopState({
      group,
      groupKey,
      pageTxIdsAdded,
      carryoverSeedTxIds,
      groupMaxOriginalIndex,
      consumedRawCount,
      endedAtInputBoundary,
    });
    const groupInstanceSeqBeforeReset = groupInstanceSeq;
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'before_process',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
      captureLocalMutationCanaryRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_entry_before_mutation',
        localScalarCanary,
        localArrayCanaryLen: localArrayCanary.length,
        localArrayCanaryHead: toDebugTxIdHead(localArrayCanary),
        localStringCanary,
      });
      captureStateMutationControlRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_entry_before_mutation',
        stateControlCounter: state.debugStateMutationControlCounter,
        stateControlLastStage: state.debugStateMutationControlLastStage,
        localScalarCanary,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
      });
      captureDirectVsHelperParityRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_before_process',
        groupLenDirect: group.length,
        groupLenViaSnapshot: beforeReset.groupTxIds.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        groupFirstTxidViaSnapshot: beforeReset.groupTxIds[0] ?? '',
        pageLenDirect: pageTxIdsAdded.length,
        pageLenViaSnapshot: beforeReset.pageTxIdsAdded.length,
        pageHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        pageHeadViaSnapshot: toDebugTxIdHead(beforeReset.pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedLenViaSnapshot: beforeReset.carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        carryoverSeedHeadViaSnapshot: toDebugTxIdHead(
          beforeReset.carryoverSeedTxIds,
        ),
        groupKeyDirect: groupKey ?? '',
        groupKeyViaSnapshot: beforeReset.groupKey,
        groupKeyIsNullDirect: groupKey === null,
      });
    }
    const flushStepSeq = debugRequestId ? nextStepSeq() : 0;
    groupIndex += 1;
    out.push(
      ...processGroup(
        state,
        group,
        debugRequestId
          ? {
              requestId: debugRequestId,
              stepSeq: flushStepSeq,
              groupIndex,
              groupInstanceSeq: groupInstanceSeqBeforeReset,
              groupKey: groupKey ?? '',
              carryoverSeedTxIds,
              pageTxIdsAdded,
              flushReason,
            }
          : undefined,
      ),
    );
    consumedRawCount = groupMaxOriginalIndex + 1;
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_process_before_reset',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    if (debugRequestId) {
      localScalarCanary += 1;
      localArrayCanary = [
        `flush_${activeFlushInvocationSeq}`,
        flushReason,
        'helper_after_mutation',
      ];
      localStringCanary =
        `helper:${activeFlushInvocationSeq}:${flushReason}:after_mutation`;
      bumpStateMutationControl('helper_after_mutation');
      captureLocalMutationCanaryRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_after_mutation',
        localScalarCanary,
        localArrayCanaryLen: localArrayCanary.length,
        localArrayCanaryHead: toDebugTxIdHead(localArrayCanary),
        localStringCanary,
      });
      captureStateMutationControlRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_after_mutation',
        stateControlCounter: state.debugStateMutationControlCounter,
        stateControlLastStage: state.debugStateMutationControlLastStage,
        localScalarCanary,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
      });
    }
    group = [];
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_group_clear',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    groupKey = null;
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_group_key_null',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    carryoverSeedTxIds = [];
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_carryover_seed_clear',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    pageTxIdsAdded = [];
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_page_txids_clear',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    groupMaxOriginalIndex = -1;
    if (debugRequestId) {
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_group_max_reset',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
    }
    groupInstanceSeq += 1;
    if (debugRequestId) {
      localScalarCanary += 1;
      localArrayCanary = [...localArrayCanary, 'helper_after_reset_complete'];
      localStringCanary = `${localStringCanary}|helper_after_reset_complete`;
      bumpStateMutationControl('helper_after_reset_complete');
      captureFlushDirectResetWitnessRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'after_reset_complete',
        groupInstanceSeqDirect: groupInstanceSeq,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
        pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        groupKeyDirect: groupKey ?? '',
        groupKeyIsNullDirect: groupKey === null,
        groupMaxOriginalIndexDirect:
          groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
        consumedRawCountDirect: consumedRawCount,
      });
      captureLocalMutationCanaryRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_after_reset_complete',
        localScalarCanary,
        localArrayCanaryLen: localArrayCanary.length,
        localArrayCanaryHead: toDebugTxIdHead(localArrayCanary),
        localStringCanary,
      });
      captureStateMutationControlRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_after_reset_complete',
        stateControlCounter: state.debugStateMutationControlCounter,
        stateControlLastStage: state.debugStateMutationControlLastStage,
        localScalarCanary,
        groupLenDirect: group.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
      });
      const afterReset = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureDirectVsHelperParityRow(state, {
        requestId: debugRequestId,
        flushInvocationSeq: activeFlushInvocationSeq,
        stepSeq: nextStepSeq(),
        flushReason,
        stage: 'helper_after_reset_complete',
        groupLenDirect: group.length,
        groupLenViaSnapshot: afterReset.groupTxIds.length,
        groupFirstTxidDirect: group.length ? group[0].id : '',
        groupFirstTxidViaSnapshot: afterReset.groupTxIds[0] ?? '',
        pageLenDirect: pageTxIdsAdded.length,
        pageLenViaSnapshot: afterReset.pageTxIdsAdded.length,
        pageHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
        pageHeadViaSnapshot: toDebugTxIdHead(afterReset.pageTxIdsAdded),
        carryoverSeedLenDirect: carryoverSeedTxIds.length,
        carryoverSeedLenViaSnapshot: afterReset.carryoverSeedTxIds.length,
        carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
        carryoverSeedHeadViaSnapshot: toDebugTxIdHead(
          afterReset.carryoverSeedTxIds,
        ),
        groupKeyDirect: groupKey ?? '',
        groupKeyViaSnapshot: afterReset.groupKey,
        groupKeyIsNullDirect: groupKey === null,
      });
      captureFlushCurrentGroupRow(state, {
        requestId: debugRequestId,
        stepSeq: flushStepSeq,
        flushReason,
        groupInstanceSeqBeforeReset,
        groupInstanceSeqAfterReset: groupInstanceSeq,
        groupKeyBeforeReset: beforeReset.groupKey,
        groupTxIdsBeforeReset: beforeReset.groupTxIds,
        pageTxIdsAddedBeforeReset: beforeReset.pageTxIdsAdded,
        carryoverSeedTxIdsBeforeReset: beforeReset.carryoverSeedTxIds,
        groupMaxOriginalIndexBeforeReset: beforeReset.groupMaxOriginalIndex,
        consumedRawCountBeforeReset: beforeReset.consumedRawCount,
        groupKeyAfterReset: afterReset.groupKey,
        groupTxIdsAfterReset: afterReset.groupTxIds,
        pageTxIdsAddedAfterReset: afterReset.pageTxIdsAdded,
        carryoverSeedTxIdsAfterReset: afterReset.carryoverSeedTxIds,
        groupMaxOriginalIndexAfterReset: afterReset.groupMaxOriginalIndex,
        consumedRawCountAfterReset: afterReset.consumedRawCount,
      });
    }

    return {
      group,
      groupKey,
      groupIndex,
      carryoverSeedTxIds,
      pageTxIdsAdded,
      groupMaxOriginalIndex,
      consumedRawCount,
      groupInstanceSeq,
      flushInvocationSeq,
      localScalarCanary,
      localArrayCanary,
      localStringCanary,
    };
  };

  for (let index = 0; index < filteredPage.length; index += 1) {
    const tx = filteredPage[index];
    const loopIndex = index + 1;
    const key = getNormalizedTxGroupKey(tx);
    if (debugRequestId) {
      const beforeLoop = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'loop_enter',
        tx,
        txGroupKey: key,
        before: beforeLoop,
        after: beforeLoop,
      });
    }
    if (groupKey === null) {
      const beforeGroupKeySeed = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      groupKey = key;
      const afterGroupKeySeed = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'seed_group_key',
        tx,
        txGroupKey: key,
        before: beforeGroupKeySeed,
        after: afterGroupKeySeed,
      });
    }
    if (key !== groupKey) {
      const beforeKeyChange = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'key_change_detected',
        tx,
        txGroupKey: key,
        before: beforeKeyChange,
        after: beforeKeyChange,
      });
      const flushedState = flushCurrentGroup(
        {
          group,
          groupKey,
          groupIndex,
          carryoverSeedTxIds,
          pageTxIdsAdded,
          groupMaxOriginalIndex,
          consumedRawCount,
          groupInstanceSeq,
          flushInvocationSeq,
          localScalarCanary,
          localArrayCanary,
          localStringCanary,
        },
        'group_key_change',
      );
      group = flushedState.group;
      groupKey = flushedState.groupKey;
      groupIndex = flushedState.groupIndex;
      carryoverSeedTxIds = flushedState.carryoverSeedTxIds;
      pageTxIdsAdded = flushedState.pageTxIdsAdded;
      groupMaxOriginalIndex = flushedState.groupMaxOriginalIndex;
      consumedRawCount = flushedState.consumedRawCount;
      groupInstanceSeq = flushedState.groupInstanceSeq;
      flushInvocationSeq = flushedState.flushInvocationSeq;
      localScalarCanary = flushedState.localScalarCanary;
      localArrayCanary = flushedState.localArrayCanary;
      localStringCanary = flushedState.localStringCanary;
      if (debugRequestId) {
        const afterFlushReturn = snapshotIngestLoopState({
          group,
          groupKey,
          pageTxIdsAdded,
          carryoverSeedTxIds,
          groupMaxOriginalIndex,
          consumedRawCount,
          endedAtInputBoundary,
        });
        bumpStateMutationControl('caller_after_flush_return_before_reseed');
        captureFlushReturnWitnessRow(state, {
          requestId: debugRequestId,
          flushInvocationSeq,
          stepSeq: nextStepSeq(),
          flushReason: 'group_key_change',
          stage: 'caller_after_flush_return_before_reseed',
          loopIndex,
          nextIncomingTxid: tx.id,
          nextIncomingGroupKey: key,
          groupInstanceSeqDirect: groupInstanceSeq,
          groupLenDirect: group.length,
          groupFirstTxidDirect: group.length ? group[0].id : '',
          pageTxIdsAddedLenDirect: pageTxIdsAdded.length,
          pageTxIdsAddedHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
          carryoverSeedLenDirect: carryoverSeedTxIds.length,
          carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
          groupKeyDirect: groupKey ?? '',
          groupKeyIsNullDirect: groupKey === null,
          groupMaxOriginalIndexDirect:
            groupMaxOriginalIndex >= 0 ? groupMaxOriginalIndex : null,
          consumedRawCountDirect: consumedRawCount,
        });
        captureLocalMutationCanaryRow(state, {
          requestId: debugRequestId,
          flushInvocationSeq,
          stepSeq: nextStepSeq(),
          flushReason: 'group_key_change',
          stage: 'caller_after_flush_return_before_reseed',
          localScalarCanary,
          localArrayCanaryLen: localArrayCanary.length,
          localArrayCanaryHead: toDebugTxIdHead(localArrayCanary),
          localStringCanary,
        });
        captureStateMutationControlRow(state, {
          requestId: debugRequestId,
          flushInvocationSeq,
          stepSeq: nextStepSeq(),
          flushReason: 'group_key_change',
          stage: 'caller_after_flush_return_before_reseed',
          stateControlCounter: state.debugStateMutationControlCounter,
          stateControlLastStage: state.debugStateMutationControlLastStage,
          localScalarCanary,
          groupLenDirect: group.length,
          groupFirstTxidDirect: group.length ? group[0].id : '',
        });
        captureDirectVsHelperParityRow(state, {
          requestId: debugRequestId,
          flushInvocationSeq,
          stepSeq: nextStepSeq(),
          flushReason: 'group_key_change',
          stage: 'caller_after_flush_return_before_reseed',
          groupLenDirect: group.length,
          groupLenViaSnapshot: afterFlushReturn.groupTxIds.length,
          groupFirstTxidDirect: group.length ? group[0].id : '',
          groupFirstTxidViaSnapshot: afterFlushReturn.groupTxIds[0] ?? '',
          pageLenDirect: pageTxIdsAdded.length,
          pageLenViaSnapshot: afterFlushReturn.pageTxIdsAdded.length,
          pageHeadDirect: toDebugTxIdHead(pageTxIdsAdded),
          pageHeadViaSnapshot: toDebugTxIdHead(afterFlushReturn.pageTxIdsAdded),
          carryoverSeedLenDirect: carryoverSeedTxIds.length,
          carryoverSeedLenViaSnapshot: afterFlushReturn.carryoverSeedTxIds.length,
          carryoverSeedHeadDirect: toDebugTxIdHead(carryoverSeedTxIds),
          carryoverSeedHeadViaSnapshot: toDebugTxIdHead(
            afterFlushReturn.carryoverSeedTxIds,
          ),
          groupKeyDirect: groupKey ?? '',
          groupKeyViaSnapshot: afterFlushReturn.groupKey,
          groupKeyIsNullDirect: groupKey === null,
        });
      }
      if (limit !== null && out.length >= limit) {
        const beforeLimitBreak = snapshotIngestLoopState({
          group,
          groupKey,
          pageTxIdsAdded,
          carryoverSeedTxIds,
          groupMaxOriginalIndex,
          consumedRawCount,
          endedAtInputBoundary,
        });
        endedAtInputBoundary = false;
        const afterLimitBreak = snapshotIngestLoopState({
          group,
          groupKey,
          pageTxIdsAdded,
          carryoverSeedTxIds,
          groupMaxOriginalIndex,
          consumedRawCount,
          endedAtInputBoundary,
        });
        captureLoopMutation({
          loopIndex,
          mutation: 'limit_break_after_flush',
          tx,
          txGroupKey: key,
          before: beforeLimitBreak,
          after: afterLimitBreak,
        });
        break;
      }
      const beforeGroupKeyReseed = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      groupKey = key;
      const afterGroupKeyReseed = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'reseed_group_key_after_flush',
        tx,
        txGroupKey: key,
        before: beforeGroupKeyReseed,
        after: afterGroupKeyReseed,
      });
    }
    const beforeGroupPush = snapshotIngestLoopState({
      group,
      groupKey,
      pageTxIdsAdded,
      carryoverSeedTxIds,
      groupMaxOriginalIndex,
      consumedRawCount,
      endedAtInputBoundary,
    });
    group.push(tx);
    const afterGroupPush = snapshotIngestLoopState({
      group,
      groupKey,
      pageTxIdsAdded,
      carryoverSeedTxIds,
      groupMaxOriginalIndex,
      consumedRawCount,
      endedAtInputBoundary,
    });
    captureLoopMutation({
      loopIndex,
      mutation: 'append_tx_to_group',
      tx,
      txGroupKey: key,
      before: beforeGroupPush,
      after: afterGroupPush,
    });
    if (tx.id) {
      const beforePageTxIdAdd = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      pageTxIdsAdded.push(tx.id);
      const afterPageTxIdAdd = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'append_txid_to_page_group',
        tx,
        txGroupKey: key,
        before: beforePageTxIdAdd,
        after: afterPageTxIdAdd,
      });
    }
    if (tx.originalIndex > groupMaxOriginalIndex) {
      const beforeGroupMaxAdvance = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      groupMaxOriginalIndex = tx.originalIndex;
      const afterGroupMaxAdvance = snapshotIngestLoopState({
        group,
        groupKey,
        pageTxIdsAdded,
        carryoverSeedTxIds,
        groupMaxOriginalIndex,
        consumedRawCount,
        endedAtInputBoundary,
      });
      captureLoopMutation({
        loopIndex,
        mutation: 'advance_group_max_original_index',
        tx,
        txGroupKey: key,
        before: beforeGroupMaxAdvance,
        after: afterGroupMaxAdvance,
      });
    }
  }

  if (group.length) {
    const shouldCarryAcrossPageBoundary =
      endedAtInputBoundary &&
      groupMaxOriginalIndex >= 0 &&
      shouldCarryGroupAcrossPageBoundary(group);
    if (shouldCarryAcrossPageBoundary) {
      const carryoverDecisionStepSeq = debugRequestId ? nextStepSeq() : 0;
      if (debugRequestId) {
        groupIndex += 1;
        captureGroupAssemblyRow(state, {
          requestId: debugRequestId,
          stepSeq: carryoverDecisionStepSeq,
          groupIndex,
          groupInstanceSeq,
          groupKey: groupKey ?? '',
          carryoverSeedTxIds,
          pageTxIdsAdded,
          inputTxIdsBeforeReorder: toDebugTxIds(group),
          reorderedTxIds: undefined,
          flushReason: 'carryover_deferred_at_page_boundary',
        });
      }
      const logicalPageSize = getTxHistoryLogicalPageSize(txs);
      const nextSkipBeforeAssign = state.nextSkip;
      const stateCarryoverTxIdsBeforeAssign = toDebugTxIds(state.carryoverGroup);
      state.carryoverGroup = group;
      state.nextSkip += logicalPageSize;
      state.recentTxIds = normalizedPage.map(tx => tx.id).filter(Boolean);
      if (debugRequestId) {
        captureCarryoverDecisionRow(state, {
          requestId: debugRequestId,
          stepSeq: carryoverDecisionStepSeq,
          groupInstanceSeq,
          endedAtInputBoundary,
          shouldCarryAcrossPageBoundary,
          groupKey: groupKey ?? '',
          groupTxIdsBeforeAssign: toDebugTxIds(group),
          pageTxIdsAdded,
          carryoverSeedTxIds,
          stateCarryoverTxIdsBeforeAssign,
          stateCarryoverTxIdsAfterAssign: toDebugTxIds(state.carryoverGroup),
          logicalPageSize,
          nextSkipBeforeAssign,
          nextSkipAfterAssign: state.nextSkip,
          recentTxIdsAfterAssign: state.recentTxIds,
        });
      }
      return {
        snapshots: out,
        logicalPageSize,
        consumedRawCount: txs.length,
      };
    }
    const flushedState = flushCurrentGroup(
      {
        group,
        groupKey,
        groupIndex,
        carryoverSeedTxIds,
        pageTxIdsAdded,
        groupMaxOriginalIndex,
        consumedRawCount,
        groupInstanceSeq,
        flushInvocationSeq,
        localScalarCanary,
        localArrayCanary,
        localStringCanary,
      },
      'end_of_page_flush',
    );
    group = flushedState.group;
    groupKey = flushedState.groupKey;
    groupIndex = flushedState.groupIndex;
    carryoverSeedTxIds = flushedState.carryoverSeedTxIds;
    pageTxIdsAdded = flushedState.pageTxIdsAdded;
    groupMaxOriginalIndex = flushedState.groupMaxOriginalIndex;
    consumedRawCount = flushedState.consumedRawCount;
    groupInstanceSeq = flushedState.groupInstanceSeq;
    flushInvocationSeq = flushedState.flushInvocationSeq;
    localScalarCanary = flushedState.localScalarCanary;
    localArrayCanary = flushedState.localArrayCanary;
    localStringCanary = flushedState.localStringCanary;
  }

  const consumedRaw = txs.slice(0, consumedRawCount);
  const logicalPageSize = getTxHistoryLogicalPageSize(consumedRaw);
  state.nextSkip += logicalPageSize;
  state.recentTxIds = extractRecentTxIdsFromNormalizedPage(
    normalizedPage,
    consumedRawCount,
  );

  return {
    snapshots: out,
    logicalPageSize,
    consumedRawCount,
  };
}
