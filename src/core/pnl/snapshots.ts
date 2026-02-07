import type {Tx, WalletCredentials, WalletSummary} from '../types';
import {
  formatAtomicAmount,
  formatBigIntDecimal,
  getAtomicDecimals,
  parseAtomicToBigint,
} from '../format';
import type {FiatRateSeriesCache} from '../fiatRateSeries';
import {createFiatRateLookup, normalizeFiatRateSeriesCoin} from './rates';
import type {
  BalanceSnapshotComputed,
  BalanceSnapshotEventType,
  BalanceSnapshotStored,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPRESSION_AGE_MS = 90 * DAY_MS;

// Scale used when converting bigint ratios to numbers.
// Must be <= 2^53 to keep Number(scaled) exact.
const RATIO_SCALE = 1_000_000_000_000n; // 1e12

export const getAssetIdFromWallet = (
  wallet: Pick<
    WalletSummary,
    'chain' | 'currencyAbbreviation' | 'tokenAddress'
  >,
): string => {
  const chain = (wallet.chain || '').toLowerCase();
  const coin = (wallet.currencyAbbreviation || '').toLowerCase();
  if (wallet.tokenAddress) {
    return `${chain}:${coin}:${wallet.tokenAddress.toLowerCase()}`;
  }
  return `${chain}:${coin}`;
};

export const extractTxIdFromSnapshotId = (
  snapshotId: string,
): string | null => {
  // Expected: tx:<walletId>:<txid>
  // (txid can itself contain ':' in our fallback ID format, so we join remaining parts)
  const parts = String(snapshotId || '').split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== 'tx') return null;
  const txid = parts.slice(2).join(':');
  return txid ? txid : null;
};

const toTxTimestampMs = (tx: Tx): number => {
  const raw = Number((tx as any)?.time);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // BWS history uses unix seconds; tolerate ms if already large.
  return raw < 1e12 ? raw * 1000 : raw;
};

const getTxId = (tx: Tx): string => {
  const id = String((tx as any)?.txid || (tx as any)?.id || '').trim();
  if (id) return id;
  // Worst-case fallback for txs without txid.
  return `${String((tx as any)?.time ?? '')}:${String(
    (tx as any)?.action ?? '',
  )}:${String((tx as any)?.amount ?? '')}:${String((tx as any)?.fees ?? '')}`;
};

