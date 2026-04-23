import type {Wallet} from '../../../store/wallet/wallet.models';
import type {
  AssetPnlSummary,
  PnlAnalysisPoint,
  PnlAnalysisResult,
} from '../../core/pnl/analysisStreaming';
import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import type {StoredWallet} from '../../core/types';
import type {GainLossMode} from '../../../utils/portfolio/assets';

type SerializableDisplayedMetrics = {
  fiatBalance?: number;
  pnlChange?: number;
  pnlPercent?: number;
  hasRate?: boolean;
  hasPnl?: boolean;
  showPnlPlaceholder?: boolean;
};

type SerializableDisplayedPoint = {
  timestamp?: number;
  totalFiatBalance?: number;
  totalPnlChange?: number;
  totalPnlPercent?: number;
};

export type AssetPnlDebugPayloadArgs = {
  surface: string;
  assetKey: string;
  gainLossMode: GainLossMode;
  quoteCurrency: string;
  storedWallets: StoredWallet[];
  eligibleWallets?: Wallet[];
  analysis?: PnlAnalysisResult;
  currentData?: PnlAnalysisResult;
  committedData?: PnlAnalysisResult;
  error?: Error;
  requestKey?: string;
  currentRatesByAssetId?: Record<string, number>;
  currentRatesSignature?: string;
  baseDebugPayload?: Record<string, unknown>;
  displayedMetrics?: SerializableDisplayedMetrics;
  formattedDisplay?: Record<string, unknown>;
  changeRow?: Record<string, unknown>;
  selectionActive?: boolean;
  selectedPoint?: SerializableDisplayedPoint;
  extraDebugData?: Record<string, unknown>;
};

type AggregatedAssetSummary = {
  fiatValue: number;
  pnlChange: number;
  pnlEnd: number;
  remainingCostBasisFiatEnd: number;
  hasRate: boolean;
  hasPnl: boolean;
  pnlPercent: number;
};

const REDACTED_PREFIX = '<redacted:';
const SENSITIVE_KEY_SUBSTRINGS = [
  'walletid',
  'walletids',
  'keyid',
  'keyids',
  'keyscope',
  'address',
  'addresses',
  'tokenaddress',
  'tokenaddresses',
  'assetid',
  'assetids',
  'requestkey',
  'signature',
  'queryrevisionkey',
  'storedwalletrequestsig',
  'currentratessignature',
  'currentspotratessignature',
  'routekey',
  'sessionid',
  'sessiontoken',
  'cleardatatoken',
  'refreshtoken',
  'copayerid',
  'copayerids',
];
const SENSITIVE_CHILD_KEY_PARENT_SUBSTRINGS = [
  'byassetid',
  'byratekey',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableHash(input: string): string {
  let hash = 5381;

  for (let index = 0; index < input.length; index++) {
    hash = (hash * 33 + input.charCodeAt(index)) % 4294967291;
  }

  return Math.abs(hash).toString(16).padStart(8, '0');
}

function buildRedactedValue(kind: string, value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = String(value);
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith(REDACTED_PREFIX)) {
    return normalized;
  }

  return `<redacted:${kind}:${stableHash(normalized)}>`;
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_SUBSTRINGS.some(part => key.includes(part));
}

function shouldRedactChildKeys(key: string): boolean {
  return SENSITIVE_CHILD_KEY_PARENT_SUBSTRINGS.some(part => key.includes(part));
}

function redactSensitiveValue(value: unknown, kind: string): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveValue(item, kind));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};

    for (const [childKey, childValue] of Object.entries(value)) {
      out[buildRedactedValue(`${kind}.key`, childKey) || childKey] =
        redactDebugIdentifiers(childValue, childKey);
    }

    return out;
  }

  return buildRedactedValue(kind, value);
}

