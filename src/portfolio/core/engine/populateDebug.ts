import type {SnapshotPersistDebugMode} from '../pnl/snapshotStore';
import type {BalanceSnapshotEventType} from '../pnl/types';

export type PortfolioPopulateFetchedTxDebugRow = {
  seq: number;
  pageNumber: number;
  skip: number;
  rawIndex: number;
  txid: string;
  timestamp: number;
  action: 'received' | 'sent' | 'moved' | 'unknown';
  amountAtomic: string;
  feeAtomic: string;
  deltaAtomic: string;
  blockHeight: number | null;
};

export type PortfolioPopulateProcessedTxDebugRow = {
  seq: number;
  txid: string;
  timestamp: number;
  action: 'received' | 'sent' | 'moved' | 'unknown';
  amountAtomic: string;
  feeAtomic: string;
  normalizedDeltaAtomic: string;
  preBalanceAtomic: string;
  postBalanceAtomic: string;
  blockHeight: number | null;
};

export type PortfolioPopulateEmittedSnapshotDebugRow = {
  rowIndex: number;
  eventType: BalanceSnapshotEventType;
  id: string;
  txIds?: string[];
  timestamp: number;
  cryptoBalance: string;
};

export type PortfolioPopulateSessionStateBeforePrepareDebugRow = {
  walletId: string;
  existingSessionBefore: boolean;
  existingSessionCreatedAtMs: number | null;
  existingSessionCarryoverTxIds?: string[];
  existingSessionRecentTxIds?: string[];
  existingSessionPendingTxIds?: string[];
};

export type PortfolioPopulateBuilderSeedDebugRow = {
  walletId: string;
  persistedCheckpointNextSkip: number;
  persistedCheckpointCarryoverTxIds?: string[];
  persistedCheckpointRecentTxIds?: string[];
  builderNextSkipAfterCreate: number;
  builderCarryoverTxIdsAfterCreate?: string[];
  builderRecentTxIdsAfterCreate?: string[];
};

export type PortfolioPopulateIngestSeedDebugRow = {
  requestId: string;
  processSeq: number;
  skip: number;
  builderCarryoverTxIdsBeforeIngest?: string[];
  builderRecentTxIdsBeforeIngest?: string[];
  pendingTxIdsBeforeIngest?: string[];
  fetchedTxHead?: string[];
  dedupedPendingTxHead?: string[];
};

export type PortfolioPopulateNormalizedFilteredPageKeyDebugRow = {
  requestId: string;
  filteredIndex: number;
  originalIndex: number;
  txid: string;
  timestamp: number;
  blockHeight: number | null;
  groupKey: string;
  startsNewGroup: boolean;
};

export type PortfolioPopulateIngestLoopMutationDebugRow = {
  requestId: string;
  stepSeq: number;
  loopIndex: number | null;
  mutation: string;
  txid: string;
  txGroupKey: string;
  groupInstanceSeq: number;
  groupKeyBefore: string;
  groupKeyAfter: string;
  groupTxIdsBefore?: string[];
  groupTxIdsAfter?: string[];
  pageTxIdsAddedBefore?: string[];
  pageTxIdsAddedAfter?: string[];
  carryoverSeedTxIdsBefore?: string[];
  carryoverSeedTxIdsAfter?: string[];
  groupMaxOriginalIndexBefore: number | null;
  groupMaxOriginalIndexAfter: number | null;
  consumedRawCountBefore: number;
  consumedRawCountAfter: number;
  endedAtInputBoundary: boolean;
  note?: string;
};

export type PortfolioPopulateFlushCurrentGroupDebugRow = {
  requestId: string;
  stepSeq: number;
  flushReason: string;
  groupInstanceSeqBeforeReset: number;
  groupInstanceSeqAfterReset: number;
  groupKeyBeforeReset: string;
  groupTxIdsBeforeReset?: string[];
  pageTxIdsAddedBeforeReset?: string[];
  carryoverSeedTxIdsBeforeReset?: string[];
  groupMaxOriginalIndexBeforeReset: number | null;
  consumedRawCountBeforeReset: number;
  groupKeyAfterReset: string;
  groupTxIdsAfterReset?: string[];
  pageTxIdsAddedAfterReset?: string[];
  carryoverSeedTxIdsAfterReset?: string[];
  groupMaxOriginalIndexAfterReset: number | null;
  consumedRawCountAfterReset: number;
};

export type PortfolioPopulateFlushDirectResetWitnessDebugRow = {
  requestId: string;
  flushInvocationSeq: number;
  stepSeq: number;
  flushReason: string;
  stage: string;
  groupInstanceSeqDirect: number;
  groupLenDirect: number;
  groupFirstTxidDirect: string;
  pageTxIdsAddedLenDirect: number;
  pageTxIdsAddedHeadDirect?: string[];
  carryoverSeedLenDirect: number;
  carryoverSeedHeadDirect?: string[];
  groupKeyDirect: string;
  groupKeyIsNullDirect: boolean;
  groupMaxOriginalIndexDirect: number | null;
  consumedRawCountDirect: number;
};