const getTxBlockHeight = (tx: Tx): number | null => {
  const raw = Number(
    (tx as any)?.blockheight ??
      (tx as any)?.blockHeight ??
      (tx as any)?.block_height,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

const getTxTransactionIndex = (tx: Tx): number | null => {
  const raw = Number(
    (tx as any)?.receipt?.transactionIndex ?? (tx as any)?.transactionIndex,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const getTxNonce = (tx: Tx): number | null => {
  const raw = Number((tx as any)?.nonce);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const utcDayIndex = (tsMs: number): number => Math.floor(tsMs / DAY_MS);
const utcDayKeyFromIndex = (dayIdx: number): string =>
  new Date(dayIdx * DAY_MS).toISOString().slice(0, 10);

const bigIntAbs = (v: bigint): bigint => (v < 0n ? -v : v);

const parseNumberishToBigint = (v: any): bigint => {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;

  // IMPORTANT: Some sources provide large atomic/unit values as numbers.
  // Converting unsafe integers via BigInt(number) or BigInt(Math.trunc(number))
  // can drift by a few units due to IEEE-754 rounding. Reuse our atomic parser
  // to keep conversion consistent with JSON/string representations.
  if (typeof v === 'number') {
    try {
      return parseAtomicToBigint(v);
    } catch {
      return 0n;
    }
  }

  const s = String(v).trim();
  if (!s) return 0n;

  // Handle hex strings commonly found in EVM receipts.
  if (/^0x[0-9a-f]+$/i.test(s)) {
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  }

  // Decimal / integer strings (including scientific notation).
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

/**
 * OP Stack chains (Base, OP Mainnet, etc.) charge an additional "L1 data fee".
 * Many providers expose this as `receipt.l1Fee`.
 */
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

/**
 * Some OP Stack forks include an additional operator fee after certain upgrades.
 * When surfaced on the receipt, it should also be treated as a network fee.
 */
const getTxOperatorFeeAtomic = (tx: Tx): bigint => {
  const receipt = (tx as any)?.receipt;
  const opFee = parseNumberishToBigint(
    receipt?.operatorFee ?? receipt?.opFee ?? (tx as any)?.operatorFee,
  );
  return bigIntAbs(opFee);
};

/**
 * BWS sometimes reports EVM `fees` as `gasLimit * gasPrice` rather than
 * `gasUsed * effectiveGasPrice`, which can create balance mismatches.
 */
const computeTxNetworkFeeAtomic = (
  tx: Tx,
  extra?: {l1FeeAtomic?: bigint; operatorFeeAtomic?: bigint},
): bigint => {
  const receipt = (tx as any)?.receipt;
  const gasUsed = parseNumberishToBigint(receipt?.gasUsed);
  if (gasUsed > 0n) {
    const price = parseNumberishToBigint(
      receipt?.effectiveGasPrice ?? receipt?.gasPrice ?? (tx as any)?.gasPrice,
    );
    if (price > 0n) {
      const l2Fee = gasUsed * price;
      const l1Fee = extra?.l1FeeAtomic ?? getTxL1DataFeeAtomic(tx);
      const operatorFee =
        extra?.operatorFeeAtomic ?? getTxOperatorFeeAtomic(tx);
      return l2Fee + l1Fee + operatorFee;
    }
  }
  // Fallback: use the fee field as-is.
  return bigIntAbs(parseNumberishToBigint((tx as any)?.fees ?? 0));
};

/**
 * Detect the common BWS overestimation pattern where `fees` equals `gasLimit * gasPrice`
 * because the receipt (and therefore `gasUsed`) is missing.
 */
const getTxMaxFeeFromGasLimitAtomic = (tx: Tx): bigint | null => {
  const receipt = (tx as any)?.receipt;
  const gasUsed = parseNumberishToBigint(receipt?.gasUsed);
  if (gasUsed > 0n) return null;

  const gasLimit = parseNumberishToBigint(
    (tx as any)?.gasLimit ?? receipt?.gasLimit,
  );
  const gasPrice = parseNumberishToBigint(
    (tx as any)?.gasPrice ?? receipt?.gasPrice ?? receipt?.effectiveGasPrice,
  );
  const fees = bigIntAbs(parseNumberishToBigint((tx as any)?.fees ?? 0));

  if (gasLimit <= 0n || gasPrice <= 0n || fees <= 0n) return null;

  const maxFee = gasLimit * gasPrice;
  return fees === maxFee ? maxFee : null;
};

const looksLikeEvmAddress = (s: string): boolean => /^0x[0-9a-f]{40}$/i.test(s);

const normalizeAddress = (v: any): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return looksLikeEvmAddress(lower) ? lower : null;
};

const getTxFromAddress = (tx: Tx): string | null =>
  normalizeAddress(
    (tx as any)?.receipt?.from ?? (tx as any)?.from ?? (tx as any)?.addressFrom,
  );

const getTxToAddress = (tx: Tx): string | null =>
  normalizeAddress(
    (tx as any)?.receipt?.to ?? (tx as any)?.to ?? (tx as any)?.addressTo,
  );

const getTxEffects = (tx: Tx): any[] =>
  Array.isArray((tx as any)?.effects) ? (tx as any).effects : [];

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

  // Best-effort parsing (handles other hex/decimal strings).
  try {
    if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s) === 0n;
    return BigInt(s) === 0n;
  } catch {
    return false;
  }
};

type NormalizedTx = {
  tx: Tx;
  originalIndex: number;
  id: string;
  tsMs: number;
  blockHeight: number | null;
  txIndex: number | null;
  nonce: number | null;

  action: string;
  rawAmountAtomic: bigint;
  absAmountAtomic: bigint;
  failed: boolean;

  from: string | null;
  to: string | null;
  effectFroms: string[];
  effectTos: string[];
  receiptPresent: boolean;

  // Fee metadata (always absolute, atomic)
  l1FeeAtomic: bigint;
  operatorFeeAtomic: bigint;
  baseFeeAtomic: bigint;
  maxFeeAtomic: bigint | null;
};

const normalizeTx = (tx: Tx, originalIndex: number): NormalizedTx => {
  const id = getTxId(tx);
  const tsMs = toTxTimestampMs(tx);
  const blockHeight = getTxBlockHeight(tx);
  const txIndex = getTxTransactionIndex(tx);
  const nonce = getTxNonce(tx);

  const action = String((tx as any)?.action || '').toLowerCase();
  const rawAmountAtomic = parseAtomicToBigint((tx as any)?.amount ?? 0);
  const absAmountAtomic = bigIntAbs(rawAmountAtomic);
  const failed = isTxFailed(tx);

  const from = getTxFromAddress(tx);
  const to = getTxToAddress(tx);
  const effects = getTxEffects(tx);

  const effectFroms = Array.from(
    new Set(
      effects
        .map(e => normalizeAddress(e?.from))
        .filter((a): a is string => !!a),
    ),
  );
  const effectTos = Array.from(
    new Set(
      effects.map(e => normalizeAddress(e?.to)).filter((a): a is string => !!a),
    ),
  );

  const receiptPresent =
    (tx as any)?.receipt !== null && (tx as any)?.receipt !== undefined;
  const l1FeeAtomic = getTxL1DataFeeAtomic(tx);
  const operatorFeeAtomic = getTxOperatorFeeAtomic(tx);
  const baseFeeAtomic = computeTxNetworkFeeAtomic(tx, {
    l1FeeAtomic,
    operatorFeeAtomic,
  });
  const maxFeeAtomic = getTxMaxFeeFromGasLimitAtomic(tx);

  return {
    tx,
    originalIndex,
    id,
    tsMs,
    blockHeight,
    txIndex,
    nonce,
    action,
    rawAmountAtomic,
    absAmountAtomic,
    failed,
    from,
    to,
    effectFroms,
    effectTos,
    receiptPresent,
    l1FeeAtomic,
    operatorFeeAtomic,
    baseFeeAtomic,
    maxFeeAtomic,
  };
};

const normalizeTxs = (txs: Tx[]): NormalizedTx[] =>
  txs.map((tx, i) => normalizeTx(tx, i));

const sortAndDedupeTxs = (txs: NormalizedTx[]): NormalizedTx[] => {
  const INF = Number.POSITIVE_INFINITY;

  // Sort ascending (time -> blockheight -> tx index -> nonce -> original order).
  // IMPORTANT: we intentionally avoid using txid lexicographic ordering as a tie-breaker because it can scramble
  // same-block transactions (same timestamp) and create temporary balance underflows that don't exist on-chain.
  const sorted = txs.slice().sort((a, b) => {
    if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;

    const bha = a.blockHeight ?? INF;
    const bhb = b.blockHeight ?? INF;
    if (bha !== bhb) return bha - bhb;

    const ia = a.txIndex ?? INF;
    const ib = b.txIndex ?? INF;
    if (ia !== ib) return ia - ib;

    if (a.nonce !== null && b.nonce !== null && a.nonce !== b.nonce) {
      return a.nonce - b.nonce;
    }

    return a.originalIndex - b.originalIndex;
  });

  const deduped: NormalizedTx[] = [];
  const seen = new Set<string>();
  for (const ntx of sorted) {
    if (!ntx.id) continue;
    if (seen.has(ntx.id)) continue;
    seen.add(ntx.id);
    deduped.push(ntx);
  }
  return deduped;
};

const isEvmChain = (chain: string): boolean => {
  const c = (chain || '').toLowerCase();
  // Best-effort: allow unknown chains to still behave correctly if history contains EVM-style addresses.
  return [
    'eth',
    'ethereum',
    'matic',
    'polygon',
    'pol',
    'arb',
    'arbitrum',
    'op',
    'optimism',
    'base',
    'bsc',
    'bnb',
    'avax',
    'avalanche',
    'ftm',
    'fantom',
    'linea',
    'zksync',
    'scroll',
  ].includes(c);
};

const isOpStackChain = (chain: string): boolean => {
  const c = (chain || '').toLowerCase();
  return c === 'base' || c === 'op' || c === 'optimism';
};

/**
 * Infer the wallet-controlled EVM addresses from tx history.
 */
const inferWalletEvmAddresses = (txs: NormalizedTx[]): Set<string> => {
  const addrs = new Set<string>();

  for (const tx of txs) {
    const {
      action,
      rawAmountAtomic,
      absAmountAtomic,
      from,
      to,
      effectFroms,
      effectTos,
    } = tx;

    if (action === 'sent' || action === 'moved') {
      if (from) addrs.add(from);
      for (const ef of effectFroms) addrs.add(ef);
      continue;
    }

    if (action === 'received') {
      // If native amount > 0, the wallet is the receiver.
      if (absAmountAtomic > 0n) {
        if (to) addrs.add(to);
      }
      // For token events (native amount == 0), BWS usually includes an `effects` entry
      // whose `to` field is the wallet-controlled address.
      for (const et of effectTos) addrs.add(et);
      continue;
    }

    // Unknown action: best-effort from/to hints.
    // This is intentionally conservative (we don't want to accidentally treat external senders as "ours").
    if (rawAmountAtomic > 0n && to) addrs.add(to);
  }

  return addrs;
};

const isTxFeePaidByWallet = (
  tx: NormalizedTx,
  walletEvmAddresses: Set<string> | null,
): boolean => {
  // If we couldn't infer any wallet-controlled EVM addresses, fall back to legacy behavior
  // (assume fees affect native balance). This preserves behavior for non-EVM chains and
  // for sparse EVM histories where `from/to` fields are missing everywhere.
  if (!walletEvmAddresses || walletEvmAddresses.size === 0) return true;

  if (tx.from) return walletEvmAddresses.has(tx.from);

  // For BWS histories, `action: "sent" | "moved"` is already relative to the wallet.
  // If `from` is missing (receipt omitted), treating the fee payer as "unknown" causes us
  // to skip applying gas for wallet-initiated contract calls (e.g. ERC20 approve), which
  // creates a permanent native-balance mismatch.
  if (tx.action === 'sent' || tx.action === 'moved') return true;

  // Some BWS history entries omit `receipt.from` / `from` even when they include `fees`.
  // In those cases, applying fees unconditionally can create a balance mismatch if the
  // fee payer is actually an external address (common for token transfers affecting this wallet).
  //
  // Best-effort: if there is exactly one `effects[].from` address, treat it as a proxy for the
  // tx initiator; otherwise, be conservative and assume the wallet did NOT pay the fee.
  if (tx.effectFroms.length === 1)
    return walletEvmAddresses.has(tx.effectFroms[0]);

  return false;
};

type TxFlow = {
  inflowAtomic: bigint;
  outflowAtomic: bigint;
  acquisitionAtomic: bigint;
};

const classifyTxFlow = (
  tx: NormalizedTx,
  opts: {
    applyFeesToBalance: boolean;
    feePaidByWallet: boolean;
    feeAtomic: bigint;
  },
): TxFlow => {
  const amount = tx.failed ? 0n : tx.absAmountAtomic;
  const fees =
    opts.applyFeesToBalance && opts.feePaidByWallet
      ? bigIntAbs(opts.feeAtomic)
      : 0n;

  // On EVM chains, a mined transaction with receipt.status = false/0 reverted.
  // In that case, *value transfers do not occur* but the network fee is still paid.
  if (tx.failed) {
    return {inflowAtomic: 0n, outflowAtomic: fees, acquisitionAtomic: 0n};
  }

  switch (tx.action) {
    case 'received': {
      // Some account-based chains include fee info on "received" txs. If amount==0 but fees>0,
      // treat as fee-only outflow (contract interactions / token transfers).
      if (amount === 0n && fees > 0n) {
        return {inflowAtomic: 0n, outflowAtomic: fees, acquisitionAtomic: 0n};
      }
      return {
        inflowAtomic: amount,
        outflowAtomic: 0n,
        acquisitionAtomic: amount,
      };
    }
    case 'sent':
      return {
        inflowAtomic: 0n,
        outflowAtomic: amount + fees,
        acquisitionAtomic: 0n,
      };
    case 'moved':
      return {inflowAtomic: 0n, outflowAtomic: fees, acquisitionAtomic: 0n};
    default: {
      // Fallback inference
      if (tx.rawAmountAtomic > 0n) {
        return {
          inflowAtomic: amount,
          outflowAtomic: 0n,
          acquisitionAtomic: amount,
        };
      }
      if (tx.rawAmountAtomic < 0n) {
        return {
          inflowAtomic: 0n,
          outflowAtomic: amount + fees,
          acquisitionAtomic: 0n,
        };
      }
      if (fees > 0n) {
        return {inflowAtomic: 0n, outflowAtomic: fees, acquisitionAtomic: 0n};
      }
      return {inflowAtomic: 0n, outflowAtomic: 0n, acquisitionAtomic: 0n};
    }
  }
};

const reorderTxBatchToPreventUnderflow = (
  batch: NormalizedTx[],
  startingBalanceAtomic: bigint,
  getDeltaAtomic: (tx: NormalizedTx) => bigint,
): NormalizedTx[] => {
  if (batch.length <= 1) return batch;

  // Cheap early-out: if the base ordering never underflows, keep it untouched.
  let bal = startingBalanceAtomic;
  let underflows = false;
  for (const tx of batch) {
    bal += getDeltaAtomic(tx);
    if (bal < 0n) {
      underflows = true;
      break;
    }
  }
  if (!underflows) return batch;

  // Greedy reordering: pick the earliest tx that doesn't underflow the running balance.
  bal = startingBalanceAtomic;
  const remaining = batch.slice();
  const ordered: NormalizedTx[] = [];

  while (remaining.length) {
    let pickIndex = -1;

    for (let i = 0; i < remaining.length; i++) {
      const d = getDeltaAtomic(remaining[i]);
      if (bal + d >= 0n) {
        pickIndex = i;
        break;
      }
    }

    if (pickIndex === -1) {
      // No feasible ordering to avoid underflow; keep original order unchanged.
      return batch;
    }

    const [tx] = remaining.splice(pickIndex, 1);
    const d = getDeltaAtomic(tx);
    ordered.push(tx);
    bal = bal + d;
  }

  return ordered;
};

const safeRatioToNumber = (numerator: bigint, denominator: bigint): number => {
  if (denominator === 0n) return 0;
  const n = bigIntAbs(numerator);
  const d = bigIntAbs(denominator);
  // ratioScaled is <= RATIO_SCALE, so converting to number is safe.
  const ratioScaled = (n * RATIO_SCALE) / d;
  return Number(ratioScaled) / Number(RATIO_SCALE);
};

const clampNonNegative = (n: number): number => (n < 0 ? 0 : n);

const atomicToUnitNumber = (atomic: bigint, decimals: number): number => {
  if (atomic === 0n) return 0;
  // Use a string-based conversion to avoid Number() overflow where possible.
  const s = formatBigIntDecimal(atomic, decimals, Math.min(decimals, 18));
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

export const computeBalanceSnapshotComputed = (
  s: BalanceSnapshotStored,
  credentials: WalletCredentials,
  prevSnapshot?: BalanceSnapshotStored | null,
): BalanceSnapshotComputed => {
  const decimals = getAtomicDecimals(credentials);
  const atomic = parseAtomicToBigint(s.cryptoBalance);
  const unitsHeld = atomicToUnitNumber(atomic, decimals);

  const prevAtomic = prevSnapshot
    ? parseAtomicToBigint(prevSnapshot.cryptoBalance)
    : 0n;
  const balanceDeltaAtomic = (atomic - prevAtomic).toString();

  const formattedCryptoBalance = formatAtomicAmount(atomic, credentials);

  const markRate = s.markRate;
  const fiatBalance = Number.isFinite(markRate) ? unitsHeld * markRate : NaN;

  const avgCostFiatPerUnit =
    unitsHeld > 0 ? s.remainingCostBasisFiat / unitsHeld : 0;
  const unrealizedPnlFiat = fiatBalance - s.remainingCostBasisFiat;

  return {
    ...s,
    balanceDeltaAtomic,
    avgCostFiatPerUnit,
    formattedCryptoBalance,
    fiatBalance,
    unrealizedPnlFiat,
  };
};

export type BuildBalanceSnapshotsArgs = {
  wallet: WalletSummary;
  credentials: WalletCredentials;
  txs: Tx[];
  quoteCurrency: string;
  fiatRateSeriesCache: FiatRateSeriesCache;
  // If provided, new snapshots are built strictly AFTER this snapshot (no duplication),
  // starting from its balance + remaining cost basis.
  latestSnapshot?: BalanceSnapshotStored | null;
  compression?: {
    enabled: boolean;
  };
  nowMs?: number;
  // Optional progress callback (called at most every ~250 txs).
  onProgress?: (p: {processed: number; total: number}) => void;
};

export type BuildBalanceSnapshotsAsyncOpts = {
  // Yield control to the event loop every N processed txs.
  // Helps keep the JS thread responsive in RN/browser.
  yieldEvery?: number;
};

type TxGroup = {
  eventType: BalanceSnapshotEventType;
  txs: NormalizedTx[];
  // Only set when eventType === 'daily'
  dayIdx?: number;
};

type FeeEstimate = {txid: string; maxFeeAtomic: bigint};
type UnderFeeCandidate = {
  txid: string;
  baseFeeAtomic: bigint;
  maxExtraAtomic: bigint;
};

type PreparedTxHistory = {
  walletId: string;
  chain: string;
  coin: string;
  network: string;
  assetId: string;

  applyFeesToBalance: boolean;
  compressionEnabled: boolean;

  decimals: number;
  nowMs: number;

  // Monotonic base ordering.
  dedupedSorted: NormalizedTx[];
  // Cursor-applied slice of dedupedSorted.
  toProcessBase: NormalizedTx[];

  // Fee payer inference (EVM only)
  walletEvmAddresses: Set<string> | null;

  // OP Stack fee reconciliation info
  isOpStackChain: boolean;
  historyHasOpStackL1FeeField: boolean;
};

const getLatestSnapshotTxIds = (
  latestSnapshot: BalanceSnapshotStored | null,
): string[] => {
  if (!latestSnapshot) return [];
  if (latestSnapshot.eventType === 'daily') {
    const anySnap: any = latestSnapshot as any;
    const ids = (latestSnapshot.txIds || anySnap.txids) as unknown;
    return Array.isArray(ids) ? ids.map(String) : [];
  }
  const txid = extractTxIdFromSnapshotId(latestSnapshot.id);
  return txid ? [txid] : [];
};

const prepareTxHistory = (
  args: BuildBalanceSnapshotsArgs,
): PreparedTxHistory => {
  const {wallet, credentials, latestSnapshot = null, compression} = args;

  const nowMs = args.nowMs ?? Date.now();
  const decimals = getAtomicDecimals(credentials);

  const walletId = String(wallet.walletId);
  const chain = String(wallet.chain || '').toLowerCase();
  const coin = String(wallet.currencyAbbreviation || '').toLowerCase();
  const network = String(wallet.network || '').toLowerCase();
  const assetId = getAssetIdFromWallet(wallet);

  // Network fees (gas / miner fees) only affect the native asset balance. For token wallets
  // (tokenAddress set), the wallet's balance is the token amount, and EVM fees are paid in
  // the native coin, so we must ignore `fees` for balance math.
  const applyFeesToBalance = !wallet.tokenAddress;
  const compressionEnabled = !!compression?.enabled;

  // Normalize once, then sort+dedupe once.
  const normalized = normalizeTxs(args.txs || []);
  const dedupedSorted = sortAndDedupeTxs(normalized);

  // For EVM-style chains, infer the set of wallet-controlled addresses from history.
  // We use this to decide whether a tx's `fees` should affect the native-coin balance.
  let walletEvmAddresses: Set<string> | null = null;
  if (applyFeesToBalance) {
    const hasEvmSignals =
      isEvmChain(chain) ||
      dedupedSorted.some(
        tx =>
          !!tx.from ||
          !!tx.to ||
          tx.effectFroms.length > 0 ||
          tx.effectTos.length > 0,
      );
    walletEvmAddresses = hasEvmSignals
      ? inferWalletEvmAddresses(dedupedSorted)
      : null;
  }

  // Cursor logic: find the index in the *base sorted list* corresponding to latestSnapshot.
  let cursorIndex = -1;
  const latestTs = latestSnapshot?.timestamp ?? -Infinity;

  if (latestSnapshot) {
    const latestTxIdList = getLatestSnapshotTxIds(latestSnapshot);

    const indexByTxid = new Map<string, number>();
    for (let i = 0; i < dedupedSorted.length; i++) {
      indexByTxid.set(dedupedSorted[i].id, i);
    }

    for (const id of latestTxIdList) {
      const idx = indexByTxid.get(id);
      if (idx !== undefined) cursorIndex = Math.max(cursorIndex, idx);
    }

    // IMPORTANT: the processing order can differ from the base sorted order.
    // We sometimes reorder txs that share the same timestamp (+ blockheight) to avoid temporary
    // balance underflows. If the latest snapshot is a tx snapshot, it might correspond to a tx
    // that is not last in the base list for that timestamp/block group.
    //
    // Fix: advance the cursor to the end of the timestamp+block group in the base sorted list.
    if (cursorIndex >= 0 && latestSnapshot.eventType === 'tx') {
      const cursorTx = dedupedSorted[cursorIndex];
      const ts0 = cursorTx.tsMs;
      if (ts0 > 0) {
        const bh0 = cursorTx.blockHeight;
        let end = cursorIndex;
        for (let i = cursorIndex + 1; i < dedupedSorted.length; i++) {
          const t = dedupedSorted[i];
          if (t.tsMs !== ts0) break;
          if (t.blockHeight !== bh0) break;
          end = i;
        }
        cursorIndex = end;
      }
    }

    // Fallback when cursor txids aren't present in history (stale snapshots or pruned history).
    // We intentionally require STRICTLY greater timestamps here to avoid duplicating same-timestamp txs.
    if (cursorIndex === -1 && Number.isFinite(latestTs)) {
      for (let i = 0; i < dedupedSorted.length; i++) {
        const ts = dedupedSorted[i].tsMs;
        if (ts > latestTs) {
          cursorIndex = i - 1;
          break;
        }
      }
      if (cursorIndex === -1) cursorIndex = dedupedSorted.length - 1;
    }
  }

  const toProcessBase =
    cursorIndex >= 0 ? dedupedSorted.slice(cursorIndex + 1) : dedupedSorted;

  const opStack = isOpStackChain(chain);
  const historyHasOpStackL1FeeField = opStack
    ? dedupedSorted.some(tx => tx.l1FeeAtomic > 0n || tx.operatorFeeAtomic > 0n)
    : false;

  return {
    walletId,
    chain,
    coin,
    network,
    assetId,
    applyFeesToBalance,
    compressionEnabled,
    decimals,
    nowMs,
    dedupedSorted,
    toProcessBase,
    walletEvmAddresses,
    isOpStackChain: opStack,
    historyHasOpStackL1FeeField,
  };
};

const reorderTxsToPreventUnderflow = (
  txs: NormalizedTx[],
  startingBalanceAtomic: bigint,
  getDeltaAtomic: (tx: NormalizedTx) => bigint,
): NormalizedTx[] => {
  const out: NormalizedTx[] = [];
  let simBalanceAtomic = startingBalanceAtomic;

  for (let i = 0; i < txs.length; ) {
    const ts = txs[i].tsMs;
    const bh = txs[i].blockHeight;

    let j = i + 1;
    while (j < txs.length) {
      const t2 = txs[j];
      if (t2.tsMs !== ts) break;
      if (t2.blockHeight !== bh) break;
      j++;
    }

    const batch = txs.slice(i, j);
    const orderedBatch = reorderTxBatchToPreventUnderflow(
      batch,
      simBalanceAtomic,
      getDeltaAtomic,
    );

    for (const tx of orderedBatch) {
      out.push(tx);

      // Simulate balance evolution with "no negative balances" semantics (matches applyOutflow clamping).
      simBalanceAtomic += getDeltaAtomic(tx);
      if (simBalanceAtomic < 0n) simBalanceAtomic = 0n;
    }

    i = j;
  }

  return out;
};

const groupTxsForCompression = (
  txsOrdered: NormalizedTx[],
  nowMs: number,
  compressionEnabled: boolean,
): TxGroup[] => {
  const groups: TxGroup[] = [];
  if (!compressionEnabled) {
    for (const tx of txsOrdered) groups.push({eventType: 'tx', txs: [tx]});
    return groups;
  }

  const cutoffMs = nowMs - COMPRESSION_AGE_MS;
  let curDayIdx: number | null = null;
  let curDayTxs: NormalizedTx[] = [];

  const flushDaily = () => {
    if (!curDayTxs.length) return;
    if (curDayTxs.length === 1) {
      groups.push({eventType: 'tx', txs: [curDayTxs[0]]});
    } else {
      groups.push({
        eventType: 'daily',
        txs: curDayTxs,
        dayIdx: curDayIdx ?? undefined,
      });
    }
    curDayTxs = [];
    curDayIdx = null;
  };

  for (const tx of txsOrdered) {
    const ts = tx.tsMs;

    if (ts && ts < cutoffMs) {
      const dayIdx = utcDayIndex(ts);
      if (curDayIdx !== null && dayIdx !== curDayIdx) {
        flushDaily();
      }
      curDayIdx = dayIdx;
      curDayTxs.push(tx);
      continue;
    }

    flushDaily();
    groups.push({eventType: 'tx', txs: [tx]});
  }
  flushDaily();

  return groups;
};

type SimulationResult = {
  out: BalanceSnapshotStored[];
  endBalanceAtomic: bigint;
  feeEstimates: FeeEstimate[];
  underFeeCandidates: UnderFeeCandidate[];
};

const simulateSnapshotsSync = (
  args: BuildBalanceSnapshotsArgs,
  prepared: PreparedTxHistory,
  feeOverrides?: Map<string, bigint> | null,
  collectFeeEstimates?: boolean,
): SimulationResult => {
  const {
    quoteCurrency,
    fiatRateSeriesCache,
    latestSnapshot = null,
    onProgress,
  } = args;
  const {
    walletId,
    chain,
    coin,
    network,
    assetId,
    applyFeesToBalance,
    compressionEnabled,
    decimals,
    nowMs,
    toProcessBase,
    walletEvmAddresses,
    isOpStackChain,
    historyHasOpStackL1FeeField,
  } = prepared;

  // Starting state (for incremental updates).
  let balanceAtomic = latestSnapshot
    ? parseAtomicToBigint(latestSnapshot.cryptoBalance)
    : 0n;
  let remainingCostBasisFiat = latestSnapshot
    ? Number(latestSnapshot.remainingCostBasisFiat || 0)
    : 0;
  if (!Number.isFinite(remainingCostBasisFiat) || remainingCostBasisFiat < 0) {
    remainingCostBasisFiat = 0;
  }

  const rateCoin = normalizeFiatRateSeriesCoin(coin);
  const rateLookup = createFiatRateLookup({
    quoteCurrency,
    coin: rateCoin,
    cache: fiatRateSeriesCache,
    nowMs,
  });

  const feePaidByWallet = (tx: NormalizedTx): boolean =>
    applyFeesToBalance ? isTxFeePaidByWallet(tx, walletEvmAddresses) : false;

  const getFeeAtomic = (tx: NormalizedTx): bigint => {
    if (!applyFeesToBalance) return 0n;
    const override = feeOverrides?.get(tx.id);
    return override !== undefined ? override : tx.baseFeeAtomic;
  };

  const getDeltaAtomic = (tx: NormalizedTx): bigint => {
    const flow = classifyTxFlow(tx, {
      applyFeesToBalance,
      feePaidByWallet: feePaidByWallet(tx),
      feeAtomic: getFeeAtomic(tx),
    });
    return flow.inflowAtomic - flow.outflowAtomic;
  };

  // 1) Reorder txs that share the same timestamp (+ blockheight) to avoid temporary underflows.
  const toProcessOrdered = reorderTxsToPreventUnderflow(
    toProcessBase,
    balanceAtomic,
    getDeltaAtomic,
  );

  // 2) Group txs for optional daily compression (older than 90 days).
  const groups = groupTxsForCompression(
    toProcessOrdered,
    nowMs,
    compressionEnabled,
  );

  // 3) Apply each group, producing a snapshot for each tx (or each day if compressed).
  const out: BalanceSnapshotStored[] = [];
  const totalTxs = toProcessOrdered.length;
  let processedTxs = 0;

  const feeEstimates: FeeEstimate[] = [];
  const underFeeCandidates: UnderFeeCandidate[] = [];

  const applyInflow = (amountIn: bigint, markRate: number) => {
    if (amountIn <= 0n) return;
    balanceAtomic += amountIn;

    // Add cost basis at acquisition price (avg cost basis uses this to accumulate total basis).
    const units = atomicToUnitNumber(amountIn, decimals);
    remainingCostBasisFiat += units * markRate;
  };

  const applyOutflow = (amountOut: bigint) => {
    if (amountOut <= 0n) return;
    if (balanceAtomic <= 0n) {
      // Nothing to dispose; keep balance at 0 and basis at 0.
      balanceAtomic = 0n;
      remainingCostBasisFiat = 0;
      return;
    }

    const dispose = amountOut > balanceAtomic ? balanceAtomic : amountOut;
    const ratio = safeRatioToNumber(dispose, balanceAtomic); // proportion of units disposed
    remainingCostBasisFiat -= remainingCostBasisFiat * ratio;
    remainingCostBasisFiat = clampNonNegative(remainingCostBasisFiat);

    balanceAtomic -= dispose;
    if (balanceAtomic === 0n) {
      remainingCostBasisFiat = 0;
    }
  };

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const txIds: string[] = [];

    let lastTs = 0;
    let lastRate: number | undefined;

    for (const tx of g.txs) {
      txIds.push(tx.id);
      const ts = tx.tsMs;

      const markRate = rateLookup.getNearestRate(ts);
      if (markRate === undefined) {
        // This is a hard dependency for inflows and for meaningful valuation.
        throw new Error(
          `Missing cached rate for ${quoteCurrency.toUpperCase()}:${rateCoin} at ts=${ts}ms. Fetch rates first (1D/1W/1M/ALL).`,
        );
      }

      lastTs = ts;
      lastRate = markRate;

      const feePaid = feePaidByWallet(tx);
      const feeAtomic = getFeeAtomic(tx);

      if (
        collectFeeEstimates &&
        feePaid &&
        applyFeesToBalance &&
        feeAtomic > 0n
      ) {
        const maxFee = tx.maxFeeAtomic;
        if (maxFee && maxFee > 0n) {
          feeEstimates.push({txid: tx.id, maxFeeAtomic: maxFee});
        }
      }

      // OP Stack chains charge an extra L1 data fee (and sometimes an operator fee).
      // Some providers omit these receipt fields for certain txs, causing us to undercount fees
      // and end up with a higher-than-actual running balance.
      if (
        collectFeeEstimates &&
        isOpStackChain &&
        historyHasOpStackL1FeeField &&
        applyFeesToBalance &&
        feePaid &&
        feeAtomic > 0n
      ) {
        const receiptPresent = tx.receiptPresent;
        const l1 = tx.l1FeeAtomic;
        const opFee = tx.operatorFeeAtomic;

        // Candidate: likely missing L1/OP fee fields (common when receipt is absent).
        if (!receiptPresent || (l1 === 0n && opFee === 0n)) {
          // Cap how much extra we can allocate to a single tx to avoid masking unrelated data issues.
          // L1 data fees can exceed L2 fees, so keep this generous.
          const maxExtraAtomic = feeAtomic * 100n;
          underFeeCandidates.push({
            txid: tx.id,
            baseFeeAtomic: feeAtomic,
            maxExtraAtomic,
          });
        }
      }

      const flow = classifyTxFlow(tx, {
        applyFeesToBalance,
        feePaidByWallet: feePaid,
        feeAtomic,
      });
      applyInflow(flow.acquisitionAtomic, markRate);
      applyOutflow(flow.outflowAtomic);

      processedTxs++;
      if (
        onProgress &&
        (processedTxs % 250 === 0 || processedTxs === totalTxs)
      ) {
        onProgress({processed: processedTxs, total: totalTxs});
      }
    }

    // Snapshot timestamp is the last tx timestamp in the group.
    const timestamp = lastTs;
    const markRate = lastRate ?? NaN;

    const eventType: BalanceSnapshotEventType = g.eventType;

    const id =
      eventType === 'tx'
        ? `tx:${walletId}:${txIds[0] ?? timestamp}`
        : `daily:${walletId}:${utcDayKeyFromIndex(
            g.dayIdx ?? utcDayIndex(timestamp),
          )}`;

    const base: BalanceSnapshotStored = {
      id,
      walletId,
      chain,
      coin,
      network,
      assetId,
      timestamp,
      eventType,
      cryptoBalance: balanceAtomic.toString(),
      remainingCostBasisFiat,
      quoteCurrency: quoteCurrency.toUpperCase(),
      markRate,
      createdAt: nowMs,

      // txIds is only included for daily snapshots (where multiple txs are collapsed).
      ...(eventType === 'daily' ? {txIds} : {}),
    };

    out.push(base);
  }

  return {
    out,
    endBalanceAtomic: balanceAtomic,
    feeEstimates,
    underFeeCandidates,
  };
};

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

const simulateSnapshotsAsync = async (
  args: BuildBalanceSnapshotsArgs,
  prepared: PreparedTxHistory,
  feeOverrides: Map<string, bigint> | null,
  collectFeeEstimates: boolean,
  asyncOpts: BuildBalanceSnapshotsAsyncOpts,
): Promise<SimulationResult> => {
  const {
    quoteCurrency,
    fiatRateSeriesCache,
    latestSnapshot = null,
    onProgress,
  } = args;
  const {
    walletId,
    chain,
    coin,
    network,
    assetId,
    applyFeesToBalance,
    compressionEnabled,
    decimals,
    nowMs,
    toProcessBase,
    walletEvmAddresses,
    isOpStackChain,
    historyHasOpStackL1FeeField,
  } = prepared;

  const yieldEvery = Math.max(1, Math.floor(asyncOpts.yieldEvery ?? 1000));

  // Starting state (for incremental updates).
  let balanceAtomic = latestSnapshot
    ? parseAtomicToBigint(latestSnapshot.cryptoBalance)
    : 0n;
  let remainingCostBasisFiat = latestSnapshot
    ? Number(latestSnapshot.remainingCostBasisFiat || 0)
    : 0;
  if (!Number.isFinite(remainingCostBasisFiat) || remainingCostBasisFiat < 0) {
    remainingCostBasisFiat = 0;
  }

  const rateCoin = normalizeFiatRateSeriesCoin(coin);
  const rateLookup = createFiatRateLookup({
    quoteCurrency,
    coin: rateCoin,
    cache: fiatRateSeriesCache,
    nowMs,
  });

  const feePaidByWallet = (tx: NormalizedTx): boolean =>
    applyFeesToBalance ? isTxFeePaidByWallet(tx, walletEvmAddresses) : false;

  const getFeeAtomic = (tx: NormalizedTx): bigint => {
    if (!applyFeesToBalance) return 0n;
    const override = feeOverrides?.get(tx.id);
    return override !== undefined ? override : tx.baseFeeAtomic;
  };

  const getDeltaAtomic = (tx: NormalizedTx): bigint => {
    const flow = classifyTxFlow(tx, {
      applyFeesToBalance,
      feePaidByWallet: feePaidByWallet(tx),
      feeAtomic: getFeeAtomic(tx),
    });
    return flow.inflowAtomic - flow.outflowAtomic;
  };

  // 1) Reorder txs that share the same timestamp (+ blockheight) to avoid temporary underflows.
  const toProcessOrdered = reorderTxsToPreventUnderflow(
    toProcessBase,
    balanceAtomic,
    getDeltaAtomic,
  );

  // 2) Group txs for optional daily compression (older than 90 days).
  const groups = groupTxsForCompression(
    toProcessOrdered,
    nowMs,
    compressionEnabled,
  );

  // 3) Apply each group, producing a snapshot for each tx (or each day if compressed).
  const out: BalanceSnapshotStored[] = [];
  const totalTxs = toProcessOrdered.length;
  let processedTxs = 0;

  const feeEstimates: FeeEstimate[] = [];
  const underFeeCandidates: UnderFeeCandidate[] = [];

  const applyInflow = (amountIn: bigint, markRate: number) => {
    if (amountIn <= 0n) return;
    balanceAtomic += amountIn;

    // Add cost basis at acquisition price (avg cost basis uses this to accumulate total basis).
    const units = atomicToUnitNumber(amountIn, decimals);
    remainingCostBasisFiat += units * markRate;
  };

  const applyOutflow = (amountOut: bigint) => {
    if (amountOut <= 0n) return;
    if (balanceAtomic <= 0n) {
      // Nothing to dispose; keep balance at 0 and basis at 0.
      balanceAtomic = 0n;
      remainingCostBasisFiat = 0;
      return;
    }

    const dispose = amountOut > balanceAtomic ? balanceAtomic : amountOut;
    const ratio = safeRatioToNumber(dispose, balanceAtomic); // proportion of units disposed
    remainingCostBasisFiat -= remainingCostBasisFiat * ratio;
    remainingCostBasisFiat = clampNonNegative(remainingCostBasisFiat);

    balanceAtomic -= dispose;
    if (balanceAtomic === 0n) {
      remainingCostBasisFiat = 0;
    }
  };

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const txIds: string[] = [];

    let lastTs = 0;
    let lastRate: number | undefined;

    for (const tx of g.txs) {
      txIds.push(tx.id);
      const ts = tx.tsMs;

      const markRate = rateLookup.getNearestRate(ts);
      if (markRate === undefined) {
        throw new Error(
          `Missing cached rate for ${quoteCurrency.toUpperCase()}:${rateCoin} at ts=${ts}ms. Fetch rates first (1D/1W/1M/ALL).`,
        );
      }

      lastTs = ts;
      lastRate = markRate;

      const feePaid = feePaidByWallet(tx);
      const feeAtomic = getFeeAtomic(tx);

      if (
        collectFeeEstimates &&
        feePaid &&
        applyFeesToBalance &&
        feeAtomic > 0n
      ) {
        const maxFee = tx.maxFeeAtomic;
        if (maxFee && maxFee > 0n) {
          feeEstimates.push({txid: tx.id, maxFeeAtomic: maxFee});
        }
      }

      if (
        collectFeeEstimates &&
        isOpStackChain &&
        historyHasOpStackL1FeeField &&
        applyFeesToBalance &&
        feePaid &&
        feeAtomic > 0n
      ) {
        const receiptPresent = tx.receiptPresent;
        const l1 = tx.l1FeeAtomic;
        const opFee = tx.operatorFeeAtomic;
        if (!receiptPresent || (l1 === 0n && opFee === 0n)) {
          const maxExtraAtomic = feeAtomic * 100n;
          underFeeCandidates.push({
            txid: tx.id,
            baseFeeAtomic: feeAtomic,
            maxExtraAtomic,
          });
        }
      }

      const flow = classifyTxFlow(tx, {
        applyFeesToBalance,
        feePaidByWallet: feePaid,
        feeAtomic,
      });
      applyInflow(flow.acquisitionAtomic, markRate);
      applyOutflow(flow.outflowAtomic);

      processedTxs++;
      if (
        onProgress &&
        (processedTxs % 250 === 0 || processedTxs === totalTxs)
      ) {
        onProgress({processed: processedTxs, total: totalTxs});
      }

      if (processedTxs % yieldEvery === 0) {
        await yieldToEventLoop();
      }
    }

    const timestamp = lastTs;
    const markRate = lastRate ?? NaN;

    const eventType: BalanceSnapshotEventType = g.eventType;

    const id =
      eventType === 'tx'
        ? `tx:${walletId}:${txIds[0] ?? timestamp}`
        : `daily:${walletId}:${utcDayKeyFromIndex(
            g.dayIdx ?? utcDayIndex(timestamp),
          )}`;

    const base: BalanceSnapshotStored = {
      id,
      walletId,
      chain,
      coin,
      network,
      assetId,
      timestamp,
      eventType,
      cryptoBalance: balanceAtomic.toString(),
      remainingCostBasisFiat,
      quoteCurrency: quoteCurrency.toUpperCase(),
      markRate,
      createdAt: nowMs,
      ...(eventType === 'daily' ? {txIds} : {}),
    };

    out.push(base);

    // Also yield between groups on large wallets (daily groups can be big).
    if (gi % 25 === 0) {
      await yieldToEventLoop();
    }
  }

  return {
    out,
    endBalanceAtomic: balanceAtomic,
    feeEstimates,
    underFeeCandidates,
  };
};

export function buildBalanceSnapshots(
  args: BuildBalanceSnapshotsArgs,
): BalanceSnapshotStored[] {
  const prepared = prepareTxHistory(args);
  const first = simulateSnapshotsSync(args, prepared, null, true);

  // Optional reconciliation using wallet.balanceAtomic as an anchor.
  if (prepared.applyFeesToBalance) {
    let targetBalanceAtomic: bigint | null = null;
    try {
      targetBalanceAtomic = parseAtomicToBigint(
        (args.wallet as any)?.balanceAtomic ?? '',
      );
    } catch {
      targetBalanceAtomic = null;
    }

    if (targetBalanceAtomic !== null && targetBalanceAtomic >= 0n) {
      const computed = first.endBalanceAtomic;
      const delta = targetBalanceAtomic - computed;

      // 1) Reduce gasLimit-based max fees (delta > 0 means our computed balance is too LOW).
      if (delta > 0n && first.feeEstimates.length > 0) {
        const maxPossible = first.feeEstimates.reduce(
          (acc, e) => acc + e.maxFeeAtomic,
          0n,
        );

        if (delta <= maxPossible) {
          let remaining = delta;
          const overrides = new Map<string, bigint>();

          // Adjust the *latest* estimated-fee txs first to minimize distortion of earlier snapshots.
          for (
            let i = first.feeEstimates.length - 1;
            i >= 0 && remaining > 0n;
            i--
          ) {
            const e = first.feeEstimates[i];
            const reduce =
              remaining < e.maxFeeAtomic ? remaining : e.maxFeeAtomic;
            const corrected = e.maxFeeAtomic - reduce;
            overrides.set(e.txid, corrected);
            remaining -= reduce;
          }

          if (overrides.size > 0) {
            return simulateSnapshotsSync(args, prepared, overrides, false).out;
          }
        }
      }

      // 2) Allocate missing OP Stack L1/operator fees (delta < 0 means our computed balance is too HIGH).
      if (
        delta < 0n &&
        prepared.historyHasOpStackL1FeeField &&
        first.underFeeCandidates.length > 0
      ) {
        let remaining = -delta;
        const overrides = new Map<string, bigint>();

        // Allocate to the *latest* candidates first (minimizes earlier snapshot distortion).
        for (
          let i = first.underFeeCandidates.length - 1;
          i >= 0 && remaining > 0n;
          i--
        ) {
          const c = first.underFeeCandidates[i];
          const add =
            remaining < c.maxExtraAtomic ? remaining : c.maxExtraAtomic;
          overrides.set(c.txid, c.baseFeeAtomic + add);
          remaining -= add;
        }

        if (remaining === 0n && overrides.size > 0) {
          return simulateSnapshotsSync(args, prepared, overrides, false).out;
        }
      }
    }
  }

  return first.out;
}

export async function buildBalanceSnapshotsAsync(
  args: BuildBalanceSnapshotsArgs,
  asyncOpts: BuildBalanceSnapshotsAsyncOpts = {},
): Promise<BalanceSnapshotStored[]> {
  const prepared = prepareTxHistory(args);
  const first = await simulateSnapshotsAsync(
    args,
    prepared,
    null,
    true,
    asyncOpts,
  );

  if (prepared.applyFeesToBalance) {
    let targetBalanceAtomic: bigint | null = null;
    try {
      targetBalanceAtomic = parseAtomicToBigint(
        (args.wallet as any)?.balanceAtomic ?? '',
      );
    } catch {
      targetBalanceAtomic = null;
    }

    if (targetBalanceAtomic !== null && targetBalanceAtomic >= 0n) {
      const computed = first.endBalanceAtomic;
      const delta = targetBalanceAtomic - computed;

      if (delta > 0n && first.feeEstimates.length > 0) {
        const maxPossible = first.feeEstimates.reduce(
          (acc, e) => acc + e.maxFeeAtomic,
          0n,
        );
        if (delta <= maxPossible) {
          let remaining = delta;
          const overrides = new Map<string, bigint>();
          for (
            let i = first.feeEstimates.length - 1;
            i >= 0 && remaining > 0n;
            i--
          ) {
            const e = first.feeEstimates[i];
            const reduce =
              remaining < e.maxFeeAtomic ? remaining : e.maxFeeAtomic;
            const corrected = e.maxFeeAtomic - reduce;
            overrides.set(e.txid, corrected);
            remaining -= reduce;
          }
          if (overrides.size > 0) {
            return (
              await simulateSnapshotsAsync(
                args,
                prepared,
                overrides,
                false,
                asyncOpts,
              )
            ).out;
          }
        }
      }

      if (
        delta < 0n &&
        prepared.historyHasOpStackL1FeeField &&
        first.underFeeCandidates.length > 0
      ) {
        let remaining = -delta;
        const overrides = new Map<string, bigint>();
        for (
          let i = first.underFeeCandidates.length - 1;
          i >= 0 && remaining > 0n;
          i--
        ) {
          const c = first.underFeeCandidates[i];
          const add =
            remaining < c.maxExtraAtomic ? remaining : c.maxExtraAtomic;
          overrides.set(c.txid, c.baseFeeAtomic + add);
          remaining -= add;
        }
        if (remaining === 0n && overrides.size > 0) {
          return (
            await simulateSnapshotsAsync(
              args,
              prepared,
              overrides,
              false,
              asyncOpts,
            )
          ).out;
        }
      }
    }
  }

  return first.out;
}
