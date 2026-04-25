import {CANONICAL_RATE_QUOTE} from './constants';

export type Interval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';
export type StoredRateInterval = '1D' | '1W' | '1M' | 'ALL';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};

export type PortfolioRuntimeKind = 'compute' | 'populate' | 'rateFetch';

export type PortfolioPublishReason =
  | 'warmPublish'
  | 'fullRecompute'
  | 'walletRecompute'
  | 'liveRateTouch'
  | 'quoteBridge'
  | 'reset'
  | 'debugClear';

export type PortfolioMmkvWriteReason =
  | 'manifest'
  | 'queue'
  | 'snapMeta'
  | 'snapIndex'
  | 'snapChunk'
  | 'invalidHistory'
  | 'rate'
  | 'workEpoch'
  | 'cacheInvalid'
  | 'flag'
  | 'reset'
  | 'wipe'
  // Reserved for the optional Phase 9 measured-cold-start cache path.
  // Phase 1-8 code must not write this reason unless the optional persisted
  // render cache is explicitly added by a benchmark-backed decision.
  | 'generatedRenderCache';

export type PortfolioMmkvPrefixFamily =
  | 'portfolio:v2'
  | 'snap'
  | 'rate:v1'
  | 'otherPortfolio';

export type PortfolioV2Metric =
  | Readonly<{
      kind: 'publish';
      reason: PortfolioPublishReason;
      revision: number;
      approximateBytes: number;
      durationMs: number;
      warning: boolean;
    }>
  | Readonly<{
      kind: 'mmkvWrite';
      reason: PortfolioMmkvWriteReason;
      localKeyHash?: string;
      keyLength: number;
      keyPrefixFamily: PortfolioMmkvPrefixFamily;
      approximateBytes: number;
      durationMs: number;
      warning: boolean;
      allowOversize: boolean;
    }>;

export type PortfolioWorkEpochReason =
  | 'resetStart'
  | 'showPortfolioOff'
  | 'walletDeletion'
  | 'quoteCurrencyChanged'
  | 'featureFlagChanged'
  | 'postAuthRepair'
  | 'debugClear';

export type Point = Readonly<{
  ts: number;
  fiatBalance: number;
  remainingUnrealizedPnlFiat: number;
  pnlChange: number;
  pnlPercent: number;
}>;

export type Series = Readonly<{
  fingerprint: string;
  points: readonly Point[];
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  finalPointSource: 'historicalRate' | 'liveRate';
}>;

export type PerIntervalSeries = Readonly<Partial<Record<Interval, Series>>>;

export type AssetGroupHealth = Readonly<{
  collapsedAcrossDistinctAssets: boolean;
  decimalConflict: boolean;
  symbolCollisionSuspected?: boolean;
  missingLiveRateMemberWalletIds: readonly string[];
  nonzeroMissingLiveRateMemberWalletIds: readonly string[];
}>;

export type AssetGroupRowShell = Readonly<{
  assetGroupId: string;
  displaySymbol: string;
  displayName?: string;
  currentCryptoAmount: string;
  currentFiatValue?: number;
  memberWalletIds: readonly string[];
  memberWalletIdsKey: string;
  memberRateSourceKeys: readonly string[];
  canonicalUnitDecimals?: number;
  groupHealth: AssetGroupHealth;
  invalidHistoryBlocked?: boolean;
}>;

export type RowPayload = Readonly<{
  assetGroupId: string;
  interval: Interval;
  pnlChange: number;
  pnlPercent: number;
  rateStart?: number;
  rateEnd?: number;
  ratePercent?: number;
  fingerprint: string;
}>;

export type WalletSlice = Readonly<{
  walletId: string;
  assetGroupIds: readonly string[];
  series: PerIntervalSeries;
  rowPayloadsByAssetGroupId: Readonly<Record<string, RowPayload>>;
  fingerprint: string;
}>;

export type AssetGroupSlice = Readonly<{
  assetGroupId: string;
  memberWalletIds: readonly string[];
  series: PerIntervalSeries;
  rowPayloadsByInterval: Readonly<Partial<Record<Interval, RowPayload>>>;
  fingerprint: string;
}>;

export type PortfolioStaleReason =
  | 'missingSnapshotIndex'
  | 'missingSnapshot'
  | 'balanceMismatch'
  | 'missingHistoricalRate'
  | 'staleHistoricalRate'
  | 'invalidHistory'
  | 'populateRetryPending'
  | 'rateFetchRetryPending';

export type PortfolioDataQuality = Readonly<{
  snapshotCoverage: 'none' | 'partial' | 'complete';
  rateCoverage: 'none' | 'partial' | 'complete';
  stale: boolean;
  staleReasons: readonly PortfolioStaleReason[];
  lastSuccessfulPopulateAtByWalletId: Readonly<Record<string, number>>;
  lastRateFetchAtByRateSourceKey: Readonly<Record<string, number>>;
  missingRateSourceKeys: readonly string[];
  invalidHistoryWalletIds: readonly string[];
  retryScheduledWalletIds: readonly string[];
}>;

export type ScopeReadiness = Readonly<{
  empty: boolean;
  initialScopeReady: boolean;
  invalidHistoryBlocked: boolean;
  hasEverPublishedValidSeries: boolean;
  refreshing: boolean;
  dataQuality: PortfolioDataQuality;
}>;

