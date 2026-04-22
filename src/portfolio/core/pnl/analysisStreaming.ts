import type {FiatRateInterval, FiatRatePoint} from '../fiatRatesShared';
import type {WalletCredentials} from '../types';
import type {SnapshotPointV2} from './snapshotStore';

// Keep the analysis worklet self-contained at runtime so it does not depend on
// cross-file helper imports when Worklets bundle mode is disabled.
function resolveStoredFiatRateInterval(
  interval: FiatRateInterval,
): FiatRateInterval {
  'worklet';

  switch (interval) {
    case '3M':
    case '1Y':
    case '5Y':
      return 'ALL';
    default:
      return interval;
  }
}

function normalizeNonNegativeInteger(value: number): number {
  'worklet';

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function getAtomicDecimals(credentials: WalletCredentials): number {
  'worklet';

  const token = credentials?.token;
  if (token && typeof token.decimals === 'number') {
    return token.decimals;
  }

  const chain = String(credentials?.chain || credentials?.coin || '').toLowerCase();
  switch (chain) {
    case 'btc':
    case 'bch':
    case 'ltc':
    case 'doge':
      return 8;
    case 'eth':
    case 'matic':
    case 'arb':
    case 'base':
    case 'op':
      return 18;
    case 'xrp':
      return 6;
    case 'sol':
      return 9;
    default:
      return 8;
  }
}

function toSignificantStr(n: number, maxDecimals: number): string {
  'worklet';

  if (!Number.isFinite(n)) {
    return '0';
  }

  const s = n.toFixed(Math.min(maxDecimals, 18));
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function parseScientificToTruncatedIntegerString(
  s: string,
): string | null {
  'worklet';

  const match = s.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) {
    return null;
  }

  const sign = match[1] === '-' ? '-' : '';
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  const exponent = Number(match[4]);
  if (!Number.isInteger(exponent)) {
    return null;
  }

  const digits = intPart + fracPart;
  const decimalPos = intPart.length + exponent;
  if (decimalPos <= 0) {
    return '0';
  }

  const rawInt =
    decimalPos >= digits.length
      ? digits + '0'.repeat(decimalPos - digits.length)
      : digits.slice(0, decimalPos);
  const normalized = rawInt.replace(/^0+(?=\d)/, '');
  if (!normalized || /^0+$/.test(normalized)) {
    return '0';
  }

  return sign ? `${sign}${normalized}` : normalized;
}

function parseAtomicToBigint(v: number | string | bigint): bigint {
  'worklet';

  if (typeof v === 'bigint') {
    return v;
  }

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      return 0n;
    }

    if (Number.isSafeInteger(v)) {
      return BigInt(v);
    }

    const s = String(v);
    if (/[eE]/.test(s)) {
      const expanded = parseScientificToTruncatedIntegerString(s);
      if (expanded) {
        return BigInt(expanded);
      }
    }

    const match = s.match(/^(-?\d+)(?:\.\d+)?$/);
    if (match) {
      return BigInt(match[1]);
    }

    return BigInt(Math.trunc(v));
  }

  const s = String(v).trim();
  if (!s) {
    return 0n;
  }

  if (/[eE]/.test(s)) {
    const expanded = parseScientificToTruncatedIntegerString(s);
    if (expanded) {
      return BigInt(expanded);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) {
      return 0n;
    }
    return BigInt(Math.trunc(n));
  }

  const match = s.match(/^(-?\d+)(?:\.\d+)?$/);
  if (!match) {
    throw new Error('Invalid atomic string');
  }

  return BigInt(match[1]);
}

function getPow10BigInt(decimals: number): bigint {
  'worklet';

  const normalized = normalizeNonNegativeInteger(decimals);
  return 10n ** BigInt(normalized);
}

function formatBigIntDecimal(
  atomic: bigint,
  decimals: number,
  maxDecimals = decimals,
): string {
  'worklet';

  const sign = atomic < 0n ? '-' : '';
  const abs = atomic < 0n ? -atomic : atomic;

  if (decimals <= 0) {
    return sign + abs.toString();
  }

  const base = getPow10BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');
  const sliceTo = Math.max(0, Math.min(decimals, maxDecimals));
  frac = frac.slice(0, sliceTo);
  frac = frac.replace(/0+$/, '');

  return frac ? `${sign}${whole.toString()}.${frac}` : sign + whole.toString();
}

function formatAtomicAmount(
  atomic: number | string | bigint,
  credentials: WalletCredentials,
  opts?: {maxDecimals?: number},
): string {
  'worklet';

  const decimals = getAtomicDecimals(credentials);
  const maxDecimals = opts?.maxDecimals ?? decimals;

  try {
    const b = parseAtomicToBigint(atomic);
    return formatBigIntDecimal(b, decimals, maxDecimals);
  } catch {
    const asNum = typeof atomic === 'number' ? atomic : Number(String(atomic));
    const unit = Math.pow(10, decimals);
    return toSignificantStr(asNum / unit, maxDecimals);
  }
}

function makeAtomicToUnitNumberConverter(
  decimals: number,
  maxFractionDigits = 15,
): (atomic: bigint) => number {
  'worklet';

  const maxAtomicToUnitFractionDigits = 15;
  const normalizedDecimals = normalizeNonNegativeInteger(decimals);
  const fractionDigits = Math.min(
    normalizedDecimals,
    normalizeNonNegativeInteger(maxFractionDigits),
    maxAtomicToUnitFractionDigits,
  );
  const base = getPow10BigInt(normalizedDecimals);
  const fractionalDivisor =
    fractionDigits > 0
      ? getPow10BigInt(normalizedDecimals - fractionDigits)
      : 1n;
  const fractionalScale = fractionDigits > 0 ? 10 ** fractionDigits : 1;

  return (atomic: bigint): number => {
    'worklet';

    if (atomic === 0n) {
      return 0;
    }

    const sign = atomic < 0n ? -1 : 1;
    const abs = atomic < 0n ? -atomic : atomic;
    const whole = Number(abs / base);
    if (!Number.isFinite(whole)) {
      return 0;
    }

    let out = whole;
    if (fractionDigits > 0) {
      const fractional = Number((abs % base) / fractionalDivisor);
      if (!Number.isFinite(fractional)) {
        return 0;
      }
      out += fractional / fractionalScale;
    }

    return sign * out;
  };
}

