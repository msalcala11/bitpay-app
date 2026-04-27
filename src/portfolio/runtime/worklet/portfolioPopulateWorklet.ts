import type {
  WorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from '../../core/engine/workerProtocol';
import type {WalletCredentials, WalletSummary, Tx} from '../../core/types';
import type {
  PrepareWalletSessionResult,
  ProcessNextPageSessionResult,
  FinishWalletSessionResult,
  SnapshotIngestConfig,
} from '../../core/engine/portfolioEngine';
import type {
  PortfolioPopulateFetchedTxDebugRow,
  PortfolioPopulateBuilderSeedDebugRow,
  PortfolioPopulateCarryoverDecisionDebugRow,
  PortfolioPopulateDirectVsHelperParityDebugRow,
  PortfolioPopulateFlushDirectResetWitnessDebugRow,
  PortfolioPopulateFlushCurrentGroupDebugRow,
  PortfolioPopulateFlushReturnWitnessDebugRow,
  PortfolioPopulateGroupAssemblyDebugRow,
  PortfolioPopulateIngestSeedDebugRow,
  PortfolioPopulateIngestLoopMutationDebugRow,
  PortfolioPopulateLocalMutationCanaryDebugRow,
  PortfolioPopulateNormalizedFilteredPageKeyDebugRow,
  PortfolioPopulateRequestLifecycleDebugRow,
  PortfolioPopulateSessionStateBeforePrepareDebugRow,
  PortfolioPopulateStateMutationControlDebugRow,
  PortfolioPopulateWalletDebugTrace,
} from '../../core/engine/populateDebug';
import type {SnapshotPersistInputV2} from '../../core/pnl/snapshotStore';
import {
  isSnapshotInvalidHistoryError,
  toSnapshotInvalidHistoryMarker,
} from '../../core/pnl/invalidHistory';
import {
  dedupeTxHistoryPage,
  getTxHistoryEntryId,
  getTxHistoryLogicalPageSize,
} from '../../core/txHistoryPaging';
import type {BwsConfig} from '../../core/shared/bws';
import {DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY} from '../../adapters/rn/mmkvKvStore';
import type {WorkletMmkvStorageBridge} from '../../adapters/rn/mmkvKvStore';
import {fetchPortfolioTxHistoryPageByRequest} from '../../adapters/rn/txHistoryRequest';
import {
  appendWorkletSnapshotChunk,
  buildOrderedWorkletSnapshotDebugRows,
  clearWorkletInvalidHistoryMarker,
  clearWorkletWalletSnapshots,
  buildWorkletWalletMetaForStore,
  ensureWorkletWalletIndex,
  saveWorkletInvalidHistoryMarker,
  updateWorkletSnapshotCheckpoint,
} from './portfolioWorkletSnapshots';
import {
  createPortfolioSnapshotBuilderState,
  getPortfolioSnapshotBuilderCheckpoint,
  portfolioSnapshotBuilderFinish,
  portfolioSnapshotBuilderFlushPendingCarryoverGroup,
  portfolioSnapshotBuilderHasPendingCarryoverGroup,
  portfolioSnapshotBuilderIngestPageWithSnapshotLimit,
  type SnapshotStreamCheckpoint,
  type PortfolioSnapshotBuilderState,
} from './portfolioWorkletSnapshotBuilder';
import {ensureWorkletSnapshotRateSeriesCache} from './portfolioWorkletRates';
import type {PortfolioWorkletKvConfig} from './portfolioWorkletKv';

export type PortfolioPopulateWorkletConfig = {
  storage: WorkletMmkvStorageBridge;
  storageId?: string;
  registryKey?: string;
};

export type PortfolioPopulateWorkletSession = {
  createdAtMs: number;
  wallet: WalletSummary;
  credentials: WalletCredentials;
  builder: PortfolioSnapshotBuilderState;
  meta: ReturnType<typeof buildWorkletWalletMetaForStore>;
  debugTrace?: PortfolioPopulateWalletDebugTrace;
  debugFetchedPageCount: number;
  debugProcessSeq: number;
  fetch: {
    cfg: BwsConfig;
    pageSize: number;
    emitRows: number | null;
    pendingTxs: Tx[];
  };
};

export type PortfolioPopulateWorkletState = {
  sessionsByWalletId: Record<string, PortfolioPopulateWorkletSession | undefined>;
  debugByWalletId: Record<string, PortfolioPopulateWalletDebugTrace | undefined>;
  serialTail?: Promise<void>;
  storageId?: string;
  registryKey?: string;
};

type GlobalWithPortfolioPopulateState = typeof globalThis & {
  __bitpayPortfolioPopulateWorkletStateV1__?: PortfolioPopulateWorkletState;
};

const PORTFOLIO_POPULATE_STATE_GLOBAL_KEY =
  '__bitpayPortfolioPopulateWorkletStateV1__';
const POPULATE_DEBUG_TXID_HEAD_LIMIT = 10;

function parseScientificToTruncatedIntegerString(s: string): string | null {
  'worklet';

  const m = s.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!m) return null;

  const sign = m[1] === '-' ? '-' : '';
  const intPart = m[2];
  const fracPart = m[3] ?? '';
  const exp = Number(m[4]);
  if (!Number.isInteger(exp)) return null;

  const digits = intPart + fracPart;
  const decimalPos = intPart.length + exp;
  if (decimalPos <= 0) return '0';

  const rawInt =
    decimalPos >= digits.length
      ? digits + '0'.repeat(decimalPos - digits.length)
      : digits.slice(0, decimalPos);

  const normalized = rawInt.replace(/^0+(?=\d)/, '');
  if (!normalized || /^0+$/.test(normalized)) return '0';
  return sign ? `${sign}${normalized}` : normalized;
}

