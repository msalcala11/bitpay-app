import {formatAtomicAmount, parseAtomicToBigint} from '../core/format';
import {
  extractTxIdFromSnapshotId,
  makeBalanceSnapshotComputer,
} from '../core/pnl/snapshotHelpers';
import type {BalanceSnapshotStored} from '../core/pnl/types';
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

type MatchedRow = {
  history: HistoryRow;
  matchedSnapshot: SnapshotTxRow | null;
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
  const snapshotCounts = new Map<string, number>();
  const computeSnapshot = makeBalanceSnapshotComputer(args.credentials);
  for (let i = 0; i < args.snapshots.length; i++) {
    const snapshot = args.snapshots[i];
    if (snapshot.eventType !== 'tx') continue;
    const txid = extractTxIdFromSnapshotId(snapshot.id) || snapshot.id;
    const prevSnapshot = i > 0 ? args.snapshots[i - 1] : null;
    const computed = computeSnapshot(snapshot, prevSnapshot);
    snapshotCounts.set(txid, (snapshotCounts.get(txid) ?? 0) + 1);
    snapshotTxRows.push({
      seq: snapshotTxRows.length + 1,
      snapshotIndex: i,
      txid,
      timestampMs: snapshot.timestamp,
      timestampUtc: formatTimestampUtc(snapshot.timestamp),
      deltaAtomic: computed.balanceDeltaAtomic,
      balanceAtomic: snapshot.cryptoBalance,
    });
  }

  const dailySnapshotCount = args.snapshots.length - snapshotTxRows.length;

  const snapshotQueues = new Map<string, SnapshotTxRow[]>();
  for (const row of snapshotTxRows) {
    const queue = snapshotQueues.get(row.txid) ?? [];
    queue.push(row);
    snapshotQueues.set(row.txid, queue);
  }

  const matchedSnapshotIndexes = new Set<number>();
  const matchedRows: MatchedRow[] = historyRows.map(history => {
    const queue = snapshotQueues.get(history.txid);
    const matchedSnapshot = queue && queue.length ? queue.shift() || null : null;
    const flags = [...history.flags];

    if ((historyCounts.get(history.txid) ?? 0) > 1) {
      flags.push('HISTORY_DUP_TXID');
    }
    if ((snapshotCounts.get(history.txid) ?? 0) > 1) {
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

    matchedSnapshotIndexes.add(matchedSnapshot.snapshotIndex);

    if (matchedSnapshot.seq !== history.seq) {
      flags.push('ORDER_DIFF');
    }

    const diffAtomic = (
      parseAtomicToBigint(history.runningBalanceAtomic) -
      parseAtomicToBigint(matchedSnapshot.balanceAtomic)
    ).toString();
    if (diffAtomic !== '0') {
      flags.push('BALANCE_MISMATCH');
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
  const summaryBalanceAtomic = String(args.wallet.balanceAtomic ?? '0');
  const summaryMinusSnapshotAtomicBig =
    parseAtomicToBigint(summaryBalanceAtomic) -
    parseAtomicToBigint(snapshotFinalAtomic);
  const historyMinusSnapshotAtomicBig =
    parseAtomicToBigint(historyFinalAtomic) -
    parseAtomicToBigint(snapshotFinalAtomic);

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
  for (const row of snapshotTxRows) {
    if (parseAtomicToBigint(row.balanceAtomic) < 0n) {
      firstSnapshotNegativeSeq = row.seq;
      break;
    }
  }

  const commonSeqLength = Math.min(historyRows.length, snapshotTxRows.length);
  let firstSequenceMismatchSeq: number | null = null;
  for (let i = 0; i < commonSeqLength; i++) {
    if (historyRows[i].txid !== snapshotTxRows[i].txid) {
      firstSequenceMismatchSeq = i + 1;
      break;
    }
  }
  if (
    firstSequenceMismatchSeq === null &&
    historyRows.length !== snapshotTxRows.length
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

  const snapshotOnlyRows = snapshotTxRows
    .filter(row => !matchedSnapshotIndexes.has(row.snapshotIndex))
    .map(row => [
      row.snapshotIndex,
      row.seq,
      row.txid,
      row.timestampUtc,
      row.balanceAtomic,
    ]);

  const focusSeq =
    firstBalanceMismatchSeq ??
    firstSequenceMismatchSeq ??
    firstHistoryNegativeSeq ??
    firstSnapshotNegativeSeq ??
    1;
  const focusStart = Math.max(1, focusSeq - 5);
  const focusEnd = Math.min(
    Math.max(historyRows.length, snapshotTxRows.length),
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
      seqNum <= snapshotTxRows.length ? snapshotTxRows[seqNum - 1] : null;
    let sameSeqDiffAtomic = '';
    if (history && snapshot) {
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
  if (historyFinalAtomic === snapshotFinalAtomic) {
    clues.push(
      'Snapshot final balance matches fetched tx history. Any mismatch is likely ordering or display, not missing arithmetic.',
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
      `Snapshot tx order diverges from fetched history at seq ${firstSequenceMismatchSeq}.`,
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
  lines.push('');
  lines.push('Counts');
  lines.push(`pages=${args.txPages.length}`);
  lines.push(`historyTxs=${historyRows.length}`);
  lines.push(`historyUniqueTxids=${historyCounts.size}`);
  lines.push(`duplicateHistoryTxids=${duplicateHistoryRows.length}`);
  lines.push(`snapshotTxs=${snapshotTxRows.length}`);
  lines.push(`snapshotDailyRows=${dailySnapshotCount}`);
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