function ratioBigIntToNumber(n: bigint, d: bigint): number {
  'worklet';

  if (d === 0n) {
    return 0;
  }

  const ratioScale = 1_000_000_000_000n;
  const sign = (n < 0n) !== (d < 0n) ? -1 : 1;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const scaled = (an * ratioScale) / ad;
  const asNum = Number(scaled);
  return sign * (Number.isFinite(asNum) ? asNum / Number(ratioScale) : 0);
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type PnlTimeframe = FiatRateInterval;

export type WalletForAnalysisMeta = {
  walletId: string;
  walletName: string;
  assetId: string;
  rateCoin: string;
  currencyAbbreviation: string;
  chain?: string;
  tokenAddress?: string;
  credentials: WalletCredentials;
};

export type WalletForPreloadedAnalysis = {
  wallet: WalletForAnalysisMeta;
  basePoint: SnapshotPointV2 | null;
  points: SnapshotPointV2[];
};

export type SnapshotPointStream = AsyncIterator<SnapshotPointV2, void, void>;

export type WalletForStreamedAnalysis = {
  wallet: WalletForAnalysisMeta;
  basePoint: SnapshotPointV2 | null;
  points: SnapshotPointStream;
};

export type WalletPoint = {
  balanceAtomic: string;
  formattedCryptoBalance: string;
  fiatBalance: number;
  // Windowed "cost basis" used for interval PnL% (reset to value at interval start).
  remainingCostBasisFiat: number;
  unrealizedPnlFiat: number;

  markRate: number;
  ratePercentChange: number;
  pnlPercent: number;
};

export type PnlAnalysisPoint = {
  timestamp: number;

  // General (single asset only)
  markRate?: number;
  ratePercentChange?: number;

  // Total
  totalCryptoBalanceAtomic?: string;
  totalCryptoBalanceFormatted?: string;
  totalFiatBalance: number;
  totalRemainingCostBasisFiat: number;
  totalUnrealizedPnlFiat: number;
  totalPnlChange: number;
  totalPnlPercent: number;

  byWalletId: Record<string, WalletPoint>;
};

export type AssetPnlSummary = {
  assetId: string;
  coin: string;
  currencyAbbreviation: string;
  chain?: string;
  tokenAddress?: string;
  displaySymbol: string;
  rateStart: number;
  rateEnd: number;
  rateChange: number;
  ratePercentChange: number;
  fiatBalanceStart: number;
  fiatBalanceEnd: number;
  remainingCostBasisFiatStart: number;
  remainingCostBasisFiatEnd: number;
  pnlStart: number;
  pnlEnd: number;
  pnlChange: number;
  pnlPercent: number;
};

export type TotalPnlSummary = {
  pnlStart: number;
  pnlEnd: number;
  pnlChange: number;
  pnlPercent: number;
};

export type PnlAnalysisWindow = {
  startTs: number;
  endTs: number;
  nowMs: number;
};

export type PnlAnalysisResult = {
  timeframe: PnlTimeframe;
  quoteCurrency: string;
  driverAssetId: string;
  driverCoin: string;
  analysisWindow?: PnlAnalysisWindow;
  assetIds: string[];
  coins: string[];
  wallets: WalletForAnalysisMeta[];
  points: PnlAnalysisPoint[];
  assetSummaries: AssetPnlSummary[];
  totalSummary: TotalPnlSummary;
};

export type PnlAnalysisChartResult = {
  timeframe: PnlTimeframe;
  quoteCurrency: string;
  driverAssetId: string;
  driverCoin: string;
  analysisWindow?: PnlAnalysisWindow;
  assetIds: string[];
  coins: string[];
  singleAsset: boolean;
  timestamps: number[];
  totalFiatBalance: number[];
  totalRemainingCostBasisFiat: number[];
  totalUnrealizedPnlFiat: number[];
  totalPnlChange: number[];
  totalPnlPercent: number[];
  driverMarkRate?: Array<number | null>;
  driverRatePercentChange?: Array<number | null>;
  lastSpotRatesByRateKey: Record<string, number>;
  latestHoldingsByRateKey: Record<string, {units: number}>;
  latestRemainingCostBasisFiatTotal: number;
};

export type PnlAnalysisDebugHooks = {
  onPnlAnalysisPointConstruction?: () => void;
  onByWalletIdConstruction?: () => void;
  onFormattedCryptoBalance?: () => void;
  onFinalizeAnalysisResult?: () => void;
};

export type PnlAnalysisPreloadedArgs = {
  cfg: {quoteCurrency: string};
  wallets: WalletForPreloadedAnalysis[];
  timeframe: PnlTimeframe;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  currentRatesByAssetId?: Record<string, number>;
  firstNonZeroTs?: number | null;
  startTs?: number;
  endTs?: number;
  nowMs?: number;
  maxPoints?: number;
  resolvedWindow?: ResolvedPnlAnalysisPreloadWindow;
  walletPointsArePrepared?: boolean;
};

export type PnlAnalysisStreamedArgs = {
  cfg: {quoteCurrency: string};
  wallets: WalletForStreamedAnalysis[];
  timeframe: PnlTimeframe;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  currentRatesByAssetId?: Record<string, number>;
  firstNonZeroTs?: number | null;
  startTs?: number;
  endTs?: number;
  nowMs?: number;
  maxPoints?: number;
  resolvedWindow?: ResolvedPnlAnalysisPreloadWindow;
};

export type ResolvedPnlAnalysisPreloadWindow = {
  quoteCurrency: string;
  wallets: WalletForAnalysisMeta[];
  assetIds: string[];
  driverAssetId: string;
  rawPointsByAssetId: Record<string, FiatRatePoint[]>;
  nowMs: number;
  liveTerminalTs?: number;
  startTs: number;
  endTs: number;
  timeline: number[];
};

type PreparedWalletPoint = {
  timestamp: number;
  cryptoBalance: string;
};

type AnalysisContext = {
  quoteCurrency: string;
  assetIds: string[];
  coins: string[];
  driverAssetId: string;
  driverCoin: string;
  nowMs: number;
  liveTerminalTs?: number;
  currentRatesByAssetId: Record<string, number>;
  rawPointsByAssetId: Record<string, FiatRatePoint[]>;
  timeline: number[];
  startTs: number;
  endTs: number;
  rateCursorByAssetId: Record<string, RateCursor>;
  baselineRateByAssetId: Record<string, number>;
};

type WalletAnalysisState = {
  wallet: WalletForAnalysisMeta;
  atomicToUnitNumber: (atomic: bigint) => number;
  unitsAtomic: bigint;
  basisFiat: number;
};

type StreamedWalletState = WalletAnalysisState & {
  iterator: SnapshotPointStream;
  nextPoint: PreparedWalletPoint | null;
};

let pnlAnalysisDebugHooksForTests: PnlAnalysisDebugHooks | undefined;

export function setPnlAnalysisDebugHooksForTests(
  hooks?: PnlAnalysisDebugHooks,
): void {
  pnlAnalysisDebugHooksForTests = hooks;
}

function notifyPnlAnalysisPointConstruction(): void {
  'worklet';

  pnlAnalysisDebugHooksForTests?.onPnlAnalysisPointConstruction?.();
}

function notifyByWalletIdConstruction(): void {
  'worklet';

  pnlAnalysisDebugHooksForTests?.onByWalletIdConstruction?.();
}

function notifyFormattedCryptoBalance(): void {
  'worklet';

  pnlAnalysisDebugHooksForTests?.onFormattedCryptoBalance?.();
}

function notifyFinalizeAnalysisResult(): void {
  'worklet';

  pnlAnalysisDebugHooksForTests?.onFinalizeAnalysisResult?.();
}

function getWalletChartRateKey(wallet: WalletForAnalysisMeta): string {
  'worklet';

  const normalizeCoin = (value?: string): string => {
    const coin = String(value || '')
      .trim()
      .toLowerCase();
    switch (coin) {
      case 'matic':
      case 'pol':
        return 'pol';
      default:
        return coin;
    }
  };

  const normalizeChain = (value?: string): string => {
    return String(value || '')
      .trim()
      .toLowerCase();
  };

  const normalizeTokenAddress = (
    chain?: string,
    tokenAddress?: string,
  ): string => {
    const normalized = String(tokenAddress || '').trim();
    if (!normalized) {
      return '';
    }

    return chain === 'sol' || chain === 'solana'
      ? normalized
      : normalized.toLowerCase();
  };

  const coin = normalizeCoin(wallet.rateCoin || wallet.currencyAbbreviation);
  if (!coin) {
    return '';
  }

  const chain = wallet.tokenAddress ? normalizeChain(wallet.chain) : '';
  const tokenAddress = normalizeTokenAddress(chain, wallet.tokenAddress);

  if (!chain && !tokenAddress) {
    return coin;
  }

  return [coin, chain, ...(tokenAddress ? [tokenAddress] : [])].join('|');
}

function buildChartPatchMetadataFromAnalysisResult(result: PnlAnalysisResult): {
  lastSpotRatesByRateKey: Record<string, number>;
  latestHoldingsByRateKey: Record<string, {units: number}>;
  latestRemainingCostBasisFiatTotal: number;
} {
  'worklet';

  const lastPoint = result.points.length
    ? result.points[result.points.length - 1]
    : undefined;
  const latestHoldingsByRateKey: Record<string, {units: number}> = {};
  const lastSpotRatesByRateKey: Record<string, number> = {};

  if (lastPoint) {
    for (const wallet of result.wallets) {
      const walletPoint = lastPoint.byWalletId[wallet.walletId];
      if (!walletPoint) {
        continue;
      }

      const rateKey = getWalletChartRateKey(wallet);
      const decimals = getAtomicDecimals(wallet.credentials);
      const units = makeAtomicToUnitNumberConverter(decimals)(
        parseAtomicToBigint(walletPoint.balanceAtomic || '0'),
      );

      if (!latestHoldingsByRateKey[rateKey]) {
        latestHoldingsByRateKey[rateKey] = {units: 0};
      }
      latestHoldingsByRateKey[rateKey].units += units;

      if (
        !(rateKey in lastSpotRatesByRateKey) &&
        typeof walletPoint.markRate === 'number' &&
        Number.isFinite(walletPoint.markRate) &&
        walletPoint.markRate > 0
      ) {
        lastSpotRatesByRateKey[rateKey] = walletPoint.markRate;
      }
    }
  }

  return {
    lastSpotRatesByRateKey,
    latestHoldingsByRateKey,
    latestRemainingCostBasisFiatTotal:
      lastPoint?.totalRemainingCostBasisFiat || 0,
  };
}

export function compactPnlAnalysisResultForChart(
  result: PnlAnalysisResult,
): PnlAnalysisChartResult {
  'worklet';

  const pointCount = result.points.length;
  const singleAsset = result.assetIds.length === 1;

  const timestamps = new Array<number>(pointCount);
  const totalFiatBalance = new Array<number>(pointCount);
  const totalRemainingCostBasisFiat = new Array<number>(pointCount);
  const totalUnrealizedPnlFiat = new Array<number>(pointCount);
  const totalPnlChange = new Array<number>(pointCount);
  const totalPnlPercent = new Array<number>(pointCount);
  const driverMarkRate = singleAsset
    ? new Array<number | null>(pointCount)
    : undefined;
  const driverRatePercentChange = singleAsset
    ? new Array<number | null>(pointCount)
    : undefined;
  const patchMetadata = buildChartPatchMetadataFromAnalysisResult(result);

  for (let i = 0; i < pointCount; i++) {
    const point = result.points[i];
    timestamps[i] = point.timestamp;
    totalFiatBalance[i] = point.totalFiatBalance;
    totalRemainingCostBasisFiat[i] = point.totalRemainingCostBasisFiat;
    totalUnrealizedPnlFiat[i] = point.totalUnrealizedPnlFiat;
    totalPnlChange[i] = point.totalPnlChange;
    totalPnlPercent[i] = point.totalPnlPercent;

    if (driverMarkRate) {
      driverMarkRate[i] =
        typeof point.markRate === 'number' && Number.isFinite(point.markRate)
          ? point.markRate
          : null;
    }
    if (driverRatePercentChange) {
      driverRatePercentChange[i] =
        typeof point.ratePercentChange === 'number' &&
        Number.isFinite(point.ratePercentChange)
          ? point.ratePercentChange
          : null;
    }
  }

  return {
    timeframe: result.timeframe,
    quoteCurrency: result.quoteCurrency,
    driverAssetId: result.driverAssetId,
    driverCoin: result.driverCoin,
    analysisWindow: result.analysisWindow,
    assetIds: result.assetIds.slice(),
    coins: result.coins.slice(),
    singleAsset,
    timestamps,
    totalFiatBalance,
    totalRemainingCostBasisFiat,
    totalUnrealizedPnlFiat,
    totalPnlChange,
    totalPnlPercent,
    driverMarkRate,
    driverRatePercentChange,
    lastSpotRatesByRateKey: patchMetadata.lastSpotRatesByRateKey,
    latestHoldingsByRateKey: patchMetadata.latestHoldingsByRateKey,
    latestRemainingCostBasisFiatTotal:
      patchMetadata.latestRemainingCostBasisFiatTotal,
  };
}

function buildEvenTimeline(
  startMs: number,
  endMs: number,
  n: number,
): number[] {
  'worklet';

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || n <= 0) return [];
  if (n === 1) return [Math.round((startMs + endMs) / 2)];

  const start = Math.round(startMs);
  const endRaw = Math.round(endMs);
  const end = endRaw < start ? start : endRaw;
  const span = end - start;

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const ts = span === 0 ? start : Math.round(start + (span * i) / (n - 1));
    out[i] = ts;
  }
  out[0] = start;
  out[n - 1] = end;
  return out;
}