function parseAtomicToBigint(v: number | string | bigint): bigint {
  'worklet';

  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    if (Number.isSafeInteger(v)) return BigInt(v);

    const s = String(v);
    if (/[eE]/.test(s)) {
      const expanded = parseScientificToTruncatedIntegerString(s);
      if (expanded) return BigInt(expanded);
    }

    const m = s.match(/^(-?\d+)(?:\.\d+)?$/);
    if (m) return BigInt(m[1]);

    return BigInt(Math.trunc(v));
  }

  const s = String(v).trim();
  if (!s) return 0n;
  if (/[eE]/.test(s)) {
    const expanded = parseScientificToTruncatedIntegerString(s);
    if (expanded) return BigInt(expanded);
    const n = Number(s);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.trunc(n));
  }

  const m = s.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('Invalid atomic string');
  return BigInt(m[1]);
}

export function getOrCreatePortfolioPopulateWorkletState(
  config: PortfolioPopulateWorkletConfig,
): PortfolioPopulateWorkletState {
  'worklet';

  const globalWithState = globalThis as GlobalWithPortfolioPopulateState;
  const normalizedRegistryKey =
    config.registryKey || DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY;
  const existing = globalWithState[PORTFOLIO_POPULATE_STATE_GLOBAL_KEY];

  if (existing) {
    const sameStorageId = existing.storageId === config.storageId;
    const sameRegistryKey = existing.registryKey === normalizedRegistryKey;
    if (!sameStorageId || !sameRegistryKey) {
      throw new Error(
        'Portfolio populate worklet is already initialized with a different MMKV configuration.',
      );
    }
    return existing;
  }

  const created: PortfolioPopulateWorkletState = {
    sessionsByWalletId: {},
    debugByWalletId: {},
    storageId: config.storageId,
    registryKey: normalizedRegistryKey,
  };

  globalWithState[PORTFOLIO_POPULATE_STATE_GLOBAL_KEY] = created;
  return created;
}

function getKvConfig(
  config: PortfolioPopulateWorkletConfig,
): PortfolioWorkletKvConfig {
  'worklet';

  return {
    storage: config.storage,
    registryKey: config.registryKey,
  };
}

