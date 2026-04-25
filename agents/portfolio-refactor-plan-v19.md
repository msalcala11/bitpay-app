# Portfolio runtime refactor plan — v19

**Status:** revised from v18 after design review.

**Target:** replace the current screen-specific portfolio computation/caching stack with a canonical worklet-owned portfolio render model. The v19 architecture uses separate queue and manifest state, scope-specific readiness, full-point chart fingerprints, a dedicated rate-fetch runtime, product-oracle correctness tests, and UI hooks that move only selected slices across to React.

**Executable by:** a senior React Native engineer or a coding agent with strong React Native, Reanimated/worklets, MMKV, Redux, and test-writing context.

---

## 0. What changed from v18

This revision intentionally changes several load-bearing parts of v18.

1. **Manifest and queue are now separate.** `PortfolioManifest` records what valid data exists. `PopulateQueue` records work to do now. Already-populated wallets can be requeued after send, pull-to-refresh, app-launch refresh, or explicit refresh.
2. **First-populate chart readiness is scope-specific.** Home does not show a partial chart just because one wallet completed. Wallet chart, asset-detail chart, key chart, account chart, and Home chart each have their own readiness predicate.
3. **Populate order and display order are separated.** Populate order is visibility-ignored so hidden livenet wallets stay warm. Display order is visibility-respecting and scope-specific so hidden wallets never leak into Home, All Assets, Allocation, KeyOverview, or scoped asset detail.
4. **Chart fingerprints hash every emitted point.** Endpoint-only fingerprints are removed. With at most 89 points, O(89) hashing is cheap and avoids stale scrub values after mid-series mutations.
5. **Chart output is capped; event processing is not.** The chart sample grid has at most 89 emitted timestamps, but PnL math still consumes every in-window balance-change event before each emitted point.
6. **Each chart point explicitly includes `remainingUnrealizedPnlFiat`.** The UI can scrub timestamp, fiat value, remaining unrealized P/L, PnL change, and PnL percent without deriving fields in React.
7. **Canonical BTC bridge rates are always available.** The canonical quote is fixed to `USD` in v19. `BTC/USD` is always ensured even if the user owns no BTC. Quote switches fetch only `BTC/<targetQuote>` and reprice from canonical `USD` using per-timestamp bridge factors.
8. **`usePortfolioSlice` does not copy the whole shared state into React.** Selectors run in the UI runtime; only the selected slice crosses into React through `runOnJS`.
9. **Product-oracle tests replace blind v1 parity where v1 may be wrong.** Legacy parity remains only for kernels and known-correct formula behavior. Row/detail equality, no-transaction rate parity, BTC bridge correctness, scope readiness, and first/final scrub invariants are tested against product expectations.
10. **Show Portfolio reset preserves shared Exchange Rate cache by default.** v19 wipes portfolio-owned snapshot/generated/queue data. Shared `rate:v1:*` data is not wiped unless the app creates a separate portfolio-owned rate namespace or product explicitly requires wiping shared market-rate data.
11. **A dedicated rate-fetch runtime is the default.** v18’s branch matrix is removed from the implementation path. The rate runtime avoids populate-vs-rate dispatch-context clobbering without blocking reads behind populate.

---

## 1. Non-negotiable product requirements

The design must satisfy these requirements.

- Portfolio snapshot aggregation, population, historical chart generation, asset rows, PnL, and quote repricing run off the JS thread.
- Large data lives in the dedicated portfolio MMKV instance or runtime memory, not persisted Redux.
- Renderable chart data exists for seven intervals: `1D`, `1W`, `1M`, `3M`, `1Y`, `5Y`, `ALL`.
- Only four rate intervals are fetched/persisted: `1D`, `1W`, `1M`, `ALL`. `3M`, `1Y`, and `5Y` derive from `ALL`.
- Asset rows are collapsed by ticker across chains: `assetGroupId = lower(currencyAbbreviation)`. Example: Ethereum USDC, Polygon USDC, and Solana USDC are one `usdc` row.
- Asset-row Today values equal the corresponding Asset Detail `1D` chart final point for the same wallet scope. Asset-row All Time values equal Asset Detail `ALL` chart final point for the same wallet scope.
- Key-scoped All Assets and key-scoped Asset Detail use only wallets in that key, including the constituent wallet list shown on asset detail.
- The portfolio interval window must match the Exchange Rate interval window. With no in-window transactions, portfolio PnL percent must equal exchange-rate percent for the same asset, interval, and quote.
- Fiat quote changes update instantly through BTC bridge. Do not fetch every asset in the new quote.
- First populate reveals asset rows progressively. First-populate charts stay hidden until the relevant scope is ready.
- Populate resumes after app kill. Already completed wallet outputs are visible immediately after post-auth startup.
- Populate begins only after the user passes PIN/biometric gate.
- Send completion requeues the sent-from wallet and updates every affected screen after refresh.
- Pull-to-refresh requeues affected wallets and/or refreshes rates, then updates every affected screen.
- Populate does not block chart/PnL reads. Reads do not block each other.
- Timeframe switching and chart scrubbing are read-only. They do not trigger rate fetches, snapshot refresh, populate, or recompute work.
- Scrubbing updates the big balance, PnL row, and timestamp from the selected point. First point PnL change is exactly zero. Final scrubbed point equals idle header/PnL numbers.
- Show Portfolio off hides portfolio-owned surfaces and clears portfolio-owned data. Show Portfolio on repopulates from empty. Exchange Rate surfaces remain visible.
- Hide Crypto Balances is UI-only masking. It does not influence portfolio runtime, recompute, populate, rates, MMKV, selectors, or triggers.
- Populate is livenet/mainnet only. Testnet/regtest wallets never enter populate queues.

---

## 2. Architecture summary

### Runtime layout

Use four runtimes by default:

```txt
React JS runtime         UI components, navigation, Redux access wrappers, trigger entrypoints
UI worklet runtime       Reanimated selectors, scrub state, selected-slice subscription
portfolio-compute        PnL, aggregation, chart series, rows, scoped render cache, quote reprice
portfolio-populate       one-wallet-at-a-time snapshot populate using existing populate kernels
portfolio-rate-fetch     BWS fiat-rate fetches with lightweight dispatch context
```

The dedicated rate runtime is chosen deliberately. It is simpler than preserving a branch matrix and avoids runtime-global dispatch-context clobbering between populate signing context and rate fetch context.

### Source of truth

The runtime owns canonical portfolio render data. React screens never compute portfolio PnL or aggregate wallet chart points.

```txt
PortfolioManifest    persistent “what valid data exists” metadata
PopulateQueue        persistent “what work remains now” metadata
sharedPortfolioState worklet-owned published render snapshot
MMKV snapshot store  persisted balance snapshots and invalid-history markers
MMKV rate store      persisted shared market rates
```

Redux stores only small app state and already-existing wallet metadata. It does not store chart arrays, snapshot arrays, asset rows, PnL payloads, or generated scoped slices.

---

## 3. Core data model

### Intervals

```ts
export type Interval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';
export type StoredRateInterval = '1D' | '1W' | '1M' | 'ALL';
export const MAX_CHART_POINTS = 89;

export function resolveStoredRateInterval(interval: Interval): StoredRateInterval {
  switch (interval) {
    case '3M':
    case '1Y':
    case '5Y':
    case 'ALL':
      return 'ALL';
    default:
      return interval;
  }
}
```

### Chart point

Each point contains every scrubbable numeric field. The UI must not derive PnL or fiat values in React.

```ts
export type Point = Readonly<{
  ts: number;
  fiatBalance: number;
  remainingUnrealizedPnlFiat: number;
  pnlChange: number;
  pnlPercent: number;
}>;
```

### Series

```ts
export type Series = Readonly<{
  fingerprint: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  points: readonly Point[]; // always length <= MAX_CHART_POINTS
}>;

export type PerIntervalSeries = Readonly<Partial<Record<Interval, Series>>>;
```

### Row payload and row shell

Rows are visible before PnL is ready. The shell comes from visible wallet metadata and live balance/rate approximations. The payload comes from the same recompute pass and same endpoint values as the corresponding chart series.

```ts
export type RowPayload = Readonly<{
  assetGroupId: string;
  rowFingerprint: string;
  fiatStart: number;
  fiatEnd: number;
  pnlChange: number;
  pnlPercent: number;
  rateStart: number;
  rateEnd: number;
  ratePercent: number;
}>;

export type AssetGroupRowShell = Readonly<{
  assetGroupId: string;
  displaySymbol: string;
  memberWalletIds: readonly string[];
  cryptoAmountDisplay: string;
  fiatAmountDisplay: string;
  orderIndex: number;
  readyToday: boolean;
  readyAllTime: boolean;
  invalidHistoryBlocked: boolean;
  rowToday?: RowPayload;
  rowAllTime?: RowPayload;
}>;
```

### Asset, wallet, and scoped slices

```ts
export type AssetGroupSlice = Readonly<{
  assetGroupId: string;
  fingerprint: string;
  memberWalletIds: readonly string[];
  memberWalletIdsKey: string;
  series: PerIntervalSeries;
  rowToday?: RowPayload;
  rowAllTime?: RowPayload;
}>;

export type WalletSlice = Readonly<{
  walletId: string;
  assetGroupId: string;
  fingerprint: string;
  series: PerIntervalSeries;
  rowToday?: RowPayload;
  rowAllTime?: RowPayload;
  lastWrittenAt: number;
  lastAccessedAt: number;
}>;

export type ScopeReadiness = Readonly<{
  hasEverPublishedValidSeries: boolean;
  initialScopeReady: boolean;
  refreshing: boolean;
  invalidHistoryBlocked: boolean;
}>;

export type ScopedPortfolioSlice = Readonly<{
  walletIdsKey: string;
  walletIds: readonly string[];
  fingerprint: string;
  computedAtMs: number;
  readiness: ScopeReadiness;
  total: PerIntervalSeries;
  totalFingerprint: string;
  byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
  rowShells: readonly AssetGroupRowShell[];
  orderedAssetGroupIdsForAssetList: readonly string[];
  invalidHistoryWalletIdsById: Readonly<Record<string, true>>;
  invalidHistoryAssetGroupIdsById: Readonly<Record<string, true>>;
  lastAccessedAt: number;
}>;
```

### Published state

```ts
export type PortfolioState = Readonly<{
  revision: number;
  quoteCurrency: string;
  canonicalRateQuoteCurrency: 'USD';
  computedAtMs: number;

  populatedWalletIdsKey: string;
  populatedWalletIdsById: Readonly<Record<string, true>>;
  invalidHistoryWalletIdsKey: string;
  invalidHistoryWalletIdsById: Readonly<Record<string, true>>;

  // Visibility-respecting global display order, not populate order.
  orderedAssetGroupIdsForAssetList: readonly string[];
  orderRevision: number;

  readinessByScopeKey: Readonly<Record<string, ScopeReadiness>>;
  byWallet: Readonly<Record<string, WalletSlice>>;
  byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
  rowShells: readonly AssetGroupRowShell[];
  total: PerIntervalSeries;
  totalFingerprint: string;

  // Bounded cache for key/account/custom wallet scopes.
  scopedByWalletSet: Readonly<Record<string, ScopedPortfolioSlice>>;
}>;
```

---

## 4. Manifest and queue

### Why split them

Do not use queue completion as the readiness database. A wallet can already have valid data and still need to be refreshed after a send, receive, app-launch incremental refresh, quote-rate refresh, or pull-to-refresh.

### Manifest