function buildAnalysisTimeline(args: {
  startTs: number;
  historicalEndTs: number;
  nowMs: number;
  maxPoints: number;
  includeLiveTerminalPoint: boolean;
}): number[] {
  'worklet';

  const maxPoints = Math.max(0, Math.floor(args.maxPoints));
  if (maxPoints <= 0) return [];

  const startTs = Math.round(args.startTs);
  const historicalEndTs = Math.max(startTs, Math.round(args.historicalEndTs));
  const nowMs = Math.max(historicalEndTs, Math.round(args.nowMs));
  const shouldAppendLiveTerminalPoint =
    args.includeLiveTerminalPoint && nowMs > historicalEndTs;

  if (!shouldAppendLiveTerminalPoint) {
    return buildEvenTimeline(startTs, historicalEndTs, maxPoints);
  }

  if (maxPoints === 1) {
    return [nowMs];
  }

  if (maxPoints === 2) {
    return [startTs, nowMs];
  }

  const historicalPointCount = maxPoints - 1;
  const historicalTimeline =
    historicalEndTs <= startTs || historicalPointCount <= 1
      ? [startTs]
      : buildEvenTimeline(startTs, historicalEndTs, historicalPointCount);

  if (!historicalTimeline.length) {
    return [nowMs];
  }

  if (historicalTimeline[historicalTimeline.length - 1] === nowMs) {
    return historicalTimeline;
  }

  return historicalTimeline.concat(nowMs);
}

function getWindowMs(timeframe: PnlTimeframe): number {
  'worklet';

  switch (timeframe) {
    case '1D':
      return 1 * MS_PER_DAY;
    case '1W':
      return 7 * MS_PER_DAY;
    case '1M':
      return 30 * MS_PER_DAY;
    case '3M':
      return 90 * MS_PER_DAY;
    case '1Y':
      return 365 * MS_PER_DAY;
    case '5Y':
      return 1825 * MS_PER_DAY;
    case 'ALL':
    default:
      return 0;
  }
}

function roundDownToHourMs(tsMs: number): number {
  'worklet';

  return Math.floor(tsMs / MS_PER_HOUR) * MS_PER_HOUR;
}

function getBaselineMs(timeframe: PnlTimeframe, nowMs: number): number | null {
  'worklet';

  if (timeframe === 'ALL') return null;
  const w = getWindowMs(timeframe);
  if (!w) return null;
  return roundDownToHourMs(nowMs - w);
}

type RateCursor = {
  getRateAt: (targetTs: number) => number | undefined;
};

function isSortedByTsAsc(points: FiatRatePoint[]): boolean {
  'worklet';

  for (let i = 1; i < points.length; i++) {
    if (points[i].ts < points[i - 1].ts) return false;
  }
  return true;
}

function makeLinearRateCursor(pointsRaw: FiatRatePoint[]): RateCursor {
  'worklet';

  const points = isSortedByTsAsc(pointsRaw)
    ? pointsRaw
    : pointsRaw.slice().sort((a, b) => a.ts - b.ts);
  let idx = 0;
  let lastTarget = -Infinity;

  const clampIdx = (i: number) => {
    'worklet';
    return Math.max(0, Math.min(points.length - 1, i));
  };

  const binarySearchInsertion = (ts: number): number => {
    'worklet';

    // first index with points[i].ts >= ts
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    getRateAt: (targetTs: number) => {
      'worklet';

      if (!Number.isFinite(targetTs) || points.length === 0) return undefined;

      if (targetTs >= lastTarget) {
        while (idx + 1 < points.length && points[idx + 1].ts <= targetTs) idx++;
      } else {
        const ins = binarySearchInsertion(targetTs);
        idx = clampIdx(ins === 0 ? 0 : ins - 1);
      }
      lastTarget = targetTs;

      const left = points[idx];
      const right = idx + 1 < points.length ? points[idx + 1] : null;
      if (!right) return left.rate;
      if (targetTs <= left.ts) {
        return left.rate;
      }
      if (targetTs >= right.ts) {
        return right.rate;
      }

      const span = right.ts - left.ts;
      if (!Number.isFinite(span) || span <= 0) {
        return left.rate;
      }

      const ratio = (targetTs - left.ts) / span;
      const rate = left.rate + (right.rate - left.rate) * ratio;
      return Number.isFinite(rate) ? rate : left.rate;
    },
  };
}

function getCurrentRateOverride(
  currentRatesByAssetId: Record<string, number>,
  assetId: string,
): number | undefined {
  'worklet';

  const rate = currentRatesByAssetId[assetId];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? rate
    : undefined;
}

function getAnalysisRateAtTimestamp(args: {
  assetId: string;
  ts: number;
  liveTerminalTs?: number;
  rateCursorByAssetId: Record<string, RateCursor>;
  currentRatesByAssetId: Record<string, number>;
}): number {
  'worklet';

  const overrideRate =
    typeof args.liveTerminalTs === 'number' && args.ts === args.liveTerminalTs
      ? getCurrentRateOverride(args.currentRatesByAssetId, args.assetId)
      : undefined;

  return (
    overrideRate ??
    args.rateCursorByAssetId[args.assetId].getRateAt(args.ts) ??
    0
  );
}