export function runSerialOnPopulateWorklet<T>(
  state: PortfolioPopulateWorkletState,
  task: () => Promise<T>,
): Promise<T> {
  'worklet';

  const tail = state.serialTail || Promise.resolve();
  const next = tail.then(task, task);
  state.serialTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isFinitePositiveInteger(value: unknown): boolean {
  'worklet';
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeEmitRows(value: unknown): number | null {
  'worklet';

  if (!isFinitePositiveInteger(value)) {
    return null;
  }
  return Math.trunc(Number(value));
}

const bigIntAbs = (value: bigint): bigint => {
  'worklet';
  return value < 0n ? -value : value;
};

const parseNumberishToBigint = (value: unknown): bigint => {
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

const getTxAction = (tx: Tx): 'received' | 'sent' | 'moved' | 'unknown' => {
  'worklet';

  const actionRaw = String((tx as any)?.action || (tx as any)?.type || '')
    .toLowerCase();
  if (actionRaw === 'received' || actionRaw === 'receive') return 'received';
  if (actionRaw === 'sent' || actionRaw === 'send') return 'sent';
  if (actionRaw === 'moved' || actionRaw === 'move') return 'moved';
  return 'unknown';
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

const computeTxBalanceDeltaAtomic = (
  tx: Tx,
  wallet: Pick<WalletSummary, 'tokenAddress'>,
): {
  action: 'received' | 'sent' | 'moved' | 'unknown';
  amountAtomic: bigint;
  feeAtomic: bigint;
  deltaAtomic: bigint;
} => {
  'worklet';

  const action = getTxAction(tx);
  const rawAmountAtomic = parseAtomicToBigint((tx as any)?.amount ?? 0);
  const amountAtomic = bigIntAbs(rawAmountAtomic);
  const feeAtomic = !wallet.tokenAddress ? computeTxNetworkFeeAtomic(tx) : 0n;

  if (isTxFailed(tx) && action === 'sent') {
    return {action, amountAtomic, feeAtomic, deltaAtomic: -feeAtomic};
  }

  if (action === 'received') {
    return {action, amountAtomic, feeAtomic, deltaAtomic: amountAtomic};
  }

  if (action === 'sent') {
    return {
      action,
      amountAtomic,
      feeAtomic,
      deltaAtomic: -(amountAtomic + feeAtomic),
    };
  }

  if (action === 'moved') {
    return {action, amountAtomic, feeAtomic, deltaAtomic: -feeAtomic};
  }

  if (rawAmountAtomic > 0n) {
    return {action, amountAtomic, feeAtomic, deltaAtomic: amountAtomic};
  }

  if (rawAmountAtomic < 0n) {
    return {
      action,
      amountAtomic,
      feeAtomic,
      deltaAtomic: -(amountAtomic + feeAtomic),
    };
  }

  if (feeAtomic > 0n) {
    return {action, amountAtomic, feeAtomic, deltaAtomic: -feeAtomic};
  }

  return {action, amountAtomic, feeAtomic, deltaAtomic: 0n};
};

const shouldCapturePopulateWalletDebugTrace = (
  snapshotDebugMode?: string,
): boolean => {
  'worklet';
  return snapshotDebugMode === 'link' || snapshotDebugMode === 'full';
};

function cloneFetchedTxDebugRow(
  row: PortfolioPopulateFetchedTxDebugRow,
): PortfolioPopulateFetchedTxDebugRow {
  'worklet';

  return {...row};
}

function cloneStringArray(values?: string[]): string[] | undefined {
  'worklet';

  return Array.isArray(values) ? values.slice() : undefined;
}

function cloneSessionStateBeforePrepareDebugRow(
  row: PortfolioPopulateSessionStateBeforePrepareDebugRow,
): PortfolioPopulateSessionStateBeforePrepareDebugRow {
  'worklet';

  return {
    ...row,
    existingSessionCarryoverTxIds: cloneStringArray(
      row.existingSessionCarryoverTxIds,
    ),
    existingSessionRecentTxIds: cloneStringArray(
      row.existingSessionRecentTxIds,
    ),
    existingSessionPendingTxIds: cloneStringArray(
      row.existingSessionPendingTxIds,
    ),
  };
}

function cloneBuilderSeedDebugRow(
  row: PortfolioPopulateBuilderSeedDebugRow,
): PortfolioPopulateBuilderSeedDebugRow {
  'worklet';

  return {
    ...row,
    persistedCheckpointCarryoverTxIds: cloneStringArray(
      row.persistedCheckpointCarryoverTxIds,
    ),
    persistedCheckpointRecentTxIds: cloneStringArray(
      row.persistedCheckpointRecentTxIds,
    ),
    builderCarryoverTxIdsAfterCreate: cloneStringArray(
      row.builderCarryoverTxIdsAfterCreate,
    ),
    builderRecentTxIdsAfterCreate: cloneStringArray(
      row.builderRecentTxIdsAfterCreate,
    ),
  };
}

function cloneIngestSeedDebugRow(
  row: PortfolioPopulateIngestSeedDebugRow,
): PortfolioPopulateIngestSeedDebugRow {
  'worklet';

  return {
    ...row,
    builderCarryoverTxIdsBeforeIngest: cloneStringArray(
      row.builderCarryoverTxIdsBeforeIngest,
    ),
    builderRecentTxIdsBeforeIngest: cloneStringArray(
      row.builderRecentTxIdsBeforeIngest,
    ),
    pendingTxIdsBeforeIngest: cloneStringArray(row.pendingTxIdsBeforeIngest),
    fetchedTxHead: cloneStringArray(row.fetchedTxHead),
    dedupedPendingTxHead: cloneStringArray(row.dedupedPendingTxHead),
  };
}

function cloneGroupAssemblyDebugRow(
  row: PortfolioPopulateGroupAssemblyDebugRow,
): PortfolioPopulateGroupAssemblyDebugRow {
  'worklet';

  return {
    ...row,
    carryoverSeedTxIds: cloneStringArray(row.carryoverSeedTxIds),
    pageTxIdsAdded: cloneStringArray(row.pageTxIdsAdded),
    inputTxIdsBeforeReorder: cloneStringArray(row.inputTxIdsBeforeReorder),
    reorderedTxIds: cloneStringArray(row.reorderedTxIds),
  };
}

function cloneNormalizedFilteredPageKeyDebugRow(
  row: PortfolioPopulateNormalizedFilteredPageKeyDebugRow,
): PortfolioPopulateNormalizedFilteredPageKeyDebugRow {
  'worklet';

  return {...row};
}

function cloneIngestLoopMutationDebugRow(
  row: PortfolioPopulateIngestLoopMutationDebugRow,
): PortfolioPopulateIngestLoopMutationDebugRow {
  'worklet';

  return {
    ...row,
    groupTxIdsBefore: cloneStringArray(row.groupTxIdsBefore),
    groupTxIdsAfter: cloneStringArray(row.groupTxIdsAfter),
    pageTxIdsAddedBefore: cloneStringArray(row.pageTxIdsAddedBefore),
    pageTxIdsAddedAfter: cloneStringArray(row.pageTxIdsAddedAfter),
    carryoverSeedTxIdsBefore: cloneStringArray(row.carryoverSeedTxIdsBefore),
    carryoverSeedTxIdsAfter: cloneStringArray(row.carryoverSeedTxIdsAfter),
  };
}

function cloneFlushCurrentGroupDebugRow(
  row: PortfolioPopulateFlushCurrentGroupDebugRow,
): PortfolioPopulateFlushCurrentGroupDebugRow {
  'worklet';

  return {
    ...row,
    groupTxIdsBeforeReset: cloneStringArray(row.groupTxIdsBeforeReset),
    pageTxIdsAddedBeforeReset: cloneStringArray(
      row.pageTxIdsAddedBeforeReset,
    ),
    carryoverSeedTxIdsBeforeReset: cloneStringArray(
      row.carryoverSeedTxIdsBeforeReset,
    ),
    groupTxIdsAfterReset: cloneStringArray(row.groupTxIdsAfterReset),
    pageTxIdsAddedAfterReset: cloneStringArray(row.pageTxIdsAddedAfterReset),
    carryoverSeedTxIdsAfterReset: cloneStringArray(
      row.carryoverSeedTxIdsAfterReset,
    ),
  };
}

function cloneFlushDirectResetWitnessDebugRow(
  row: PortfolioPopulateFlushDirectResetWitnessDebugRow,
): PortfolioPopulateFlushDirectResetWitnessDebugRow {
  'worklet';

  return {
    ...row,
    pageTxIdsAddedHeadDirect: cloneStringArray(row.pageTxIdsAddedHeadDirect),
    carryoverSeedHeadDirect: cloneStringArray(row.carryoverSeedHeadDirect),
  };
}

function cloneFlushReturnWitnessDebugRow(
  row: PortfolioPopulateFlushReturnWitnessDebugRow,
): PortfolioPopulateFlushReturnWitnessDebugRow {
  'worklet';

  return {
    ...row,
    pageTxIdsAddedHeadDirect: cloneStringArray(row.pageTxIdsAddedHeadDirect),
    carryoverSeedHeadDirect: cloneStringArray(row.carryoverSeedHeadDirect),
  };
}

function cloneLocalMutationCanaryDebugRow(
  row: PortfolioPopulateLocalMutationCanaryDebugRow,
): PortfolioPopulateLocalMutationCanaryDebugRow {
  'worklet';

  return {
    ...row,
    localArrayCanaryHead: cloneStringArray(row.localArrayCanaryHead),
  };
}

function cloneStateMutationControlDebugRow(
  row: PortfolioPopulateStateMutationControlDebugRow,
): PortfolioPopulateStateMutationControlDebugRow {
  'worklet';

  return {...row};
}

function cloneDirectVsHelperParityDebugRow(
  row: PortfolioPopulateDirectVsHelperParityDebugRow,
): PortfolioPopulateDirectVsHelperParityDebugRow {
  'worklet';

  return {
    ...row,
    pageHeadDirect: cloneStringArray(row.pageHeadDirect),
    pageHeadViaSnapshot: cloneStringArray(row.pageHeadViaSnapshot),
    carryoverSeedHeadDirect: cloneStringArray(row.carryoverSeedHeadDirect),
    carryoverSeedHeadViaSnapshot: cloneStringArray(
      row.carryoverSeedHeadViaSnapshot,
    ),
  };
}

function cloneCarryoverDecisionDebugRow(
  row: PortfolioPopulateCarryoverDecisionDebugRow,
): PortfolioPopulateCarryoverDecisionDebugRow {
  'worklet';

  return {
    ...row,
    groupTxIdsBeforeAssign: cloneStringArray(row.groupTxIdsBeforeAssign),
    pageTxIdsAdded: cloneStringArray(row.pageTxIdsAdded),
    carryoverSeedTxIds: cloneStringArray(row.carryoverSeedTxIds),
    stateCarryoverTxIdsBeforeAssign: cloneStringArray(
      row.stateCarryoverTxIdsBeforeAssign,
    ),
    stateCarryoverTxIdsAfterAssign: cloneStringArray(
      row.stateCarryoverTxIdsAfterAssign,
    ),
    recentTxIdsAfterAssign: cloneStringArray(row.recentTxIdsAfterAssign),
  };
}

function cloneRequestLifecycleDebugRow(
  row: PortfolioPopulateRequestLifecycleDebugRow,
): PortfolioPopulateRequestLifecycleDebugRow {
  'worklet';

  return {...row};
}

function clonePopulateWalletDebugTrace(
  trace: PortfolioPopulateWalletDebugTrace,
): PortfolioPopulateWalletDebugTrace {
  'worklet';

  return {
    walletId: String(trace.walletId || ''),
    snapshotDebugMode: trace.snapshotDebugMode,
    capturedAtMs: Number(trace.capturedAtMs || 0),
    sessionStateBeforePrepareRows: (
      trace.sessionStateBeforePrepareRows || []
    ).map(cloneSessionStateBeforePrepareDebugRow),
    builderSeedRows: (trace.builderSeedRows || []).map(cloneBuilderSeedDebugRow),
    ingestSeedRows: (trace.ingestSeedRows || []).map(cloneIngestSeedDebugRow),
    normalizedFilteredPageKeyRows: (
      trace.normalizedFilteredPageKeyRows || []
    ).map(cloneNormalizedFilteredPageKeyDebugRow),
    ingestLoopMutationRows: (trace.ingestLoopMutationRows || []).map(
      cloneIngestLoopMutationDebugRow,
    ),
    flushCurrentGroupRows: (trace.flushCurrentGroupRows || []).map(
      cloneFlushCurrentGroupDebugRow,
    ),
    flushDirectResetWitnessRows: (
      trace.flushDirectResetWitnessRows || []
    ).map(cloneFlushDirectResetWitnessDebugRow),
    flushReturnWitnessRows: (trace.flushReturnWitnessRows || []).map(
      cloneFlushReturnWitnessDebugRow,
    ),
    localMutationCanaryRows: (trace.localMutationCanaryRows || []).map(
      cloneLocalMutationCanaryDebugRow,
    ),
    stateMutationControlRows: (trace.stateMutationControlRows || []).map(
      cloneStateMutationControlDebugRow,
    ),
    directVsHelperParityRows: (trace.directVsHelperParityRows || []).map(
      cloneDirectVsHelperParityDebugRow,
    ),
    carryoverDecisionRows: (trace.carryoverDecisionRows || []).map(
      cloneCarryoverDecisionDebugRow,
    ),
    groupAssemblyRows: (trace.groupAssemblyRows || []).map(
      cloneGroupAssemblyDebugRow,
    ),
    requestLifecycleRows: (trace.requestLifecycleRows || []).map(
      cloneRequestLifecycleDebugRow,
    ),
    fetchedTxRows: trace.fetchedTxRows.map(cloneFetchedTxDebugRow),
    processedTxRows: trace.processedTxRows.map(row => ({...row})),
    emittedSnapshotRows: trace.emittedSnapshotRows.map(row => ({
      ...row,
      txIds: Array.isArray(row.txIds) ? row.txIds.slice() : undefined,
    })),
  };
}

function createPopulateWalletDebugTrace(args: {
  walletId: string;
  snapshotDebugMode: 'none' | 'link' | 'full';
}): PortfolioPopulateWalletDebugTrace {
  'worklet';

  return {
    walletId: args.walletId,
    snapshotDebugMode: args.snapshotDebugMode,
    capturedAtMs: Date.now(),
    sessionStateBeforePrepareRows: [],
    builderSeedRows: [],
    ingestSeedRows: [],
    normalizedFilteredPageKeyRows: [],
    ingestLoopMutationRows: [],
    flushCurrentGroupRows: [],
    flushDirectResetWitnessRows: [],
    flushReturnWitnessRows: [],
    localMutationCanaryRows: [],
    stateMutationControlRows: [],
    directVsHelperParityRows: [],
    carryoverDecisionRows: [],
    groupAssemblyRows: [],
    requestLifecycleRows: [],
    fetchedTxRows: [],
    processedTxRows: [],
    emittedSnapshotRows: [],
  };
}

function extractTxIdsFromRawTxs(txs: Tx[]): string[] {
  'worklet';

  const out: string[] = [];
  for (const tx of txs) {
    const txid = getTxHistoryEntryId(tx);
    if (txid) {
      out.push(txid);
    }
  }
  return out;
}

function extractTxIdsHead(txIds: string[], limit = POPULATE_DEBUG_TXID_HEAD_LIMIT): string[] {
  'worklet';

  if (!txIds.length) {
    return [];
  }
  return txIds.slice(0, Math.max(1, Math.trunc(Number(limit) || 1)));
}

function extractBuilderCarryoverTxIds(
  builder: PortfolioSnapshotBuilderState,
): string[] {
  'worklet';

  return builder.carryoverGroup.map(tx => tx.id).filter(Boolean);
}

function captureRequestLifecycleRow(
  trace: PortfolioPopulateWalletDebugTrace | undefined,
  row: PortfolioPopulateRequestLifecycleDebugRow,
): void {
  'worklet';

  if (!trace) {
    return;
  }

  trace.requestLifecycleRows.push({...row});
  trace.capturedAtMs = Date.now();
}

export function clearPopulateWalletDebugTraceOnWorklet(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): void {
  'worklet';

  delete state.debugByWalletId[walletId];
}

export function clearAllPopulateWalletDebugTracesOnWorklet(
  state: PortfolioPopulateWorkletState,
): void {
  'worklet';

  state.debugByWalletId = {};
}

export function getPopulateWalletDebugTraceOnWorklet(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): PortfolioPopulateWalletDebugTrace | null {
  'worklet';

  const trace = state.debugByWalletId[walletId];
  return trace ? clonePopulateWalletDebugTrace(trace) : null;
}

function captureFetchedTxRows(
  session: PortfolioPopulateWorkletSession,
  txs: Tx[],
  skip: number,
): void {
  'worklet';

  if (!session.debugTrace || !txs.length) {
    return;
  }

  session.debugFetchedPageCount += 1;
  const pageNumber = session.debugFetchedPageCount;
  const seqBase = session.debugTrace.fetchedTxRows.length;

  for (let index = 0; index < txs.length; index += 1) {
    const tx = txs[index];
    const {action, amountAtomic, feeAtomic, deltaAtomic} =
      computeTxBalanceDeltaAtomic(tx, session.wallet);
    session.debugTrace.fetchedTxRows.push({
      seq: seqBase + index + 1,
      pageNumber,
      skip,
      rawIndex: index,
      txid: getTxHistoryEntryId(tx),
      timestamp: toTxTimestampMs(tx),
      action,
      amountAtomic: amountAtomic.toString(),
      feeAtomic: feeAtomic.toString(),
      deltaAtomic: deltaAtomic.toString(),
      blockHeight: getTxBlockHeight(tx),
    });
  }

  session.debugTrace.capturedAtMs = Date.now();
}

function captureEmittedSnapshotRows(
  session: PortfolioPopulateWorkletSession,
  snapshots: SnapshotPersistInputV2[],
): void {
  'worklet';

  if (!session.debugTrace || !snapshots.length) {
    return;
  }

  const rows = buildOrderedWorkletSnapshotDebugRows({
    snapshots,
    startingRowIndex: session.debugTrace.emittedSnapshotRows.length + 1,
  });
  session.debugTrace.emittedSnapshotRows.push(...rows);
  session.debugTrace.capturedAtMs = Date.now();
}

function captureSessionStateBeforePrepare(
  trace: PortfolioPopulateWalletDebugTrace | undefined,
  args: {
    walletId: string;
    existingSession?: PortfolioPopulateWorkletSession;
  },
): void {
  'worklet';

  if (!trace) {
    return;
  }

  const existingSession = args.existingSession;
  trace.sessionStateBeforePrepareRows.push({
    walletId: args.walletId,
    existingSessionBefore: !!existingSession,
    existingSessionCreatedAtMs: existingSession?.createdAtMs ?? null,
    existingSessionCarryoverTxIds: existingSession
      ? extractBuilderCarryoverTxIds(existingSession.builder)
      : undefined,
    existingSessionRecentTxIds: existingSession?.builder.recentTxIds.slice(),
    existingSessionPendingTxIds: existingSession
      ? extractTxIdsFromRawTxs(existingSession.fetch.pendingTxs)
      : undefined,
  });
  trace.capturedAtMs = Date.now();
}

function captureBuilderSeed(
  trace: PortfolioPopulateWalletDebugTrace | undefined,
  args: {
    walletId: string;
    persistedCheckpoint: SnapshotStreamCheckpoint | null | undefined;
    builder: PortfolioSnapshotBuilderState;
  },
): void {
  'worklet';

  if (!trace) {
    return;
  }

  const builderCheckpoint = getPortfolioSnapshotBuilderCheckpoint(args.builder);
  const persistedCarryoverGroup = Array.isArray(
    args.persistedCheckpoint?.carryoverGroup,
  )
    ? args.persistedCheckpoint?.carryoverGroup
    : undefined;
  const persistedRecentTxIds = Array.isArray(args.persistedCheckpoint?.recentTxIds)
    ? args.persistedCheckpoint?.recentTxIds
    : undefined;
  const builderCarryoverGroup = Array.isArray(builderCheckpoint.carryoverGroup)
    ? builderCheckpoint.carryoverGroup
    : undefined;
  const builderRecentTxIds = Array.isArray(builderCheckpoint.recentTxIds)
    ? builderCheckpoint.recentTxIds
    : undefined;
  const persistedCheckpointCarryoverTxIds = Array.isArray(
    args.persistedCheckpoint?.carryoverGroup,
  )
    ? persistedCarryoverGroup?.map(entry => String(entry?.id || '')).filter(Boolean)
    : undefined;
  const persistedCheckpointRecentTxIds = Array.isArray(
    args.persistedCheckpoint?.recentTxIds,
  )
    ? persistedRecentTxIds?.map(id => String(id || '')).filter(Boolean)
    : undefined;
  const builderCarryoverTxIdsAfterCreate = Array.isArray(
    builderCheckpoint.carryoverGroup,
  )
    ? builderCarryoverGroup?.map(entry => String(entry?.id || '')).filter(Boolean)
    : undefined;
  const builderRecentTxIdsAfterCreate = Array.isArray(
    builderCheckpoint.recentTxIds,
  )
    ? builderRecentTxIds?.map(id => String(id || '')).filter(Boolean)
    : undefined;
  trace.builderSeedRows.push({
    walletId: args.walletId,
    persistedCheckpointNextSkip: Number(
      args.persistedCheckpoint?.nextSkip ?? 0,
    ),
    persistedCheckpointCarryoverTxIds,
    persistedCheckpointRecentTxIds,
    builderNextSkipAfterCreate: Number(builderCheckpoint.nextSkip ?? 0),
    builderCarryoverTxIdsAfterCreate,
    builderRecentTxIdsAfterCreate,
  });
  trace.capturedAtMs = Date.now();
}

function captureIngestSeed(
  trace: PortfolioPopulateWalletDebugTrace | undefined,
  row: PortfolioPopulateIngestSeedDebugRow,
): void {
  'worklet';

  if (!trace) {
    return;
  }

  trace.ingestSeedRows.push({
    ...row,
    builderCarryoverTxIdsBeforeIngest: cloneStringArray(
      row.builderCarryoverTxIdsBeforeIngest,
    ),
    builderRecentTxIdsBeforeIngest: cloneStringArray(
      row.builderRecentTxIdsBeforeIngest,
    ),
    pendingTxIdsBeforeIngest: cloneStringArray(row.pendingTxIdsBeforeIngest),
    fetchedTxHead: cloneStringArray(row.fetchedTxHead),
    dedupedPendingTxHead: cloneStringArray(row.dedupedPendingTxHead),
  });
  trace.capturedAtMs = Date.now();
}

function requireSession(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): PortfolioPopulateWorkletSession {
  'worklet';

  const session = state.sessionsByWalletId[walletId];
  if (!session) {
    throw new Error(`Wallet session not prepared for background fetch: ${walletId}`);
  }
  return session;
}

export async function handlePrepareWalletOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  params: {
    cfg: BwsConfig;
    wallet: WalletSummary;
    credentials: WalletCredentials;
    ingest: SnapshotIngestConfig;
    pageSize: number;
    emitRows?: number;
  },
): Promise<PrepareWalletSessionResult> {
  'worklet';

  const meta = buildWorkletWalletMetaForStore({
    wallet: params.wallet,
    credentials: params.credentials as any,
    quoteCurrency: params.ingest.quoteCurrency,
    compressionEnabled: params.ingest.compressionEnabled,
    compressionAgeDays: params.ingest.compressionAgeDays,
    chunkRows: params.ingest.chunkRows,
    snapshotDebugMode: params.ingest.snapshotDebugMode ?? 'none',
  });

  const kvConfig = getKvConfig(config);
  const index = await ensureWorkletWalletIndex(kvConfig, meta);
  const fiatRateSeriesCache = await ensureWorkletSnapshotRateSeriesCache({
    ...kvConfig,
    cfg: params.cfg,
    quoteCurrency: params.ingest.quoteCurrency,
    wallet: params.wallet,
  });

  const shouldCaptureDebug = shouldCapturePopulateWalletDebugTrace(
    meta.snapshotDebugMode,
  );
  const existingSession = state.sessionsByWalletId[params.wallet.walletId];
  const debugTrace = shouldCaptureDebug
    ? createPopulateWalletDebugTrace({
        walletId: params.wallet.walletId,
        snapshotDebugMode: meta.snapshotDebugMode ?? 'none',
      })
    : undefined;
  if (debugTrace) {
    state.debugByWalletId[params.wallet.walletId] = debugTrace;
  } else {
    clearPopulateWalletDebugTraceOnWorklet(state, params.wallet.walletId);
  }

  const prepareStartedAtMs = Date.now();
  captureSessionStateBeforePrepare(debugTrace, {
    walletId: params.wallet.walletId,
    existingSession,
  });

  const builder = createPortfolioSnapshotBuilderState({
    wallet: params.wallet,
    credentials: params.credentials as any,
    quoteCurrency: params.ingest.quoteCurrency,
    fiatRateSeriesCache,
    compressionEnabled: params.ingest.compressionEnabled,
    compressionAgeDays: params.ingest.compressionAgeDays,
    snapshotDebugMode: meta.snapshotDebugMode ?? 'none',
    debugTrace,
    checkpoint: index.checkpoint,
  });
  captureBuilderSeed(debugTrace, {
    walletId: params.wallet.walletId,
    persistedCheckpoint: index.checkpoint,
    builder,
  });

  state.sessionsByWalletId[params.wallet.walletId] = {
    createdAtMs: Date.now(),
    wallet: params.wallet,
    credentials: params.credentials,
    builder,
    meta,
    debugTrace,
    debugFetchedPageCount: 0,
    debugProcessSeq: 0,
    fetch: {
      cfg: params.cfg,
      pageSize: Math.max(1, Math.trunc(Number(params.pageSize || 1))),
      emitRows: normalizeEmitRows(params.emitRows),
      pendingTxs: [],
    },
  };
  captureRequestLifecycleRow(debugTrace, {
    requestId: 'snapshots.prepareWallet:1',
    method: 'snapshots.prepareWallet',
    walletId: params.wallet.walletId,
    startedAtMs: prepareStartedAtMs,
    finishedAtMs: Date.now(),
    skipUsed: Number(index.checkpoint?.nextSkip ?? 0),
    fetchedTxs: null,
    consumedRawCount: null,
    logicalPageSize: null,
    appendedSnapshots: null,
    done: null,
  });

  return {
    checkpoint: getPortfolioSnapshotBuilderCheckpoint(builder),
  };
}

export async function handleCloseWalletSessionOnPopulateWorklet(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<void> {
  'worklet';

  delete state.sessionsByWalletId[walletId];
}

async function handleInvalidHistoryOnPopulateWorklet(args: {
  config: PortfolioPopulateWorkletConfig;
  state: PortfolioPopulateWorkletState;
  walletId: string;
  error: unknown;
}): Promise<void> {
  'worklet';

  if (!isSnapshotInvalidHistoryError(args.error)) {
    return;
  }

  const marker = toSnapshotInvalidHistoryMarker({
    walletId: args.walletId,
    error: args.error,
  });
  const kvConfig = getKvConfig(args.config);
  if (marker) {
    await saveWorkletInvalidHistoryMarker(kvConfig, marker);
  }
  await clearWorkletWalletSnapshots(kvConfig, args.walletId, {
    preserveInvalidHistoryMarker: true,
  });
  delete args.state.sessionsByWalletId[args.walletId];
}

export async function handleProcessNextPageOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<ProcessNextPageSessionResult> {
  'worklet';

  try {
    const session = requireSession(state, walletId);
    session.debugProcessSeq += 1;
    const processSeq = session.debugProcessSeq;
    const debugRequestId = session.debugTrace
      ? `snapshots.processNextPage:${processSeq}`
      : undefined;
    const requestId =
      debugRequestId ?? `snapshots.processNextPage:${processSeq}`;
    const requestStartedAtMs = Date.now();
    const checkpoint = getPortfolioSnapshotBuilderCheckpoint(session.builder);
    const skip = checkpoint.nextSkip;
    const kvConfig = getKvConfig(config);

    while (true) {
      let txs = session.fetch.pendingTxs;
      let fetchedTxs = 0;
      let fetchMs = 0;
      let fetchedTxHead: string[] | undefined;

      if (!txs.length) {
        const fetchStartedAt = Date.now();
        txs = await fetchPortfolioTxHistoryPageByRequest({
          credentials: session.credentials,
          cfg: session.fetch.cfg,
          skip,
          limit: session.fetch.pageSize,
          reverse: true,
        });
        fetchMs = Math.max(0, Date.now() - fetchStartedAt);
        fetchedTxs = txs.length;
        if (debugRequestId) {
          fetchedTxHead = extractTxIdsHead(extractTxIdsFromRawTxs(txs));
        }
        captureFetchedTxRows(session, txs, skip);
        session.fetch.pendingTxs = dedupeTxHistoryPage(txs);

        const logicalPageSize = txs.length
          ? getTxHistoryLogicalPageSize(txs)
          : 0;
        if (!txs.length || logicalPageSize <= 0) {
          session.fetch.pendingTxs = [];
          if (portfolioSnapshotBuilderHasPendingCarryoverGroup(session.builder)) {
            const computeStartedAt = Date.now();
            const snapshots = portfolioSnapshotBuilderFlushPendingCarryoverGroup(
              session.builder,
              debugRequestId,
            );
            const nextCheckpoint = getPortfolioSnapshotBuilderCheckpoint(
              session.builder,
            );
            if (snapshots.length) {
              await appendWorkletSnapshotChunk({
                ...kvConfig,
                meta: session.meta,
                snapshots,
                checkpoint: nextCheckpoint,
              });
              captureEmittedSnapshotRows(session, snapshots);
            } else {
              await updateWorkletSnapshotCheckpoint({
                ...kvConfig,
                walletId,
                checkpoint: nextCheckpoint,
              });
            }
            captureRequestLifecycleRow(session.debugTrace, {
              requestId,
              method: 'snapshots.processNextPage',
              walletId,
              startedAtMs: requestStartedAtMs,
              finishedAtMs: Date.now(),
              skipUsed: skip,
              fetchedTxs,
              consumedRawCount: 0,
              logicalPageSize,
              appendedSnapshots: snapshots.length,
              done: true,
            });
            return {
              checkpoint: nextCheckpoint,
              appendedSnapshots: snapshots.length,
              fetchedTxs,
              logicalPageSize,
              done: true,
              fetchMs,
              computeMs: Math.max(0, Date.now() - computeStartedAt),
            };
          }

          captureRequestLifecycleRow(session.debugTrace, {
            requestId,
            method: 'snapshots.processNextPage',
            walletId,
            startedAtMs: requestStartedAtMs,
            finishedAtMs: Date.now(),
            skipUsed: skip,
            fetchedTxs,
            consumedRawCount: 0,
            logicalPageSize,
            appendedSnapshots: 0,
            done: true,
          });
          return {
            checkpoint: getPortfolioSnapshotBuilderCheckpoint(session.builder),
            appendedSnapshots: 0,
            fetchedTxs,
            logicalPageSize,
            done: true,
            fetchMs,
            computeMs: 0,
          };
        }
      }

      if (debugRequestId) {
        captureIngestSeed(session.debugTrace, {
          requestId: debugRequestId,
          processSeq,
          skip,
          builderCarryoverTxIdsBeforeIngest: extractBuilderCarryoverTxIds(
            session.builder,
          ),
          builderRecentTxIdsBeforeIngest: session.builder.recentTxIds.slice(),
          pendingTxIdsBeforeIngest: extractTxIdsFromRawTxs(
            session.fetch.pendingTxs,
          ),
          fetchedTxHead,
          dedupedPendingTxHead: extractTxIdsHead(
            extractTxIdsFromRawTxs(session.fetch.pendingTxs),
          ),
        });
      }
      const computeStartedAt = Date.now();
      const consumed = portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
        session.builder,
        session.fetch.pendingTxs,
        session.fetch.emitRows ?? undefined,
        debugRequestId,
      );
      const nextCheckpoint = getPortfolioSnapshotBuilderCheckpoint(
        session.builder,
      );

      if (consumed.snapshots.length) {
        await appendWorkletSnapshotChunk({
          ...kvConfig,
          meta: session.meta,
          snapshots: consumed.snapshots,
          checkpoint: nextCheckpoint,
        });
        captureEmittedSnapshotRows(session, consumed.snapshots);
      } else if (consumed.logicalPageSize > 0) {
        await updateWorkletSnapshotCheckpoint({
          ...kvConfig,
          walletId,
          checkpoint: nextCheckpoint,
        });
      }

      const consumedRawCount = Math.max(
        0,
        Math.min(
          session.fetch.pendingTxs.length,
          Number(consumed.consumedRawCount ?? 0),
        ),
      );
      session.fetch.pendingTxs =
        consumedRawCount > 0
          ? session.fetch.pendingTxs.slice(consumedRawCount)
          : [];

      if (!consumed.logicalPageSize && !consumed.snapshots.length) {
        if (!session.fetch.pendingTxs.length) {
          continue;
        }
      }

      captureRequestLifecycleRow(session.debugTrace, {
        requestId,
        method: 'snapshots.processNextPage',
        walletId,
        startedAtMs: requestStartedAtMs,
        finishedAtMs: Date.now(),
        skipUsed: skip,
        fetchedTxs,
        consumedRawCount,
        logicalPageSize: consumed.logicalPageSize,
        appendedSnapshots: consumed.snapshots.length,
        done: false,
      });
      return {
        checkpoint: nextCheckpoint,
        appendedSnapshots: consumed.snapshots.length,
        fetchedTxs,
        logicalPageSize: consumed.logicalPageSize,
        done: false,
        fetchMs,
        computeMs: Math.max(0, Date.now() - computeStartedAt),
      };
    }
  } catch (error: unknown) {
    await handleInvalidHistoryOnPopulateWorklet({
      config,
      state,
      walletId,
      error,
    });
    throw error;
  }
}

export async function handleFinishWalletOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<FinishWalletSessionResult> {
  'worklet';

  try {
    const session = requireSession(state, walletId);
    const requestStartedAtMs = Date.now();
    const debugRequestId = session.debugTrace
      ? 'snapshots.finishWallet:1'
      : undefined;
    const requestId = debugRequestId ?? 'snapshots.finishWallet:1';
    const snapshots = portfolioSnapshotBuilderFinish(
      session.builder,
      debugRequestId,
    );
    const checkpoint = getPortfolioSnapshotBuilderCheckpoint(session.builder);
    const kvConfig = getKvConfig(config);

    if (snapshots.length) {
      await appendWorkletSnapshotChunk({
        ...kvConfig,
        meta: session.meta,
        snapshots,
        checkpoint,
      });
      captureEmittedSnapshotRows(session, snapshots);
    } else {
      await updateWorkletSnapshotCheckpoint({
        ...kvConfig,
        walletId,
        checkpoint,
      });
    }

    await clearWorkletInvalidHistoryMarker(kvConfig, walletId);
    delete state.sessionsByWalletId[walletId];
    captureRequestLifecycleRow(session.debugTrace, {
      requestId,
      method: 'snapshots.finishWallet',
      walletId,
      startedAtMs: requestStartedAtMs,
      finishedAtMs: Date.now(),
      skipUsed: Number(checkpoint.nextSkip ?? 0),
      fetchedTxs: null,
      consumedRawCount: null,
      logicalPageSize: null,
      appendedSnapshots: snapshots.length,
      done: true,
    });

    return {
      checkpoint,
      appendedSnapshots: snapshots.length,
    };
  } catch (error: unknown) {
    await handleInvalidHistoryOnPopulateWorklet({
      config,
      state,
      walletId,
      error,
    });
    throw error;
  }
}

export function canHandlePortfolioPopulateRequestOnRuntime(
  method: WorkerMethod,
): boolean {
  'worklet';

  return (
    method === 'snapshots.prepareWallet' ||
    method === 'snapshots.processNextPage' ||
    method === 'snapshots.finishWallet' ||
    method === 'snapshots.closeWalletSession'
  );
}

export async function handlePortfolioPopulateRequestOnRuntime(
  config: PortfolioPopulateWorkletConfig,
  request: WorkerRequest,
): Promise<WorkerResponse> {
  'worklet';

  const state = getOrCreatePortfolioPopulateWorkletState(config);

  return runSerialOnPopulateWorklet(state, async () => {
    try {
      switch (request.method) {
        case 'snapshots.prepareWallet': {
          const result = await handlePrepareWalletOnPopulateWorklet(
            config,
            state,
            request.params as any,
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        case 'snapshots.closeWalletSession': {
          await handleCloseWalletSessionOnPopulateWorklet(
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result: undefined,
          } as WorkerResponse;
        }

        case 'snapshots.processNextPage': {
          const result = await handleProcessNextPageOnPopulateWorklet(
            config,
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        case 'snapshots.finishWallet': {
          const result = await handleFinishWalletOnPopulateWorklet(
            config,
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        default:
          throw new Error(
            `Unsupported portfolio populate worklet method: ${String(
              request.method,
            )}`,
          );
      }
    } catch (error: unknown) {
      const runtimeError =
        error instanceof Error ? error : new Error(String(error));
      return {
        id: request.id,
        ok: false,
        error: runtimeError.message || String(runtimeError),
        stack: runtimeError.stack,
      } as WorkerResponse;
    }
  });
}