export function redactDebugIdentifiers<T>(
  value: T,
  parentKey?: string,
): T {
  if (Array.isArray(value)) {
    return value.map(item =>
      redactDebugIdentifiers(item, parentKey),
    ) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  const normalizedParentKey = String(parentKey || '').toLowerCase();

  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (shouldRedactKey(normalizedKey)) {
      out[key] = redactSensitiveValue(rawValue, normalizedKey);
      continue;
    }

    if (shouldRedactChildKeys(normalizedKey) && isRecord(rawValue)) {
      const next: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(rawValue)) {
        next[
          buildRedactedValue(`${normalizedKey}.key`, childKey) || childKey
        ] = redactDebugIdentifiers(childValue, key);
      }
      out[key] = next;
      continue;
    }

    if (shouldRedactChildKeys(normalizedParentKey) && typeof rawValue === 'string') {
      out[key] = buildRedactedValue(`${normalizedParentKey}.value`, rawValue);
      continue;
    }

    out[key] = redactDebugIdentifiers(rawValue, key);
  }

  return out as T;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function subtractOrNull(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (
    typeof left !== 'number' ||
    !Number.isFinite(left) ||
    typeof right !== 'number' ||
    !Number.isFinite(right)
  ) {
    return null;
  }

  return left - right;
}

function aggregateAssetSummaries(
  summaries: AssetPnlSummary[],
): AggregatedAssetSummary {
  const fiatValue = summaries.reduce(
    (total, summary) => total + (summary.fiatBalanceEnd || 0),
    0,
  );
  const pnlChange = summaries.reduce(
    (total, summary) => total + (summary.pnlChange || 0),
    0,
  );
  const pnlEnd = summaries.reduce(
    (total, summary) => total + (summary.pnlEnd || 0),
    0,
  );
  const remainingCostBasisFiatEnd = summaries.reduce(
    (total, summary) => total + (summary.remainingCostBasisFiatEnd || 0),
    0,
  );
  const hasRate = summaries.some(
    summary =>
      typeof summary.rateEnd === 'number' &&
      Number.isFinite(summary.rateEnd) &&
      summary.rateEnd > 0,
  );
  const hasPnl = summaries.length > 0;

  return {
    fiatValue,
    pnlChange,
    pnlEnd,
    remainingCostBasisFiatEnd,
    hasRate,
    hasPnl,
    pnlPercent:
      remainingCostBasisFiatEnd > 0
        ? (pnlEnd / remainingCostBasisFiatEnd) * 100
        : 0,
  };
}

function serializeAnalysisPoint(
  point?: PnlAnalysisPoint | SerializableDisplayedPoint,
): Record<string, unknown> | null {
  if (!point) {
    return null;
  }

  return {
    timestamp:
      typeof point.timestamp === 'number' && Number.isFinite(point.timestamp)
        ? point.timestamp
        : null,
    totalFiatBalance: asFiniteNumberOrNull(point.totalFiatBalance),
    totalPnlChange: asFiniteNumberOrNull(point.totalPnlChange),
    totalPnlPercent: asFiniteNumberOrNull(point.totalPnlPercent),
  };
}

function serializeRelevantRates(args: {
  currentRatesByAssetId?: Record<string, number>;
  assetIds: string[];
}): Record<string, number> {
  const out: Record<string, number> = {};

  for (const assetId of args.assetIds) {
    const rate = args.currentRatesByAssetId?.[assetId];
    if (typeof rate === 'number' && Number.isFinite(rate)) {
      out[assetId] = rate;
    }
  }

  return out;
}

