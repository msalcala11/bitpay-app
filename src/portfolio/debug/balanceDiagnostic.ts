import {formatAtomicAmount, parseAtomicToBigint} from '../core/format';
import {isSnapshotInvalidHistoryError} from '../core/pnl/invalidHistory';
import {BalanceSnapshotStreamBuilder} from '../core/pnl/snapshotStream';
import {
  extractTxIdFromSnapshotId,
  makeBalanceSnapshotComputer,
} from '../core/pnl/snapshotHelpers';
import type {SnapshotIndexV2, SnapshotPersistInputV2} from '../core/pnl/snapshotStore';
import type {BalanceSnapshotStored} from '../core/pnl/types';
import type {PortfolioPopulateWalletDebugTrace} from '../core/engine/populateDebug';
import {getTxHistoryEntryId} from '../core/txHistoryPaging';
import type {Tx, WalletCredentials, WalletSummary} from '../core/types';

export type BalanceDiagnosticTxPage = {
  pageNumber: number;
  skip: number;
  txs: Tx[];
};

export type BalanceDiagnosticResult = {
  summaryLine: string;
  reportText: string;
};

export type BalanceDiagnosticPopulateCapture = {
  capturedAtMs: number;
  snapshotDebugMode: 'none' | 'link' | 'full';
  beforeIndex: SnapshotIndexV2 | null;
  afterIndex: SnapshotIndexV2 | null;
  debugTrace?: PortfolioPopulateWalletDebugTrace | null;
};

type HistoryRow = {
  seq: number;
  pageNumber: number;
  skip: number;
  txid: string;
  timestampMs: number;
  timestampUtc: string;
  blockHeight: number | null;
  action: string;
  amountAtomic: string;
  feeAtomic: string;
  deltaAtomic: string;
  runningBalanceAtomic: string;
  flags: string[];
};

type SnapshotTxRow = {
  seq: number;
  snapshotIndex: number;
  txid: string;
  timestampMs: number;
  timestampUtc: string;
  deltaAtomic: string;
  balanceAtomic: string;
};

type SnapshotCoverageRow = {
  seq: number;
  snapshotIndex: number;
  txid: string;
  timestampMs: number;
  timestampUtc: string;
  deltaAtomic: string | null;
  balanceAtomic: string | null;
  eventType: 'tx' | 'daily';
  coverageKey: string;
  coverageTxCount: number;
  balanceComparable: boolean;
};

type MatchedRow = {
  history: HistoryRow;
  matchedSnapshot: SnapshotCoverageRow | null;
  matchedDiffAtomic: string | null;
  flags: string[];
};

type FeeAuditRow = {
  seq: number;
  pageNumber: number;
  txid: string;
  action: string;
  timestampUtc: string;
  amountAtomic: string;
  deltaAtomic: string;
  historyRunningAtomic: string;
  txFeesFieldAtomic: string;
  computedFeeAtomic: string;
  computedMinusTxFeesAtomic: string;
  gasUsedAtomic: string;
  effectiveGasPriceAtomic: string;
  gasPriceAtomic: string;
  gasUsedTimesPriceAtomic: string;
  l1FeeAtomic: string;
  operatorFeeAtomic: string;
  receiptStatus: string;
  feeSource: 'receipt' | 'tx.fees' | 'none';
};

type RecomputedTraceRow = {
  seq: number;
  eventType: string;
  eventRef: string;
  timestampUtc: string;
  preBalanceAtomic: string;
  deltaAtomic: string;
  postBalanceAtomic: string;
  txIds: string[];
  flushTriggeredBy: string;
};

type PopulateFetchedHistoryCompareRow = {
  seq: number;
  diagnosticTxid: string;
  populateTxid: string;
  diagnosticTimestampUtc: string;
  populateTimestampUtc: string;
  diagnosticAction: string;
  populateAction: string;
  diagnosticAmountAtomic: string;
  populateAmountAtomic: string;
  diagnosticFeeAtomic: string;
  populateFeeAtomic: string;
  diagnosticDeltaAtomic: string;
  populateDeltaAtomic: string;
  diagnosticBlockHeight: string;
  populateBlockHeight: string;
  flags: string[];
};

const bigIntAbs = (value: bigint): bigint => (value < 0n ? -value : value);

const csvEscape = (value: unknown): string => {
  const nextValue = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(nextValue)) {
    return `"${nextValue.replace(/"/g, '""')}"`;
  }
  return nextValue;
};

const toCsv = (rows: Array<Array<unknown>>): string =>
  rows.map(row => row.map(csvEscape).join(',')).join('\n');

const formatTimestampUtc = (timestampMs: number | null | undefined): string => {
  if (!Number.isFinite(timestampMs as number)) {
    return '';
  }
  return new Date(timestampMs as number).toISOString();
};

const parseNumberishToBigint = (value: unknown): bigint => {
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
  const raw = Number((tx as any)?.time);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
};

const getTxId = (tx: Tx): string => {
  return getTxHistoryEntryId(tx);
};

const getTxAction = (
  tx: Tx,
): 'received' | 'sent' | 'moved' | 'unknown' => {
  const actionRaw = String((tx as any)?.action || (tx as any)?.type || '')
    .toLowerCase();
  if (actionRaw === 'received' || actionRaw === 'receive') return 'received';
  if (actionRaw === 'sent' || actionRaw === 'send') return 'sent';
  if (actionRaw === 'moved' || actionRaw === 'move') return 'moved';
  return 'unknown';
};