export type ScopedPortfolioSlice = Readonly<{
  walletIdsKey: string;
  walletIds: readonly string[];
  total: PerIntervalSeries;
  rowShells: readonly AssetGroupRowShell[];
  readiness: ScopeReadiness;
  fingerprint: string;
  lastAccessedAt: number;
}>;

export type PortfolioState = Readonly<{
  schemaVersion: 1;
  workEpoch: number;
  revision: number;
  quoteCurrency: string;
  canonicalRateQuoteCurrency: typeof CANONICAL_RATE_QUOTE;
  computedAtMs: number;
  populatedWalletIdsKey: string;
  invalidHistoryWalletIdsKey: string;
  readinessByScopeKey: Readonly<Record<string, ScopeReadiness>>;
  orderedAssetGroupIdsForAssetList: readonly string[];
  orderRevision: number;
  byWallet: Readonly<Record<string, WalletSlice>>;
  byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
  rowShells: readonly AssetGroupRowShell[];
  total: PerIntervalSeries;
  totalFingerprint: string;
  scopedByWalletSet: Readonly<Record<string, ScopedPortfolioSlice>>;
}>;

export type PortfolioPublishedState = PortfolioState;

export type FiatRateAssetRef = Readonly<{
  coin: string;
  chain?: string;
  tokenAddress?: string;
}>;

export type BwsConfig = Readonly<{
  baseUrl?: string;
}>;

export type SnapshotIngestConfig = Readonly<{
  compressionEnabled: boolean;
  compressionAgeDays: number;
  pageSize: number;
}>;

export type PopulateQueueReason =
  | 'initial'
  | 'appLaunchIncremental'
  | 'send'
  | 'pullToRefresh'
  | 'keyImport'
  | 'showPortfolioToggleOn'
  | 'manual';

export type PopulateQueuePriority =
  | 'urgentUserVisible'
  | 'normalUserVisible'
  | 'background';

export type PopulateCheckpoint = Readonly<{
  schemaVersion: 1;
  itemId: string;
  runId: string;
  walletId: string;
  stagingKeyPrefix: string;
  stagingKeys: readonly string[];
  snapshotIndexRevision: number | null;
  cursor?: JsonValue;
  cursorSchemaVersion?: number;
  lastProcessedBlockId?: string;
  lastProcessedBlockHeight?: number;
  lastProcessedTxId?: string;
  pageSize: number;
  ingestFingerprint: string;
  failed: boolean;
  closed: boolean;
  corrupt: boolean;
  invalidHistoryBlocked: boolean;
  updatedAtMs: number;
}>;

export type PopulateRetryState = Readonly<{
  attempt: number;
  nextRetryAtMs: number;
  lastErrorKind:
    | 'missingRuntimeContext'
    | 'network'
    | 'bws'
    | 'checkpointInvalid'
    | 'invalidHistory'
    | 'unknown';
  lastErrorAtMs: number;
}>;

export type PopulateQueueItem = Readonly<{
  itemId: string;
  runId: string;
  walletId: string;
  reason: PopulateQueueReason;
  priority: PopulateQueuePriority;
  requestedAtMs: number;
  checkpoint?: PopulateCheckpoint;
  retry?: PopulateRetryState;
}>;

export type PopulateQueueV1 = Readonly<{
  schemaVersion: 1;
  pending: readonly PopulateQueueItem[];
  active?: PopulateQueueItem;
  completedInRunItemIds: Readonly<Record<string, true>>;
  startedAt: number;
  updatedAt: number;
  cfg: BwsConfig;
  ingest: SnapshotIngestConfig;
  pageSize: number;
}>;

export type PortfolioManifestV1 = Readonly<{
  schemaVersion: 1;
  canonicalRateQuoteCurrency: typeof CANONICAL_RATE_QUOTE;
  populatedWalletIds: readonly string[];
  invalidHistoryWalletIds: readonly string[];
  populateOrderWalletIds: readonly string[];
  populateOrderAssetGroupIds: readonly string[];
  orderRevision: number;
  initialPopulateStartedAt?: number;
  initialPopulateCompletedAt?: number;
  updatedAt: number;
}>;

export const EMPTY_DATA_QUALITY: PortfolioDataQuality = {
  snapshotCoverage: 'none',
  rateCoverage: 'none',
  stale: false,
  staleReasons: [],
  lastSuccessfulPopulateAtByWalletId: {},
  lastRateFetchAtByRateSourceKey: {},
  missingRateSourceKeys: [],
  invalidHistoryWalletIds: [],
  retryScheduledWalletIds: [],
};

export const EMPTY_PORTFOLIO_STATE: PortfolioState = {
  schemaVersion: 1,
  workEpoch: 0,
  revision: 0,
  quoteCurrency: CANONICAL_RATE_QUOTE,
  canonicalRateQuoteCurrency: CANONICAL_RATE_QUOTE,
  computedAtMs: 0,
  populatedWalletIdsKey: '',
  invalidHistoryWalletIdsKey: '',
  readinessByScopeKey: {},
  orderedAssetGroupIdsForAssetList: [],
  orderRevision: 0,
  byWallet: {},
  byAssetGroup: {},
  rowShells: [],
  total: {},
  totalFingerprint: '',
  scopedByWalletSet: {},
};