```ts
export type PortfolioManifestV1 = Readonly<{
  schemaVersion: 1;
  canonicalRateQuoteCurrency: 'USD';

  // Valid portfolio data exists for these wallets.
  populatedWalletIds: readonly string[];

  // Wallets currently blocked by active invalid-history markers.
  invalidHistoryWalletIds: readonly string[];

  // Visibility-ignored livenet/not-deleted canonical populate order.
  populateOrderWalletIds: readonly string[];
  populateOrderAssetGroupIds: readonly string[];

  // Monotonic when the canonical populate order changes or manifest resets from empty.
  orderRevision: number;

  initialPopulateStartedAt?: number;
  initialPopulateCompletedAt?: number;
  updatedAt: number;
}>;
```

Manifest writes happen when:

- a wallet finishes populate successfully: add to `populatedWalletIds`, remove from `invalidHistoryWalletIds`;
- a wallet hits active invalid history: remove from `populatedWalletIds`, add to `invalidHistoryWalletIds`;
- a wallet/key is deleted: remove wallet from all manifest lists and rebuild canonical populate order;
- Show Portfolio off / debug clear / sign-out reset: reset manifest to empty;
- wallet set changes: rebuild `populateOrder*` for livenet/not-deleted wallets, visibility ignored.

### Populate queue

```ts
export type PopulateQueueV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  reason:
    | 'initial'
    | 'appLaunchIncremental'
    | 'send'
    | 'pullToRefresh'
    | 'keyImport'
    | 'showPortfolioToggleOn'
    | 'manual';

  pendingWalletIds: readonly string[];
  activeWalletId?: string;
  completedInRunWalletIds: readonly string[];

  startedAt: number;
  updatedAt: number;
  cfg: BwsConfig;
  ingest: SnapshotIngestConfig;
  pageSize: number;
}>;
```

Queue writes happen when:

- building a fresh queue: set `pendingWalletIds` from `manifest.populateOrderWalletIds` or a supplied subset;
- appending refresh work: add wallet IDs to `pendingWalletIds` unless already pending or active;
- starting a wallet: move it to `activeWalletId`; leave persisted checkpoint state enough to recover after app kill;
- completing a wallet in this run: clear `activeWalletId`, add to `completedInRunWalletIds`, update manifest populated state;
- invalid-history skip: clear `activeWalletId`, update manifest invalid-history state;
- deletion/reconciliation: prune only deleted/non-livenet wallets. Do not prune hidden livenet wallets.

### Append semantics

This is the critical v19 fix:

```ts
function appendToQueue(walletId: string, reason: PopulateQueueV1['reason']): void {
  const q = loadQueue() ?? emptyQueue(reason);

  // Dedupe only against work currently pending or active.
  if (q.activeWalletId === walletId) return;
  if (q.pendingWalletIds.includes(walletId)) return;

  // Do NOT dedupe against manifest.populatedWalletIds.
  // Already-populated wallets must be refreshable.
  saveQueue({
    ...q,
    reason,
    pendingWalletIds: [...q.pendingWalletIds, walletId],
    updatedAt: Date.now(),
  });
}
```

This means:

- send completion can requeue a wallet that was already populated;
- pull-to-refresh can requeue already-populated wallets;
- app-launch incremental refresh can requeue already-populated wallets;
- old data remains visible while the refresh is pending because manifest still says valid data exists;
- once refresh completes, the manifest is updated and recompute publishes fresh values.

---

## 5. Populate order and display order

### Populate order

Populate order is **visibility-ignored**:

```txt
livenet/mainnet AND not deleted
```

Hidden wallets are still populated so unhide is instant if they already existed when populate was allowed to run.

Build populate order by:

1. group livenet/not-deleted wallets by `assetGroupId = lower(currencyAbbreviation)`;
2. compute approximate fiat value per asset group from live balances/rates;
3. sort asset groups descending by fiat value;
4. within each asset group, sort wallets descending by fiat value;
5. persist resulting `manifest.populateOrderAssetGroupIds` and `manifest.populateOrderWalletIds`.

### Display order

Display order is **visibility-respecting** and scope-specific:

```txt
livenet/mainnet AND not deleted AND effective wallet/key/account visibility is visible
```

Display order should preserve canonical populate order where possible:

```ts
function computeDisplayOrderForScope(args: {
  scopeWalletIds: readonly string[]; // already visibility-filtered
  manifestPopulateOrderAssetGroupIds: readonly string[];
  assetGroupIdByWalletId: Record<string, string>;
  fallbackFiatValues: Record<string, number>;
}): string[];
```

Rules:

- hidden wallets never contribute to global or scoped row shells, totals, charts, or allocation rows;
- hidden wallets can remain in manifest and queue;
- Home, All Assets, Allocation, KeyOverview, AccountDetails, and scoped Asset Detail each use visibility-filtered display order;
- display order for a key/account scope uses only visible wallets inside that key/account;
- allocation order equals asset-list order for the same scope.

---

## 6. Scope readiness

First-populate chart readiness is not “any wallet populated.” It is per scope.

```ts
function isWalletUsableForInitialChart(walletId: string, manifest: PortfolioManifestV1): boolean {
  return manifest.populatedWalletIds.includes(walletId) ||
         manifest.invalidHistoryWalletIds.includes(walletId);
}

function isInitialScopeReady(scopeWalletIds: readonly string[], manifest: PortfolioManifestV1): boolean {
  return scopeWalletIds.every(id => isWalletUsableForInitialChart(id, manifest));
}
```

### First populate

- **WalletDetails chart:** show once that wallet is populated, or show invalid-history affordance if blocked.
- **Asset Detail chart:** show once every visible wallet in that asset group/scope is populated or invalid-history blocked.
- **KeyOverview chart:** show once every visible wallet in that key is populated or invalid-history blocked.
- **AccountDetails chart:** show once every visible wallet in that account is populated or invalid-history blocked.
- **Home chart:** show once every visible Home-scope wallet is populated or invalid-history blocked.
- **Rows:** visible immediately as row shells; right side shows skeleton/error-ready until row payload is ready.