export type PortfolioPopulateFlushReturnWitnessDebugRow = {
  requestId: string;
  flushInvocationSeq: number;
  stepSeq: number;
  flushReason: string;
  stage: string;
  loopIndex: number;
  nextIncomingTxid: string;
  nextIncomingGroupKey: string;
  groupInstanceSeqDirect: number;
  groupLenDirect: number;
  groupFirstTxidDirect: string;
  pageTxIdsAddedLenDirect: number;
  pageTxIdsAddedHeadDirect?: string[];
  carryoverSeedLenDirect: number;
  carryoverSeedHeadDirect?: string[];
  groupKeyDirect: string;
  groupKeyIsNullDirect: boolean;
  groupMaxOriginalIndexDirect: number | null;
  consumedRawCountDirect: number;
};

export type PortfolioPopulateLocalMutationCanaryDebugRow = {
  requestId: string;
  flushInvocationSeq: number;
  stepSeq: number;
  flushReason: string;
  stage: string;
  localScalarCanary: number;
  localArrayCanaryLen: number;
  localArrayCanaryHead?: string[];
  localStringCanary: string;
};

export type PortfolioPopulateStateMutationControlDebugRow = {
  requestId: string;
  flushInvocationSeq: number;
  stepSeq: number;
  flushReason: string;
  stage: string;
  stateControlCounter: number;
  stateControlLastStage: string;
  localScalarCanary: number;
  groupLenDirect: number;
  groupFirstTxidDirect: string;
};

export type PortfolioPopulateDirectVsHelperParityDebugRow = {
  requestId: string;
  flushInvocationSeq: number;
  stepSeq: number;
  flushReason: string;
  stage: string;
  groupLenDirect: number;
  groupLenViaSnapshot: number;
  groupFirstTxidDirect: string;
  groupFirstTxidViaSnapshot: string;
  pageLenDirect: number;
  pageLenViaSnapshot: number;
  pageHeadDirect?: string[];
  pageHeadViaSnapshot?: string[];
  carryoverSeedLenDirect: number;
  carryoverSeedLenViaSnapshot: number;
  carryoverSeedHeadDirect?: string[];
  carryoverSeedHeadViaSnapshot?: string[];
  groupKeyDirect: string;
  groupKeyViaSnapshot: string;
  groupKeyIsNullDirect: boolean;
};

export type PortfolioPopulateCarryoverDecisionDebugRow = {
  requestId: string;
  stepSeq: number;
  groupInstanceSeq: number;
  endedAtInputBoundary: boolean;
  shouldCarryAcrossPageBoundary: boolean;
  groupKey: string;
  groupTxIdsBeforeAssign?: string[];
  pageTxIdsAdded?: string[];
  carryoverSeedTxIds?: string[];
  stateCarryoverTxIdsBeforeAssign?: string[];
  stateCarryoverTxIdsAfterAssign?: string[];
  logicalPageSize: number;
  nextSkipBeforeAssign: number;
  nextSkipAfterAssign: number;
  recentTxIdsAfterAssign?: string[];
};

export type PortfolioPopulateGroupAssemblyDebugRow = {
  requestId: string;
  stepSeq?: number;
  groupIndex: number;
  groupInstanceSeq?: number;
  groupKey: string;
  carryoverSeedTxIds?: string[];
  pageTxIdsAdded?: string[];
  inputTxIdsBeforeReorder?: string[];
  reorderedTxIds?: string[];
  flushReason: string;
};

export type PortfolioPopulateRequestLifecycleDebugRow = {
  requestId: string;
  method: string;
  walletId: string;
  startedAtMs: number;
  finishedAtMs: number;
  skipUsed: number | null;
  fetchedTxs: number | null;
  consumedRawCount: number | null;
  logicalPageSize: number | null;
  appendedSnapshots: number | null;
  done: boolean | null;
};

export type PortfolioPopulateWalletDebugTrace = {
  walletId: string;
  snapshotDebugMode: SnapshotPersistDebugMode;
  capturedAtMs: number;
  sessionStateBeforePrepareRows: PortfolioPopulateSessionStateBeforePrepareDebugRow[];
  builderSeedRows: PortfolioPopulateBuilderSeedDebugRow[];
  ingestSeedRows: PortfolioPopulateIngestSeedDebugRow[];
  normalizedFilteredPageKeyRows: PortfolioPopulateNormalizedFilteredPageKeyDebugRow[];
  ingestLoopMutationRows: PortfolioPopulateIngestLoopMutationDebugRow[];
  flushCurrentGroupRows: PortfolioPopulateFlushCurrentGroupDebugRow[];
  flushDirectResetWitnessRows: PortfolioPopulateFlushDirectResetWitnessDebugRow[];
  flushReturnWitnessRows: PortfolioPopulateFlushReturnWitnessDebugRow[];
  localMutationCanaryRows: PortfolioPopulateLocalMutationCanaryDebugRow[];
  stateMutationControlRows: PortfolioPopulateStateMutationControlDebugRow[];
  directVsHelperParityRows: PortfolioPopulateDirectVsHelperParityDebugRow[];
  carryoverDecisionRows: PortfolioPopulateCarryoverDecisionDebugRow[];
  groupAssemblyRows: PortfolioPopulateGroupAssemblyDebugRow[];
  requestLifecycleRows: PortfolioPopulateRequestLifecycleDebugRow[];
  fetchedTxRows: PortfolioPopulateFetchedTxDebugRow[];
  processedTxRows: PortfolioPopulateProcessedTxDebugRow[];
  emittedSnapshotRows: PortfolioPopulateEmittedSnapshotDebugRow[];
};
