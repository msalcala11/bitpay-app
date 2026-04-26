import type {FiatRatePoint} from '../../core/fiatRatesShared';
import {isStoredFiatRateInterval} from '../../core/fiatRatesShared';
import {createPreparedRateReader} from '../../core/pnl/rateReader';
import type {
  AssetGroupComputedStateInput,
  WalletComputedStateInput,
} from './portfolioState';
import type {
  Interval,
  MarketRatePoint,
  PerIntervalSeries,
  RowPayload,
  Series,
  StoredRateInterval,
} from '../model';
import {
  buildWalletSeriesFromEvents,
  type BalanceChangeEvent,
  type BuildWalletSeriesFromEventsArgs,
} from './seriesFormula';
import {buildRowPayloadFromSeries} from './rowPayload';
import type {WeightedGroupRateConstituentInput} from './weightedGroupRates';

export type FormulaWalletIntervalInput = Readonly<{
  interval: Interval;
  seriesIdentityKey: string;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  finalPointSource: Series['finalPointSource'];
  baselineUnits: number;
  balanceEvents?: readonly BalanceChangeEvent[];
  ratePoints: readonly FiatRatePoint[];
  maxPoints?: number;
}>;

export type FormulaWalletInput = Readonly<{
  walletId: string;
  assetGroupId: string;
  assetIdentityKey: string;
  rateSourceKey: string;
  displayUnitsAtomic: string;
  displayUnitDecimals: number;
  liveRate?: number;
  lastWrittenAt: number;
  lastAccessedAt: number;
  intervals: readonly FormulaWalletIntervalInput[];
}>;

export type FormulaAssetGroupInput = Readonly<{
  assetGroupId: string;
  displaySymbol: string;
  orderIndex: number;
  symbolCollisionSuspected?: boolean;
}>;

export type BuildFormulaComputedInputsArgs = Readonly<{
  quoteCurrency: string;
  wallets: readonly FormulaWalletInput[];
  assetGroups: readonly FormulaAssetGroupInput[];
}>;

export type FormulaComputedInputsInvalidReason =
  | 'invalidQuoteCurrency'
  | 'invalidWalletIdentity'
  | 'invalidAssetGroupIdentity'
  | 'invalidDisplayUnitsAtomic'
  | 'invalidDisplayUnitDecimals'
  | 'invalidWalletTimestamp'
  | 'invalidWalletInterval'
  | 'invalidWalletIntervalWindow'
  | 'invalidWalletIntervalIdentity'
  | 'duplicateWalletId'
  | 'duplicateAssetGroupId'
  | 'duplicateWalletInterval'
  | 'unknownAssetGroup'
  | 'seriesTimelineMismatch';

export type BuildFormulaComputedInputsResult =
  | Readonly<{
      kind: 'valid';
      wallets: readonly WalletComputedStateInput[];
      assetGroups: readonly AssetGroupComputedStateInput[];
      invalidHistoryWalletIds: readonly string[];
      missingRateSourceKeys: readonly string[];
    }>
  | Readonly<{
      kind: 'invalid';
      reason: FormulaComputedInputsInvalidReason;
    }>;

type WalletBuildState = Readonly<{
  input: FormulaWalletInput;
  computed: WalletComputedStateInput;
  marketRatePointsByInterval: Readonly<
    Partial<Record<Interval, readonly MarketRatePoint[]>>
  >;
  validIntervals: Readonly<Partial<Record<Interval, true>>>;
  missingRateIntervals: Readonly<Partial<Record<Interval, true>>>;
  invalidHistoryBlocked: boolean;
}>;

function stableNumber(value: number): string {
  'worklet';

  if (!Number.isFinite(value)) {
    return 'nonfinite';
  }

  if (Object.is(value, -0)) {
    return '0';
  }

  return String(value);
}