A single corrupted wallet should not hide every chart forever. Active invalid-history wallets are considered “not waiting anymore” for the first-populate gate, but they are not counted as populated and their invalid data is never used in PnL.

### Incremental refresh

If a scope has ever published valid series, keep stale series visible while refresh work is pending. Set `refreshing = true` and progressively update as refreshed wallets finish. This keeps incremental behavior simple and avoids blanking charts after send/pull-to-refresh.

---

## 7. PnL formula and chart sample grid

### Formula type

This is display PnL, not tax accounting:

```txt
window-local average-cost-style remaining cost basis
```

It is not FIFO, LIFO, tax-lot accounting, realized PnL, or historical acquisition-cost reporting.

### Core formula

For each displayed interval:

1. Resolve a shared window `{windowStartTs, windowEndTs}` using the same helper as Exchange Rate charts.
2. Resolve a capped chart output grid with at most 89 timestamps. Always include the exact start and final window endpoints.
3. For each wallet, find units held at `windowStartTs`.
4. Initialize `remainingCostBasisFiat = unitsAtStart * rateAt(windowStartTs)`.
5. Process every in-window balance-change event in chronological order. Do not discard events just because they are between chart sample timestamps.
6. Before each emitted chart sample timestamp `ti`, apply all balance-change events with `eventTs <= ti`.
7. Emit a point using current units, current cost basis, and `rateAt(ti)`.

Balance-change update:

```ts
if (deltaUnits > 0) {
  remainingCostBasisFiat += deltaUnits * rateAt(eventTs);
} else if (deltaUnits < 0 && beforeUnits > 0) {
  remainingCostBasisFiat *= Math.max(afterUnits, 0) / beforeUnits;
}

if (afterUnits <= 0 || !Number.isFinite(remainingCostBasisFiat) || remainingCostBasisFiat < 0) {
  units = 0;
  remainingCostBasisFiat = 0;
}
```

At each emitted point:

```ts
fiatBalance = units * rateAt(ti);
remainingUnrealizedPnlFiat = fiatBalance - remainingCostBasisFiat;
firstRemainingUnrealizedPnlFiat = value at first emitted point;
pnlChange = remainingUnrealizedPnlFiat - firstRemainingUnrealizedPnlFiat;
pnlPercent = remainingCostBasisFiat > 0
  ? (remainingUnrealizedPnlFiat / remainingCostBasisFiat) * 100
  : 0;
```

The first point has `pnlChange === 0` exactly.

### No-transaction parity

If no balance-change events occur in the selected window for an asset/scope:

```ts
pnlPercent === ((rateEnd - rateStart) / rateStart) * 100
```

within numeric tolerance, because the only change is mark-rate movement over the same interval window used by Exchange Rate charts.

### Transfer model

Do not match or net owned-wallet transfers. Display PnL is wallet-local:

- source wallet outflow disposes basis pro rata;
- destination wallet inflow adds basis at the destination event spot rate;
- cross-chain asset-group moves still price each side through its own asset/rate source.

---

## 8. Full-point fingerprints

Endpoint-only fingerprints are removed.

Every emitted series has at most 89 points, so hash all point values:

```ts
function buildSeriesFingerprint(args: {
  inputFingerprint: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  points: readonly Point[];
}): string {
  return stableHash([
    args.inputFingerprint,
    args.interval,
    args.windowStartTs,
    args.windowEndTs,
    args.points.length,
    ...args.points.flatMap(p => [
      p.ts,
      stableNumber(p.fiatBalance),
      stableNumber(p.remainingUnrealizedPnlFiat),
      stableNumber(p.pnlChange),
      stableNumber(p.pnlPercent),
    ]),
  ]);
}
```

The input fingerprint includes:

- quote currency;
- canonical quote currency;
- interval;
- window start/end;
- sorted wallet IDs;
- asset/rate identifiers;
- per-wallet snapshot index revisions;
- relevant stored rate `fetchedOn` timestamps;
- live-rate value/as-of timestamp if used for final/current mark;
- BTC bridge rate `fetchedOn` timestamps for bridged quote output.

Row fingerprint is derived from the exact final endpoint values used by the corresponding series:

```ts
rowFingerprint = stableHash([
  assetGroupId,
  interval,
  fiatStart,
  fiatEnd,
  pnlChange,
  pnlPercent,
  rateStart,
  rateEnd,
  ratePercent,
]);
```

---

## 9. Fiat rates and BTC FX bridge

### Canonical quote

v19 fixes the canonical quote to `USD`:

```ts
export const CANONICAL_RATE_QUOTE = 'USD' as const;
```

All asset rate series used for portfolio PnL are persisted under `rate:v1:USD:*`.

### Always ensure canonical BTC

Initial populate and any rate refresh must always ensure:

```txt
BTC/USD 1D
BTC/USD 1W
BTC/USD 1M
BTC/USD ALL
```

This is required even when the user owns no BTC, because all future quote switches need the denominator side of the bridge.

### Quote switch

When the user switches from any quote to `targetQuote`:

1. If `targetQuote === 'USD'`, no target BTC fetch is required.
2. Otherwise fetch/ensure only:

```txt
BTC/<targetQuote> 1D
BTC/<targetQuote> 1W
BTC/<targetQuote> 1M
BTC/<targetQuote> ALL
```

3. Reprice all published scopes from existing snapshots and USD asset rates.

The rate lookup formula at every timestamp `τ` is:

```ts
rate(τ, targetQuote) =
  assetRate(τ, 'USD') * btcRate(τ, targetQuote) / btcRate(τ, 'USD');
```

Apply this at:

- interval baseline `t0`;
- every emitted chart sample timestamp `ti`;
- every in-window balance-change event timestamp `τ`.

Do not scalar-transform old `pnlChange`, `pnlPercent`, or remaining cost basis. Cost basis is path-dependent and must be recomputed with per-event bridge rates.

---

## 10. Storage and reset behavior

### MMKV instances

All portfolio v2 MMKV access uses the dedicated portfolio instance:

```txt
bitpay.portfolio.engine
```

