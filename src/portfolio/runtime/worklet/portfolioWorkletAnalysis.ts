import {
  buildPnlAnalysisChartSeriesFromStreamed,
  buildPnlAnalysisSeriesFromStreamed,
  resolvePnlAnalysisPreloadWindow,
  type PnlAnalysisChartResult,
  type PnlAnalysisResult,
  type PnlAnalysisStreamedArgs,
  type WalletForAnalysisMeta,
  type WalletForStreamedAnalysis,
} from '../../core/pnl/analysisStreaming';
import type {FiatRatePoint} from '../../core/fiatRatesShared';
import type {
  ComputeAnalysisArgs,
  ComputeAnalysisSessionScopeArgs,
  DisposeAnalysisSessionArgs,
  PrepareAnalysisSessionResult,
} from '../../core/engine/portfolioEngine';
import type {PortfolioWorkletKvConfig} from './portfolioWorkletKv';
import {
  ensureWorkletCanonicalAndFxRates,
  getWorkletRateSeriesWithFx,
} from './portfolioWorkletRates';
import {
  findWorkletLastPointAtOrBefore,
  iterateWorkletPoints,
  loadWorkletSnapshotIndex,
} from './portfolioWorkletSnapshots';

function normalizeFiatRateSeriesChain(
  chain?: string,
): string | undefined {
  'worklet';

  const normalized = String(chain || '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function normalizeFiatRateSeriesTokenAddress(
  chain?: string,
  tokenAddress?: string,
): string | undefined {
  'worklet';

  const normalized = String(tokenAddress || '').trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedChain = normalizeFiatRateSeriesChain(chain);
  return normalizedChain === 'sol' || normalizedChain === 'solana'
    ? normalized
    : normalized.toLowerCase();
}

function normalizeFiatRateSeriesCoin(
  currencyAbbreviation?: string,
): string {
  'worklet';

  switch ((currencyAbbreviation || '').toLowerCase()) {
    case 'wbtc':
      return 'btc';
    case 'weth':
      return 'eth';
    case 'matic':
    case 'pol':
      return 'pol';
    default:
      return (currencyAbbreviation || '').toLowerCase();
  }
}

function getAssetIdFromWallet(wallet: {
  chain?: string;
  currencyAbbreviation?: string;
  tokenAddress?: string;
}): string {
  'worklet';

  const chain = (wallet.chain || '').toLowerCase();
  const coin = (wallet.currencyAbbreviation || '').toLowerCase();
  if (wallet.tokenAddress) {
    return `${chain}:${coin}:${wallet.tokenAddress.toLowerCase()}`;
  }

  return `${chain}:${coin}`;
}

function getFiatRateAssetRef(args: {
  currencyAbbreviation?: string;
  chain?: string;
  tokenAddress?: string;
}): {
  coin: string;
  chain?: string;
  tokenAddress?: string;
} {
  'worklet';

  const rawTokenAddress = String(args.tokenAddress || '').trim();
  const chain = rawTokenAddress
    ? normalizeFiatRateSeriesChain(args.chain) || ''
    : '';
  const tokenAddress =
    normalizeFiatRateSeriesTokenAddress(chain, rawTokenAddress) || '';
  const coin = normalizeFiatRateSeriesCoin(args.currencyAbbreviation);

  if (
    tokenAddress === '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0' &&
    chain === 'eth' &&
    coin === 'pol'
  ) {
    return {
      coin: 'pol',
    };
  }

  return {
    coin,
    chain: chain || undefined,
    tokenAddress: tokenAddress || undefined,
  };
}

function sanitizeRatePoints(
  pointsRaw: FiatRatePoint[] | undefined,
): FiatRatePoint[] {
  'worklet';

  if (!Array.isArray(pointsRaw)) {
    return [];
  }

  return pointsRaw
    .map(point => ({ts: Number(point.ts), rate: Number(point.rate)}))
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.rate))
    .sort((a, b) => a.ts - b.ts);
}

