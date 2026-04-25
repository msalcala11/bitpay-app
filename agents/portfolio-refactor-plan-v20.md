# Portfolio runtime refactor plan — v20

**Status:** revised from v19 after implementation-safety feedback.

**Target:** replace the current screen-specific portfolio computation/caching stack with a canonical worklet-owned portfolio render model. The v20 architecture uses separate queue and manifest state, run-scoped queue items, scope-specific readiness with explicit empty-scope handling, raw row-shell values, full-point chart fingerprints, a dedicated rate-fetch runtime, product-oracle correctness tests, and UI hooks that move only selected slices across to React.

**Executable by:** a senior React Native engineer or a coding agent with strong React Native, Reanimated/worklets, MMKV, Redux, and test-writing context.

---

## 0. What changed from v19

This revision applies the implementation-safety feedback on v19. The big v20 direction remains intact; v20 tightens the contracts that an implementation agent is most likely to fill in incorrectly.

1. **Row shells publish raw values, not formatted strings.** `AssetGroupRowShell` now uses `currentCryptoAmount: string` and `currentFiatValue?: number`. The crypto amount is a decimal display-unit aggregate using the asset group’s canonical decimals, not a localized string. The UI formats, localizes, and masks. The UI must not aggregate member wallets.
2. **Queue items are run-scoped.** The queue stores `PopulateQueueItem` objects with `itemId = runId + ':' + walletId`. Dedupe is only within the same run against pending, active, and completed-in-run item IDs. A new run can enqueue a previously completed wallet. The queue never dedupes against `manifest.populatedWalletIds`.
3. **Active-wallet resume is deterministic.** On app restart, a persisted active queue item is moved to the front of pending. The next populate loop resumes from its checkpoint if valid, or clears incomplete staging and restarts that wallet if the checkpoint is absent/invalid.
4. **Empty scopes are not “ready.”** Readiness now includes `empty: boolean`. An empty Home/key/account/asset scope renders an empty/no-chart state, not a ready chart with no points.
5. **`usePortfolioSlice` is explicitly worklet-safe.** Selectors must be stable worklet-compatible functions and may close only over primitives or shareable/frozen values. The hook does not run an initial JS selector over the entire shared state.
6. **Scoped row-shell behavior is test-pinned.** Scoped shells must publish before scoped PnL is ready, must respect visibility, and must not permit UI-side aggregation through `memberWalletIds`.
7. **Repo-specific V4 rate/classifier guardrails are restored.** The plan now pins native-vs-token fetch paths, token URL construction, Solana token-address casing, ETH-side MATIC/POL reclassification, response extraction, and no persisted `3M`/`1Y`/`5Y` rate keys.
8. **Runtime wording is clarified.** React JS and the UI worklet are app execution contexts. The portfolio system owns three additional worklet runtimes: compute, populate, and rate-fetch.

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

Use React JS and the UI worklet as app execution contexts, plus three portfolio-owned worklet runtimes:

```txt
React JS runtime         UI components, navigation, Redux access wrappers, trigger entrypoints
UI worklet runtime       Reanimated selectors, scrub state, selected-slice subscription
portfolio-compute        PnL, aggregation, chart series, rows, scoped render cache, quote reprice
portfolio-populate       one-wallet-at-a-time snapshot populate using existing populate kernels
portfolio-rate-fetch     BWS fiat-rate fetches with lightweight dispatch context
```

The dedicated rate-fetch runtime is chosen deliberately. It is simpler than preserving a branch matrix and avoids runtime-global dispatch-context clobbering between populate signing context and rate fetch context. In shorthand, v20 uses three portfolio worklet runtimes: compute, populate, and rate-fetch.

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

  // Runtime-computed aggregates. UI formats/localizes/masks these values.
  // `currentCryptoAmount` is a decimal display-unit aggregate using the
  // asset group's canonical decimals, not a localized/formatted string.
  currentCryptoAmount: string;
  currentFiatValue?: number;

  // Membership only: navigation, scoped detail wallet list, debug, and cache keys.
  // UI must never sum these wallets to derive displayed row amounts or PnL.
  memberWalletIds: readonly string[];
  memberWalletIdsKey: string;

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
  // Empty scope means no visible wallets for this route/scope. It renders an
  // empty/no-chart state, not a ready empty chart.
  empty: boolean;
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