No v2 code uses default app MMKV for portfolio flag, manifest, queue, snapshots, invalid-history markers, or generated portfolio data.

### Keys

```txt
portfolio:v2:flag
portfolio:v2:cacheInvalid
portfolio:v2:manifest:v1
portfolio:v2:populate:queue:v1
portfolio:v2:generated:*       optional generated render cache if persisted later
snap:*                         wallet snapshots and invalid-history markers
rate:v1:*                      shared market-rate cache
```

### Show Portfolio off wipe

Default v19 wipe prefixes:

```ts
const PORTFOLIO_WIPE_PREFIXES = [
  'portfolio:v2:',
  'snap:',
];
```

Exclude:

```ts
PORTFOLIO_V2_FLAG_KEY
PORTFOLIO_CACHE_INVALID_KEY
```

Do **not** wipe shared `rate:v1:*` by default because Exchange Rate surfaces remain visible when Show Portfolio is off and use the same market-rate cache. If product decides market-rate cache is portfolio-owned and must also be cleared, introduce a separate explicit option and test that Exchange Rate surfaces refetch without being hidden.

### Reset sequence

```ts
async function performResetSequence(): Promise<void> {
  if (inFlightReset) return inFlightReset;

  inFlightReset = (async () => {
    setPopulateResetInFlight(true);
    try {
      cancelPopulate();
      await Promise.all([
        waitForPopulateLoopToStop(),
        waitForRecomputeDrainToStop(),
        waitForEnsureFreshToStop(),
      ]);
      markPortfolioCacheInvalid();
      await wipePortfolioMmkvKeys();
      resetSharedPortfolioStateForDebugClear();
      saveEmptyManifest();
      clearQueue();
      clearPortfolioCacheInvalid();
    } finally {
      setPopulateResetInFlight(false);
      inFlightReset = null;
    }
  })();

  return inFlightReset;
}
```

If anything throws after `markPortfolioCacheInvalid`, ordinary work remains blocked until a later successful reset/repair clears the bit.

---

## 11. Recompute and scheduler

### Recompute inputs

Build inputs at fire time only. Do not cache them in refs or read Redux at module top level.

```ts
export type RecomputeInputs = Readonly<{
  scope:
    | 'full'
    | {kind: 'wallet'; walletId: string}
    | {kind: 'wallets'; walletIds: readonly string[]}
    | {kind: 'touchWallet'; walletId: string}
    | {kind: 'touchWallets'; walletIds: readonly string[]};

  visibleEligibleWallets: readonly StoredWallet[];
  quoteCurrency: string;
  canonicalRateQuoteCurrency: 'USD';
  liveRatesByAssetId: Readonly<Record<string, number>>;
  liveRatesAsOfMs?: number;

  manifest: PortfolioManifestV1;

  // Visibility-respecting, scope/global display order.
  orderedAssetGroupIdsForAssetList: readonly string[];
  orderRevision: number;

  evictScopedWalletIds?: readonly string[];
}>;
```

### Full recompute

A full recompute:

- reads `manifest.populatedWalletIds` for readiness;
- filters by visible eligible wallets for display and totals;
- builds global row shells for all visible asset groups;
- builds PnL series for populated visible wallets only;
- marks row payloads ready only when the underlying series exists;
- publishes scope-specific readiness;
- refreshes existing scoped cache entries using the same loaded input set;
- evicts scoped entries containing deleted wallet IDs when requested.

### Wallet/wallets recompute

A wallet/wallets recompute:

- rebuilds the corresponding `byWallet` slices;
- refreshes global asset groups and totals affected by those wallets;
- refreshes cached scoped entries whose wallet set intersects the updated wallet set;
- preserves non-intersecting scoped entries by reference.

### Touch recompute

A touch recompute only updates `lastAccessedAt` for existing slices. It does not alter series, rows, totals, readiness, order, fingerprints, or computed-at timestamp.

### Scheduler

The scheduler coalesces and drains in this order:

```txt
full → wallet/wallets → touch/touches
```

A pending full does not discard pending wallet builds or touches unless the merge rule explicitly subsumes them. This preserves progressive populate updates and focus/touch bookkeeping.

All scheduler writes to `sharedPortfolioState` occur on the compute runtime. No trigger writes shared state directly.

---

## 12. Hooks and selectors

### Selectors

Selectors are pure worklet functions of `PortfolioState` and primitive args. They do not read Redux, MMKV, queue, or manifest.

Core selectors:

```ts
selectTotalSeries(state, interval)
selectWalletSeries(state, walletId, interval)
selectAssetGroupSeries(state, assetGroupId, interval)
selectAssetGroupRowShells(state, mode)
selectAssetGroupRow(state, assetGroupId, mode)
selectOrderedAssetGroupIds(state)
selectAllocationRows(state)
selectScopeReadiness(state, scopeKey)
selectScopedSeries(state, walletIdsKey, interval)
selectScopedAssetGroupSeries(state, walletIdsKey, assetGroupId, interval)
selectScopedAssetGroupRows(state, walletIdsKey, mode)
selectScopedOrderedAssetGroupIds(state, walletIdsKey)
stableWalletIdsKey(walletIds)
```

### `usePortfolioSlice`

Do not copy the entire `sharedPortfolioState` object into React.

Use UI-runtime selector evaluation:

```ts
export function usePortfolioSlice<T>(
  selector: (s: PortfolioState) => T,
  areEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const [slice, setSlice] = useState(() => selector(sharedPortfolioState.value));

  useAnimatedReaction(
    () => selector(sharedPortfolioState.value),
    (next, prev) => {
      if (prev === null || !areEqual(next, prev)) {
        runOnJS(setSlice)(next);
      }
    },
    [selector, areEqual],
  );

  return slice;
}
```

Rules:

- selected slices may cross into React;
- the full `PortfolioState` must not cross into React except in debug screens;
- chart memoization uses `series.fingerprint`;
- row memoization uses `rowFingerprint` or row shell scalar fields;
- cache-miss scoped selectors return `undefined`/skeleton state and wait for scheduled recompute. They never aggregate in JS.