function serializeAnalysisResult(args: {
  result?: PnlAnalysisResult;
  assetIds: string[];
}): Record<string, unknown> | null {
  const {result} = args;
  if (!result) {
    return null;
  }

  const assetSummaries = Array.isArray(result.assetSummaries)
    ? result.assetSummaries
    : [];
  const wallets = Array.isArray(result.wallets) ? result.wallets : [];
  const points = Array.isArray(result.points) ? result.points : [];
  const matchedAssetSummaries = assetSummaries.filter(summary =>
    args.assetIds.length ? args.assetIds.includes(summary.assetId) : true,
  );
  const aggregatedAssetSummary = aggregateAssetSummaries(matchedAssetSummaries);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  return {
    timeframe: result.timeframe,
    quoteCurrency: result.quoteCurrency,
    driverAssetId: result.driverAssetId,
    driverCoin: result.driverCoin,
    analysisWindow: result.analysisWindow
      ? {
          startTs: result.analysisWindow.startTs,
          endTs: result.analysisWindow.endTs,
          nowMs: result.analysisWindow.nowMs,
        }
      : null,
    assetIds: Array.isArray(result.assetIds) ? result.assetIds : [],
    walletIds: wallets.map(wallet => wallet.walletId),
    pointsCount: points.length,
    firstPoint: serializeAnalysisPoint(firstPoint),
    lastPoint: serializeAnalysisPoint(lastPoint),
    totalSummary: result.totalSummary,
    matchedAssetSummaries,
    aggregatedAssetSummary,
  };
}

function serializeStoredWallets(storedWallets: StoredWallet[]): Array<Record<string, unknown>> {
  return storedWallets.map(wallet => ({
    walletId: wallet.walletId,
    assetId: getAssetIdFromWallet(wallet.summary),
    chain: wallet.summary?.chain || null,
    currencyAbbreviation: wallet.summary?.currencyAbbreviation || null,
    tokenAddress: wallet.summary?.tokenAddress || null,
    network: wallet.summary?.network || null,
    balanceAtomic: wallet.summary?.balanceAtomic || null,
  }));
}