The queue stores run-scoped work items, not just wallet IDs. This avoids the v19 ambiguity where a wallet that had already completed a previous run could be accidentally blocked from a send or pull-to-refresh refresh.

```ts
export type PopulateQueueReason =
  | 'initial'
  | 'appLaunchIncremental'
  | 'send'
  | 'pullToRefresh'
  | 'keyImport'
  | 'showPortfolioToggleOn'
  | 'manual';

export type PopulateCheckpoint = Readonly<{
  walletId: string;
  cursor?: string;
  lastProcessedBlockHeight?: number;
  lastProcessedTxId?: string;
  updatedAt: number;
}>;

export type PopulateQueueItem = Readonly<{
  itemId: string;        // `${runId}:${walletId}`
  runId: string;
  walletId: string;
  reason: PopulateQueueReason;
  requestedAtMs: number;
  checkpoint?: PopulateCheckpoint;
}>;

export type PopulateQueueV1 = Readonly<{
  schemaVersion: 1;
  pending: readonly PopulateQueueItem[];
  active?: PopulateQueueItem;

  // Dedupe only within the same run. Keys are PopulateQueueItem.itemId.
  completedInRunItemIds: Readonly<Record<string, true>>;

  startedAt: number;
  updatedAt: number;
  cfg: BwsConfig;
  ingest: SnapshotIngestConfig;
  pageSize: number;
}>;
```

Queue writes happen when:

- building a fresh queue: create one `runId`, create one item per wallet from `manifest.populateOrderWalletIds` or a supplied subset, and place those items in `pending`;
- appending refresh work: create a new business-event `runId` for that send/pull/app-launch/manual event and append items for the affected wallet IDs;
- starting a wallet: move the first `pending` item into `active` and persist the queue;
- checkpointing a wallet: update `active.checkpoint` after each durable page/checkpoint step;
- completing a wallet in this run: clear `active`, add `active.itemId` to `completedInRunItemIds`, and update manifest populated state;
- invalid-history skip: clear `active`, update manifest invalid-history state, and add `active.itemId` to `completedInRunItemIds` for this run;
- deletion/reconciliation: prune only deleted/non-livenet wallets. Do not prune hidden livenet wallets.

### Queue dedupe semantics

Dedupe is run-scoped:

```ts
function hasItemInQueue(queue: PopulateQueueV1, item: PopulateQueueItem): boolean {
  return (
    queue.pending.some(p => p.itemId === item.itemId) ||
    queue.active?.itemId === item.itemId ||
    queue.completedInRunItemIds[item.itemId] === true
  );
}
```

Never dedupe against `manifest.populatedWalletIds`. Manifest means “valid data exists.” Queue means “work to do now.” A wallet can have valid data and still need new work after a send, receive, pull-to-refresh, app-launch incremental refresh, key import retry, or manual refresh.

This enables the important scenario:

```txt
initial run pending: B, C, D
initial run already completed: A
user sends from A
append new item: {runId: 'send-2', walletId: 'A'}
queue pending becomes: B, C, D, A(send-2)
```

A new run may enqueue the same wallet even if an earlier run already completed that wallet. If the same wallet is already pending under an older run, v20 still allows the new run-scoped item. A future optimization may safely coalesce an older unstarted item into a newer item for the same wallet, but that optimization is not required and must preserve send/pull correctness.

### Active-wallet resume after app kill

Resume normalizes persisted `active` state before the loop starts:

```ts
export function normalizeQueueOnResume(queue: PopulateQueueV1): PopulateQueueV1 {
  if (!queue.active) return queue;
  return {
    ...queue,
    pending: [queue.active, ...queue.pending],
    active: undefined,
    updatedAt: Date.now(),
  };
}
```

When the loop starts that item again:

1. If `item.checkpoint` is valid, resume the wallet from that checkpoint.
2. If the checkpoint is missing, stale, or invalid, clear that wallet’s incomplete/staging snapshot data and restart that wallet from the normal reorg-safe starting point.
3. Do not update `manifest.populatedWalletIds` until the wallet finishes successfully.
4. Previously completed wallets remain in the manifest and their PnL remains visible immediately after post-auth startup.

This makes app-kill recovery deterministic: completed work stays published; the interrupted wallet is retried first; pending work continues afterward.

### Append helper