---

## 13. Trigger behavior

Every ordinary trigger checks `canRunPortfolioV2Work()` as its first executable statement. The only exceptions are reset/repair paths and Show Portfolio visibility toggle, because those need to run precisely when ordinary work is blocked.

### Post-auth app launch

1. If cache invalid bit is set, run repair reset.
2. Warm-publish from existing manifest/snapshots/rates without network.
3. Await the warm recompute drain so completed PnL is committed before populate starts.
4. Resume any pending queue.
5. Start background rate freshen; when it completes, schedule a follow-up recompute.

### Send completed

```ts
onSendCompleted({walletId}) {
  populateWallet(walletId, 'send');
}
```

`populateWallet` filters out testnet/regtest wallets. Already-populated livenet wallets can be requeued because queue append does not dedupe against manifest populated state.

### Pull to refresh

1. Force `ensureFresh` for visible affected assets plus canonical `BTC/USD`.
2. Requeue changed livenet wallets, including already-populated wallets.
3. Schedule recompute for affected wallet set or full scope.

### Quote currency changed

1. Ensure BTC bridge rates for target quote.
2. Run `recomputeQuoteBridgeFromExistingData` on compute runtime.
3. Do not fetch per-asset target-quote rates.
4. Do not touch populate queue.

### Key imported

If Show Portfolio is enabled, requeue all livenet wallets in the imported key. Hidden wallets are included because populate is visibility-ignored.

### Wallets/key/account visibility changed

1. If unhidden livenet wallets were imported during a blocked window and are not in manifest populated state, requeue them.
2. Schedule a full recompute using visibility-respecting eligible wallets.
3. Do not delete snapshots.

### Wallets/key deleted

1. Cancel populate and wait for loop stop.
2. Reconcile manifest and queue using visibility-ignored populate eligibility.
3. Clear deleted wallets’ `snap:*` data through snapshot-store APIs, not raw MMKV loops.
4. Schedule full recompute with `evictScopedWalletIds`.
5. Requeue surviving pending wallets if needed.
6. Do not clear shared `rate:v1:*` keys.

### Show Portfolio toggled off

1. UI hides portfolio-owned surfaces immediately via setting gate.
2. Run `performResetSequence`.
3. Leave Exchange Rate surfaces mounted and market-rate cache intact by default.

### Show Portfolio toggled on

1. Discharge any pending wipe obligation.
2. Repair cache invalid bit if latched.
3. Start fresh initial populate from empty manifest/queue.

---

## 14. UI migration contracts

### Row/list surfaces

Rows render from row shells. The row shell exists before PnL is ready.

- Ready Today uses `rowToday`.
- Ready All Time uses `rowAllTime`.
- Not ready uses skeleton/right-side placeholder.
- Invalid-history blocked uses skeleton footprint plus error-ready affordance.
- Switching Today/All Time never changes order.
- Home and All Assets use the same global display order.
- Allocation uses the same display order as All Assets for the same scope.

### Charts

A chart receives a `Series | undefined` and a `ScopeReadiness`.

First-populate behavior:

- if no prior valid series and `initialScopeReady === false`, hide chart;
- if invalid-history blocked and no valid series, show error-ready affordance where product wants it;
- if ready, show chart.

Incremental behavior:

- if `hasEverPublishedValidSeries`, keep stale chart visible while `refreshing` is true;
- replace chart atomically when new series publishes.

### Scrubbing

Scrub state is UI-local. Scrub reads points only.

Idle:

```txt
big balance = lastPoint.fiatBalance
PnL row = lastPoint.pnlChange + lastPoint.pnlPercent
no timestamp
```

Scrubbed:

```txt
big balance = selectedPoint.fiatBalance
PnL row = selectedPoint.pnlChange + selectedPoint.pnlPercent + formatted timestamp
```

Timestamp format:

- `1D`, `1W`, `1M`: date + short time, e.g. `March 29, 2026 at 5:22 PM`.
- `3M`, `1Y`, `5Y`: date only.
- `ALL`: date + time if window duration is `< 90 days`; date only otherwise.

If a series updates mid-scrub, keep the cursor by timestamp if possible; otherwise snap to nearest timestamp; if outside the new range, end scrub and return to idle.

### Hide Crypto Balances

Only UI components read `state.APP.hideAllBalances`. `src/portfolio/v2/**` runtime modules must not read it.

When hidden:

- user balance strings and delta-fiat strings render `****`;
- portfolio balance charts are hidden;
- chart scrub is impossible because chart is unmounted;
- Exchange Rate market prices/charts remain unmasked;
- Exchange Rate user-balance subviews are masked.

---

## 15. Phase plan

### Phase 0 — Inventory and flag

- Inventory current portfolio consumers, Redux state paths, MMKV prefixes, reset paths, visibility actions, post-auth signal, send/pull/quote triggers, and current invalid-history behavior.
- Add `PORTFOLIO_V2` feature flag, default false.
- Confirm dedicated portfolio MMKV instance and registry behavior.
- Confirm whether `rate:v1:*` is shared with Exchange Rate screens. v19 default is not to wipe it.

Acceptance:

- Inventory document checked in.
- Feature flag readable on JS and worklet paths.
- No behavior change with flag off.

### Phase 1 — V2 scaffolding

Create:

```txt
src/portfolio/v2/model.ts
src/portfolio/v2/manifest.ts
src/portfolio/v2/populate/queue.ts
src/portfolio/v2/runtimes.ts
src/portfolio/v2/sharedState.ts
src/portfolio/v2/reduxAccess.ts
src/portfolio/v2/kvStore.ts
src/portfolio/v2/logPortfolioRuntimeError.ts
```

Define model types from this plan, including `Point.remainingUnrealizedPnlFiat`, `PortfolioManifestV1`, `PopulateQueueV1`, `ScopeReadiness`, and `AssetGroupRowShell`.