export function buildAssetPnlDebugPayload(
  args: AssetPnlDebugPayloadArgs,
): Record<string, unknown> {
  const baseDebugPayload = isRecord(args.baseDebugPayload)
    ? args.baseDebugPayload
    : {};
  const rowAssetIds = asStringArray(baseDebugPayload.rowAssetIds);
  const rowWalletIds = asStringArray(baseDebugPayload.rowWalletIds);
  const dataWalletIds = new Set(
    (args.analysis?.wallets || []).map(wallet => wallet.walletId),
  );
  const currentWalletIds = new Set(
    (args.currentData?.wallets || []).map(wallet => wallet.walletId),
  );
  const committedWalletIds = new Set(
    (args.committedData?.wallets || []).map(wallet => wallet.walletId),
  );
  const dataAssetIds = new Set(args.analysis?.assetIds || []);
  const currentAssetIds = new Set(args.currentData?.assetIds || []);
  const committedAssetIds = new Set(args.committedData?.assetIds || []);
  const displayedFiatBalance = asFiniteNumberOrNull(
    args.displayedMetrics?.fiatBalance,
  );
  const displayedPnlChange = asFiniteNumberOrNull(
    args.displayedMetrics?.pnlChange,
  );
  const displayedPnlPercent = asFiniteNumberOrNull(
    args.displayedMetrics?.pnlPercent,
  );
  const canonicalDataResult = serializeAnalysisResult({
    result: args.analysis,
    assetIds: rowAssetIds,
  });
  const canonicalAggregatedSummary = isRecord(canonicalDataResult)
    ? (canonicalDataResult.aggregatedAssetSummary as
        | AggregatedAssetSummary
        | undefined)
    : undefined;

  return redactDebugIdentifiers({
    version: 1,
    source: 'buildAssetPnlDebugPayload',
    generatedAtUtc: new Date().toISOString(),
    surface: args.surface,
    asset: {
      key: args.assetKey,
      gainLossMode: args.gainLossMode,
      quoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase(),
      rowAssetIds,
      rowWalletIds,
    },
    analysisInputs: {
      requestKey: args.requestKey || null,
      currentRatesSignature: args.currentRatesSignature || null,
      relevantCurrentRatesByAssetId: serializeRelevantRates({
        currentRatesByAssetId: args.currentRatesByAssetId,
        assetIds: rowAssetIds,
      }),
      storedWalletIds: (args.storedWallets || []).map(wallet => wallet.walletId),
      eligibleWalletIds: (args.eligibleWallets || [])
        .map(wallet => String(wallet?.id || ''))
        .filter(Boolean),
      storedWallets: serializeStoredWallets(args.storedWallets || []),
    },
    analysisState: {
      error: args.error
        ? {
            name: args.error.name,
            message: args.error.message,
          }
        : null,
      hasData: !!args.analysis,
      hasCurrentData: !!args.currentData,
      hasCommittedData: !!args.committedData,
      dataIsCurrentData: args.analysis === args.currentData,
      dataIsCommittedData: args.analysis === args.committedData,
    },
    rowCoverage: {
      dataContainsRowWalletIds: rowWalletIds.filter(walletId =>
        dataWalletIds.has(walletId),
      ),
      dataMissingRowWalletIds: rowWalletIds.filter(
        walletId => !dataWalletIds.has(walletId),
      ),
      currentContainsRowWalletIds: rowWalletIds.filter(walletId =>
        currentWalletIds.has(walletId),
      ),
      currentMissingRowWalletIds: rowWalletIds.filter(
        walletId => !currentWalletIds.has(walletId),
      ),
      committedContainsRowWalletIds: rowWalletIds.filter(walletId =>
        committedWalletIds.has(walletId),
      ),
      committedMissingRowWalletIds: rowWalletIds.filter(
        walletId => !committedWalletIds.has(walletId),
      ),
      dataContainsRowAssetIds: rowAssetIds.filter(assetId =>
        dataAssetIds.has(assetId),
      ),
      currentContainsRowAssetIds: rowAssetIds.filter(assetId =>
        currentAssetIds.has(assetId),
      ),
      committedContainsRowAssetIds: rowAssetIds.filter(assetId =>
        committedAssetIds.has(assetId),
      ),
    },
    canonicalResults: {
      data: canonicalDataResult,
      current: serializeAnalysisResult({
        result: args.currentData,
        assetIds: rowAssetIds,
      }),
      committed: serializeAnalysisResult({
        result: args.committedData,
        assetIds: rowAssetIds,
      }),
    },
    displayed: {
      source: args.selectionActive ? 'selected' : 'idle',
      selectionActive: !!args.selectionActive,
      metrics: {
        fiatBalance: displayedFiatBalance,
        pnlChange: displayedPnlChange,
        pnlPercent: displayedPnlPercent,
        hasRate:
          typeof args.displayedMetrics?.hasRate === 'boolean'
            ? args.displayedMetrics.hasRate
            : null,
        hasPnl:
          typeof args.displayedMetrics?.hasPnl === 'boolean'
            ? args.displayedMetrics.hasPnl
            : null,
        showPnlPlaceholder:
          typeof args.displayedMetrics?.showPnlPlaceholder === 'boolean'
            ? args.displayedMetrics.showPnlPlaceholder
            : null,
      },
      formatted: args.formattedDisplay || null,
      changeRow: args.changeRow || null,
      selectedPoint: serializeAnalysisPoint(args.selectedPoint),
    },
    consistencyChecks: {
      displayedMinusCanonicalFiatBalance: subtractOrNull(
        displayedFiatBalance,
        asFiniteNumberOrNull(canonicalAggregatedSummary?.fiatValue),
      ),
      displayedMinusCanonicalPnlChange: subtractOrNull(
        displayedPnlChange,
        asFiniteNumberOrNull(canonicalAggregatedSummary?.pnlChange),
      ),
      displayedMinusCanonicalPnlPercent: subtractOrNull(
        displayedPnlPercent,
        asFiniteNumberOrNull(canonicalAggregatedSummary?.pnlPercent),
      ),
      selectedMinusCanonicalPnlChange: subtractOrNull(
        asFiniteNumberOrNull(args.selectedPoint?.totalPnlChange),
        asFiniteNumberOrNull(canonicalAggregatedSummary?.pnlChange),
      ),
      selectedMinusCanonicalPnlPercent: subtractOrNull(
        asFiniteNumberOrNull(args.selectedPoint?.totalPnlPercent),
        asFiniteNumberOrNull(canonicalAggregatedSummary?.pnlPercent),
      ),
    },
    rowComputation: baseDebugPayload,
    extra: args.extraDebugData || null,
  });
}

export default buildAssetPnlDebugPayload;