```ts
function appendToQueue(args: {
  walletIds: readonly string[];
  reason: PopulateQueueReason;
  runId?: string;
}): void {
  const q = loadQueue() ?? emptyQueue();
  const runId = args.runId ?? createRunId(args.reason);
  const nextItems = args.walletIds.map(walletId => ({
    itemId: `${runId}:${walletId}`,
    runId,
    walletId,
    reason: args.reason,
    requestedAtMs: Date.now(),
  }));

  const toAppend = nextItems.filter(item => !hasItemInQueue(q, item));
  if (!toAppend.length) return;

  saveQueue({
    ...q,
    pending: [...q.pending, ...toAppend],
    updatedAt: Date.now(),
  });
}
```

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

First-populate chart readiness is scope-specific and empty-scope aware.

```ts
function isWalletUsableForInitialChart(
  walletId: string,
  manifest: PortfolioManifestV1,
): boolean {
  return manifest.populatedWalletIds.includes(walletId) ||
         manifest.invalidHistoryWalletIds.includes(walletId);
}

function computeInitialScopeReadiness(
  scopeWalletIds: readonly string[],
  manifest: PortfolioManifestV1,
): Pick<ScopeReadiness, 'empty' | 'initialScopeReady' | 'invalidHistoryBlocked'> {
  if (scopeWalletIds.length === 0) {
    return {
      empty: true,
      initialScopeReady: false,
      invalidHistoryBlocked: false,
    };
  }

  const initialScopeReady = scopeWalletIds.every(id =>
    isWalletUsableForInitialChart(id, manifest),
  );

  const invalidHistoryBlocked = scopeWalletIds.every(id =>
    manifest.invalidHistoryWalletIds.includes(id),
  );

  return {
    empty: false,
    initialScopeReady,
    invalidHistoryBlocked,
  };
}
```

An empty scope is not a ready chart. It means the route has no visible wallets after livenet/deleted/visibility filtering. The UI should render the product’s empty/no-portfolio state and should not mount an empty chart.

### First populate

- **WalletDetails chart:** show once that wallet is populated, or show invalid-history affordance if blocked.
- **Asset Detail chart:** show once every visible wallet in that asset group/scope is populated or invalid-history blocked.
- **KeyOverview chart:** show once every visible wallet in that key is populated or invalid-history blocked.
- **AccountDetails chart:** show once every visible wallet in that account is populated or invalid-history blocked.
- **Home chart:** show once every visible Home-scope wallet is populated or invalid-history blocked.
- **Empty scope:** render empty/no-chart state, not a ready chart.
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

v20 fixes the canonical quote to `USD`:

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


### V4 fiat-rates endpoint and classifier contract

The rate path must preserve the repo-specific V4 behavior; otherwise quote switching and ticker grouping will look correct in abstract tests but fail on real token portfolios.

**Endpoint shape**

```txt
GET /v4/fiatrates/<QUOTE_UPPER>?days=<N>
GET /v4/fiatrates/<QUOTE_UPPER>?days=<N>&chain=<chain>&tokenAddress=<tokenAddress>
```

Rules:

- `days=1`, `7`, and `30` are used for `1D`, `1W`, and `1M`.
- `ALL` omits `days`.
- `3M`, `1Y`, and `5Y` resolve to `ALL` before fetch/persist and never produce separate URLs or MMKV keys.
- Native coins use a batched multi-coin request with no `chain` or `tokenAddress`.
- Tokens use one token-specific request per `(coin, chain, tokenAddress)` tuple.

**Classifier**

Use the existing canonical classifier, not a new duplicate:

```ts
getFiatRateAssetRef({currencyAbbreviation, chain, tokenAddress, credentials})
```

Preserve these rules:

- `wbtc -> btc`;
- `weth -> eth`;
- `matic -> pol`;
- legacy ETH-side MATIC/POL token address `0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0` with `chain='eth'` reclassifies to native `pol`, so it uses the batched native path;
- `chain` is lowercase/trimmed;
- token address is trimmed and lowercased except on `sol`/`solana`, where case must be preserved;
- native rate key: `rate:v1:<QUOTE>:<coin>:<storedInterval>`;
- token rate key: `rate:v1:<QUOTE>:<coin>:<storedInterval>:<chain>:<tokenAddress>`.

**Response extraction**

`extractSeriesFromFiatRatePayload` must preserve v1 behavior:

- accept direct series shape;
- accept keyed records and try exact/lower/upper coin keys;
- for token-specific single-key payloads whose key does not match the requested symbol, fall back to the single value in the response record;
- swallow individual token fetch failures so one bad token does not abort the whole batch;
- native batched fetch failure may be swallowed only for coins that have a stale fallback series; otherwise it rethrows.

**Required examples**

A mixed request with native `btc`, `eth`, `sol`, wrapped `wbtc`, legacy `matic/pol`, ETH USDC, and SOL USDC should produce:

```txt
one native batched fetch: {btc, eth, sol, pol}
two token fetches: usdc on eth, usdc on sol
SOL token address case preserved
ETH token address lowercased
legacy matic/pol stored as native rate:v1:USD:pol:<interval>
```

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

Default v20 wipe prefixes:

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

Selectors run in the UI worklet and only the selected slice crosses into React:

```ts
export type WorkletPortfolioSelector<T> = (state: PortfolioState) => T;

export function usePortfolioSlice<T>(
  selector: WorkletPortfolioSelector<T>,
  areEqual: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  const [slice, setSlice] = useState<T | undefined>(undefined);

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

Selector rules:

- selector must be worklet-compatible;
- selector identity must be stable, usually via a typed hook façade or `useMemo`/`useCallback` with primitive deps only;
- selector may close only over primitives, frozen/shareable values, or other worklet-safe constants;
- selector must not close over React props objects, Redux objects, class instances, `Map`, `Set`, formatters, non-worklet functions, mutable arrays, or navigation objects;
- selector must return only the selected slice, never the full `PortfolioState`;
- selector must not aggregate wallets, walk chart points to compute PnL, format strings, or read MMKV/Redux/queue/manifest;
- debug screens may have a separate explicit “read whole state” helper, but normal UI hooks must not.
- selected slices may cross into React;
- chart memoization uses `series.fingerprint`;
- row memoization uses `rowFingerprint` or row shell scalar fields;
- cache-miss scoped selectors return `undefined`/skeleton state and wait for scheduled recompute. They never aggregate in JS.

The initial value is intentionally `undefined` until the UI-worklet reaction publishes the first selected slice into React. Hook façades should map this to skeleton/empty state as needed. Avoid `useState(() => selector(sharedPortfolioState.value))` in normal UI code because that can materialize the shared value on the JS thread.

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

Rows render from row shells. The row shell exists before PnL is ready. The runtime publishes raw aggregate values; the UI formats and masks them.

- `currentCryptoAmount` and `currentFiatValue` come from the runtime shell; UI must not sum `memberWalletIds` to derive row amounts.
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
- Confirm whether `rate:v1:*` is shared with Exchange Rate screens. v20 default is not to wipe it.

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

- Implement manifest-aware run-scoped queue operations.
- Implement active-item resume normalization and checkpoint/restart behavior.
- Implement visibility-ignored populate eligibility.
- Implement one-wallet-at-a-time populate loop using existing kernels.
- Preserve signing context installation around the same kernel calls as v1.
- Preserve invalid-history quarantine behavior.
- Preserve incremental reorg-safe tail rewind/overwrite behavior.
- Update manifest after wallet success or invalid-history skip.
- Emit progress ticks after success or skip.

Acceptance:

- Already-populated wallet can be requeued after send/pull/app-launch refresh.
- Queue dedupes only same-run item IDs against pending, active, and completed-in-run; it never dedupes against manifest populated state.
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
11. Queue append dedupes within the same run against pending, active, and completed-in-run item IDs; it never dedupes against manifest populated state.
12. New run ID can enqueue a wallet that completed in an earlier run, including the case where initial run completed A and a later send run enqueues A while B/C/D remain pending.
13. Active queue item resume after app kill: persisted active item is moved to the front of pending; valid checkpoint resumes; missing/invalid checkpoint clears incomplete staging and restarts that wallet; completed manifest data remains visible.
14. Deleted wallets are pruned from manifest and queue.
15. Hidden livenet wallets remain populate-eligible.
16. Testnet/regtest wallets never enter queue.

### Display order and visibility

17. Populate order includes hidden livenet wallets.
18. Home display order excludes hidden wallets.
19. Key/account scoped display order excludes hidden wallets inside that scope.
20. Allocation order equals All Assets order for the same scope.
21. Mid-populate Today/All Time toggle does not change row order.

### First-populate readiness

22. Home chart hidden until every visible Home-scope wallet is populated or invalid-history blocked.
23. WalletDetails chart appears as soon as that wallet is populated.
24. Asset Detail chart appears only after every visible wallet in that asset group/scope is populated or invalid-history blocked.
25. KeyOverview chart appears only after every visible wallet in that key scope is populated or invalid-history blocked.
26. Incremental refresh keeps stale chart visible if the scope has previously published valid series.
27. Empty Home/key/account/asset scopes publish `empty: true`, `initialScopeReady: false`, and render empty/no-chart state rather than a ready empty chart.

### PnL and rates

28. First chart point `pnlChange === 0` exactly.
29. Final chart point equals idle header/PnL numbers.
30. Every Point includes `remainingUnrealizedPnlFiat` and scrub UI reads it directly.
31. No-transaction PnL percent equals Exchange Rate percent for each interval.
32. Buy/sell/partial disposal/zero-balance fixtures match product formula.
33. Same-user transfer fixture proves transfers are not netted.
34. Cross-chain same-ticker transfer fixture uses per-chain rates.
35. Chart output capped to `<= 89` points.
36. Transaction between emitted chart samples affects later emitted PnL.
37. Full-point fingerprint changes when a middle point changes while endpoints stay the same.

### Quote switch

38. `BTC/USD` canonical rates are ensured even with no BTC wallet.
39. Quote switch to EUR fetches only `BTC/EUR` stored intervals.
40. Quote switch to USD performs no target BTC fetch.
41. In-window transaction quote-bridge reprice matches from-scratch bridged recompute.
42. Multi-hop USD → EUR → GBP still bridges from canonical USD, not display EUR.
43. Quote switch during populate does not touch queue and publishes bridged current data.
44. V4 rate fetch uses one native batched request and token-specific requests per token tuple; ETH token addresses are lowercased, SOL/Solana token addresses are case-preserved.
45. Classifier aliases `wbtc -> btc`, `weth -> eth`, `matic -> pol`, and reclassifies legacy ETH-side MATIC/POL token address to native `pol`.
46. Token response extraction handles exact/lower/upper keyed matches and single-key token fallback.
47. `3M`, `1Y`, and `5Y` never produce separate rate URLs or MMKV keys; they resolve to `ALL`.

### Hooks, selectors, and UI

48. `usePortfolioSlice` passes only selected slice to React, not full `PortfolioState`.
49. `usePortfolioSlice` selectors are worklet-compatible/stable and reject or fail tests when they close over non-worklet objects, Redux objects, formatters, maps/sets, or mutable props.
50. Scoped selectors do not aggregate wallets or walk points in JS.
51. Scoped row shells publish before scoped PnL is ready, include only visible wallets for that scoped route, and update `walletIdsKey` after visibility changes.
52. UI never aggregates row amounts or PnL through `memberWalletIds`; instrumentation fails if row components sum wallets or walk points.
53. Timeframe switches cause zero fetch/populate/snapshot/recompute side effects.
54. Chart scrubbing causes zero fetch/populate/snapshot/recompute/MMKV side effects.
55. Scrub timestamp formatting matches interval rules.
56. Scrub survives mid-publish by timestamp or falls back to idle.
57. Hide Crypto Balances causes zero v2 runtime/MMKV/shared-state writes.
58. Show Portfolio off hides portfolio surfaces but leaves Exchange Rate surfaces visible.
59. No maximum-update-depth errors during rapid timeframe toggles or scrubbing.

### Lifecycle

60. Post-auth warm publish lands before populate kick and before network freshen resolves.
61. Send-triggered refresh propagates to Home, All Assets, Asset Detail, WalletDetails, KeyOverview, and scoped rows.
62. Pull-to-refresh rate change propagates to all affected screens.
63. Key import populates only livenet wallets.
64. Key delete clears wallet snapshots and updates all affected screens.
65. Hide/unhide preserves snapshots and updates visible totals/charts.
66. Unhide of a wallet imported during a blocked window triggers populate if it lacks manifest populated state.
67. Invalid-history marker skips wallet without marking populated and does not block unrelated scopes indefinitely.
68. Expired invalid-history marker can retry and successful populate clears marker.
69. Negative running balances are quarantined, never clamped into valid-looking PnL.
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