Acceptance:

- Typecheck green.
- Unit tests for empty state, manifest load/save, queue load/save, reset invalid bit, and Redux access init.

### Phase 2 — Snapshot/rate readers and canonical rates

- Add snapshot index `revision` if needed.
- Add async v2 readers for snapshots and rates.
- Implement `resolveStoredRateInterval`.
- Implement `ensureFresh` with freshness-check/fetch/persist separation and a second guard before persist.
- Use dedicated rate-fetch runtime.
- Always include `BTC/USD` canonical rates in normal rate refreshes.
- Implement `ensureQuoteCurrencyFxBridge` for target BTC rates only.

Acceptance:

- `3M`/`1Y`/`5Y` never create separate rate keys.
- `BTC/USD` is ensured even if portfolio has no BTC wallet.
- Quote switch fetches only `BTC/<target>`.
- Rate fetch context lifecycle tests pass.

### Phase 3 — Recompute, formula, fingerprints, scoped cache

- Implement shared interval-window helper used by portfolio and Exchange Rate tests.
- Implement capped chart sample grid with endpoint preservation.
- Implement PnL formula consuming all balance-change events, not only emitted timestamps.
- Implement full-point series fingerprint.
- Implement global and scoped recompute.
- Implement scope readiness.
- Implement row shells and row payloads derived from series endpoints.
- Implement quote-bridge reprice from snapshots/rates using per-timestamp formula.

Acceptance:

- Product-oracle PnL fixtures pass.
- No-transaction PnL percent equals Exchange Rate percent.
- Row/detail equality passes globally and key-scoped.
- Quote-switch in-window transaction fixture matches from-scratch bridged recompute.
- Mid-series mutation changes fingerprint and re-renders chart.

### Phase 4 — Scheduler and hooks

- Implement three-phase scheduler.
- Implement `usePortfolioSlice` with UI-runtime selector evaluation.
- Implement typed hooks: `usePortfolioChart`, `usePortfolioAssetRows`, `usePortfolioStatus`.
- Implement selectors as pure worklet functions.
- Add import restrictions so UI cannot call generic compute/request APIs.

Acceptance:

- No hook copies full `PortfolioState` into React except debug-only helpers.
- Timeframe switch triggers no runtime/fetch/populate/snapshot work.
- Scoped selector cache misses return skeleton state, not JS aggregation.

### Phase 5 — Populate runtime

- Implement manifest-aware queue operations.
- Implement visibility-ignored populate eligibility.
- Implement one-wallet-at-a-time populate loop using existing kernels.
- Preserve signing context installation around the same kernel calls as v1.
- Preserve invalid-history quarantine behavior.
- Preserve incremental reorg-safe tail rewind/overwrite behavior.
- Update manifest after wallet success or invalid-history skip.
- Emit progress ticks after success or skip.

Acceptance:

- Already-populated wallet can be requeued after send/pull/app-launch refresh.
- Queue does not dedupe against manifest populated state.
- App kill/resume shows completed PnL immediately and continues pending work.
- Hidden livenet wallets remain populate-eligible.
- Testnet/regtest wallets never enter queue.

### Phase 6 — Triggers

Wire all trigger sites behind `PORTFOLIO_V2`:

- post-auth app launch;
- send completed;
- pull-to-refresh;
- quote-currency change;
- live-rates update;
- key import;
- wallet/key/account hide/unhide;
- key/wallet delete;
- Show Portfolio toggle.

Acceptance:

- Guard-before-side-effect tests pass.
- Send requeues already-populated wallet.
- Pull-to-refresh requeues already-populated changed wallets and refreshes rates.
- Quote switch fetches only BTC bridge rates.
- Show Portfolio rapid toggle serializes and final state wins.

### Phase 7 — UI migration

- Migrate Home portfolio balance/chart and asset list.
- Migrate All Assets and Allocation.
- Migrate WalletDetails, AccountDetails, KeyOverview.
- Migrate AssetBalanceHistoryScreen and scoped asset detail.
- Keep Exchange Rate screens independent from Show Portfolio.
- Implement shared scrub hook.
- Implement Hide Crypto Balances UI-only masking.

Acceptance:

- First-populate chart gates are scope-specific.
- Rows visible immediately and reveal right-side PnL progressively.
- Scrub first/final point invariants pass.
- No maximum-update-depth errors on rapid timeframe/scrub interactions.
- Hide Crypto Balances causes zero v2 runtime side effects.

### Phase 7.5 — Debug and reset paths

- Migrate debug screens to v2 helpers.
- Replace direct portfolio wipes with `performResetSequence`.
- Ensure wipe uses portfolio MMKV instance and registry-aware deletes.
- Default wipe excludes shared `rate:v1:*`.

Acceptance:

- Debug clear resets manifest, queue, generated state, and snapshots.
- Feature flag and cache-invalid bit exclusions behave correctly.
- Registry list is clean after wipe.
- Exchange Rate cached rates remain if using shared `rate:v1:*` default.

### Phase 8 — Flip flag and delete v1 orchestration

- Default `PORTFOLIO_V2` to true.
- Delete v1 runtime request/client/session/chart-cache/store orchestration.
- Delete persisted Redux portfolio chart caches.
- Keep kernels used by v2.
- Update root reducer/persist config.
- Keep kill switch until soak complete.

Acceptance:

- Full test suite, typecheck, and lint green.
- No UI imports banned v1 APIs.
- No persisted Redux arrays for portfolio charts/snapshots/rates.

### Phase 9 — Polish and benchmark

- Delete spikes and unused helpers.
- Benchmark post-auth warm publish, first-populate reveal, timeframe switch, scrub, quote switch, and pull-to-refresh.
- Add persisted derived render-state hydration only if measured cold-start latency requires it. This is optional and should not be added preemptively.

---

## 16. Required tests before Phase 8

### Architecture and storage