const getTxBlockHeight = (tx: Tx): number | null => {
  const raw = Number(
    (tx as any)?.blockheight ??
      (tx as any)?.blockHeight ??
      (tx as any)?.block_height,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

const isTxFailed = (tx: Tx): boolean => {
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
  const receipt = (tx as any)?.receipt;
  const operatorFee = parseNumberishToBigint(
    receipt?.operatorFee ?? receipt?.opFee ?? (tx as any)?.operatorFee,
  );
  return bigIntAbs(operatorFee);
};

const computeTxNetworkFeeAtomic = (tx: Tx): bigint => {
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

const inspectTxFee = (
  tx: Tx,
  wallet: Pick<WalletSummary, 'tokenAddress'>,
): {
  txFeesFieldAtomic: bigint;
  computedFeeAtomic: bigint;
  computedMinusTxFeesAtomic: bigint;
  gasUsedAtomic: bigint;
  effectiveGasPriceAtomic: bigint;
  gasPriceAtomic: bigint;
  gasUsedTimesPriceAtomic: bigint;
  l1FeeAtomic: bigint;
  operatorFeeAtomic: bigint;
  receiptStatus: string;
  feeSource: 'receipt' | 'tx.fees' | 'none';
} => {
  const receipt = (tx as any)?.receipt;
  const txFeesFieldAtomic = bigIntAbs(
    parseNumberishToBigint((tx as any)?.fees ?? 0),
  );

  if (wallet.tokenAddress) {
    return {
      txFeesFieldAtomic,
      computedFeeAtomic: 0n,
      computedMinusTxFeesAtomic: -txFeesFieldAtomic,
      gasUsedAtomic: 0n,
      effectiveGasPriceAtomic: 0n,
      gasPriceAtomic: 0n,
      gasUsedTimesPriceAtomic: 0n,
      l1FeeAtomic: 0n,
      operatorFeeAtomic: 0n,
      receiptStatus:
        receipt?.status === undefined || receipt?.status === null
          ? ''
          : String(receipt.status),
      feeSource: 'none',
    };
  }

  const gasUsedAtomic = parseNumberishToBigint(receipt?.gasUsed);
  const effectiveGasPriceAtomic = parseNumberishToBigint(
    receipt?.effectiveGasPrice,
  );
  const gasPriceAtomic = parseNumberishToBigint(
    receipt?.gasPrice ?? (tx as any)?.gasPrice,
  );
  const priceAtomic =
    effectiveGasPriceAtomic > 0n ? effectiveGasPriceAtomic : gasPriceAtomic;
  const gasUsedTimesPriceAtomic =
    gasUsedAtomic > 0n && priceAtomic > 0n ? gasUsedAtomic * priceAtomic : 0n;
  const l1FeeAtomic = getTxL1DataFeeAtomic(tx);
  const operatorFeeAtomic = getTxOperatorFeeAtomic(tx);
  const feeSource: 'receipt' | 'tx.fees' =
    gasUsedTimesPriceAtomic > 0n ? 'receipt' : 'tx.fees';
  const computedFeeAtomic =
    feeSource === 'receipt'
      ? gasUsedTimesPriceAtomic + l1FeeAtomic + operatorFeeAtomic
      : txFeesFieldAtomic;

  return {
    txFeesFieldAtomic,
    computedFeeAtomic,
    computedMinusTxFeesAtomic: computedFeeAtomic - txFeesFieldAtomic,
    gasUsedAtomic,
    effectiveGasPriceAtomic,
    gasPriceAtomic,
    gasUsedTimesPriceAtomic,
    l1FeeAtomic,
    operatorFeeAtomic,
    receiptStatus:
      receipt?.status === undefined || receipt?.status === null
        ? ''
        : String(receipt.status),
    feeSource,
  };
};

const computeTxBalanceDeltaAtomic = (
  tx: Tx,
  wallet: Pick<WalletSummary, 'tokenAddress'>,
): {
  action: string;
  amountAtomic: bigint;
  feeAtomic: bigint;
  deltaAtomic: bigint;
} => {
  const action = getTxAction(tx);
  const rawAmountAtomic = parseAtomicToBigint((tx as any)?.amount ?? 0);
  const absAmountAtomic = bigIntAbs(rawAmountAtomic);
  const feeAtomic = !wallet.tokenAddress ? computeTxNetworkFeeAtomic(tx) : 0n;

  if (isTxFailed(tx) && action === 'sent') {
    return {
      action,
      amountAtomic: absAmountAtomic,
      feeAtomic,
      deltaAtomic: -feeAtomic,
    };
  }

  switch (action) {
    case 'received':
      return {
        action,
        amountAtomic: absAmountAtomic,
        feeAtomic,
        deltaAtomic: absAmountAtomic,
      };
    case 'sent':
      return {
        action,
        amountAtomic: absAmountAtomic,
        feeAtomic,
        deltaAtomic: -(absAmountAtomic + feeAtomic),
      };
    case 'moved':
      return {
        action,
        amountAtomic: absAmountAtomic,
        feeAtomic,
        deltaAtomic: -feeAtomic,
      };
    default:
      if (rawAmountAtomic > 0n) {
        return {
          action,
          amountAtomic: absAmountAtomic,
          feeAtomic,
          deltaAtomic: absAmountAtomic,
        };
      }
      if (rawAmountAtomic < 0n) {
        return {
          action,
          amountAtomic: absAmountAtomic,
          feeAtomic,
          deltaAtomic: -(absAmountAtomic + feeAtomic),
        };
      }
      if (feeAtomic > 0n) {
        return {
          action,
          amountAtomic: absAmountAtomic,
          feeAtomic,
          deltaAtomic: -feeAtomic,
        };
      }
      return {
        action,
        amountAtomic: absAmountAtomic,
        feeAtomic,
        deltaAtomic: 0n,
      };
  }
};

const limitRows = <T,>(
  rows: T[],
  maxRows: number,
): {rows: T[]; truncated: number} => {
  if (rows.length <= maxRows) return {rows, truncated: 0};
  return {rows: rows.slice(0, maxRows), truncated: rows.length - maxRows};
};

const addSection = (lines: string[], title: string, body: string) => {
  if (!body.trim()) return;
  lines.push('');
  lines.push(title);
  lines.push(body);
};

const extractDayKeyFromSnapshotId = (snapshotId: string): string | null => {
  const parts = String(snapshotId || '').split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== 'daily') return null;
  const dayKey = parts.slice(2).join(':');
  return dayKey ? dayKey : null;
};

const isLinkedSnapshotId = (snapshotId: string): boolean =>
  /^(tx|daily):/.test(String(snapshotId || '').trim());

const formatCheckpointRecentTxIds = (
  txIds?: string[],
  redactTxid?: (txid: string) => string,
): string =>
  Array.isArray(txIds) && txIds.length
    ? txIds.map(txid => (redactTxid ? redactTxid(txid) : txid)).join('|')
    : '';

const formatTxidList = (
  txIds?: string[],
  redactTxid?: (txid: string) => string,
): string =>
  Array.isArray(txIds) && txIds.length
    ? txIds.map(txid => (redactTxid ? redactTxid(txid) : txid)).join('|')
    : '';

const formatCheckpointCarryoverGroup = (
  carryoverGroup?: Array<{
    id: string;
    tsMs: number;
    blockHeight: number | null;
    txIndex: number | null;
    nonce: number | null;
    action: string;
    absAmountAtomic: string;
    failed: boolean;
    baseFeeAtomic: string;
  }>,
  redactTxid?: (txid: string) => string,
): string => {
  if (!Array.isArray(carryoverGroup) || !carryoverGroup.length) {
    return '';
  }

  return carryoverGroup
    .map(tx =>
      [
        redactTxid ? redactTxid(tx.id) : tx.id,
        tx.action,
        tx.absAmountAtomic,
        tx.baseFeeAtomic,
        tx.tsMs,
        tx.blockHeight ?? '',
        tx.txIndex ?? '',
        tx.nonce ?? '',
        tx.failed ? 'failed' : 'ok',
      ].join('@'),
    )
    .join('|');
};

const buildCheckpointRows = (
  label: string,
  index: SnapshotIndexV2 | null | undefined,
  redactTxid?: (txid: string) => string,
): Array<Array<unknown>> => [
  [
    label,
    index?.checkpoint?.nextSkip ?? '',
    index?.checkpoint?.balanceAtomic ?? '',
    index?.checkpoint?.lastTimestamp ?? '',
    formatTimestampUtc(index?.checkpoint?.lastTimestamp),
    formatCheckpointRecentTxIds(index?.checkpoint?.recentTxIds, redactTxid),
    formatCheckpointCarryoverGroup(
      index?.checkpoint?.carryoverGroup,
      redactTxid,
    ),
    index?.updatedAt ?? '',
    formatTimestampUtc(index?.updatedAt),
    index?.compressionEnabled === undefined
      ? ''
      : index.compressionEnabled
        ? 'yes'
        : 'no',
    index?.chunkRows ?? '',
  ],
];

const buildRecomputedTraceRows = (
  snapshots: SnapshotPersistInputV2[],
): RecomputedTraceRow[] => {
  const out: RecomputedTraceRow[] = [];
  let previousBalanceAtomic = 0n;

  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    const nextSnapshot = i + 1 < snapshots.length ? snapshots[i + 1] : null;
    const eventType = snapshot.eventType === 'daily' ? 'daily' : 'tx';
    const postBalanceAtomic = parseAtomicToBigint(snapshot.cryptoBalance ?? '0');
    const deltaAtomic = postBalanceAtomic - previousBalanceAtomic;
    const txid = extractTxIdFromSnapshotId(snapshot.id ?? '');
    const dayKey = extractDayKeyFromSnapshotId(snapshot.id ?? '');
    let flushTriggeredBy = 'tx';

    if (eventType === 'daily') {
      if (!nextSnapshot) {
        flushTriggeredBy = 'finish';
      } else if (nextSnapshot.eventType === 'daily') {
        flushTriggeredBy = 'day_boundary';
      } else {
        flushTriggeredBy = 'compression_exit';
      }
    }

    out.push({
      seq: i + 1,
      eventType,
      eventRef: eventType === 'daily' ? dayKey || String(snapshot.id || '') : txid || String(snapshot.id || ''),
      timestampUtc: formatTimestampUtc(snapshot.timestamp),
      preBalanceAtomic: previousBalanceAtomic.toString(),
      deltaAtomic: deltaAtomic.toString(),
      postBalanceAtomic: postBalanceAtomic.toString(),
      txIds: Array.isArray(snapshot.txIds) ? snapshot.txIds.slice() : [],
      flushTriggeredBy,
    });

    previousBalanceAtomic = postBalanceAtomic;
  }

  return out;
};

const buildPopulateFetchedHistoryCompareRows = (args: {
  historyRows: HistoryRow[];
  populateDebugTrace?: PortfolioPopulateWalletDebugTrace | null;
  limit: number;
}): PopulateFetchedHistoryCompareRow[] => {
  const out: PopulateFetchedHistoryCompareRow[] = [];
  const populateRows = args.populateDebugTrace?.fetchedTxRows ?? [];
  const maxRows = Math.max(
    0,
    Math.min(
      Number.isFinite(args.limit) ? Math.trunc(args.limit) : 0,
      Math.max(args.historyRows.length, populateRows.length),
    ),
  );

  for (let index = 0; index < maxRows; index += 1) {
    const history = args.historyRows[index];
    const populate = populateRows[index];
    const flags: string[] = [];

    if (!history) {
      flags.push('DIAG_MISSING');
    }
    if (!populate) {
      flags.push('POPULATE_MISSING');
    }
    if (history && populate) {
      if (history.txid !== populate.txid) flags.push('TXID_DIFF');
      if (history.timestampMs !== populate.timestamp) flags.push('TIMESTAMP_DIFF');
      if (history.action !== populate.action) flags.push('ACTION_DIFF');
      if (history.amountAtomic !== populate.amountAtomic) flags.push('AMOUNT_DIFF');
      if (history.feeAtomic !== populate.feeAtomic) flags.push('FEE_DIFF');
      if (history.deltaAtomic !== populate.deltaAtomic) flags.push('DELTA_DIFF');
      if (String(history.blockHeight ?? '') !== String(populate.blockHeight ?? '')) {
        flags.push('BLOCKHEIGHT_DIFF');
      }
    }

    out.push({
      seq: index + 1,
      diagnosticTxid: history?.txid || '',
      populateTxid: populate?.txid || '',
      diagnosticTimestampUtc: history?.timestampUtc || '',
      populateTimestampUtc: formatTimestampUtc(populate?.timestamp),
      diagnosticAction: history?.action || '',
      populateAction: populate?.action || '',
      diagnosticAmountAtomic: history?.amountAtomic || '',
      populateAmountAtomic: populate?.amountAtomic || '',
      diagnosticFeeAtomic: history?.feeAtomic || '',
      populateFeeAtomic: populate?.feeAtomic || '',
      diagnosticDeltaAtomic: history?.deltaAtomic || '',
      populateDeltaAtomic: populate?.deltaAtomic || '',
      diagnosticBlockHeight:
        history?.blockHeight === null || history?.blockHeight === undefined
          ? ''
          : String(history.blockHeight),
      populateBlockHeight:
        populate?.blockHeight === null || populate?.blockHeight === undefined
          ? ''
          : String(populate.blockHeight),
      flags,
    });
  }

  return out;
};

const recomputeSnapshotsFromHistory = (args: {
  wallet: WalletSummary;
  credentials: WalletCredentials;
  txPages: BalanceDiagnosticTxPage[];
  quoteCurrency?: string;
  compressionEnabled: boolean;
  nowMs: number;
}): {
  finalAtomic: string;
  snapshots: SnapshotPersistInputV2[];
  traceRows: RecomputedTraceRow[];
  error?: string;
} => {
  try {
    const builderCredentials = {
      walletId: String(args.credentials?.walletId || args.wallet.walletId || ''),
      chain: String(args.credentials?.chain || args.wallet.chain || ''),
      network: String(args.credentials?.network || args.wallet.network || ''),
      coin: String(
        args.credentials?.coin ||
          args.credentials?.currencyAbbreviation ||
          args.wallet.currencyAbbreviation ||
          '',
      ),
      token: args.credentials?.token,
    };

    const builder = new BalanceSnapshotStreamBuilder({
      wallet: args.wallet,
      credentials: builderCredentials,
      quoteCurrency: args.quoteCurrency || 'USD',
      fiatRateSeriesCache: {},
      nowMs: args.nowMs,
      compressionEnabled: args.compressionEnabled,
      snapshotDebugMode: 'link',
    });

    const snapshots: SnapshotPersistInputV2[] = [];
    for (const page of args.txPages) {
      const result = builder.ingestPageWithSnapshotLimit(page.txs, undefined);
      snapshots.push(...result.snapshots);
    }
    snapshots.push(...builder.finish());

    return {
      finalAtomic: snapshots.length
        ? String(snapshots[snapshots.length - 1].cryptoBalance || '0')
        : '0',
      snapshots,
      traceRows: buildRecomputedTraceRows(snapshots),
    };
  } catch (error: unknown) {
    if (!isSnapshotInvalidHistoryError(error)) {
      throw error;
    }

    return {
      finalAtomic: '',
      snapshots: [],
      traceRows: [],
      error: error.message,
    };
  }
};

const createTxidRedactor = () => {
  const aliases = new Map<string, string>();
  let nextId = 1;

  return (txid: string): string => {
    const key = String(txid || '');
    const existing = aliases.get(key);
    if (existing) return existing;
    const alias = `tx_${String(nextId++).padStart(4, '0')}`;
    aliases.set(key, alias);
    return alias;
  };
};

export function buildWalletBalanceDiagnostic(args: {
  wallet: WalletSummary;
  credentials: WalletCredentials;
  txPages: BalanceDiagnosticTxPage[];
  index?: SnapshotIndexV2 | null;
  populateCapture?: BalanceDiagnosticPopulateCapture;
  snapshots: BalanceSnapshotStored[];
}): BalanceDiagnosticResult {
  const historyRows: HistoryRow[] = [];
  const feeAuditRows: FeeAuditRow[] = [];
  let runningHistoryBalance = 0n;
  let seq = 0;
  const historyCounts = new Map<string, number>();

  const pageSummaryRows: Array<Array<unknown>> = [
    [
      'page',
      'skip',
      'txs',
      'firstTxid',
      'lastTxid',
      'dupWithinPage',
      'dupVsEarlierPages',
      'firstTsUtc',
      'lastTsUtc',
    ],
  ];
  const seenAcrossPages = new Set<string>();

  for (const page of args.txPages) {
    const pageSeen = new Set<string>();
    let dupWithinPage = 0;
    let dupVsEarlierPages = 0;

    for (const tx of page.txs) {
      const txid = getTxId(tx);
      if (pageSeen.has(txid)) dupWithinPage += 1;
      if (seenAcrossPages.has(txid)) dupVsEarlierPages += 1;
      pageSeen.add(txid);
      seenAcrossPages.add(txid);

      const timestampMs = toTxTimestampMs(tx);
      const {action, amountAtomic, feeAtomic, deltaAtomic} =
        computeTxBalanceDeltaAtomic(tx, args.wallet);
      runningHistoryBalance += deltaAtomic;
      seq += 1;
      historyCounts.set(txid, (historyCounts.get(txid) ?? 0) + 1);

      historyRows.push({
        seq,
        pageNumber: page.pageNumber,
        skip: page.skip,
        txid,
        timestampMs,
        timestampUtc: formatTimestampUtc(timestampMs),
        blockHeight: getTxBlockHeight(tx),
        action,
        amountAtomic: amountAtomic.toString(),
        feeAtomic: feeAtomic.toString(),
        deltaAtomic: deltaAtomic.toString(),
        runningBalanceAtomic: runningHistoryBalance.toString(),
        flags: [],
      });

      if (
        !args.wallet.tokenAddress &&
        (action === 'sent' || action === 'moved')
      ) {
        const feeAudit = inspectTxFee(tx, args.wallet);
        feeAuditRows.push({
          seq,
          pageNumber: page.pageNumber,
          txid,
          action,
          timestampUtc: formatTimestampUtc(timestampMs),
          amountAtomic: amountAtomic.toString(),
          deltaAtomic: deltaAtomic.toString(),
          historyRunningAtomic: runningHistoryBalance.toString(),
          txFeesFieldAtomic: feeAudit.txFeesFieldAtomic.toString(),
          computedFeeAtomic: feeAudit.computedFeeAtomic.toString(),
          computedMinusTxFeesAtomic:
            feeAudit.computedMinusTxFeesAtomic.toString(),
          gasUsedAtomic: feeAudit.gasUsedAtomic.toString(),
          effectiveGasPriceAtomic:
            feeAudit.effectiveGasPriceAtomic.toString(),
          gasPriceAtomic: feeAudit.gasPriceAtomic.toString(),
          gasUsedTimesPriceAtomic:
            feeAudit.gasUsedTimesPriceAtomic.toString(),
          l1FeeAtomic: feeAudit.l1FeeAtomic.toString(),
          operatorFeeAtomic: feeAudit.operatorFeeAtomic.toString(),
          receiptStatus: feeAudit.receiptStatus,
          feeSource: feeAudit.feeSource,
        });
      }
    }

    const firstTx = page.txs.length ? page.txs[0] : null;
    const lastTx = page.txs.length ? page.txs[page.txs.length - 1] : null;
    pageSummaryRows.push([
      page.pageNumber,
      page.skip,
      page.txs.length,
      firstTx ? getTxId(firstTx) : '',
      lastTx ? getTxId(lastTx) : '',
      dupWithinPage,
      dupVsEarlierPages,
      firstTx ? formatTimestampUtc(toTxTimestampMs(firstTx)) : '',
      lastTx ? formatTimestampUtc(toTxTimestampMs(lastTx)) : '',
    ]);
  }

  const snapshotTxRows: SnapshotTxRow[] = [];
  const snapshotCoverageRows: SnapshotCoverageRow[] = [];
  const snapshotCounts = new Map<string, number>();
  const snapshotCoverageCounts = new Map<string, number>();
  const computeSnapshot = makeBalanceSnapshotComputer(args.credentials);
  for (let i = 0; i < args.snapshots.length; i++) {
    const snapshot = args.snapshots[i];
    const prevSnapshot = i > 0 ? args.snapshots[i - 1] : null;
    const computed = computeSnapshot(snapshot, prevSnapshot);
    if (snapshot.eventType === 'tx') {
      const txid = extractTxIdFromSnapshotId(snapshot.id) || snapshot.id;
      snapshotCounts.set(txid, (snapshotCounts.get(txid) ?? 0) + 1);
      snapshotCoverageCounts.set(
        txid,
        (snapshotCoverageCounts.get(txid) ?? 0) + 1,
      );
      snapshotTxRows.push({
        seq: snapshotTxRows.length + 1,
        snapshotIndex: i,
        txid,
        timestampMs: snapshot.timestamp,
        timestampUtc: formatTimestampUtc(snapshot.timestamp),
        deltaAtomic: computed.balanceDeltaAtomic,
        balanceAtomic: snapshot.cryptoBalance,
      });
      snapshotCoverageRows.push({
        seq: snapshotCoverageRows.length + 1,
        snapshotIndex: i,
        txid,
        timestampMs: snapshot.timestamp,
        timestampUtc: formatTimestampUtc(snapshot.timestamp),
        deltaAtomic: computed.balanceDeltaAtomic,
        balanceAtomic: snapshot.cryptoBalance,
        eventType: 'tx',
        coverageKey: `${i}:0:${txid}`,
        coverageTxCount: 1,
        balanceComparable: true,
      });
      continue;
    }

    const txIds =
      Array.isArray(snapshot.txIds) && snapshot.txIds.length
        ? snapshot.txIds.map(String).filter(Boolean)
        : [];
    for (let coverageIndex = 0; coverageIndex < txIds.length; coverageIndex++) {
      const txid = txIds[coverageIndex];
      const isSingleTxDaily = txIds.length === 1;
      const isLastTxInDaily = coverageIndex === txIds.length - 1;
      const balanceComparable = isSingleTxDaily || isLastTxInDaily;
      snapshotCoverageCounts.set(
        txid,
        (snapshotCoverageCounts.get(txid) ?? 0) + 1,
      );
      snapshotCoverageRows.push({
        seq: snapshotCoverageRows.length + 1,
        snapshotIndex: i,
        txid,
        timestampMs: snapshot.timestamp,
        timestampUtc: formatTimestampUtc(snapshot.timestamp),
        deltaAtomic: isSingleTxDaily ? computed.balanceDeltaAtomic : null,
        balanceAtomic: balanceComparable ? snapshot.cryptoBalance : null,
        eventType: 'daily',
        coverageKey: `${i}:${coverageIndex}:${txid}`,
        coverageTxCount: txIds.length,
        balanceComparable,
      });
    }
  }

  const dailySnapshotCount = args.snapshots.length - snapshotTxRows.length;

  const snapshotQueues = new Map<string, SnapshotCoverageRow[]>();
  for (const row of snapshotCoverageRows) {
    const queue = snapshotQueues.get(row.txid) ?? [];
    queue.push(row);
    snapshotQueues.set(row.txid, queue);
  }

  const matchedSnapshotCoverageKeys = new Set<string>();
  const matchedRows: MatchedRow[] = historyRows.map(history => {
    const queue = snapshotQueues.get(history.txid);
    const matchedSnapshot = queue && queue.length ? queue.shift() || null : null;
    const flags = [...history.flags];

    if ((historyCounts.get(history.txid) ?? 0) > 1) {
      flags.push('HISTORY_DUP_TXID');
    }
    if ((snapshotCoverageCounts.get(history.txid) ?? 0) > 1) {
      flags.push('SNAP_DUP_TXID');
    }

    if (!matchedSnapshot) {
      flags.push('SNAP_MISSING');
      return {
        history,
        matchedSnapshot: null,
        matchedDiffAtomic: null,
        flags,
      };
    }

    matchedSnapshotCoverageKeys.add(matchedSnapshot.coverageKey);

    if (matchedSnapshot.eventType === 'daily') {
      flags.push('SNAP_DAILY_COVERAGE');
      if (matchedSnapshot.coverageTxCount > 1) {
        flags.push('SNAP_DAILY_COMPRESSED');
      }
    }

    if (matchedSnapshot.seq !== history.seq) {
      flags.push('ORDER_DIFF');
    }

    let diffAtomic: string | null = null;
    if (matchedSnapshot.balanceComparable && matchedSnapshot.balanceAtomic) {
      diffAtomic = (
        parseAtomicToBigint(history.runningBalanceAtomic) -
        parseAtomicToBigint(matchedSnapshot.balanceAtomic)
      ).toString();
      if (diffAtomic !== '0') {
        flags.push('BALANCE_MISMATCH');
      }
    }

    return {
      history,
      matchedSnapshot,
      matchedDiffAtomic: diffAtomic,
      flags,
    };
  });

  const historyFinalAtomic = historyRows.length
    ? historyRows[historyRows.length - 1].runningBalanceAtomic
    : '0';
  const latestSnapshot = args.snapshots.length
    ? args.snapshots[args.snapshots.length - 1]
    : null;
  const snapshotFinalAtomic = latestSnapshot ? latestSnapshot.cryptoBalance : '0';
  const snapshotIdsLinked =
    !!args.snapshots.length && args.snapshots.every(snapshot => isLinkedSnapshotId(snapshot.id));
  const summaryBalanceAtomic = String(args.wallet.balanceAtomic ?? '0');
  const summaryMinusSnapshotAtomicBig =
    parseAtomicToBigint(summaryBalanceAtomic) -
    parseAtomicToBigint(snapshotFinalAtomic);
  const historyMinusSnapshotAtomicBig =
    parseAtomicToBigint(historyFinalAtomic) -
    parseAtomicToBigint(snapshotFinalAtomic);
  const recomputeQuoteCurrency =
    args.snapshots.find(snapshot => typeof snapshot.quoteCurrency === 'string')
      ?.quoteCurrency || 'USD';
  const recomputeNowMs = Date.now();
  const recomputedNoCompression = recomputeSnapshotsFromHistory({
    wallet: args.wallet,
    credentials: args.credentials,
    txPages: args.txPages,
    quoteCurrency: recomputeQuoteCurrency,
    compressionEnabled: false,
    nowMs: recomputeNowMs,
  });
  const recomputedCompression = recomputeSnapshotsFromHistory({
    wallet: args.wallet,
    credentials: args.credentials,
    txPages: args.txPages,
    quoteCurrency: recomputeQuoteCurrency,
    compressionEnabled: args.index?.compressionEnabled !== false,
    nowMs: recomputeNowMs,
  });
  const populateDebugTrace = args.populateCapture?.debugTrace || null;
  const populateProcessedFinalAtomic =
    populateDebugTrace?.processedTxRows.length
      ? populateDebugTrace.processedTxRows[
          populateDebugTrace.processedTxRows.length - 1
        ].postBalanceAtomic
      : '';
  const populateEmittedFinalAtomic =
    populateDebugTrace?.emittedSnapshotRows.length
      ? populateDebugTrace.emittedSnapshotRows[
          populateDebugTrace.emittedSnapshotRows.length - 1
        ].cryptoBalance
      : '';

  const seenForDedup = new Set<string>();
  let dedupedHistoryFinal = 0n;
  for (const row of historyRows) {
    if (seenForDedup.has(row.txid)) continue;
    seenForDedup.add(row.txid);
    dedupedHistoryFinal += parseAtomicToBigint(row.deltaAtomic);
  }

  let firstHistoryNegativeSeq: number | null = null;
  for (const row of historyRows) {
    if (parseAtomicToBigint(row.runningBalanceAtomic) < 0n) {
      firstHistoryNegativeSeq = row.seq;
      break;
    }
  }

  let firstSnapshotNegativeSeq: number | null = null;
  for (const row of snapshotCoverageRows) {
    if (!row.balanceAtomic) continue;
    if (parseAtomicToBigint(row.balanceAtomic) < 0n) {
      firstSnapshotNegativeSeq = row.seq;
      break;
    }
  }

  const commonSeqLength = Math.min(historyRows.length, snapshotCoverageRows.length);
  let firstSequenceMismatchSeq: number | null = null;
  for (let i = 0; i < commonSeqLength; i++) {
    if (historyRows[i].txid !== snapshotCoverageRows[i].txid) {
      firstSequenceMismatchSeq = i + 1;
      break;
    }
  }
  if (
    firstSequenceMismatchSeq === null &&
    historyRows.length !== snapshotCoverageRows.length
  ) {
    firstSequenceMismatchSeq = commonSeqLength + 1;
  }

  let firstBalanceMismatchSeq: number | null = null;
  for (const row of matchedRows) {
    if (row.matchedDiffAtomic && row.matchedDiffAtomic !== '0') {
      firstBalanceMismatchSeq = row.history.seq;
      break;
    }
  }

  const duplicateHistoryRows = Array.from(historyCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([txid, count]) => {
      const occurrences = historyRows.filter(row => row.txid === txid);
      return [
        txid,
        count,
        occurrences.map(row => row.pageNumber).join('|'),
        occurrences.map(row => row.seq).join('|'),
        occurrences[0]?.timestampUtc ?? '',
        occurrences[occurrences.length - 1]?.timestampUtc ?? '',
      ];
    });

  const duplicateSnapshotRows = Array.from(snapshotCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([txid, count]) => {
      const occurrences = snapshotTxRows.filter(row => row.txid === txid);
      return [
        txid,
        count,
        occurrences.map(row => row.snapshotIndex).join('|'),
        occurrences.map(row => row.seq).join('|'),
        occurrences[0]?.timestampUtc ?? '',
        occurrences[occurrences.length - 1]?.timestampUtc ?? '',
      ];
    });

  const historyOnlyRows = matchedRows
    .filter(row => !row.matchedSnapshot)
    .map(row => [
      row.history.seq,
      row.history.pageNumber,
      row.history.txid,
      row.history.timestampUtc,
      row.history.action,
      row.history.runningBalanceAtomic,
    ]);

  const snapshotOnlyRows = snapshotCoverageRows
    .filter(row => !matchedSnapshotCoverageKeys.has(row.coverageKey))
    .map(row => [
      row.snapshotIndex,
      row.seq,
      row.txid,
      row.timestampUtc,
      row.balanceAtomic ?? '',
    ]);

  const focusSeq =
    firstBalanceMismatchSeq ??
    firstSequenceMismatchSeq ??
    firstHistoryNegativeSeq ??
    firstSnapshotNegativeSeq ??
    1;
  const focusStart = Math.max(1, focusSeq - 5);
  const focusEnd = Math.min(
    Math.max(historyRows.length, snapshotCoverageRows.length),
    focusSeq + 5,
  );

  const sequenceWindowRows: Array<Array<unknown>> = [
    [
      'seq',
      'page',
      'historyTxid',
      'snapshotTxidAtSameSeq',
      'historyAction',
      'historyTsUtc',
      'snapshotTsUtc',
      'historyDeltaAtomic',
      'historyRunningAtomic',
      'snapshotIndex',
      'snapshotDeltaAtomic',
      'snapshotBalanceAtomic',
      'sameSeqDiffAtomic',
    ],
  ];

  for (let seqNum = focusStart; seqNum <= focusEnd; seqNum++) {
    const history = seqNum <= historyRows.length ? historyRows[seqNum - 1] : null;
    const snapshot =
      seqNum <= snapshotCoverageRows.length
        ? snapshotCoverageRows[seqNum - 1]
        : null;
    let sameSeqDiffAtomic = '';
    if (history && snapshot && snapshot.balanceAtomic) {
      sameSeqDiffAtomic = (
        parseAtomicToBigint(history.runningBalanceAtomic) -
        parseAtomicToBigint(snapshot.balanceAtomic)
      ).toString();
    }
    sequenceWindowRows.push([
      seqNum,
      history?.pageNumber ?? '',
      history?.txid ?? '',
      snapshot?.txid ?? '',
      history?.action ?? '',
      history?.timestampUtc ?? '',
      snapshot?.timestampUtc ?? '',
      history?.deltaAtomic ?? '',
      history?.runningBalanceAtomic ?? '',
      snapshot?.snapshotIndex ?? '',
      snapshot?.deltaAtomic ?? '',
      snapshot?.balanceAtomic ?? '',
      sameSeqDiffAtomic,
    ]);
  }

  const matchedWindowRows: Array<Array<unknown>> = [
    [
      'seq',
      'page',
      'txid',
      'historyAction',
      'historyTsUtc',
      'historyDeltaAtomic',
      'historyRunningAtomic',
      'matchedSnapshotIndex',
      'matchedSnapshotSeq',
      'matchedSnapshotTsUtc',
      'matchedSnapshotBalanceAtomic',
      'matchedDiffAtomic',
      'flags',
    ],
  ];

  for (
    let seqNum = focusStart;
    seqNum <= Math.min(focusEnd, matchedRows.length);
    seqNum++
  ) {
    const row = matchedRows[seqNum - 1];
    matchedWindowRows.push([
      row.history.seq,
      row.history.pageNumber,
      row.history.txid,
      row.history.action,
      row.history.timestampUtc,
      row.history.deltaAtomic,
      row.history.runningBalanceAtomic,
      row.matchedSnapshot?.snapshotIndex ?? '',
      row.matchedSnapshot?.seq ?? '',
      row.matchedSnapshot?.timestampUtc ?? '',
      row.matchedSnapshot?.balanceAtomic ?? '',
      row.matchedDiffAtomic ?? '',
      row.flags.join('|'),
    ]);
  }

  const clues: string[] = [];
  if (!snapshotIdsLinked) {
    clues.push(
      'Stored snapshot ids are not linked to tx/daily rows. Snapshot tx matching and daily-row counts may be misleading until the wallet is repopulated with snapshotDebugMode=link or full.',
    );
  }
  if (historyFinalAtomic === snapshotFinalAtomic) {
    clues.push(
      'Snapshot final balance matches fetched tx history. Any mismatch is likely ordering or display, not missing arithmetic.',
    );
  }
  if (
    dailySnapshotCount > 0 &&
    historyRows.length > 0 &&
    historyOnlyRows.length === 0 &&
    snapshotOnlyRows.length === 0 &&
    snapshotCoverageRows.length === historyRows.length
  ) {
    clues.push(
      'Linked daily snapshot rows cover the fetched history txids. Tx-row counts can still differ because compression is enabled.',
    );
  }
  if (
    dedupedHistoryFinal.toString() === snapshotFinalAtomic &&
    historyFinalAtomic !== snapshotFinalAtomic
  ) {
    clues.push(
      'Snapshot final balance matches deduped history but not raw fetched history. Duplicate txids across pages are a strong suspect.',
    );
  }
  if (historyRows.length !== snapshotTxRows.length) {
    clues.push(
      `History tx count (${historyRows.length}) and snapshot tx count (${snapshotTxRows.length}) differ.`,
    );
  }
  if (firstSequenceMismatchSeq !== null) {
    clues.push(
      `Snapshot-linked tx order diverges from fetched history at seq ${firstSequenceMismatchSeq}.`,
    );
  }
  if (firstBalanceMismatchSeq !== null) {
    clues.push(
      `Same-txid running balance first differs at seq ${firstBalanceMismatchSeq}.`,
    );
  }
  if (summaryMinusSnapshotAtomicBig !== 0n && feeAuditRows.length) {
    clues.push(
      'Outgoing fee audit is included below for native-asset sent/moved transactions.',
    );
  }
  if (recomputedNoCompression.error) {
    clues.push(
      `Fresh in-memory recompute without compression failed: ${recomputedNoCompression.error}`,
    );
  } else if (recomputedNoCompression.finalAtomic === summaryBalanceAtomic) {
    clues.push(
      'Fresh in-memory recompute without compression matches the live BWS summary.',
    );
  }
  if (recomputedCompression.error) {
    clues.push(
      `Fresh in-memory recompute with compression failed: ${recomputedCompression.error}`,
    );
  } else if (recomputedCompression.finalAtomic === snapshotFinalAtomic) {
    clues.push(
      'Fresh in-memory recompute with compression matches the stored snapshot final balance.',
    );
  }
  if (
    populateProcessedFinalAtomic &&
    populateProcessedFinalAtomic === summaryBalanceAtomic
  ) {
    clues.push(
      'Populate worklet processed-tx trace final balance matches the live BWS summary.',
    );
  }
  if (
    populateProcessedFinalAtomic &&
    populateEmittedFinalAtomic &&
    populateProcessedFinalAtomic !== populateEmittedFinalAtomic
  ) {
    clues.push(
      'Populate worklet processed-tx trace final balance differs from the emitted snapshot trace final balance.',
    );
  }
  if (!clues.length) {
    clues.push(
      'No obvious mismatch was detected in counts, ordering, or final balances.',
    );
  }

  const redactTxid = createTxidRedactor();
  const redactedWalletId = 'wallet_1';

  const summaryLine = [
    `history=${historyRows.length} txs`,
    `historyDupTxids=${duplicateHistoryRows.length}`,
    `snapshotTxs=${snapshotTxRows.length}`,
    `dailySnaps=${dailySnapshotCount}`,
    `firstSequenceMismatch=${firstSequenceMismatchSeq ?? 'none'}`,
    `firstBalanceMismatch=${firstBalanceMismatchSeq ?? 'none'}`,
  ].join(' · ');

  const lines: string[] = [];
  lines.push('Wallet balance diagnostic');
  lines.push(`generatedAtUtc=${new Date().toISOString()}`);
  lines.push('identifiersRedacted=yes');
  lines.push(`walletId=${redactedWalletId}`);
  lines.push(`walletName=${args.wallet.walletName}`);
  lines.push(
    `asset=${args.wallet.chain}:${args.wallet.currencyAbbreviation}:${args.wallet.network}`,
  );
  lines.push(summaryLine);
  lines.push('');
  lines.push('Balances');
  lines.push(`bwsSummaryAtomic=${summaryBalanceAtomic}`);
  lines.push(
    `bwsSummaryFormatted=${formatAtomicAmount(summaryBalanceAtomic, args.credentials)}`,
  );
  lines.push(`historyFinalAtomic=${historyFinalAtomic}`);
  lines.push(
    `historyFinalFormatted=${formatAtomicAmount(historyFinalAtomic, args.credentials)}`,
  );
  lines.push(`historyDedupedFinalAtomic=${dedupedHistoryFinal.toString()}`);
  lines.push(
    `historyDedupedFinalFormatted=${formatAtomicAmount(
      dedupedHistoryFinal,
      args.credentials,
    )}`,
  );
  lines.push(`snapshotFinalAtomic=${snapshotFinalAtomic}`);
  lines.push(
    `snapshotFinalFormatted=${formatAtomicAmount(
      snapshotFinalAtomic,
      args.credentials,
    )}`,
  );
  lines.push(
    `historyMinusSnapshotAtomic=${historyMinusSnapshotAtomicBig.toString()}`,
  );
  lines.push(
    `summaryMinusSnapshotAtomic=${summaryMinusSnapshotAtomicBig.toString()}`,
  );
  lines.push(
    `recomputedNoCompressionFinalAtomic=${recomputedNoCompression.finalAtomic}`,
  );
  if (recomputedNoCompression.error) {
    lines.push(
      `recomputedNoCompressionError=${recomputedNoCompression.error}`,
    );
  }
  lines.push(
    `recomputedCompressionFinalAtomic=${recomputedCompression.finalAtomic}`,
  );
  if (recomputedCompression.error) {
    lines.push(`recomputedCompressionError=${recomputedCompression.error}`);
  }
  lines.push(`storedSnapshotFinalAtomic=${snapshotFinalAtomic}`);
  if (populateProcessedFinalAtomic) {
    lines.push(
      `populateWorkletProcessedFinalAtomic=${populateProcessedFinalAtomic}`,
    );
  }
  if (populateEmittedFinalAtomic) {
    lines.push(`populateWorkletEmittedFinalAtomic=${populateEmittedFinalAtomic}`);
  }
  lines.push('');
  lines.push('Counts');
  lines.push(`pages=${args.txPages.length}`);
  lines.push(`historyTxs=${historyRows.length}`);
  lines.push(`historyUniqueTxids=${historyCounts.size}`);
  lines.push(`duplicateHistoryTxids=${duplicateHistoryRows.length}`);
  lines.push(`snapshotTxs=${snapshotTxRows.length}`);
  lines.push(`snapshotDailyRows=${dailySnapshotCount}`);
  lines.push(`snapshotIdsLinked=${snapshotIdsLinked ? 'yes' : 'no'}`);
  lines.push(`duplicateSnapshotTxids=${duplicateSnapshotRows.length}`);
  lines.push(`historyWithoutSnapshot=${historyOnlyRows.length}`);
  lines.push(`snapshotWithoutHistory=${snapshotOnlyRows.length}`);
  lines.push(`firstHistoryNegativeSeq=${firstHistoryNegativeSeq ?? 'none'}`);
  lines.push(`firstSnapshotNegativeSeq=${firstSnapshotNegativeSeq ?? 'none'}`);
  lines.push(
    `firstSequenceMismatchSeq=${firstSequenceMismatchSeq ?? 'none'}`,
  );
  lines.push(`firstBalanceMismatchSeq=${firstBalanceMismatchSeq ?? 'none'}`);
  lines.push('');
  lines.push('Clues');
  for (const clue of clues) {
    lines.push(`- ${clue}`);
  }

  if (args.index) {
    addSection(
      lines,
      'Current snapshot index checkpoint (csv)',
      toCsv([
        [
          'phase',
          'nextSkip',
          'balanceAtomic',
          'lastTimestamp',
          'lastTimestampUtc',
          'recentTxIds',
          'carryoverGroup',
          'updatedAt',
          'updatedAtUtc',
          'compressionEnabled',
          'chunkRows',
        ],
        ...buildCheckpointRows('current', args.index, redactTxid),
      ]),
    );
  }

  if (args.populateCapture) {
    addSection(
      lines,
      'Last debug populate checkpoint capture (csv)',
      [
        `capturedAtUtc=${formatTimestampUtc(args.populateCapture.capturedAtMs)}`,
        `snapshotDebugMode=${args.populateCapture.snapshotDebugMode}`,
        `debugFetchedTxRows=${
          args.populateCapture.debugTrace?.fetchedTxRows.length ?? 0
        }`,
        `debugProcessedTxRows=${
          args.populateCapture.debugTrace?.processedTxRows.length ?? 0
        }`,
        `debugEmittedSnapshotRows=${
          args.populateCapture.debugTrace?.emittedSnapshotRows.length ?? 0
        }`,
        `debugSessionStateBeforePrepareRows=${
          args.populateCapture.debugTrace?.sessionStateBeforePrepareRows.length ??
          0
        }`,
        `debugBuilderSeedRows=${
          args.populateCapture.debugTrace?.builderSeedRows.length ?? 0
        }`,
        `debugIngestSeedRows=${
          args.populateCapture.debugTrace?.ingestSeedRows.length ?? 0
        }`,
        `debugNormalizedFilteredPageKeyRows=${
          args.populateCapture.debugTrace?.normalizedFilteredPageKeyRows.length ??
          0
        }`,
        `debugIngestLoopMutationRows=${
          args.populateCapture.debugTrace?.ingestLoopMutationRows.length ?? 0
        }`,
        `debugFlushCurrentGroupRows=${
          args.populateCapture.debugTrace?.flushCurrentGroupRows.length ?? 0
        }`,
        `debugFlushDirectResetWitnessRows=${
          args.populateCapture.debugTrace?.flushDirectResetWitnessRows.length ??
          0
        }`,
        `debugFlushReturnWitnessRows=${
          args.populateCapture.debugTrace?.flushReturnWitnessRows.length ?? 0
        }`,
        `debugLocalMutationCanaryRows=${
          args.populateCapture.debugTrace?.localMutationCanaryRows.length ?? 0
        }`,
        `debugStateMutationControlRows=${
          args.populateCapture.debugTrace?.stateMutationControlRows.length ?? 0
        }`,
        `debugDirectVsHelperParityRows=${
          args.populateCapture.debugTrace?.directVsHelperParityRows.length ?? 0
        }`,
        `debugCarryoverDecisionRows=${
          args.populateCapture.debugTrace?.carryoverDecisionRows.length ?? 0
        }`,
        `debugGroupAssemblyRows=${
          args.populateCapture.debugTrace?.groupAssemblyRows.length ?? 0
        }`,
        `debugRequestLifecycleRows=${
          args.populateCapture.debugTrace?.requestLifecycleRows.length ?? 0
        }`,
        toCsv([
          [
            'phase',
            'nextSkip',
            'balanceAtomic',
            'lastTimestamp',
            'lastTimestampUtc',
            'recentTxIds',
            'carryoverGroup',
            'updatedAt',
            'updatedAtUtc',
            'compressionEnabled',
            'chunkRows',
          ],
          ...buildCheckpointRows(
            'beforePopulate',
            args.populateCapture.beforeIndex,
            redactTxid,
          ),
          ...buildCheckpointRows(
            'afterPopulate',
            args.populateCapture.afterIndex,
            redactTxid,
          ),
        ]),
      ].join('\n'),
    );
  }

  if (populateDebugTrace?.sessionStateBeforePrepareRows.length) {
    addSection(
      lines,
      'Worklet Session State Before Prepare (csv)',
      toCsv([
        [
          'walletId',
          'existingSessionBefore',
          'existingSessionCreatedAtUtc',
          'existingSessionCarryoverTxIds',
          'existingSessionRecentTxIds',
          'existingSessionPendingTxIds',
        ],
        ...populateDebugTrace.sessionStateBeforePrepareRows.map(row => [
          redactTxid(row.walletId),
          row.existingSessionBefore ? 'yes' : 'no',
          formatTimestampUtc(row.existingSessionCreatedAtMs),
          formatTxidList(row.existingSessionCarryoverTxIds, redactTxid),
          formatTxidList(row.existingSessionRecentTxIds, redactTxid),
          formatTxidList(row.existingSessionPendingTxIds, redactTxid),
        ]),
      ]),
    );
  }

  if (populateDebugTrace?.builderSeedRows.length) {
    addSection(
      lines,
      'Builder Seed At Prepare (csv)',
      toCsv([
        [
          'walletId',
          'persistedCheckpointNextSkip',
          'persistedCheckpointCarryoverTxIds',
          'persistedCheckpointRecentTxIds',
          'builderNextSkipAfterCreate',
          'builderCarryoverTxIdsAfterCreate',
          'builderRecentTxIdsAfterCreate',
        ],
        ...populateDebugTrace.builderSeedRows.map(row => [
          redactTxid(row.walletId),
          row.persistedCheckpointNextSkip,
          formatTxidList(row.persistedCheckpointCarryoverTxIds, redactTxid),
          formatTxidList(row.persistedCheckpointRecentTxIds, redactTxid),
          row.builderNextSkipAfterCreate,
          formatTxidList(row.builderCarryoverTxIdsAfterCreate, redactTxid),
          formatTxidList(row.builderRecentTxIdsAfterCreate, redactTxid),
        ]),
      ]),
    );
  }

  if (populateDebugTrace?.ingestSeedRows.length) {
    const limitedIngestSeedRows = limitRows(populateDebugTrace.ingestSeedRows, 50);
    addSection(
      lines,
      'processNextPage Ingest Seeds (csv)',
      toCsv([
        [
          'requestId',
          'processSeq',
          'skip',
          'builderCarryoverTxIdsBeforeIngest',
          'builderRecentTxIdsBeforeIngest',
          'pendingTxIdsBeforeIngest',
          'fetchedTxHead',
          'dedupedPendingTxHead',
        ],
        ...limitedIngestSeedRows.rows.map(row => [
          row.requestId,
          row.processSeq,
          row.skip,
          formatTxidList(row.builderCarryoverTxIdsBeforeIngest, redactTxid),
          formatTxidList(row.builderRecentTxIdsBeforeIngest, redactTxid),
          formatTxidList(row.pendingTxIdsBeforeIngest, redactTxid),
          formatTxidList(row.fetchedTxHead, redactTxid),
          formatTxidList(row.dedupedPendingTxHead, redactTxid),
        ]),
      ]) +
        (limitedIngestSeedRows.truncated
          ? `\n# truncated=${limitedIngestSeedRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.normalizedFilteredPageKeyRows.length) {
    const limitedPageKeyRows = limitRows(
      populateDebugTrace.normalizedFilteredPageKeyRows,
      100,
    );
    addSection(
      lines,
      'Normalized Filtered Page Keys (csv)',
      toCsv([
        [
          'requestId',
          'filteredIndex',
          'originalIndex',
          'txid',
          'timestampUtc',
          'blockHeight',
          'groupKey',
          'startsNewGroup',
        ],
        ...limitedPageKeyRows.rows.map(row => [
          row.requestId,
          row.filteredIndex,
          row.originalIndex,
          redactTxid(row.txid),
          formatTimestampUtc(row.timestamp),
          row.blockHeight ?? '',
          row.groupKey,
          row.startsNewGroup ? 'yes' : 'no',
        ]),
      ]) +
        (limitedPageKeyRows.truncated
          ? `\n# truncated=${limitedPageKeyRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.ingestLoopMutationRows.length) {
    const limitedMutationRows = limitRows(
      populateDebugTrace.ingestLoopMutationRows,
      250,
    );
    addSection(
      lines,
      'Ingest Loop Mutation Trace (csv)',
      toCsv([
        [
          'requestId',
          'stepSeq',
          'loopIndex',
          'mutation',
          'txid',
          'txGroupKey',
          'groupInstanceSeq',
          'groupKeyBefore',
          'groupKeyAfter',
          'groupTxIdsBefore',
          'groupTxIdsAfter',
          'pageTxIdsAddedBefore',
          'pageTxIdsAddedAfter',
          'carryoverSeedTxIdsBefore',
          'carryoverSeedTxIdsAfter',
          'groupMaxOriginalIndexBefore',
          'groupMaxOriginalIndexAfter',
          'consumedRawCountBefore',
          'consumedRawCountAfter',
          'endedAtInputBoundary',
          'note',
        ],
        ...limitedMutationRows.rows.map(row => [
          row.requestId,
          row.stepSeq,
          row.loopIndex ?? '',
          row.mutation,
          row.txid ? redactTxid(row.txid) : '',
          row.txGroupKey,
          row.groupInstanceSeq,
          row.groupKeyBefore,
          row.groupKeyAfter,
          formatTxidList(row.groupTxIdsBefore, redactTxid),
          formatTxidList(row.groupTxIdsAfter, redactTxid),
          formatTxidList(row.pageTxIdsAddedBefore, redactTxid),
          formatTxidList(row.pageTxIdsAddedAfter, redactTxid),
          formatTxidList(row.carryoverSeedTxIdsBefore, redactTxid),
          formatTxidList(row.carryoverSeedTxIdsAfter, redactTxid),
          row.groupMaxOriginalIndexBefore ?? '',
          row.groupMaxOriginalIndexAfter ?? '',
          row.consumedRawCountBefore,
          row.consumedRawCountAfter,
          row.endedAtInputBoundary ? 'yes' : 'no',
          row.note ?? '',
        ]),
      ]) +
        (limitedMutationRows.truncated
          ? `\n# truncated=${limitedMutationRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.flushCurrentGroupRows.length) {
    const limitedFlushRows = limitRows(
      populateDebugTrace.flushCurrentGroupRows,
      100,
    );
    addSection(
      lines,
      'flushCurrentGroup Before/After (csv)',
      toCsv([
        [
          'requestId',
          'stepSeq',
          'flushReason',
          'groupInstanceSeqBeforeReset',
          'groupInstanceSeqAfterReset',
          'groupKeyBeforeReset',
          'groupTxIdsBeforeReset',
          'pageTxIdsAddedBeforeReset',
          'carryoverSeedTxIdsBeforeReset',
          'groupMaxOriginalIndexBeforeReset',
          'consumedRawCountBeforeReset',
          'groupKeyAfterReset',
          'groupTxIdsAfterReset',
          'pageTxIdsAddedAfterReset',
          'carryoverSeedTxIdsAfterReset',
          'groupMaxOriginalIndexAfterReset',
          'consumedRawCountAfterReset',
        ],
        ...limitedFlushRows.rows.map(row => [
          row.requestId,
          row.stepSeq,
          row.flushReason,
          row.groupInstanceSeqBeforeReset,
          row.groupInstanceSeqAfterReset,
          row.groupKeyBeforeReset,
          formatTxidList(row.groupTxIdsBeforeReset, redactTxid),
          formatTxidList(row.pageTxIdsAddedBeforeReset, redactTxid),
          formatTxidList(row.carryoverSeedTxIdsBeforeReset, redactTxid),
          row.groupMaxOriginalIndexBeforeReset ?? '',
          row.consumedRawCountBeforeReset,
          row.groupKeyAfterReset,
          formatTxidList(row.groupTxIdsAfterReset, redactTxid),
          formatTxidList(row.pageTxIdsAddedAfterReset, redactTxid),
          formatTxidList(row.carryoverSeedTxIdsAfterReset, redactTxid),
          row.groupMaxOriginalIndexAfterReset ?? '',
          row.consumedRawCountAfterReset,
        ]),
      ]) +
        (limitedFlushRows.truncated
          ? `\n# truncated=${limitedFlushRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.flushDirectResetWitnessRows.length) {
    const limitedDirectResetRows = limitRows(
      populateDebugTrace.flushDirectResetWitnessRows,
      200,
    );
    addSection(
      lines,
      'flushCurrentGroup Direct Reset Witness (csv)',
      toCsv([
        [
          'requestId',
          'flushInvocationSeq',
          'stepSeq',
          'flushReason',
          'stage',
          'groupInstanceSeqDirect',
          'groupLenDirect',
          'groupFirstTxidDirect',
          'pageTxIdsAddedLenDirect',
          'pageTxIdsAddedHeadDirect',
          'carryoverSeedLenDirect',
          'carryoverSeedHeadDirect',
          'groupKeyDirect',
          'groupKeyIsNullDirect',
          'groupMaxOriginalIndexDirect',
          'consumedRawCountDirect',
        ],
        ...limitedDirectResetRows.rows.map(row => [
          row.requestId,
          row.flushInvocationSeq,
          row.stepSeq,
          row.flushReason,
          row.stage,
          row.groupInstanceSeqDirect,
          row.groupLenDirect,
          row.groupFirstTxidDirect
            ? redactTxid(row.groupFirstTxidDirect)
            : '',
          row.pageTxIdsAddedLenDirect,
          formatTxidList(row.pageTxIdsAddedHeadDirect, redactTxid),
          row.carryoverSeedLenDirect,
          formatTxidList(row.carryoverSeedHeadDirect, redactTxid),
          row.groupKeyDirect,
          row.groupKeyIsNullDirect ? 'yes' : 'no',
          row.groupMaxOriginalIndexDirect ?? '',
          row.consumedRawCountDirect,
        ]),
      ]) +
        (limitedDirectResetRows.truncated
          ? `\n# truncated=${limitedDirectResetRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.flushReturnWitnessRows.length) {
    const limitedFlushReturnRows = limitRows(
      populateDebugTrace.flushReturnWitnessRows,
      100,
    );
    addSection(
      lines,
      'Caller After flushCurrentGroup Return (csv)',
      toCsv([
        [
          'requestId',
          'flushInvocationSeq',
          'stepSeq',
          'flushReason',
          'stage',
          'loopIndex',
          'nextIncomingTxid',
          'nextIncomingGroupKey',
          'groupInstanceSeqDirect',
          'groupLenDirect',
          'groupFirstTxidDirect',
          'pageTxIdsAddedLenDirect',
          'pageTxIdsAddedHeadDirect',
          'carryoverSeedLenDirect',
          'carryoverSeedHeadDirect',
          'groupKeyDirect',
          'groupKeyIsNullDirect',
          'groupMaxOriginalIndexDirect',
          'consumedRawCountDirect',
        ],
        ...limitedFlushReturnRows.rows.map(row => [
          row.requestId,
          row.flushInvocationSeq,
          row.stepSeq,
          row.flushReason,
          row.stage,
          row.loopIndex,
          row.nextIncomingTxid ? redactTxid(row.nextIncomingTxid) : '',
          row.nextIncomingGroupKey,
          row.groupInstanceSeqDirect,
          row.groupLenDirect,
          row.groupFirstTxidDirect
            ? redactTxid(row.groupFirstTxidDirect)
            : '',
          row.pageTxIdsAddedLenDirect,
          formatTxidList(row.pageTxIdsAddedHeadDirect, redactTxid),
          row.carryoverSeedLenDirect,
          formatTxidList(row.carryoverSeedHeadDirect, redactTxid),
          row.groupKeyDirect,
          row.groupKeyIsNullDirect ? 'yes' : 'no',
          row.groupMaxOriginalIndexDirect ?? '',
          row.consumedRawCountDirect,
        ]),
      ]) +
        (limitedFlushReturnRows.truncated
          ? `\n# truncated=${limitedFlushReturnRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.localMutationCanaryRows.length) {
    const limitedCanaryRows = limitRows(
      populateDebugTrace.localMutationCanaryRows,
      100,
    );
    addSection(
      lines,
      'Worklet Local Mutation Canary (csv)',
      toCsv([
        [
          'requestId',
          'flushInvocationSeq',
          'stepSeq',
          'flushReason',
          'stage',
          'localScalarCanary',
          'localArrayCanaryLen',
          'localArrayCanaryHead',
          'localStringCanary',
        ],
        ...limitedCanaryRows.rows.map(row => [
          row.requestId,
          row.flushInvocationSeq,
          row.stepSeq,
          row.flushReason,
          row.stage,
          row.localScalarCanary,
          row.localArrayCanaryLen,
          (row.localArrayCanaryHead || []).join('|'),
          row.localStringCanary,
        ]),
      ]) +
        (limitedCanaryRows.truncated
          ? `\n# truncated=${limitedCanaryRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.stateMutationControlRows.length) {
    const limitedStateControlRows = limitRows(
      populateDebugTrace.stateMutationControlRows,
      100,
    );
    addSection(
      lines,
      'State Object Mutation Control (csv)',
      toCsv([
        [
          'requestId',
          'flushInvocationSeq',
          'stepSeq',
          'flushReason',
          'stage',
          'stateControlCounter',
          'stateControlLastStage',
          'localScalarCanary',
          'groupLenDirect',
          'groupFirstTxidDirect',
        ],
        ...limitedStateControlRows.rows.map(row => [
          row.requestId,
          row.flushInvocationSeq,
          row.stepSeq,
          row.flushReason,
          row.stage,
          row.stateControlCounter,
          row.stateControlLastStage,
          row.localScalarCanary,
          row.groupLenDirect,
          row.groupFirstTxidDirect
            ? redactTxid(row.groupFirstTxidDirect)
            : '',
        ]),
      ]) +
        (limitedStateControlRows.truncated
          ? `\n# truncated=${limitedStateControlRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.directVsHelperParityRows.length) {
    const limitedParityRows = limitRows(
      populateDebugTrace.directVsHelperParityRows,
      100,
    );
    addSection(
      lines,
      'Direct vs Helper Snapshot Parity (csv)',
      toCsv([
        [
          'requestId',
          'flushInvocationSeq',
          'stepSeq',
          'flushReason',
          'stage',
          'groupLenDirect',
          'groupLenViaSnapshot',
          'groupFirstTxidDirect',
          'groupFirstTxidViaSnapshot',
          'pageLenDirect',
          'pageLenViaSnapshot',
          'pageHeadDirect',
          'pageHeadViaSnapshot',
          'carryoverSeedLenDirect',
          'carryoverSeedLenViaSnapshot',
          'carryoverSeedHeadDirect',
          'carryoverSeedHeadViaSnapshot',
          'groupKeyDirect',
          'groupKeyViaSnapshot',
          'groupKeyIsNullDirect',
        ],
        ...limitedParityRows.rows.map(row => [
          row.requestId,
          row.flushInvocationSeq,
          row.stepSeq,
          row.flushReason,
          row.stage,
          row.groupLenDirect,
          row.groupLenViaSnapshot,
          row.groupFirstTxidDirect ? redactTxid(row.groupFirstTxidDirect) : '',
          row.groupFirstTxidViaSnapshot
            ? redactTxid(row.groupFirstTxidViaSnapshot)
            : '',
          row.pageLenDirect,
          row.pageLenViaSnapshot,
          formatTxidList(row.pageHeadDirect, redactTxid),
          formatTxidList(row.pageHeadViaSnapshot, redactTxid),
          row.carryoverSeedLenDirect,
          row.carryoverSeedLenViaSnapshot,
          formatTxidList(row.carryoverSeedHeadDirect, redactTxid),
          formatTxidList(row.carryoverSeedHeadViaSnapshot, redactTxid),
          row.groupKeyDirect,
          row.groupKeyViaSnapshot,
          row.groupKeyIsNullDirect ? 'yes' : 'no',
        ]),
      ]) +
        (limitedParityRows.truncated
          ? `\n# truncated=${limitedParityRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.carryoverDecisionRows.length) {
    const limitedCarryoverRows = limitRows(
      populateDebugTrace.carryoverDecisionRows,
      50,
    );
    addSection(
      lines,
      'Carryover Decision Snapshot (csv)',
      toCsv([
        [
          'requestId',
          'stepSeq',
          'groupInstanceSeq',
          'endedAtInputBoundary',
          'shouldCarryAcrossPageBoundary',
          'groupKey',
          'groupTxIdsBeforeAssign',
          'pageTxIdsAdded',
          'carryoverSeedTxIds',
          'stateCarryoverTxIdsBeforeAssign',
          'stateCarryoverTxIdsAfterAssign',
          'logicalPageSize',
          'nextSkipBeforeAssign',
          'nextSkipAfterAssign',
          'recentTxIdsAfterAssign',
        ],
        ...limitedCarryoverRows.rows.map(row => [
          row.requestId,
          row.stepSeq,
          row.groupInstanceSeq,
          row.endedAtInputBoundary ? 'yes' : 'no',
          row.shouldCarryAcrossPageBoundary ? 'yes' : 'no',
          row.groupKey,
          formatTxidList(row.groupTxIdsBeforeAssign, redactTxid),
          formatTxidList(row.pageTxIdsAdded, redactTxid),
          formatTxidList(row.carryoverSeedTxIds, redactTxid),
          formatTxidList(row.stateCarryoverTxIdsBeforeAssign, redactTxid),
          formatTxidList(row.stateCarryoverTxIdsAfterAssign, redactTxid),
          row.logicalPageSize,
          row.nextSkipBeforeAssign,
          row.nextSkipAfterAssign,
          formatTxidList(row.recentTxIdsAfterAssign, redactTxid),
        ]),
      ]) +
        (limitedCarryoverRows.truncated
          ? `\n# truncated=${limitedCarryoverRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.groupAssemblyRows.length) {
    const limitedGroupAssemblyRows = limitRows(
      populateDebugTrace.groupAssemblyRows,
      100,
    );
    addSection(
      lines,
      'Group Assembly Trace (first few groups) (csv)',
      toCsv([
        [
          'requestId',
          'stepSeq',
          'groupIndex',
          'groupInstanceSeq',
          'groupKey',
          'carryoverSeedTxIds',
          'pageTxIdsAdded',
          'inputTxIdsBeforeReorder',
          'reorderedTxIds',
          'flushReason',
        ],
        ...limitedGroupAssemblyRows.rows.map(row => [
          row.requestId,
          row.stepSeq ?? '',
          row.groupIndex,
          row.groupInstanceSeq ?? '',
          row.groupKey,
          formatTxidList(row.carryoverSeedTxIds, redactTxid),
          formatTxidList(row.pageTxIdsAdded, redactTxid),
          formatTxidList(row.inputTxIdsBeforeReorder, redactTxid),
          formatTxidList(row.reorderedTxIds, redactTxid),
          row.flushReason,
        ]),
      ]) +
        (limitedGroupAssemblyRows.truncated
          ? `\n# truncated=${limitedGroupAssemblyRows.truncated}`
          : ''),
    );
  }

  if (populateDebugTrace?.requestLifecycleRows.length) {
    addSection(
      lines,
      'Populate Request Lifecycle (csv)',
      toCsv([
        [
          'requestId',
          'method',
          'walletId',
          'startedAtUtc',
          'finishedAtUtc',
          'skipUsed',
          'fetchedTxs',
          'consumedRawCount',
          'logicalPageSize',
          'appendedSnapshots',
          'done',
        ],
        ...populateDebugTrace.requestLifecycleRows.map(row => [
          row.requestId,
          row.method,
          redactTxid(row.walletId),
          formatTimestampUtc(row.startedAtMs),
          formatTimestampUtc(row.finishedAtMs),
          row.skipUsed ?? '',
          row.fetchedTxs ?? '',
          row.consumedRawCount ?? '',
          row.logicalPageSize ?? '',
          row.appendedSnapshots ?? '',
          row.done === null ? '' : row.done ? 'yes' : 'no',
        ]),
      ]),
    );
  }

  addSection(
    lines,
    'Fresh in-memory recompute',
    [
      `recomputedAtUtc=${formatTimestampUtc(recomputeNowMs)}`,
      `recomputedCompressionEnabled=${
        args.index?.compressionEnabled !== false ? 'yes' : 'no'
      }`,
      `recomputedNoCompressionFinalAtomic=${recomputedNoCompression.finalAtomic}`,
      recomputedNoCompression.error
        ? `recomputedNoCompressionError=${recomputedNoCompression.error}`
        : null,
      `recomputedCompressionFinalAtomic=${recomputedCompression.finalAtomic}`,
      recomputedCompression.error
        ? `recomputedCompressionError=${recomputedCompression.error}`
        : null,
      `storedSnapshotFinalAtomic=${snapshotFinalAtomic}`,
      `recomputedCompressionRows=${recomputedCompression.traceRows.length}`,
      `recomputedNoCompressionRows=${recomputedNoCompression.traceRows.length}`,
    ]
      .filter((line): line is string => !!line)
      .join('\n'),
  );

  addSection(
    lines,
    'Page summary (csv)',
    toCsv(
      pageSummaryRows.map((row, index) =>
        index === 0
          ? row
          : [
              row[0],
              row[1],
              row[2],
              row[3] ? redactTxid(String(row[3])) : '',
              row[4] ? redactTxid(String(row[4])) : '',
              row[5],
              row[6],
              row[7],
              row[8],
            ],
      ),
    ),
  );

  const limitedSequenceWindow = limitRows(sequenceWindowRows.slice(1), 20);
  addSection(
    lines,
    'Sequence window around first issue (csv)',
    toCsv([
      sequenceWindowRows[0],
      ...limitedSequenceWindow.rows.map(row => [
        row[0],
        row[1],
        row[2] ? redactTxid(String(row[2])) : '',
        row[3] ? redactTxid(String(row[3])) : '',
        row[4],
        row[5],
        row[6],
        row[7],
        row[8],
        row[9],
        row[10],
        row[11],
        row[12],
      ]),
    ]),
  );

  const limitedMatchedWindow = limitRows(matchedWindowRows.slice(1), 20);
  addSection(
    lines,
    'Txid-matched balance window (csv)',
    toCsv([
      matchedWindowRows[0],
      ...limitedMatchedWindow.rows.map(row => [
        row[0],
        row[1],
        row[2] ? redactTxid(String(row[2])) : '',
        row[3],
        row[4],
        row[5],
        row[6],
        row[7],
        row[8],
        row[9],
        row[10],
        row[11],
        row[12],
      ]),
    ]),
  );

  const limitedRecomputedCompressionRows = limitRows(
    recomputedCompression.traceRows,
    500,
  );
  addSection(
    lines,
    'Recomputed compression trace (csv)',
    toCsv([
      [
        'seq',
        'eventType',
        'eventRef',
        'timestampUtc',
        'preBalanceAtomic',
        'deltaAtomic',
        'postBalanceAtomic',
        'txIds',
        'flushTriggeredBy',
      ],
      ...limitedRecomputedCompressionRows.rows.map(row => [
        row.seq,
        row.eventType,
        row.eventType === 'tx' ? redactTxid(row.eventRef) : row.eventRef,
        row.timestampUtc,
        row.preBalanceAtomic,
        row.deltaAtomic,
        row.postBalanceAtomic,
        row.txIds.length
          ? row.txIds.map(txid => redactTxid(txid)).join('|')
          : '',
        row.flushTriggeredBy,
      ]),
    ]) +
      (limitedRecomputedCompressionRows.truncated
        ? `\n# truncated=${limitedRecomputedCompressionRows.truncated}`
        : ''),
  );

  const limitedRecomputedNoCompressionRows = limitRows(
    recomputedNoCompression.traceRows,
    500,
  );
  addSection(
    lines,
    'Recomputed no-compression trace (csv)',
    toCsv([
      [
        'seq',
        'eventType',
        'eventRef',
        'timestampUtc',
        'preBalanceAtomic',
        'deltaAtomic',
        'postBalanceAtomic',
        'txIds',
        'flushTriggeredBy',
      ],
      ...limitedRecomputedNoCompressionRows.rows.map(row => [
        row.seq,
        row.eventType,
        row.eventType === 'tx' ? redactTxid(row.eventRef) : row.eventRef,
        row.timestampUtc,
        row.preBalanceAtomic,
        row.deltaAtomic,
        row.postBalanceAtomic,
        row.txIds.length
          ? row.txIds.map(txid => redactTxid(txid)).join('|')
          : '',
        row.flushTriggeredBy,
      ]),
    ]) +
      (limitedRecomputedNoCompressionRows.truncated
        ? `\n# truncated=${limitedRecomputedNoCompressionRows.truncated}`
        : ''),
  );

  if (populateDebugTrace) {
    const populateFetchedCompareRows = buildPopulateFetchedHistoryCompareRows({
      historyRows,
      populateDebugTrace,
      limit: 23,
    });
    addSection(
      lines,
      'Diagnostic vs populate worklet fetched history (first 23 rows) (csv)',
      toCsv([
        [
          'seq',
          'diagnosticTxid',
          'populateTxid',
          'diagnosticTimestampUtc',
          'populateTimestampUtc',
          'diagnosticAction',
          'populateAction',
          'diagnosticAmountAtomic',
          'populateAmountAtomic',
          'diagnosticFeeAtomic',
          'populateFeeAtomic',
          'diagnosticDeltaAtomic',
          'populateDeltaAtomic',
          'diagnosticBlockHeight',
          'populateBlockHeight',
          'flags',
        ],
        ...populateFetchedCompareRows.map(row => [
          row.seq,
          row.diagnosticTxid ? redactTxid(row.diagnosticTxid) : '',
          row.populateTxid ? redactTxid(row.populateTxid) : '',
          row.diagnosticTimestampUtc,
          row.populateTimestampUtc,
          row.diagnosticAction,
          row.populateAction,
          row.diagnosticAmountAtomic,
          row.populateAmountAtomic,
          row.diagnosticFeeAtomic,
          row.populateFeeAtomic,
          row.diagnosticDeltaAtomic,
          row.populateDeltaAtomic,
          row.diagnosticBlockHeight,
          row.populateBlockHeight,
          row.flags.join('|'),
        ]),
      ]),
    );

    const limitedPopulateProcessedRows = limitRows(
      populateDebugTrace.processedTxRows,
      1000,
    );
    addSection(
      lines,
      'Populate worklet processed tx trace (csv)',
      toCsv([
        [
          'seq',
          'txid',
          'timestampUtc',
          'action',
          'amountAtomic',
          'feeAtomic',
          'normalizedDeltaAtomic',
          'preBalanceAtomic',
          'postBalanceAtomic',
          'blockHeight',
        ],
        ...limitedPopulateProcessedRows.rows.map(row => [
          row.seq,
          redactTxid(row.txid),
          formatTimestampUtc(row.timestamp),
          row.action,
          row.amountAtomic,
          row.feeAtomic,
          row.normalizedDeltaAtomic,
          row.preBalanceAtomic,
          row.postBalanceAtomic,
          row.blockHeight ?? '',
        ]),
      ]) +
        (limitedPopulateProcessedRows.truncated
          ? `\n# truncated=${limitedPopulateProcessedRows.truncated}`
          : ''),
    );

    const limitedPopulateSnapshotRows = limitRows(
      populateDebugTrace.emittedSnapshotRows,
      1000,
    );
    addSection(
      lines,
      'Populate worklet emitted snapshot rows (csv)',
      toCsv([
        [
          'rowIndex',
          'eventType',
          'id',
          'txIds',
          'timestampUtc',
          'cryptoBalanceAtomic',
        ],
        ...limitedPopulateSnapshotRows.rows.map(row => [
          row.rowIndex,
          row.eventType,
          row.eventType === 'tx'
            ? redactTxid(extractTxIdFromSnapshotId(row.id) || row.id)
            : extractDayKeyFromSnapshotId(row.id) || row.id,
          Array.isArray(row.txIds) && row.txIds.length
            ? row.txIds.map(txid => redactTxid(txid)).join('|')
            : '',
          formatTimestampUtc(row.timestamp),
          row.cryptoBalance,
        ]),
      ]) +
        (limitedPopulateSnapshotRows.truncated
          ? `\n# truncated=${limitedPopulateSnapshotRows.truncated}`
          : ''),
    );
  }

  if (feeAuditRows.length) {
    const feeAuditTotals = feeAuditRows.reduce(
      (acc, row) => {
        acc.txFeesFieldAtomic += parseAtomicToBigint(row.txFeesFieldAtomic);
        acc.computedFeeAtomic += parseAtomicToBigint(row.computedFeeAtomic);
        acc.computedMinusTxFeesAtomic += parseAtomicToBigint(
          row.computedMinusTxFeesAtomic,
        );
        return acc;
      },
      {
        txFeesFieldAtomic: 0n,
        computedFeeAtomic: 0n,
        computedMinusTxFeesAtomic: 0n,
      },
    );
    const limited = limitRows(feeAuditRows, 50);
    const body = toCsv([
      [
        'seq',
        'page',
        'txid',
        'action',
        'timestampUtc',
        'amountAtomic',
        'deltaAtomic',
        'historyRunningAtomic',
        'txFeesFieldAtomic',
        'computedFeeAtomic',
        'computedMinusTxFeesAtomic',
        'gasUsedAtomic',
        'effectiveGasPriceAtomic',
        'gasPriceAtomic',
        'gasUsedTimesPriceAtomic',
        'l1FeeAtomic',
        'operatorFeeAtomic',
        'receiptStatus',
        'feeSource',
      ],
      ...limited.rows.map(row => [
        row.seq,
        row.pageNumber,
        row.txid ? redactTxid(row.txid) : '',
        row.action,
        row.timestampUtc,
        row.amountAtomic,
        row.deltaAtomic,
        row.historyRunningAtomic,
        row.txFeesFieldAtomic,
        row.computedFeeAtomic,
        row.computedMinusTxFeesAtomic,
        row.gasUsedAtomic,
        row.effectiveGasPriceAtomic,
        row.gasPriceAtomic,
        row.gasUsedTimesPriceAtomic,
        row.l1FeeAtomic,
        row.operatorFeeAtomic,
        row.receiptStatus,
        row.feeSource,
      ]),
    ]);
    const summary = [
      `summaryMinusSnapshotAtomic=${summaryMinusSnapshotAtomicBig.toString()}`,
      `outgoingTxs=${feeAuditRows.length}`,
      `outgoingTxFeesFieldAtomic=${feeAuditTotals.txFeesFieldAtomic.toString()}`,
      `outgoingComputedFeeAtomic=${feeAuditTotals.computedFeeAtomic.toString()}`,
      `outgoingComputedMinusTxFeesAtomic=${feeAuditTotals.computedMinusTxFeesAtomic.toString()}`,
    ].join('\n');
    addSection(
      lines,
      'Outgoing fee audit (csv)',
      `${summary}\n${body}${
        limited.truncated ? `\n# truncated=${limited.truncated}` : ''
      }`,
    );
  }

  if (duplicateHistoryRows.length) {
    const limited = limitRows(duplicateHistoryRows, 50);
    const body = toCsv([
      ['txid', 'count', 'pages', 'seqs', 'firstTsUtc', 'lastTsUtc'],
      ...limited.rows.map(row => [
        row[0] ? redactTxid(String(row[0])) : '',
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
      ]),
    ]);
    addSection(
      lines,
      'Duplicate history txids (csv)',
      `${body}${limited.truncated ? `\n# truncated=${limited.truncated}` : ''}`,
    );
  }

  if (duplicateSnapshotRows.length) {
    const limited = limitRows(duplicateSnapshotRows, 50);
    const body = toCsv([
      [
        'txid',
        'count',
        'snapshotIndexes',
        'snapshotSeqs',
        'firstTsUtc',
        'lastTsUtc',
      ],
      ...limited.rows.map(row => [
        row[0] ? redactTxid(String(row[0])) : '',
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
      ]),
    ]);
    addSection(
      lines,
      'Duplicate snapshot txids (csv)',
      `${body}${limited.truncated ? `\n# truncated=${limited.truncated}` : ''}`,
    );
  }

  if (historyOnlyRows.length) {
    const limited = limitRows(historyOnlyRows, 50);
    const body = toCsv([
      [
        'seq',
        'page',
        'txid',
        'timestampUtc',
        'action',
        'historyRunningAtomic',
      ],
      ...limited.rows.map(row => [
        row[0],
        row[1],
        row[2] ? redactTxid(String(row[2])) : '',
        row[3],
        row[4],
        row[5],
      ]),
    ]);
    addSection(
      lines,
      'History txids missing from snapshots (csv)',
      `${body}${limited.truncated ? `\n# truncated=${limited.truncated}` : ''}`,
    );
  }

  if (snapshotOnlyRows.length) {
    const limited = limitRows(snapshotOnlyRows, 50);
    const body = toCsv([
      [
        'snapshotIndex',
        'snapshotSeq',
        'txid',
        'timestampUtc',
        'snapshotBalanceAtomic',
      ],
      ...limited.rows.map(row => [
        row[0],
        row[1],
        row[2] ? redactTxid(String(row[2])) : '',
        row[3],
        row[4],
      ]),
    ]);
    addSection(
      lines,
      'Snapshot txids missing from fetched history (csv)',
      `${body}${limited.truncated ? `\n# truncated=${limited.truncated}` : ''}`,
    );
  }

  return {
    summaryLine,
    reportText: lines.join('\n'),
  };
}