function getAnalysisBasisRateAtTimestamp(args: {
  assetId: string;
  ts: number;
  liveTerminalTs?: number;
  rateCursorByAssetId: Record<string, RateCursor>;
  baselineRateByAssetId: Record<string, number>;
  currentRatesByAssetId: Record<string, number>;
}): number {
  'worklet';

  const overrideRate =
    typeof args.liveTerminalTs === 'number' && args.ts === args.liveTerminalTs
      ? getCurrentRateOverride(args.currentRatesByAssetId, args.assetId)
      : undefined;

  return (
    overrideRate ??
    args.rateCursorByAssetId[args.assetId].getRateAt(args.ts) ??
    args.baselineRateByAssetId[args.assetId] ??
    0
  );
}

function isSingleAsset(wallets: WalletForAnalysisMeta[]): boolean {
  'worklet';

  const assetIds = new Set<string>();
  for (const w of wallets) {
    assetIds.add(w.assetId);
    if (assetIds.size > 1) return false;
  }
  return assetIds.size === 1;
}

function findFirstNonZeroTsFromPreloadedWallets(
  wallets: WalletForPreloadedAnalysis[],
): number | null {
  'worklet';

  let best: number | null = null;

  for (const entry of wallets) {
    const candidates = [
      entry.basePoint,
      ...(Array.isArray(entry.points) ? entry.points : []),
    ];

    for (const point of candidates) {
      if (!point) continue;
      const balance = parseAtomicToBigint(point.cryptoBalance);
      if (balance <= 0n) continue;
      const ts = Number(point.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (best === null || ts < best) best = ts;
      break;
    }
  }

  return best;
}

function normalizeWalletPointsForAnalysis(
  pointsRaw: SnapshotPointV2[],
  startTs: number,
  endTs: number,
): PreparedWalletPoint[] {
  'worklet';

  return (Array.isArray(pointsRaw) ? pointsRaw : [])
    .map(p => ({
      timestamp: Number(p.timestamp),
      cryptoBalance: String(p.cryptoBalance),
    }))
    .filter(
      p =>
        Number.isFinite(p.timestamp) &&
        p.timestamp > startTs &&
        p.timestamp <= endTs,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

function validatePreparedWalletPoint(
  pointRaw: SnapshotPointV2,
  startTs: number,
  endTs: number,
  prevTs: number,
  detail: string,
): PreparedWalletPoint {
  'worklet';

  const timestamp = Number(pointRaw.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Prepared analysis point has invalid timestamp (${detail}).`,
    );
  }
  if (timestamp <= startTs || timestamp > endTs) {
    throw new Error(
      `Prepared analysis point is outside the requested window (${detail}).`,
    );
  }
  if (timestamp < prevTs) {
    throw new Error(
      `Prepared analysis points must be sorted ascending by timestamp (${detail}).`,
    );
  }
  return {
    timestamp,
    cryptoBalance: String(pointRaw.cryptoBalance),
  };
}

function validatePreparedWalletPoints(
  pointsRaw: SnapshotPointV2[],
  startTs: number,
  endTs: number,
): PreparedWalletPoint[] {
  'worklet';

  const points = Array.isArray(pointsRaw) ? pointsRaw : [];
  const out: PreparedWalletPoint[] = new Array(points.length);
  let prevTs = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const prepared = validatePreparedWalletPoint(
      points[i],
      startTs,
      endTs,
      prevTs,
      `row ${i}`,
    );
    prevTs = prepared.timestamp;
    out[i] = prepared;
  }

  return out;
}

async function readNextPreparedWalletPointFromStream(args: {
  iterator: SnapshotPointStream;
  startTs: number;
  endTs: number;
  prevTs: number;
  detail: string;
}): Promise<PreparedWalletPoint | null> {
  'worklet';

  const next = await args.iterator.next();
  if (next.done) return null;
  return validatePreparedWalletPoint(
    next.value,
    args.startTs,
    args.endTs,
    args.prevTs,
    args.detail,
  );
}

export function resolvePnlAnalysisPreloadWindow(args: {
  cfg: {quoteCurrency: string};
  wallets: WalletForAnalysisMeta[];
  timeframe: PnlTimeframe;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  currentRatesByAssetId?: Record<string, number>;
  firstNonZeroTs?: number | null;
  nowMs?: number;
  maxPoints?: number;
}): ResolvedPnlAnalysisPreloadWindow {
  'worklet';

  const nowMsRequested =
    typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const maxPoints = typeof args.maxPoints === 'number' ? args.maxPoints : 91;

  const wallets = args.wallets.slice();
  const quoteCurrency = args.cfg.quoteCurrency.toUpperCase();
  const assetIds = Array.from(new Set(wallets.map(w => w.assetId))).sort(
    (a, b) => a.localeCompare(b),
  );
  const storedInterval = resolveStoredFiatRateInterval(args.timeframe);

  if (!assetIds.length) {
    return {
      quoteCurrency,
      wallets,
      assetIds: [],
      driverAssetId: '',
      rawPointsByAssetId: {},
      nowMs: nowMsRequested,
      liveTerminalTs: undefined,
      startTs: nowMsRequested,
      endTs: nowMsRequested,
      timeline: [],
    };
  }

  const rawPointsByAssetId: Record<string, FiatRatePoint[]> = {};
  let driverAssetId = assetIds[0];
  let driverLen = -1;

  for (const assetId of assetIds) {
    const points = (args.ratePointsByAssetId[assetId] ?? [])
      .map(p => ({ts: Number(p.ts), rate: Number(p.rate)}))
      .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.rate))
      .sort((a, b) => a.ts - b.ts);

    if (!points.length) {
      throw new Error(
        `Missing rates for ${quoteCurrency}:${assetId}:${storedInterval} (requested ${args.timeframe}).`,
      );
    }

    rawPointsByAssetId[assetId] = points;
    if (
      points.length > driverLen ||
      (points.length === driverLen && assetId < driverAssetId)
    ) {
      driverAssetId = assetId;
      driverLen = points.length;
    }
  }

  let overlapStart = -Infinity;
  let overlapEnd = Infinity;
  for (const assetId of assetIds) {
    const pts = rawPointsByAssetId[assetId];
    overlapStart = Math.max(overlapStart, pts[0].ts);
    overlapEnd = Math.min(overlapEnd, pts[pts.length - 1].ts);
  }
  if (
    !Number.isFinite(overlapStart) ||
    !Number.isFinite(overlapEnd) ||
    overlapEnd <= overlapStart
  ) {
    throw new Error('No overlapping rate window across selected assets.');
  }

  const nowMs = nowMsRequested;
  const baselineMs = getBaselineMs(args.timeframe, nowMs);
  const desiredStart =
    args.timeframe === 'ALL'
      ? (typeof args.firstNonZeroTs === 'number' &&
        Number.isFinite(args.firstNonZeroTs)
          ? args.firstNonZeroTs
          : null) ?? overlapStart
      : baselineMs ?? overlapStart;

  const startTs = Math.max(overlapStart, desiredStart);
  const historicalEndTs = Math.max(startTs, Math.min(overlapEnd, nowMs));
  const hasLiveTerminalRates = assetIds.every(assetId => {
    const overrideRate = getCurrentRateOverride(
      args.currentRatesByAssetId || {},
      assetId,
    );
    return typeof overrideRate === 'number' && Number.isFinite(overrideRate);
  });
  const liveTerminalTs = hasLiveTerminalRates ? nowMs : undefined;
  const timeline = buildAnalysisTimeline({
    startTs,
    historicalEndTs,
    nowMs,
    maxPoints,
    includeLiveTerminalPoint: hasLiveTerminalRates,
  });
  if (!timeline.length) {
    throw new Error('Failed to build analysis timeline.');
  }

  return {
    quoteCurrency,
    wallets,
    assetIds,
    driverAssetId,
    rawPointsByAssetId,
    nowMs,
    liveTerminalTs,
    startTs: timeline[0],
    endTs: timeline[timeline.length - 1],
    timeline,
  };
}

function buildEmptyAnalysisResult(
  timeframe: PnlTimeframe,
  quoteCurrency: string,
): PnlAnalysisResult {
  'worklet';

  return {
    timeframe,
    quoteCurrency: quoteCurrency.toUpperCase(),
    driverAssetId: '',
    driverCoin: '',
    analysisWindow: undefined,
    assetIds: [],
    coins: [],
    wallets: [],
    points: [],
    assetSummaries: [],
    totalSummary: {pnlStart: 0, pnlEnd: 0, pnlChange: 0, pnlPercent: 0},
  };
}

function buildEmptyAnalysisChartResult(
  timeframe: PnlTimeframe,
  quoteCurrency: string,
): PnlAnalysisChartResult {
  'worklet';

  return {
    timeframe,
    quoteCurrency: quoteCurrency.toUpperCase(),
    driverAssetId: '',
    driverCoin: '',
    analysisWindow: undefined,
    assetIds: [],
    coins: [],
    singleAsset: false,
    timestamps: [],
    totalFiatBalance: [],
    totalRemainingCostBasisFiat: [],
    totalUnrealizedPnlFiat: [],
    totalPnlChange: [],
    totalPnlPercent: [],
    driverMarkRate: undefined,
    driverRatePercentChange: undefined,
    lastSpotRatesByRateKey: {},
    latestHoldingsByRateKey: {},
    latestRemainingCostBasisFiatTotal: 0,
  };
}

function buildAnalysisContext(args: {
  cfg: {quoteCurrency: string};
  wallets: WalletForAnalysisMeta[];
  timeframe: PnlTimeframe;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  currentRatesByAssetId?: Record<string, number>;
  firstNonZeroTs?: number | null;
  startTs?: number;
  endTs?: number;
  nowMs?: number;
  maxPoints?: number;
  resolvedWindow?: ResolvedPnlAnalysisPreloadWindow;
}): AnalysisContext {
  'worklet';

  const maxPoints = typeof args.maxPoints === 'number' ? args.maxPoints : 91;
  const resolved =
    args.resolvedWindow ??
    resolvePnlAnalysisPreloadWindow({
      cfg: args.cfg,
      wallets: args.wallets,
      timeframe: args.timeframe,
      ratePointsByAssetId: args.ratePointsByAssetId,
      currentRatesByAssetId: args.currentRatesByAssetId,
      firstNonZeroTs: args.firstNonZeroTs,
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
    });

  const timelineMatchesResolvedWindow =
    !!args.resolvedWindow &&
    (typeof args.startTs !== 'number' ||
      !Number.isFinite(args.startTs) ||
      args.startTs === resolved.startTs) &&
    (typeof args.endTs !== 'number' ||
      !Number.isFinite(args.endTs) ||
      args.endTs === resolved.endTs);

  const timeline = timelineMatchesResolvedWindow
    ? resolved.timeline
    : typeof args.startTs === 'number' &&
      Number.isFinite(args.startTs) &&
      typeof args.endTs === 'number' &&
      Number.isFinite(args.endTs) &&
      args.endTs >= args.startTs
    ? buildEvenTimeline(args.startTs, args.endTs, maxPoints)
    : resolved.timeline;
  if (!timeline.length) {
    throw new Error('Failed to build analysis timeline.');
  }

  const quoteCurrency = resolved.quoteCurrency;
  const assetIds = resolved.assetIds;
  const driverAssetId = resolved.driverAssetId;
  const rawPointsByAssetId = resolved.rawPointsByAssetId;
  const startTs = timeline[0];
  const endTs = timeline[timeline.length - 1];
  const liveTerminalTs =
    typeof resolved.liveTerminalTs === 'number' &&
    endTs === resolved.liveTerminalTs
      ? resolved.liveTerminalTs
      : undefined;
  const rateCursorByAssetId: Record<string, RateCursor> = {};
  for (const assetId of assetIds) {
    rateCursorByAssetId[assetId] = makeLinearRateCursor(
      rawPointsByAssetId[assetId],
    );
  }

  const baselineRateByAssetId: Record<string, number> = {};
  for (const assetId of assetIds) {
    const r0 = rateCursorByAssetId[assetId].getRateAt(timeline[0]);
    if (r0 === undefined)
      throw new Error(
        `Missing ${quoteCurrency}:${assetId} rate at ts=${timeline[0]}.`,
      );
    baselineRateByAssetId[assetId] = r0;
  }

  const coins = Array.from(new Set(resolved.wallets.map(w => w.rateCoin))).sort(
    (a, b) => a.localeCompare(b),
  );
  const driverCoin =
    resolved.wallets.find(w => w.assetId === driverAssetId)?.rateCoin ?? '';

  return {
    quoteCurrency,
    assetIds,
    coins,
    driverAssetId,
    driverCoin,
    nowMs: resolved.nowMs,
    liveTerminalTs,
    currentRatesByAssetId: args.currentRatesByAssetId || {},
    rawPointsByAssetId,
    timeline,
    startTs,
    endTs,
    rateCursorByAssetId,
    baselineRateByAssetId,
  };
}

function createWalletAnalysisState(
  wallet: WalletForAnalysisMeta,
  basePoint: SnapshotPointV2 | null,
  baselineRateByAssetId: Record<string, number>,
): WalletAnalysisState {
  'worklet';

  const decimals = getAtomicDecimals(wallet.credentials);
  const atomicToUnitNumber = makeAtomicToUnitNumberConverter(decimals);
  const unitsAtomic = basePoint
    ? parseAtomicToBigint(basePoint.cryptoBalance)
    : 0n;
  const basisFiat =
    atomicToUnitNumber(unitsAtomic) *
    (baselineRateByAssetId[wallet.assetId] ?? 0);

  return {
    wallet,
    atomicToUnitNumber,
    unitsAtomic,
    basisFiat: Number.isFinite(basisFiat) ? basisFiat : 0,
  };
}

async function createStreamedWalletStateById(
  wallets: WalletForStreamedAnalysis[],
  context: AnalysisContext,
): Promise<Record<string, StreamedWalletState>> {
  'worklet';

  const stateByWalletId: Record<string, StreamedWalletState> = {};

  for (const entry of wallets) {
    const iterator = entry.points;
    stateByWalletId[entry.wallet.walletId] = {
      ...createWalletAnalysisState(
        entry.wallet,
        entry.basePoint,
        context.baselineRateByAssetId,
      ),
      iterator,
      nextPoint: await readNextPreparedWalletPointFromStream({
        iterator,
        startTs: context.startTs,
        endTs: context.endTs,
        prevTs: -Infinity,
        detail: `wallet ${entry.wallet.walletId}`,
      }),
    };
  }

  return stateByWalletId;
}

function applyAnalysisPointToWalletState(args: {
  state: WalletAnalysisState;
  point: PreparedWalletPoint;
  rateCursorByAssetId: Record<string, RateCursor>;
  baselineRateByAssetId: Record<string, number>;
  currentRatesByAssetId: Record<string, number>;
  liveTerminalTs?: number;
}): void {
  'worklet';

  const {
    state,
    point,
    rateCursorByAssetId,
    baselineRateByAssetId,
    currentRatesByAssetId,
    liveTerminalTs,
  } = args;
  const afterAtomic = parseAtomicToBigint(point.cryptoBalance);
  const beforeAtomic = state.unitsAtomic;
  const delta = afterAtomic - beforeAtomic;

  if (delta !== 0n) {
    if (delta > 0n) {
      const rateForBasis = getAnalysisBasisRateAtTimestamp({
        assetId: state.wallet.assetId,
        ts: point.timestamp,
        liveTerminalTs,
        rateCursorByAssetId,
        baselineRateByAssetId,
        currentRatesByAssetId,
      });
      state.basisFiat += state.atomicToUnitNumber(delta) * rateForBasis;
    } else if (beforeAtomic > 0n) {
      state.basisFiat *= ratioBigIntToNumber(afterAtomic, beforeAtomic);
    } else {
      state.basisFiat = 0;
    }

    state.unitsAtomic = afterAtomic;
    if (state.unitsAtomic <= 0n) {
      state.unitsAtomic = 0n;
      state.basisFiat = 0;
    }
  }
}

async function advanceStreamedWalletStateToTimestamp(args: {
  state: StreamedWalletState;
  walletId: string;
  ts: number;
  context: AnalysisContext;
}): Promise<void> {
  'worklet';

  const {state, walletId, ts, context} = args;

  while (state.nextPoint && state.nextPoint.timestamp <= ts) {
    const currentPoint = state.nextPoint;
    applyAnalysisPointToWalletState({
      state,
      point: currentPoint,
      rateCursorByAssetId: context.rateCursorByAssetId,
      baselineRateByAssetId: context.baselineRateByAssetId,
      currentRatesByAssetId: context.currentRatesByAssetId,
      liveTerminalTs: context.liveTerminalTs,
    });
    state.nextPoint = await readNextPreparedWalletPointFromStream({
      iterator: state.iterator,
      startTs: context.startTs,
      endTs: context.endTs,
      prevTs: currentPoint.timestamp,
      detail: `wallet ${walletId}`,
    });
  }
}

function clampWalletAnalysisState(state: WalletAnalysisState): void {
  'worklet';

  if (!Number.isFinite(state.basisFiat) || state.basisFiat < 0)
    state.basisFiat = 0;
}

function finalizeAnalysisResult(args: {
  timeframe: PnlTimeframe;
  walletMetas: WalletForAnalysisMeta[];
  quoteCurrency: string;
  driverAssetId: string;
  driverCoin: string;
  analysisWindow: PnlAnalysisWindow;
  assetIds: string[];
  coins: string[];
  points: PnlAnalysisPoint[];
  baselineRateByAssetId: Record<string, number>;
  rateCursorByAssetId: Record<string, RateCursor>;
  currentRatesByAssetId: Record<string, number>;
  endTs: number;
  liveTerminalTs?: number;
}): PnlAnalysisResult {
  'worklet';

  notifyFinalizeAnalysisResult();

  if (!args.points.length) {
    return {
      timeframe: args.timeframe,
      quoteCurrency: args.quoteCurrency,
      driverAssetId: args.driverAssetId,
      driverCoin: args.driverCoin,
      analysisWindow: args.analysisWindow,
      assetIds: args.assetIds,
      coins: args.coins,
      wallets: args.walletMetas,
      points: [],
      assetSummaries: [],
      totalSummary: {pnlStart: 0, pnlEnd: 0, pnlChange: 0, pnlPercent: 0},
    };
  }

  const first = args.points[0];
  const last = args.points[args.points.length - 1];
  const assetMetaById = new Map<string, WalletForAnalysisMeta>();
  const walletIdsByAssetId = new Map<string, Set<string>>();
  const displayBaseCount = new Map<string, number>();

  for (const wallet of args.walletMetas) {
    if (!assetMetaById.has(wallet.assetId)) {
      assetMetaById.set(wallet.assetId, wallet);
      const displayBase = String(
        wallet.currencyAbbreviation || wallet.rateCoin || wallet.assetId,
      ).toUpperCase();
      displayBaseCount.set(
        displayBase,
        (displayBaseCount.get(displayBase) ?? 0) + 1,
      );
    }
    const walletIds =
      walletIdsByAssetId.get(wallet.assetId) ?? new Set<string>();
    walletIds.add(wallet.walletId);
    walletIdsByAssetId.set(wallet.assetId, walletIds);
  }

  const shortenTokenAddress = (tokenAddress?: string): string => {
    if (!tokenAddress) return '';
    return tokenAddress.length <= 10
      ? tokenAddress
      : `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
  };

  const displaySymbolForAsset = (meta: WalletForAnalysisMeta): string => {
    const displayBase = String(
      meta.currencyAbbreviation || meta.rateCoin || meta.assetId,
    ).toUpperCase();
    if ((displayBaseCount.get(displayBase) ?? 0) <= 1) return displayBase;
    const chain = meta.chain ? meta.chain.toUpperCase() : '';
    if (!meta.tokenAddress)
      return chain
        ? `${displayBase} (${chain})`
        : `${displayBase} (${meta.assetId})`;
    const shortToken = shortenTokenAddress(meta.tokenAddress);
    return chain
      ? `${displayBase} (${chain}:${shortToken})`
      : `${displayBase} (${shortToken})`;
  };

  const assetSummaries: AssetPnlSummary[] = args.assetIds.map(assetId => {
    const meta = assetMetaById.get(assetId);
    const ids = walletIdsByAssetId.get(assetId) ?? new Set<string>();

    let startFiatBalance = 0;
    let endFiatBalance = 0;
    let startBasis = 0;
    let startPnl = 0;
    let endPnl = 0;
    let endBasis = 0;

    for (const wallet of args.walletMetas) {
      if (!ids.has(wallet.walletId)) continue;
      startFiatBalance += first.byWalletId[wallet.walletId]?.fiatBalance ?? 0;
      endFiatBalance += last.byWalletId[wallet.walletId]?.fiatBalance ?? 0;
      startBasis +=
        first.byWalletId[wallet.walletId]?.remainingCostBasisFiat ?? 0;
      startPnl += first.byWalletId[wallet.walletId]?.unrealizedPnlFiat ?? 0;
      endPnl += last.byWalletId[wallet.walletId]?.unrealizedPnlFiat ?? 0;
      endBasis += last.byWalletId[wallet.walletId]?.remainingCostBasisFiat ?? 0;
    }

    const rateStart = args.baselineRateByAssetId[assetId] ?? 0;
    const rateEnd =
      (typeof args.liveTerminalTs === 'number' &&
      args.endTs === args.liveTerminalTs
        ? getCurrentRateOverride(args.currentRatesByAssetId, assetId)
        : undefined) ??
      args.rateCursorByAssetId[assetId].getRateAt(args.endTs) ??
      0;
    const rateChange = rateEnd - rateStart;
    const ratePct = rateStart > 0 ? (rateChange / rateStart) * 100 : 0;
    const pnlPercent = endBasis > 0 ? (endPnl / endBasis) * 100 : 0;

    return {
      assetId,
      coin: meta?.rateCoin ?? '',
      currencyAbbreviation: meta?.currencyAbbreviation ?? '',
      chain: meta?.chain,
      tokenAddress: meta?.tokenAddress,
      displaySymbol: meta ? displaySymbolForAsset(meta) : assetId,
      rateStart,
      rateEnd,
      rateChange,
      ratePercentChange: ratePct,
      fiatBalanceStart: startFiatBalance,
      fiatBalanceEnd: endFiatBalance,
      remainingCostBasisFiatStart: startBasis,
      remainingCostBasisFiatEnd: endBasis,
      pnlStart: startPnl,
      pnlEnd: endPnl,
      pnlChange: endPnl - startPnl,
      pnlPercent,
    };
  });

  const totalSummary: TotalPnlSummary = {
    pnlStart: first.totalUnrealizedPnlFiat,
    pnlEnd: last.totalUnrealizedPnlFiat,
    pnlChange: last.totalUnrealizedPnlFiat - first.totalUnrealizedPnlFiat,
    pnlPercent: last.totalPnlPercent,
  };

  return {
    timeframe: args.timeframe,
    quoteCurrency: args.quoteCurrency,
    driverAssetId: args.driverAssetId,
    driverCoin: args.driverCoin,
    analysisWindow: args.analysisWindow,
    assetIds: args.assetIds,
    coins: args.coins,
    wallets: args.walletMetas,
    points: args.points,
    assetSummaries,
    totalSummary,
  };
}

export function buildPnlAnalysisSeriesFromPreloaded(
  args: PnlAnalysisPreloadedArgs,
): PnlAnalysisResult {
  'worklet';

  const wallets = args.wallets.slice();
  const walletMetas = wallets.map(w => w.wallet);
  const firstNonZeroTs =
    typeof args.firstNonZeroTs === 'number' &&
    Number.isFinite(args.firstNonZeroTs)
      ? args.firstNonZeroTs
      : findFirstNonZeroTsFromPreloadedWallets(wallets);

  if (!walletMetas.length) {
    return buildEmptyAnalysisResult(args.timeframe, args.cfg.quoteCurrency);
  }

  const context = buildAnalysisContext({
    cfg: args.cfg,
    wallets: walletMetas,
    timeframe: args.timeframe,
    ratePointsByAssetId: args.ratePointsByAssetId,
    currentRatesByAssetId: args.currentRatesByAssetId,
    firstNonZeroTs,
    startTs: args.startTs,
    endTs: args.endTs,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
    resolvedWindow: args.resolvedWindow,
  });

  type PreloadedWalletState = WalletAnalysisState & {
    points: PreparedWalletPoint[];
    nextIndex: number;
  };

  const stateByWalletId: Record<string, PreloadedWalletState> = {};
  for (const entry of wallets) {
    const points = args.walletPointsArePrepared
      ? validatePreparedWalletPoints(
          entry.points,
          context.startTs,
          context.endTs,
        )
      : normalizeWalletPointsForAnalysis(
          entry.points,
          context.startTs,
          context.endTs,
        );

    stateByWalletId[entry.wallet.walletId] = {
      ...createWalletAnalysisState(
        entry.wallet,
        entry.basePoint,
        context.baselineRateByAssetId,
      ),
      points,
      nextIndex: 0,
    };
  }

  const singleAsset = isSingleAsset(walletMetas);
  const points: PnlAnalysisPoint[] = [];

  for (const ts of context.timeline) {
    const byWalletId: Record<string, WalletPoint> = {};
    notifyByWalletIdConstruction();

    let totalFiatBalance = 0;
    let totalBasis = 0;
    let totalCryptoAtomic = 0n;
    let totalCryptoCreds: WalletCredentials | null = null;

    const driverRate = getAnalysisRateAtTimestamp({
      assetId: context.driverAssetId,
      ts,
      liveTerminalTs: context.liveTerminalTs,
      rateCursorByAssetId: context.rateCursorByAssetId,
      currentRatesByAssetId: context.currentRatesByAssetId,
    });

    for (const wallet of walletMetas) {
      const st = stateByWalletId[wallet.walletId];

      while (
        st.nextIndex < st.points.length &&
        st.points[st.nextIndex].timestamp <= ts
      ) {
        applyAnalysisPointToWalletState({
          state: st,
          point: st.points[st.nextIndex],
          rateCursorByAssetId: context.rateCursorByAssetId,
          baselineRateByAssetId: context.baselineRateByAssetId,
          currentRatesByAssetId: context.currentRatesByAssetId,
          liveTerminalTs: context.liveTerminalTs,
        });
        st.nextIndex += 1;
      }

      clampWalletAnalysisState(st);

      const rate = getAnalysisRateAtTimestamp({
        assetId: st.wallet.assetId,
        ts,
        liveTerminalTs: context.liveTerminalTs,
        rateCursorByAssetId: context.rateCursorByAssetId,
        currentRatesByAssetId: context.currentRatesByAssetId,
      });
      const units = st.atomicToUnitNumber(st.unitsAtomic);
      const fiatBalance = units * rate;
      const unrealized = fiatBalance - st.basisFiat;

      const baseRate = context.baselineRateByAssetId[st.wallet.assetId] ?? rate;
      const ratePct = baseRate > 0 ? ((rate - baseRate) / baseRate) * 100 : 0;
      const pnlPct = st.basisFiat > 0 ? (unrealized / st.basisFiat) * 100 : 0;

      notifyFormattedCryptoBalance();
      byWalletId[wallet.walletId] = {
        balanceAtomic: st.unitsAtomic.toString(),
        formattedCryptoBalance: formatAtomicAmount(
          st.unitsAtomic,
          wallet.credentials,
        ),
        fiatBalance,
        remainingCostBasisFiat: st.basisFiat,
        unrealizedPnlFiat: unrealized,
        markRate: rate,
        ratePercentChange: ratePct,
        pnlPercent: pnlPct,
      };

      totalFiatBalance += fiatBalance;
      totalBasis += st.basisFiat;

      if (singleAsset) {
        totalCryptoAtomic += st.unitsAtomic;
        totalCryptoCreds = totalCryptoCreds || wallet.credentials;
      }
    }

    const totalUnrealized = totalFiatBalance - totalBasis;
    const pnlStart =
      points.length > 0 ? points[0].totalUnrealizedPnlFiat : totalUnrealized;
    const totalPnlPercent =
      totalBasis > 0 ? (totalUnrealized / totalBasis) * 100 : 0;

    const driverBase =
      context.baselineRateByAssetId[context.driverAssetId] || driverRate;
    const ratePercentChange =
      driverBase > 0
        ? ((driverRate - driverBase) / driverBase) * 100
        : undefined;

    const totalCryptoBalanceAtomic = singleAsset
      ? totalCryptoAtomic.toString()
      : undefined;
    let totalCryptoBalanceFormatted: string | undefined;
    if (singleAsset && totalCryptoCreds) {
      notifyFormattedCryptoBalance();
      totalCryptoBalanceFormatted = formatAtomicAmount(
        totalCryptoAtomic,
        totalCryptoCreds,
      );
    }

    notifyPnlAnalysisPointConstruction();
    points.push({
      timestamp: ts,
      markRate: singleAsset ? driverRate : undefined,
      ratePercentChange: singleAsset ? ratePercentChange : undefined,
      totalCryptoBalanceAtomic,
      totalCryptoBalanceFormatted,
      totalFiatBalance,
      totalRemainingCostBasisFiat: totalBasis,
      totalUnrealizedPnlFiat: totalUnrealized,
      totalPnlChange: totalUnrealized - pnlStart,
      totalPnlPercent,
      byWalletId,
    });
  }

  return finalizeAnalysisResult({
    timeframe: args.timeframe,
    walletMetas,
    quoteCurrency: context.quoteCurrency,
    driverAssetId: context.driverAssetId,
    driverCoin: context.driverCoin,
    analysisWindow: {
      startTs: context.startTs,
      endTs: context.endTs,
      nowMs: context.nowMs,
    },
    assetIds: context.assetIds,
    coins: context.coins,
    points,
    baselineRateByAssetId: context.baselineRateByAssetId,
    rateCursorByAssetId: context.rateCursorByAssetId,
    currentRatesByAssetId: context.currentRatesByAssetId,
    endTs: context.endTs,
    liveTerminalTs: context.liveTerminalTs,
  });
}

export async function buildPnlAnalysisSeriesFromStreamed(
  args: PnlAnalysisStreamedArgs,
): Promise<PnlAnalysisResult> {
  'worklet';

  const wallets = args.wallets.slice();
  const walletMetas = wallets.map(w => w.wallet);
  const firstNonZeroTs =
    typeof args.firstNonZeroTs === 'number' &&
    Number.isFinite(args.firstNonZeroTs)
      ? args.firstNonZeroTs
      : null;

  if (!walletMetas.length) {
    return buildEmptyAnalysisResult(args.timeframe, args.cfg.quoteCurrency);
  }

  const context = buildAnalysisContext({
    cfg: args.cfg,
    wallets: walletMetas,
    timeframe: args.timeframe,
    ratePointsByAssetId: args.ratePointsByAssetId,
    currentRatesByAssetId: args.currentRatesByAssetId,
    firstNonZeroTs,
    startTs: args.startTs,
    endTs: args.endTs,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
    resolvedWindow: args.resolvedWindow,
  });

  const stateByWalletId = await createStreamedWalletStateById(wallets, context);

  const singleAsset = isSingleAsset(walletMetas);
  const points: PnlAnalysisPoint[] = [];

  for (const ts of context.timeline) {
    const byWalletId: Record<string, WalletPoint> = {};
    notifyByWalletIdConstruction();

    let totalFiatBalance = 0;
    let totalBasis = 0;
    let totalCryptoAtomic = 0n;
    let totalCryptoCreds: WalletCredentials | null = null;

    const driverRate = getAnalysisRateAtTimestamp({
      assetId: context.driverAssetId,
      ts,
      liveTerminalTs: context.liveTerminalTs,
      rateCursorByAssetId: context.rateCursorByAssetId,
      currentRatesByAssetId: context.currentRatesByAssetId,
    });

    for (const wallet of walletMetas) {
      const st = stateByWalletId[wallet.walletId];

      await advanceStreamedWalletStateToTimestamp({
        state: st,
        walletId: wallet.walletId,
        ts,
        context,
      });

      clampWalletAnalysisState(st);

      const rate = getAnalysisRateAtTimestamp({
        assetId: st.wallet.assetId,
        ts,
        liveTerminalTs: context.liveTerminalTs,
        rateCursorByAssetId: context.rateCursorByAssetId,
        currentRatesByAssetId: context.currentRatesByAssetId,
      });
      const units = st.atomicToUnitNumber(st.unitsAtomic);
      const fiatBalance = units * rate;
      const unrealized = fiatBalance - st.basisFiat;

      const baseRate = context.baselineRateByAssetId[st.wallet.assetId] ?? rate;
      const ratePct = baseRate > 0 ? ((rate - baseRate) / baseRate) * 100 : 0;
      const pnlPct = st.basisFiat > 0 ? (unrealized / st.basisFiat) * 100 : 0;

      notifyFormattedCryptoBalance();
      byWalletId[wallet.walletId] = {
        balanceAtomic: st.unitsAtomic.toString(),
        formattedCryptoBalance: formatAtomicAmount(
          st.unitsAtomic,
          wallet.credentials,
        ),
        fiatBalance,
        remainingCostBasisFiat: st.basisFiat,
        unrealizedPnlFiat: unrealized,
        markRate: rate,
        ratePercentChange: ratePct,
        pnlPercent: pnlPct,
      };

      totalFiatBalance += fiatBalance;
      totalBasis += st.basisFiat;

      if (singleAsset) {
        totalCryptoAtomic += st.unitsAtomic;
        totalCryptoCreds = totalCryptoCreds || wallet.credentials;
      }
    }

    const totalUnrealized = totalFiatBalance - totalBasis;
    const pnlStart =
      points.length > 0 ? points[0].totalUnrealizedPnlFiat : totalUnrealized;
    const totalPnlPercent =
      totalBasis > 0 ? (totalUnrealized / totalBasis) * 100 : 0;

    const driverBase =
      context.baselineRateByAssetId[context.driverAssetId] || driverRate;
    const ratePercentChange =
      driverBase > 0
        ? ((driverRate - driverBase) / driverBase) * 100
        : undefined;

    const totalCryptoBalanceAtomic = singleAsset
      ? totalCryptoAtomic.toString()
      : undefined;
    let totalCryptoBalanceFormatted: string | undefined;
    if (singleAsset && totalCryptoCreds) {
      notifyFormattedCryptoBalance();
      totalCryptoBalanceFormatted = formatAtomicAmount(
        totalCryptoAtomic,
        totalCryptoCreds,
      );
    }

    notifyPnlAnalysisPointConstruction();
    points.push({
      timestamp: ts,
      markRate: singleAsset ? driverRate : undefined,
      ratePercentChange: singleAsset ? ratePercentChange : undefined,
      totalCryptoBalanceAtomic,
      totalCryptoBalanceFormatted,
      totalFiatBalance,
      totalRemainingCostBasisFiat: totalBasis,
      totalUnrealizedPnlFiat: totalUnrealized,
      totalPnlChange: totalUnrealized - pnlStart,
      totalPnlPercent,
      byWalletId,
    });
  }

  return finalizeAnalysisResult({
    timeframe: args.timeframe,
    walletMetas,
    quoteCurrency: context.quoteCurrency,
    driverAssetId: context.driverAssetId,
    driverCoin: context.driverCoin,
    analysisWindow: {
      startTs: context.startTs,
      endTs: context.endTs,
      nowMs: context.nowMs,
    },
    assetIds: context.assetIds,
    coins: context.coins,
    points,
    baselineRateByAssetId: context.baselineRateByAssetId,
    rateCursorByAssetId: context.rateCursorByAssetId,
    currentRatesByAssetId: context.currentRatesByAssetId,
    endTs: context.endTs,
    liveTerminalTs: context.liveTerminalTs,
  });
}

export async function buildPnlAnalysisChartSeriesFromStreamed(
  args: PnlAnalysisStreamedArgs,
): Promise<PnlAnalysisChartResult> {
  'worklet';

  const wallets = args.wallets.slice();
  const walletMetas = wallets.map(w => w.wallet);
  const firstNonZeroTs =
    typeof args.firstNonZeroTs === 'number' &&
    Number.isFinite(args.firstNonZeroTs)
      ? args.firstNonZeroTs
      : null;

  if (!walletMetas.length) {
    return buildEmptyAnalysisChartResult(
      args.timeframe,
      args.cfg.quoteCurrency,
    );
  }

  const context = buildAnalysisContext({
    cfg: args.cfg,
    wallets: walletMetas,
    timeframe: args.timeframe,
    ratePointsByAssetId: args.ratePointsByAssetId,
    currentRatesByAssetId: args.currentRatesByAssetId,
    firstNonZeroTs,
    startTs: args.startTs,
    endTs: args.endTs,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
    resolvedWindow: args.resolvedWindow,
  });

  const stateByWalletId = await createStreamedWalletStateById(wallets, context);
  const singleAsset = isSingleAsset(walletMetas);
  const pointCount = context.timeline.length;
  const timestamps = new Array<number>(pointCount);
  const totalFiatBalance = new Array<number>(pointCount);
  const totalRemainingCostBasisFiat = new Array<number>(pointCount);
  const totalUnrealizedPnlFiat = new Array<number>(pointCount);
  const totalPnlChange = new Array<number>(pointCount);
  const totalPnlPercent = new Array<number>(pointCount);
  const driverMarkRate = singleAsset
    ? new Array<number | null>(pointCount)
    : undefined;
  const driverRatePercentChange = singleAsset
    ? new Array<number | null>(pointCount)
    : undefined;

  let firstTotalUnrealized: number | undefined;
  let latestRemainingCostBasisFiatTotal = 0;

  for (let i = 0; i < pointCount; i++) {
    const ts = context.timeline[i];
    let totalFiatBalanceForPoint = 0;
    let totalBasis = 0;

    const driverRate = getAnalysisRateAtTimestamp({
      assetId: context.driverAssetId,
      ts,
      liveTerminalTs: context.liveTerminalTs,
      rateCursorByAssetId: context.rateCursorByAssetId,
      currentRatesByAssetId: context.currentRatesByAssetId,
    });

    for (const wallet of walletMetas) {
      const state = stateByWalletId[wallet.walletId];

      await advanceStreamedWalletStateToTimestamp({
        state,
        walletId: wallet.walletId,
        ts,
        context,
      });

      clampWalletAnalysisState(state);

      const rate = getAnalysisRateAtTimestamp({
        assetId: state.wallet.assetId,
        ts,
        liveTerminalTs: context.liveTerminalTs,
        rateCursorByAssetId: context.rateCursorByAssetId,
        currentRatesByAssetId: context.currentRatesByAssetId,
      });
      const units = state.atomicToUnitNumber(state.unitsAtomic);
      totalFiatBalanceForPoint += units * rate;
      totalBasis += state.basisFiat;
    }

    const totalUnrealized = totalFiatBalanceForPoint - totalBasis;
    if (typeof firstTotalUnrealized !== 'number') {
      firstTotalUnrealized = totalUnrealized;
    }

    timestamps[i] = ts;
    totalFiatBalance[i] = totalFiatBalanceForPoint;
    totalRemainingCostBasisFiat[i] = totalBasis;
    totalUnrealizedPnlFiat[i] = totalUnrealized;
    totalPnlChange[i] = totalUnrealized - firstTotalUnrealized;
    totalPnlPercent[i] =
      totalBasis > 0 ? (totalUnrealized / totalBasis) * 100 : 0;
    latestRemainingCostBasisFiatTotal = totalBasis;

    if (driverMarkRate) {
      driverMarkRate[i] = Number.isFinite(driverRate) ? driverRate : null;
    }

    if (driverRatePercentChange) {
      const driverBase =
        context.baselineRateByAssetId[context.driverAssetId] ?? driverRate;
      driverRatePercentChange[i] =
        driverBase > 0 ? ((driverRate - driverBase) / driverBase) * 100 : null;
    }
  }

  const latestHoldingsByRateKey: Record<string, {units: number}> = {};
  const lastSpotRatesByRateKey: Record<string, number> = {};

  for (const wallet of walletMetas) {
    const state = stateByWalletId[wallet.walletId];
    if (!state) {
      continue;
    }

    const rateKey = getWalletChartRateKey(wallet);
    const units = state.atomicToUnitNumber(state.unitsAtomic);

    if (!latestHoldingsByRateKey[rateKey]) {
      latestHoldingsByRateKey[rateKey] = {units: 0};
    }
    latestHoldingsByRateKey[rateKey].units += units;

    const markRate = getAnalysisRateAtTimestamp({
      assetId: state.wallet.assetId,
      ts: context.endTs,
      liveTerminalTs: context.liveTerminalTs,
      rateCursorByAssetId: context.rateCursorByAssetId,
      currentRatesByAssetId: context.currentRatesByAssetId,
    });

    if (
      !(rateKey in lastSpotRatesByRateKey) &&
      Number.isFinite(markRate) &&
      markRate > 0
    ) {
      lastSpotRatesByRateKey[rateKey] = markRate;
    }
  }

  return {
    timeframe: args.timeframe,
    quoteCurrency: context.quoteCurrency,
    driverAssetId: context.driverAssetId,
    driverCoin: context.driverCoin,
    analysisWindow: {
      startTs: context.startTs,
      endTs: context.endTs,
      nowMs: context.nowMs,
    },
    assetIds: context.assetIds.slice(),
    coins: context.coins.slice(),
    singleAsset,
    timestamps,
    totalFiatBalance,
    totalRemainingCostBasisFiat,
    totalUnrealizedPnlFiat,
    totalPnlChange,
    totalPnlPercent,
    driverMarkRate,
    driverRatePercentChange,
    lastSpotRatesByRateKey,
    latestHoldingsByRateKey,
    latestRemainingCostBasisFiatTotal,
  };
}