1. Large portfolio chart/rate/snapshot data is absent from persisted Redux.
2. Portfolio MMKV instance is used for all v2 keys.
3. Wipe uses registry-aware delete and leaves registry clean.
4. Show Portfolio off wipe excludes shared `rate:v1:*` by default; Exchange Rate surfaces remain visible.
5. Cache invalid bit blocks ordinary work after mid-wipe failure and repair clears it.
6. Reset waits for populate, recompute, and ensureFresh.

### Manifest and queue

7. Manifest populated state and queue pending state are independent.
8. Already-populated wallet requeues after send.
9. Already-populated wallet requeues after pull-to-refresh.
10. App-launch incremental refresh can requeue populated wallets.
11. Append dedupes pending/active only, not manifest populated.
12. Queue resume after app kill continues from persisted pending/active state.
13. Deleted wallets are pruned from manifest and queue.
14. Hidden livenet wallets remain populate-eligible.
15. Testnet/regtest wallets never enter queue.

### Display order and visibility

16. Populate order includes hidden livenet wallets.
17. Home display order excludes hidden wallets.
18. Key/account scoped display order excludes hidden wallets inside that scope.
19. Allocation order equals All Assets order for the same scope.
20. Mid-populate Today/All Time toggle does not change row order.

### First-populate readiness

21. Home chart hidden until every visible Home-scope wallet is populated or invalid-history blocked.
22. WalletDetails chart appears as soon as that wallet is populated.
23. Asset Detail chart appears only after every visible wallet in that asset group/scope is populated or invalid-history blocked.
24. KeyOverview chart appears only after every visible wallet in that key scope is populated or invalid-history blocked.
25. Incremental refresh keeps stale chart visible if the scope has previously published valid series.

### PnL and rates

26. First chart point `pnlChange === 0` exactly.
27. Final chart point equals idle header/PnL numbers.
28. Every Point includes `remainingUnrealizedPnlFiat` and scrub UI reads it directly.
29. No-transaction PnL percent equals Exchange Rate percent for each interval.
30. Buy/sell/partial disposal/zero-balance fixtures match product formula.
31. Same-user transfer fixture proves transfers are not netted.
32. Cross-chain same-ticker transfer fixture uses per-chain rates.
33. Chart output capped to `<= 89` points.
34. Transaction between emitted chart samples affects later emitted PnL.
35. Full-point fingerprint changes when a middle point changes while endpoints stay the same.

### Quote switch

36. `BTC/USD` canonical rates are ensured even with no BTC wallet.
37. Quote switch to EUR fetches only `BTC/EUR` stored intervals.
38. Quote switch to USD performs no target BTC fetch.
39. In-window transaction quote-bridge reprice matches from-scratch bridged recompute.
40. Multi-hop USD → EUR → GBP still bridges from canonical USD, not display EUR.
41. Quote switch during populate does not touch queue and publishes bridged current data.

### Hooks, selectors, and UI

42. `usePortfolioSlice` passes only selected slice to React, not full `PortfolioState`.
43. Scoped selectors do not aggregate wallets or walk points in JS.
44. Timeframe switches cause zero fetch/populate/snapshot/recompute side effects.
45. Chart scrubbing causes zero fetch/populate/snapshot/recompute/MMKV side effects.
46. Scrub timestamp formatting matches interval rules.
47. Scrub survives mid-publish by timestamp or falls back to idle.
48. Hide Crypto Balances causes zero v2 runtime/MMKV/shared-state writes.
49. Show Portfolio off hides portfolio surfaces but leaves Exchange Rate surfaces visible.
50. No maximum-update-depth errors during rapid timeframe toggles or scrubbing.

### Lifecycle

51. Post-auth warm publish lands before populate kick and before network freshen resolves.
52. Send-triggered refresh propagates to Home, All Assets, Asset Detail, WalletDetails, KeyOverview, and scoped rows.
53. Pull-to-refresh rate change propagates to all affected screens.
54. Key import populates only livenet wallets.
55. Key delete clears wallet snapshots and updates all affected screens.
56. Hide/unhide preserves snapshots and updates visible totals/charts.
57. Unhide of a wallet imported during a blocked window triggers populate if it lacks manifest populated state.
58. Invalid-history marker skips wallet without marking populated and does not block unrelated scopes indefinitely.
59. Expired invalid-history marker can retry and successful populate clears marker.
60. Negative running balances are quarantined, never clamped into valid-looking PnL.

---

## 17. Deletion targets

After Phase 8, remove:

```txt
src/store/portfolio-charts/**
src/store/portfolio/** v1 slice/effects, except any tiny retained summary fields if still needed
src/portfolio/runtime/portfolioClient.ts
src/portfolio/runtime/portfolioHost.ts
src/portfolio/runtime/portfolioRequestRouting.ts
src/portfolio/runtime/portfolioWorkletTransport.ts
src/portfolio/runtime/portfolioWorkletDispatch.ts
src/portfolio/runtime/serialQueue.ts
src/portfolio/runtime/worklet/portfolioRequestWorklet.ts
src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts
src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts
src/portfolio/core/engine/portfolioEngine.ts session/query APIs
src/portfolio/service/portfolioPopulateService.ts
src/portfolio/ui/hooks/** v1 orchestration hooks
src/portfolio/ui/selectors/** v1 row/analysis selectors
```

Keep/adapt kernels:

```txt
src/portfolio/core/pnl/analysisStreaming.ts
src/portfolio/core/pnl/snapshotStream.ts
src/portfolio/core/pnl/snapshotStore.ts
src/portfolio/core/pnl/fiatRateStore.ts
src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts
src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts
src/portfolio/runtime/worklet/portfolioWorkletRates.ts
src/portfolio/adapters/rn/**
```

The goal is not merely LOC reduction. The goal is to make consistency structural:

```txt
one manifest of valid data
one queue of current work
one formula
one shared interval-window helper
one set of published render slices
rows derived from chart endpoints
UI reads only published slices
```