function snapshotIndexHasRows(
  index:
    | {
        chunks?: Array<{
          rows?: number;
        }>;
      }
    | null
    | undefined,
): boolean {
  'worklet';

  if (!Array.isArray(index?.chunks) || !index?.chunks.length) {
    return false;
  }

  return index.chunks.some(chunk => Number(chunk?.rows) > 0);
}

type PreparedWorkletAnalysisSessionData = {
  quoteCurrency: string;
  timeframe: ComputeAnalysisArgs['timeframe'];
  nowMs?: number;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
  ratePointsByAssetId: Record<string, FiatRatePoint[]>;
  walletMetasById: Record<string, WalletForAnalysisMeta>;
  walletIds: string[];
  firstNonZeroTsByWalletId: Record<string, number | null>;
};

function logWorkletAnalysisPreparation(args: {
  stage:
    | 'no_request_wallets'
    | 'no_snapshot_wallets'
    | 'no_snapshot_wallets_with_rates'
    | 'prepared';
  targetQuoteCurrency: string;
  timeframe: ComputeAnalysisArgs['timeframe'];
  requestWalletCount: number;
  snapshotWalletCount: number;
  baseAssetCount: number;
  rateAssetCount: number;
  walletsWithRatesCount: number;
  currentRateAssetCount: number;
}): void {
  'worklet';

  console.log('[portfolio-analysis-prep] worklet', {
    stage: args.stage,
    targetQuoteCurrency: args.targetQuoteCurrency,
    timeframe: args.timeframe,
    requestWalletCount: args.requestWalletCount,
    snapshotWalletCount: args.snapshotWalletCount,
    baseAssetCount: args.baseAssetCount,
    rateAssetCount: args.rateAssetCount,
    walletsWithRatesCount: args.walletsWithRatesCount,
    currentRateAssetCount: args.currentRateAssetCount,
  });
}

let nextPreparedWorkletAnalysisSessionId = 1;
const preparedWorkletAnalysisSessions = new Map<
  string,
  PreparedWorkletAnalysisSessionData
>();

function buildEmptyPreparedWorkletAnalysisSessionData(args: {
  quoteCurrency: string;
  timeframe: ComputeAnalysisArgs['timeframe'];
  nowMs: ComputeAnalysisArgs['nowMs'];
  maxPoints: ComputeAnalysisArgs['maxPoints'];
  currentRatesByAssetId?: Record<string, number>;
}): PreparedWorkletAnalysisSessionData {
  'worklet';

  return {
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
    currentRatesByAssetId: args.currentRatesByAssetId,
    ratePointsByAssetId: {},
    walletMetasById: {},
    walletIds: [],
    firstNonZeroTsByWalletId: {},
  };
}