function stableHash(values: readonly (boolean | number | string)[]): string {
  'worklet';

  const input = values
    .map(value => (typeof value === 'number' ? stableNumber(value) : String(value)))
    .join('|');
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function isStrictIdentity(value: unknown): value is string {
  'worklet';

  return (
    typeof value === 'string' && !!value.trim() && value === value.trim()
  );
}

function normalizeDisplaySymbol(value: unknown): string | null {
  'worklet';

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isFiniteNumber(value: unknown): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function isValidAtomicString(value: unknown): value is string {
  'worklet';

  return typeof value === 'string' && /^\d+$/.test(value);
}

function isValidDisplayUnitDecimals(value: unknown): value is number {
  'worklet';

  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 30
  );
}

function isInterval(value: unknown): value is Interval {
  'worklet';

  return (
    value === '1D' ||
    value === '1W' ||
    value === '1M' ||
    value === '3M' ||
    value === '1Y' ||
    value === '5Y' ||
    value === 'ALL'
  );
}

function isFinalPointSource(
  value: unknown,
): value is Series['finalPointSource'] {
  'worklet';

  return value === 'historicalRate' || value === 'liveRate';
}

function validateFormulaWalletInterval(
  interval: FormulaWalletIntervalInput,
): FormulaComputedInputsInvalidReason | undefined {
  'worklet';

  if (
    !isInterval(interval.interval) ||
    !isStoredFiatRateInterval(interval.sampledFromStoredInterval) ||
    !isFinalPointSource(interval.finalPointSource)
  ) {
    return 'invalidWalletInterval';
  }
  if (
    !isStrictIdentity(interval.seriesIdentityKey)
  ) {
    return 'invalidWalletIntervalIdentity';
  }
  if (
    !isFiniteNumber(interval.windowStartTs) ||
    !isFiniteNumber(interval.windowEndTs) ||
    interval.windowEndTs <= interval.windowStartTs
  ) {
    return 'invalidWalletIntervalWindow';
  }

  return undefined;
}

function validateFormulaAssetGroup(
  group: FormulaAssetGroupInput,
): FormulaComputedInputsInvalidReason | undefined {
  'worklet';

  if (
    !isStrictIdentity(group.assetGroupId) ||
    !normalizeDisplaySymbol(group.displaySymbol) ||
    !isFiniteNumber(group.orderIndex)
  ) {
    return 'invalidAssetGroupIdentity';
  }

  return undefined;
}

function validateFormulaWallet(
  wallet: FormulaWalletInput,
): FormulaComputedInputsInvalidReason | undefined {
  'worklet';

  if (
    !isStrictIdentity(wallet.walletId) ||
    !isStrictIdentity(wallet.assetGroupId) ||
    !isStrictIdentity(wallet.assetIdentityKey) ||
    !isStrictIdentity(wallet.rateSourceKey)
  ) {
    return 'invalidWalletIdentity';
  }
  if (!isValidAtomicString(wallet.displayUnitsAtomic)) {
    return 'invalidDisplayUnitsAtomic';
  }
  if (!isValidDisplayUnitDecimals(wallet.displayUnitDecimals)) {
    return 'invalidDisplayUnitDecimals';
  }
  if (
    !isFiniteNumber(wallet.lastWrittenAt) ||
    !isFiniteNumber(wallet.lastAccessedAt)
  ) {
    return 'invalidWalletTimestamp';
  }

  const seenIntervals = new Set<Interval>();
  for (const interval of wallet.intervals) {
    const invalidIntervalReason = validateFormulaWalletInterval(interval);
    if (invalidIntervalReason) {
      return invalidIntervalReason;
    }
    if (seenIntervals.has(interval.interval)) {
      return 'duplicateWalletInterval';
    }
    seenIntervals.add(interval.interval);
  }

  return undefined;
}

function buildMarketRatePointsForSeries(
  interval: FormulaWalletIntervalInput,
  series: Series,
): readonly MarketRatePoint[] | undefined {
  'worklet';

  const reader = createPreparedRateReader({
    series: interval.ratePoints,
    policy: 'linearRender',
  });
  const start = reader.read(series.windowStartTs);

  if (start.kind !== 'rate') {
    return undefined;
  }

  const out: MarketRatePoint[] = [];
  for (const point of series.points) {
    const rate = reader.read(point.ts);
    if (rate.kind !== 'rate') {
      return undefined;
    }
    out.push({
      ts: point.ts,
      rate: rate.rate,
      percentChange: ((rate.rate - start.rate) / start.rate) * 100,
    });
  }

  return out;
}

function buildWalletRows(args: {
  assetGroupId: string;
  series: PerIntervalSeries;
  marketRatePointsByInterval: Readonly<
    Partial<Record<Interval, readonly MarketRatePoint[]>>
  >;
}): Pick<WalletComputedStateInput, 'rowToday' | 'rowAllTime'> {
  'worklet';

  const rows: Partial<Record<'rowToday' | 'rowAllTime', RowPayload>> = {};
  const rowIntervals: readonly Readonly<{
    interval: Interval;
    key: 'rowToday' | 'rowAllTime';
  }>[] = [
    {interval: '1D', key: 'rowToday'},
    {interval: 'ALL', key: 'rowAllTime'},
  ];

  for (const rowInterval of rowIntervals) {
    const series = args.series[rowInterval.interval];
    const marketPoints = args.marketRatePointsByInterval[rowInterval.interval];
    if (!series || !marketPoints?.length) {
      continue;
    }

    const first = marketPoints[0];
    const last = marketPoints[marketPoints.length - 1];
    const row = buildRowPayloadFromSeries({
      assetGroupId: args.assetGroupId,
      series,
      rateStart: first.rate,
      rateEnd: last.rate,
      ratePercent: last.percentChange,
    });

    if (row.kind === 'valid') {
      rows[rowInterval.key] = row.row;
    }
  }

  return rows;
}

function buildWalletState(
  wallet: FormulaWalletInput,
): {
  state: WalletBuildState;
  invalidHistory: boolean;
  missingRateSourceKeys: readonly string[];
} {
  'worklet';

  const series: Partial<Record<Interval, Series>> = {};
  const marketRatePointsByInterval: Partial<
    Record<Interval, readonly MarketRatePoint[]>
  > = {};
  const validIntervals: Partial<Record<Interval, true>> = {};
  const missingRateIntervals: Partial<Record<Interval, true>> = {};
  const missingRateSourceKeys: string[] = [];
  let invalidHistory = false;

  for (const interval of wallet.intervals) {
    const formulaArgs: BuildWalletSeriesFromEventsArgs = {
      ...interval,
    };
    const built = buildWalletSeriesFromEvents(formulaArgs);
    if (built.kind === 'valid') {
      series[interval.interval] = built.series;
      validIntervals[interval.interval] = true;
      const marketPoints = buildMarketRatePointsForSeries(
        interval,
        built.series,
      );
      if (marketPoints) {
        marketRatePointsByInterval[interval.interval] = marketPoints;
      }
      continue;
    }

    if (built.kind === 'missingRate') {
      missingRateIntervals[interval.interval] = true;
      missingRateSourceKeys.push(wallet.rateSourceKey);
      continue;
    }

    invalidHistory = true;
  }

  const effectiveSeries = invalidHistory ? {} : series;
  const effectiveMarketRatePointsByInterval = invalidHistory
    ? {}
    : marketRatePointsByInterval;
  const rows = invalidHistory
    ? {}
    : buildWalletRows({
        assetGroupId: wallet.assetGroupId,
        series: effectiveSeries,
        marketRatePointsByInterval: effectiveMarketRatePointsByInterval,
      });

  return {
    state: {
      input: wallet,
      marketRatePointsByInterval: effectiveMarketRatePointsByInterval,
      validIntervals: invalidHistory ? {} : validIntervals,
      missingRateIntervals: invalidHistory ? {} : missingRateIntervals,
      invalidHistoryBlocked: invalidHistory,
      computed: {
        walletId: wallet.walletId,
        assetGroupId: wallet.assetGroupId,
        series: effectiveSeries,
        ...rows,
        lastWrittenAt: wallet.lastWrittenAt,
        lastAccessedAt: wallet.lastAccessedAt,
      },
    },
    invalidHistory,
    missingRateSourceKeys,
  };
}

function intervalKeysForWallets(
  wallets: readonly WalletBuildState[],
): readonly Interval[] {
  'worklet';

  return uniqueSorted(
    wallets.flatMap(wallet =>
      wallet.input.intervals.map(interval => interval.interval),
    ),
  ) as readonly Interval[];
}

function aggregateSeries(args: {
  identityKey: string;
  interval: Interval;
  memberSeries: readonly Series[];
}): Series | null {
  'worklet';

  if (!args.memberSeries.length) {
    return null;
  }

  const firstSeries = args.memberSeries[0];
  const pointCount = firstSeries.points.length;
  const points = firstSeries.points.map((point, pointIndex) => {
    let fiatBalance = 0;
    let remainingUnrealizedPnlFiat = 0;
    let pnlChange = 0;

    for (const series of args.memberSeries) {
      const memberPoint = series.points[pointIndex];
      if (
        !memberPoint ||
        series.interval !== firstSeries.interval ||
        series.windowStartTs !== firstSeries.windowStartTs ||
        series.windowEndTs !== firstSeries.windowEndTs ||
        series.sampledFromStoredInterval !== firstSeries.sampledFromStoredInterval ||
        series.finalPointSource !== firstSeries.finalPointSource ||
        series.points.length !== pointCount ||
        memberPoint.ts !== point.ts
      ) {
        return null;
      }

      fiatBalance += memberPoint.fiatBalance;
      remainingUnrealizedPnlFiat += memberPoint.remainingUnrealizedPnlFiat;
      pnlChange += memberPoint.pnlChange;
    }

    const remainingCostBasisFiat = fiatBalance - remainingUnrealizedPnlFiat;
    return {
      ts: point.ts,
      fiatBalance,
      remainingUnrealizedPnlFiat,
      pnlChange,
      pnlPercent:
        remainingCostBasisFiat > 0
          ? (remainingUnrealizedPnlFiat / remainingCostBasisFiat) * 100
          : 0,
    };
  });

  if (points.some(point => point === null)) {
    return null;
  }

  const validPoints = points as Series['points'];
  return {
    fingerprint: stableHash([
      args.identityKey,
      args.interval,
      firstSeries.windowStartTs,
      firstSeries.windowEndTs,
      firstSeries.sampledFromStoredInterval,
      firstSeries.finalPointSource,
      ...args.memberSeries.map(series => series.fingerprint).sort(),
      ...validPoints.flatMap(point => [
        point.ts,
        point.fiatBalance,
        point.remainingUnrealizedPnlFiat,
        point.pnlChange,
        point.pnlPercent,
      ]),
    ]),
    interval: args.interval,
    windowStartTs: firstSeries.windowStartTs,
    windowEndTs: firstSeries.windowEndTs,
    sampledFromStoredInterval: firstSeries.sampledFromStoredInterval,
    finalPointSource: firstSeries.finalPointSource,
    points: validPoints,
  };
}

function getWalletInterval(
  wallet: FormulaWalletInput,
  interval: Interval,
): FormulaWalletIntervalInput | undefined {
  'worklet';

  return wallet.intervals.find(candidate => candidate.interval === interval);
}

function buildAssetGroupInput(args: {
  group: FormulaAssetGroupInput;
  wallets: readonly WalletBuildState[];
}): AssetGroupComputedStateInput | null {
  'worklet';

  const intervals = intervalKeysForWallets(args.wallets);
  const series: Partial<Record<Interval, Series>> = {};
  const marketRatePointsByInterval: Partial<
    Record<Interval, readonly MarketRatePoint[]>
  > = {};
  const weightedConstituentsByInterval: Partial<
    Record<Interval, readonly WeightedGroupRateConstituentInput[]>
  > = {};
  const sampledFromStoredIntervalByInterval: Partial<
    Record<Interval, StoredRateInterval>
  > = {};

  for (const interval of intervals) {
    const validMemberSeries = args.wallets
      .map(wallet => wallet.computed.series[interval])
      .filter((candidate): candidate is Series => !!candidate);
    const hasMissingRate = args.wallets.some(
      wallet => wallet.missingRateIntervals[interval],
    );

    if (validMemberSeries.length && !hasMissingRate) {
      const aggregated = aggregateSeries({
        identityKey: [
          'assetGroup',
          args.group.assetGroupId,
          interval,
          ...args.wallets.map(wallet => wallet.input.walletId).sort(),
        ].join('|'),
        interval,
        memberSeries: validMemberSeries,
      });
      if (!aggregated) {
        return null;
      }
      series[interval] = aggregated;
      sampledFromStoredIntervalByInterval[interval] =
        aggregated.sampledFromStoredInterval;
    }

    const rateSourceEntries = new Map<
      string,
      {baselineUnits: number; points: readonly MarketRatePoint[]}
    >();
    for (const wallet of args.wallets) {
      const walletInterval = getWalletInterval(wallet.input, interval);
      if (!walletInterval) {
        continue;
      }

      const existing = rateSourceEntries.get(wallet.input.rateSourceKey);
      const marketPoints = wallet.marketRatePointsByInterval[interval] ?? [];
      rateSourceEntries.set(wallet.input.rateSourceKey, {
        baselineUnits:
          (existing?.baselineUnits ?? 0) + walletInterval.baselineUnits,
        points: existing?.points.length ? existing.points : marketPoints,
      });
    }

    const rateSourceKeys = Array.from(rateSourceEntries.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    if (rateSourceKeys.length === 1) {
      const entry = rateSourceEntries.get(rateSourceKeys[0]);
      if (entry?.points.length) {
        marketRatePointsByInterval[interval] = entry.points;
      }
    } else if (rateSourceKeys.length > 1) {
      weightedConstituentsByInterval[interval] = rateSourceKeys.map(key => {
        const entry = rateSourceEntries.get(key);
        return {
          rateSourceKey: key,
          baselineUnits: entry?.baselineUnits ?? 0,
          points: entry?.points ?? [],
        };
      });
    }
  }

  return {
    assetGroupId: args.group.assetGroupId,
    displaySymbol: args.group.displaySymbol,
    orderIndex: args.group.orderIndex,
    series,
    members: args.wallets.map(wallet => ({
      walletId: wallet.input.walletId,
      assetIdentityKey: wallet.input.assetIdentityKey,
      rateSourceKey: wallet.input.rateSourceKey,
      displayUnitsAtomic: wallet.input.displayUnitsAtomic,
      displayUnitDecimals: wallet.input.displayUnitDecimals,
      liveRate: wallet.input.liveRate,
      invalidHistoryBlocked: wallet.invalidHistoryBlocked,
    })),
    marketRatePointsByInterval,
    weightedConstituentsByInterval,
    sampledFromStoredIntervalByInterval,
    ...(typeof args.group.symbolCollisionSuspected === 'boolean'
      ? {symbolCollisionSuspected: args.group.symbolCollisionSuspected}
      : {}),
  };
}

export function buildFormulaComputedInputs(
  args: BuildFormulaComputedInputsArgs,
): BuildFormulaComputedInputsResult {
  'worklet';

  if (!isStrictIdentity(args.quoteCurrency)) {
    return {kind: 'invalid', reason: 'invalidQuoteCurrency'};
  }

  const groupsById = new Map<string, FormulaAssetGroupInput>();
  for (const group of args.assetGroups) {
    const invalidGroupReason = validateFormulaAssetGroup(group);
    if (invalidGroupReason) {
      return {kind: 'invalid', reason: invalidGroupReason};
    }
    if (groupsById.has(group.assetGroupId)) {
      return {kind: 'invalid', reason: 'duplicateAssetGroupId'};
    }
    groupsById.set(group.assetGroupId, group);
  }

  const walletStates: WalletBuildState[] = [];
  const seenWalletIds = new Set<string>();
  const invalidHistoryWalletIds: string[] = [];
  const missingRateSourceKeys: string[] = [];

  for (const wallet of args.wallets) {
    const invalidWalletReason = validateFormulaWallet(wallet);
    if (invalidWalletReason) {
      return {kind: 'invalid', reason: invalidWalletReason};
    }
    if (seenWalletIds.has(wallet.walletId)) {
      return {kind: 'invalid', reason: 'duplicateWalletId'};
    }
    seenWalletIds.add(wallet.walletId);
    if (!groupsById.has(wallet.assetGroupId)) {
      return {kind: 'invalid', reason: 'unknownAssetGroup'};
    }

    const built = buildWalletState(wallet);
    walletStates.push(built.state);
    if (built.invalidHistory) {
      invalidHistoryWalletIds.push(wallet.walletId);
    }
    missingRateSourceKeys.push(...built.missingRateSourceKeys);
  }

  const assetGroups: AssetGroupComputedStateInput[] = [];
  for (const group of args.assetGroups) {
    const memberWallets = walletStates.filter(
      wallet => wallet.input.assetGroupId === group.assetGroupId,
    );
    const assetGroup = buildAssetGroupInput({group, wallets: memberWallets});
    if (!assetGroup) {
      return {kind: 'invalid', reason: 'seriesTimelineMismatch'};
    }
    assetGroups.push(assetGroup);
  }

  return {
    kind: 'valid',
    wallets: walletStates.map(wallet => wallet.computed),
    assetGroups,
    invalidHistoryWalletIds: uniqueSorted(invalidHistoryWalletIds),
    missingRateSourceKeys: uniqueSorted(missingRateSourceKeys),
  };
}