async function prepareWorkletAnalysisSessionData(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PreparedWorkletAnalysisSessionData> {
  'worklet';

  if (!args.wallets.length) {
    logWorkletAnalysisPreparation({
      stage: 'no_request_wallets',
      targetQuoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase(),
      timeframe: args.timeframe,
      requestWalletCount: 0,
      snapshotWalletCount: 0,
      baseAssetCount: 0,
      rateAssetCount: 0,
      walletsWithRatesCount: 0,
      currentRateAssetCount: Object.keys(args.currentRatesByAssetId || {}).length,
    });
    return buildEmptyPreparedWorkletAnalysisSessionData({
      quoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase(),
      timeframe: args.timeframe,
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
      currentRatesByAssetId: args.currentRatesByAssetId,
    });
  }

  const targetQuoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const walletMetas: WalletForAnalysisMeta[] = args.wallets.map(wallet => ({
    walletId: wallet.summary.walletId,
    walletName: wallet.summary.walletName,
    assetId: getAssetIdFromWallet(wallet.summary),
    rateCoin: normalizeFiatRateSeriesCoin(wallet.summary.currencyAbbreviation),
    currencyAbbreviation: wallet.summary.currencyAbbreviation,
    chain: normalizeFiatRateSeriesChain(wallet.summary.chain),
    tokenAddress: normalizeFiatRateSeriesTokenAddress(
      wallet.summary.chain,
      wallet.summary.tokenAddress,
    ),
    credentials: wallet.credentials,
  }));
  const walletMetaByWalletId = new Map(
    walletMetas.map(meta => [meta.walletId, meta] as const),
  );

  const snapshotIndexesByWalletId = new Map(
    await Promise.all(
      args.wallets.map(async wallet => {
        return [
          wallet.summary.walletId,
          await loadWorkletSnapshotIndex(config, wallet.summary.walletId),
        ] as const;
      }),
    ),
  );

  const walletIdsWithSnapshots = new Set(
    args.wallets
      .filter(wallet =>
        snapshotIndexHasRows(
          snapshotIndexesByWalletId.get(wallet.summary.walletId),
        ),
      )
      .map(wallet => wallet.summary.walletId),
  );
  const walletsWithSnapshots = args.wallets.filter(wallet =>
    walletIdsWithSnapshots.has(wallet.summary.walletId),
  );

  if (!walletsWithSnapshots.length) {
    logWorkletAnalysisPreparation({
      stage: 'no_snapshot_wallets',
      targetQuoteCurrency,
      timeframe: args.timeframe,
      requestWalletCount: args.wallets.length,
      snapshotWalletCount: 0,
      baseAssetCount: 0,
      rateAssetCount: 0,
      walletsWithRatesCount: 0,
      currentRateAssetCount: Object.keys(args.currentRatesByAssetId || {}).length,
    });
    return buildEmptyPreparedWorkletAnalysisSessionData({
      quoteCurrency: targetQuoteCurrency,
      timeframe: args.timeframe,
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
      currentRatesByAssetId: args.currentRatesByAssetId,
    });
  }

  const baseAssets = Array.from(
    new Map(
      walletsWithSnapshots.map(wallet => {
        const assetRef = getFiatRateAssetRef({
          currencyAbbreviation: wallet.summary.currencyAbbreviation,
          chain: wallet.summary.chain,
          tokenAddress: wallet.summary.tokenAddress,
        });
        const assetId = getAssetIdFromWallet(wallet.summary);
        return [
          assetId,
          {
            assetId,
            coin: assetRef.coin,
            chain: assetRef.chain,
            tokenAddress: assetRef.tokenAddress,
          },
        ] as const;
      }),
    ).values(),
  );

  await ensureWorkletCanonicalAndFxRates({
    storage: config.storage,
    registryKey: config.registryKey,
    cfg: args.cfg,
    quoteCurrency: targetQuoteCurrency,
    timeframe: args.timeframe,
    assets: baseAssets,
  });

  const ratePointsByAssetId: Record<string, FiatRatePoint[]> = {};
  for (const asset of baseAssets) {
    const series = await getWorkletRateSeriesWithFx({
      storage: config.storage,
      registryKey: config.registryKey,
      quoteCurrency: targetQuoteCurrency,
      coin: asset.coin,
      interval: args.timeframe,
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    });
    const points = sanitizeRatePoints(series?.points);
    if (points.length) {
      ratePointsByAssetId[asset.assetId] = points;
    }
  }

  const walletMetasWithRates = walletMetas.filter(
    meta => (ratePointsByAssetId[meta.assetId]?.length ?? 0) > 0,
  );
  const walletIdsWithRates = new Set(
    walletMetasWithRates.map(meta => meta.walletId),
  );
  const walletsWithSnapshotsAndRates = walletsWithSnapshots.filter(wallet =>
    walletIdsWithRates.has(wallet.summary.walletId),
  );

  if (!walletsWithSnapshotsAndRates.length) {
    logWorkletAnalysisPreparation({
      stage: 'no_snapshot_wallets_with_rates',
      targetQuoteCurrency,
      timeframe: args.timeframe,
      requestWalletCount: args.wallets.length,
      snapshotWalletCount: walletsWithSnapshots.length,
      baseAssetCount: baseAssets.length,
      rateAssetCount: Object.keys(ratePointsByAssetId).length,
      walletsWithRatesCount: 0,
      currentRateAssetCount: Object.keys(args.currentRatesByAssetId || {}).length,
    });
    return buildEmptyPreparedWorkletAnalysisSessionData({
      quoteCurrency: targetQuoteCurrency,
      timeframe: args.timeframe,
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
      currentRatesByAssetId: args.currentRatesByAssetId,
    });
  }

  const firstNonZeroTsByWalletId: Record<string, number | null> = {};
  for (const wallet of walletsWithSnapshotsAndRates) {
    const walletId = wallet.summary.walletId;
    const ts =
      snapshotIndexesByWalletId.get(walletId)?.checkpoint?.firstNonZeroTs;
    firstNonZeroTsByWalletId[walletId] =
      typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null;
  }

  logWorkletAnalysisPreparation({
    stage: 'prepared',
    targetQuoteCurrency,
    timeframe: args.timeframe,
    requestWalletCount: args.wallets.length,
    snapshotWalletCount: walletsWithSnapshots.length,
    baseAssetCount: baseAssets.length,
    rateAssetCount: Object.keys(ratePointsByAssetId).length,
    walletsWithRatesCount: walletsWithSnapshotsAndRates.length,
    currentRateAssetCount: Object.keys(args.currentRatesByAssetId || {}).length,
  });

  return {
    quoteCurrency: targetQuoteCurrency,
    timeframe: args.timeframe,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
    currentRatesByAssetId: args.currentRatesByAssetId,
    ratePointsByAssetId,
    walletMetasById: walletsWithSnapshotsAndRates.reduce<
      Record<string, WalletForAnalysisMeta>
    >((accumulator, wallet) => {
      const walletId = wallet.summary.walletId;
      const walletMeta = walletMetaByWalletId.get(walletId);
      if (!walletMeta) {
        throw new Error(`Missing analysis wallet metadata for ${walletId}.`);
      }
      accumulator[walletId] = walletMeta;
      return accumulator;
    }, {}),
    walletIds: walletsWithSnapshotsAndRates.map(
      wallet => wallet.summary.walletId,
    ),
    firstNonZeroTsByWalletId,
  };
}

async function buildWorkletStreamedAnalysisArgsFromPreparedSessionData(
  config: PortfolioWorkletKvConfig,
  prepared: PreparedWorkletAnalysisSessionData,
  walletIds?: string[],
): Promise<PnlAnalysisStreamedArgs> {
  'worklet';

  const selectedWalletIds = Array.from(
    new Set(
      (Array.isArray(walletIds) && walletIds.length
        ? walletIds
        : prepared.walletIds
      )
        .map(walletId => String(walletId || ''))
        .filter(walletId => !!prepared.walletMetasById[walletId]),
    ),
  );

  if (!selectedWalletIds.length) {
    return {
      cfg: {quoteCurrency: prepared.quoteCurrency},
      wallets: [],
      timeframe: prepared.timeframe,
      ratePointsByAssetId: {},
      currentRatesByAssetId: prepared.currentRatesByAssetId,
      nowMs: prepared.nowMs,
      maxPoints: prepared.maxPoints,
    };
  }

  const selectedWalletMetas = selectedWalletIds
    .map(walletId => prepared.walletMetasById[walletId])
    .filter((wallet): wallet is WalletForAnalysisMeta => !!wallet);
  const firstNonZeroTs =
    prepared.timeframe === 'ALL'
      ? selectedWalletIds.reduce<number | null>((best, walletId) => {
          const candidate = prepared.firstNonZeroTsByWalletId[walletId];
          if (
            typeof candidate !== 'number' ||
            !Number.isFinite(candidate) ||
            candidate <= 0
          ) {
            return best;
          }
          if (best === null || candidate < best) {
            return candidate;
          }
          return best;
        }, null)
      : null;
  const resolved = resolvePnlAnalysisPreloadWindow({
    cfg: {quoteCurrency: prepared.quoteCurrency},
    wallets: selectedWalletMetas,
    timeframe: prepared.timeframe,
    ratePointsByAssetId: prepared.ratePointsByAssetId,
    currentRatesByAssetId: prepared.currentRatesByAssetId,
    firstNonZeroTs,
    nowMs: prepared.nowMs,
    maxPoints: prepared.maxPoints,
  });

  const wallets: WalletForStreamedAnalysis[] = [];
  for (const walletId of selectedWalletIds) {
    const walletMeta = prepared.walletMetasById[walletId];
    if (!walletMeta) {
      continue;
    }
    const basePoint = await findWorkletLastPointAtOrBefore({
      storage: config.storage,
      registryKey: config.registryKey,
      walletId,
      tsMs: resolved.startTs,
    });
    wallets.push({
      wallet: walletMeta,
      basePoint,
      points: iterateWorkletPoints({
        storage: config.storage,
        registryKey: config.registryKey,
        walletId,
        fromExclusive: resolved.startTs,
        toInclusive: resolved.endTs,
      }),
    });
  }

  return {
    cfg: {quoteCurrency: prepared.quoteCurrency},
    wallets,
    timeframe: prepared.timeframe,
    ratePointsByAssetId: prepared.ratePointsByAssetId,
    currentRatesByAssetId: prepared.currentRatesByAssetId,
    firstNonZeroTs,
    startTs: resolved.startTs,
    endTs: resolved.endTs,
    nowMs: resolved.nowMs,
    maxPoints: prepared.maxPoints,
    resolvedWindow: resolved,
  };
}

async function computeWorkletAnalysisFromPreparedSessionData(
  config: PortfolioWorkletKvConfig,
  prepared: PreparedWorkletAnalysisSessionData,
  walletIds?: string[],
): Promise<PnlAnalysisResult> {
  'worklet';

  const streamedArgs =
    await buildWorkletStreamedAnalysisArgsFromPreparedSessionData(
      config,
      prepared,
      walletIds,
    );

  return buildPnlAnalysisSeriesFromStreamed(streamedArgs);
}

export async function computeWorkletAnalysis(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PnlAnalysisResult> {
  'worklet';
  const prepared = await prepareWorkletAnalysisSessionData(config, args);
  return computeWorkletAnalysisFromPreparedSessionData(config, prepared);
}

export async function prepareWorkletAnalysisSession(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PrepareAnalysisSessionResult> {
  'worklet';

  const prepared = await prepareWorkletAnalysisSessionData(config, args);
  const sessionId = `analysis-session:${nextPreparedWorkletAnalysisSessionId++}`;
  preparedWorkletAnalysisSessions.set(sessionId, prepared);
  return {sessionId};
}

export async function computeWorkletAnalysisSessionScope(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisSessionScopeArgs,
): Promise<PnlAnalysisResult> {
  'worklet';

  const prepared = preparedWorkletAnalysisSessions.get(args.sessionId);
  if (!prepared) {
    throw new Error(
      `Prepared portfolio analysis session not found: ${args.sessionId}`,
    );
  }

  return computeWorkletAnalysisFromPreparedSessionData(
    config,
    prepared,
    args.walletIds,
  );
}

export function disposeWorkletAnalysisSession(
  args: DisposeAnalysisSessionArgs,
): void {
  'worklet';

  preparedWorkletAnalysisSessions.delete(args.sessionId);
}

export function clearWorkletAnalysisSessions(): void {
  'worklet';

  preparedWorkletAnalysisSessions.clear();
}

export async function computeWorkletAnalysisChart(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PnlAnalysisChartResult> {
  'worklet';
  const prepared = await prepareWorkletAnalysisSessionData(config, args);
  const streamedArgs =
    await buildWorkletStreamedAnalysisArgsFromPreparedSessionData(
      config,
      prepared,
    );
  return buildPnlAnalysisChartSeriesFromStreamed(streamedArgs);
}
