# Portfolio runtime refactor plan — v23.1

**Status:** final contract-polish revision of v23. This is the last design iteration before implementation; future feedback should land as inline corrections in the implementation PR rather than as a v24/v25 architecture rewrite. It keeps the v23 architecture intact and only tightens edge-case contracts: all-zero row-shell fiat, weighted-series fingerprints and per-interval unavailability, checkpoint cursor persistence, invalid-history retry ownership, and final blocker tests.

**Target:** replace the current screen-specific portfolio computation/caching stack with a canonical worklet-owned portfolio render model. The v23.1 architecture uses separate queue and manifest state, run-scoped and priority-aware queue items, scope-specific readiness with explicit empty-scope handling, raw row-shell values with per-member rate sourcing, weighted group-rate parity for collapsed multi-chain assets, full-point chart fingerprints, a bounded LRU scoped cache, a dedicated rate-fetch runtime, product-oracle correctness tests, robust Show Portfolio wipe latching, and UI hooks that move only selected slices across to React.

**Executable by:** a senior React Native engineer or a coding agent with strong React Native, Reanimated/worklets, MMKV, Redux, and test-writing context.

---

## 0. What changed from v23

This revision keeps the v23 architecture intact and applies the final contract-polish patches from the latest review round. The goal is to align type contracts with prose, remove edge-case ambiguity, and pin ownership of the few remaining underspecified APIs.

1. **Weighted group exchange-rate math is pinned.** Collapsed multi-rate-source asset groups use a baseline-unit weighted market index. The runtime exposes `weightedRate(t)` for chart display and `weightedPercent(t)` as the no-transaction parity oracle. It is derived only when needed, not persisted.
2. **Portfolio-entered Exchange Rate routing is typed.** UI navigation distinguishes standalone market assets from portfolio-scoped weighted asset groups so a collapsed portfolio row cannot accidentally open one arbitrary token deployment.
3. **Weighted group quote bridging is explicit.** Quote switches rebuild weighted group rate series and row `rateStart` / `rateEnd` / `ratePercent` from per-timestamp bridged constituent rates. No scalar transform of a finished USD weighted series is allowed.
4. **Refresh queue insertion is stable and supersedes stale work.** Urgent send/pull work runs after the active wallet, preserves FIFO within each priority class, and drops older unstarted same-wallet normal/background items so stale pending work does not run after fresher urgent work.
5. **Row-shell fiat values have precise missing-rate behavior.** `currentFiatValue` is undefined if any visible nonzero member wallet lacks its live rate; zero-unit members do not block the aggregate; visible members with all current units equal to zero publish `currentFiatValue: 0`.
6. **Checkpoint validity is concrete.** Resume is allowed only when schema, wallet/run identity, staging keys, revision relationship, cursor/page/block/tx state, ingest config, and failure markers are internally valid.
7. **Wallet/key deletion restores the triple-guard contract.** Delete triggers guard before side effects, quiesce populate, reconcile, clear snapshots through store APIs, guard again before recompute, and never write shared state directly.
8. **Reset/MMKV registry discipline is restored.** Reset uses timeout-bounded quiescence, a durable cache-invalid bit, post-auth repair, real-MMKV key enumeration, and registry-aware deletes.
9. **Per-trigger ordering is tabulated.** Post-auth is warm-publish-first; freshness events are ensureFresh-first; deletion/show-toggle have their own ordering. Future triggers must not be “consistency-ized.”
10. **Row formulas and numeric fixtures are restored.** Row/detail equality is pinned by explicit formulas plus the `$100.20`, `$100.192`, and weighted-group `180.392 → 180.592 → 0.1108696616%` fixtures.
11. **Anti-regression variants are required for the load-bearing tests.** Queue dedupe, mid-series fingerprints, no-BTC-wallet quote switch, and transfer non-netting each include a “stub the bug back in and assert failure” variant.
12. **Delete survivor re-kick no longer double-enqueues.** `onWalletsDeleted` now resumes the already-reconciled queue via `kickPopulateLoopIfIdle()` instead of calling `populateWallets(survivors)` and creating new run-scoped items.
13. **`reconcileManifestAndQueueAgainstPopulateEligible(...)` is specified.** The helper signature, pruning semantics, return shape, and visibility-ignored eligibility source are pinned.
14. **Checkpoint type and validity checklist match.** `PopulateCheckpoint` now includes schema/run/item identity, staging keys, snapshot revision, ingest/page compatibility, and failure state fields.
15. **Scope readiness is publish-driven.** `hasEverPublishedValidSeries` flips only after recompute actually publishes a non-empty valid series, not merely because metadata says a scope is ready.
16. **Weighted group series type/prose are aligned.** Single-source groups use `marketAsset` routes and do not publish `weightedGroupRateSeries`; multi-source collapsed groups use `portfolioWeightedAssetGroup` and require full-point weighted fingerprints.
17. **Small helper contracts are pinned.** `startPopulate`, `resetSharedPortfolioStateForDebugClear`, `getSeriesIdlePoint`, `lastAccessedAt` LRU semantics, manifest validation, logger signature, and canonical BTC dependency ownership are explicit.
18. **Final v23.1 edge cases are pinned.** All-zero row-shell fiat publishes `0`; weighted route unavailability is per interval, not per route; weighted fingerprints include the weight vector and unavailable reason; persisted checkpoint cursors are schema-validated JSON; invalid-history triggers read markers but populate owns marker-clearing writes.

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
- The portfolio interval window must match the Exchange Rate interval window. With no in-window transactions, a single-rate-source asset’s portfolio PnL percent must equal that asset’s Exchange Rate percent for the same interval and quote. For collapsed multi-chain/multi-rate-source asset groups, the parity target is the runtime-published weighted group exchange-rate series for that same visible wallet scope, not an arbitrary constituent token’s Exchange Rate series.
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

The dedicated rate-fetch runtime is chosen deliberately. It is simpler than preserving a branch matrix and avoids runtime-global dispatch-context clobbering between populate signing context and rate fetch context. In shorthand, v23 uses three portfolio worklet runtimes: compute, populate, and rate-fetch.

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

export type MarketRatePoint = Readonly<{
  ts: number;
  rate: number;
  percentChange: number;
}>;

export type WeightedGroupRatePoint = Readonly<{
  ts: number;

  // UX-displayable portfolio-weighted average rate for this asset group.
  // Derived as groupIndex(t) / sum(unitsAtT0_i). This is what the chart y-axis
  // renders for portfolio-entered collapsed groups. Valid series emit finite
  // values; unavailable intervals publish no points.
  weightedRate: number | undefined;

  // No-transaction parity oracle. Derived as
  // (groupIndex(t) - groupIndex(t0)) / groupIndex(t0) * 100. Valid series emit
  // finite values; unavailable intervals publish no points.
  weightedPercent: number | undefined;
}>;

export type WeightedGroupRateSeries = Readonly<{
  // Full-point hash. Includes quote, assetGroupId, walletIdsKey, interval/window,
  // unavailableReason, baselineUnits, memberRateSourceKeys, the per-source weight
  // vector (`baselineUnitsByRateSourceKey`), and every emitted point's ts,
  // weightedRate, and weightedPercent. Endpoint-only fingerprints are forbidden
  // because the Exchange Rate scrub UI can stale on middle-point mutations.
  fingerprint: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  // Interval-local unavailability. The route can still be valid while one
  // interval is unavailable (for example, acquired today => zero 1D baseline).
  // Unavailable intervals publish `points: []` and render an interval-local
  // empty state; they do NOT silently fall back to a representative market route.
  unavailableReason?: 'zeroBaseline' | 'missingConstituentRate';

  // Multiple FiatRateAssetRef keys for collapsed groups such as USDC across
  // chains. Single-source groups do NOT publish this series; they route as
  // ordinary `marketAsset` Exchange Rate screens.
  memberRateSourceKeys: readonly string[];
  weighting: 'baselineUnitWeightedCollapsedGroup';
  // Total display-unit baseline units plus the exact per-source display-unit
  // weight vector. Store vector values as stable decimal strings so fingerprints
  // and debug output do not depend on JS floating-point stringification.
  baselineUnits: number;
  baselineUnitsByRateSourceKey: Readonly<Record<string, string>>;

  // Internal index values are not displayed directly. `groupIndex(t)` is
  // Σ(unitsAtT0_i * rate_i(t)); UI displays weightedRate, while tests use
  // weightedPercent for parity. Valid series have finite point values.
  // Unavailable intervals use `points: []` plus `unavailableReason`.
  points: readonly WeightedGroupRatePoint[];
}>;

export type PerIntervalWeightedGroupRateSeries =
  Readonly<Partial<Record<Interval, WeightedGroupRateSeries>>>;

export type ExchangeRateRoute =
  | {
      kind: 'marketAsset';
      fiatRateAssetRef: FiatRateAssetRef;
    }
  | {
      kind: 'portfolioWeightedAssetGroup';
      assetGroupId: string;
      walletIdsKey: string;
      scope: PortfolioRouteScope;
    };
```

`ExchangeRateRoute` lives in `src/portfolio/v2/routes/exchangeRateRoute.ts`, importing `FiatRateAssetRef` from the rate-classifier module and `PortfolioRouteScope` from the route-scope module. Only portfolio-owned row/detail navigation code may construct `portfolioWeightedAssetGroup` routes. Standalone Exchange Rates screens construct only `marketAsset` routes. The Exchange Rate screen must switch on `route.kind`; it must never infer weighted-vs-market behavior from ticker strings.

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
  // For collapsed multi-rate-source groups, these are endpoints from
  // weightedGroupRateSeries, not from one arbitrary constituent rate source.
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

  // Sum of each visible member wallet's current units times that wallet's own
  // FiatRateAssetRef / live-rate key. Do not value a collapsed ticker group
  // through one coarse group rate unless every member wallet has the exact same
  // rate source.
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

`currentFiatValue` contract:

```ts
const visibleMembers = getVisibleMembers(assetGroupId);

if (visibleMembers.length === 0) {
  // No visible members means no row shell is published for this scope.
  return undefined;
}

const nonzeroMembers = visibleMembers.filter(wallet =>
  currentUnits(wallet) !== 0
);

currentFiatValue =
  nonzeroMembers.length === 0
    ? 0
    : nonzeroMembers.every(wallet =>
        hasLiveRate(wallet.fiatRateAssetRef)
      )
      ? sum(nonzeroMembers.map(wallet =>
          currentUnits(wallet) * liveRateFor(wallet.fiatRateAssetRef)
        ))
      : undefined;
```

The runtime performs this aggregation. The UI may format, mask, navigate, or render skeletons, but it must not aggregate through `memberWalletIds` or walk wallet balances/points to derive row amounts. This is especially important for collapsed ticker groups and native/token distinctions. No visible members means no shell is published. Visible members with all current units equal to zero publish `currentFiatValue: 0` even if rates are missing, because zero holdings have a knowable fiat value. A zero-unit member wallet with a missing live rate does not block the aggregate because it contributes zero; a visible nonzero member wallet with a missing live rate makes `currentFiatValue` undefined. Runtime must not publish a partial fiat total, and UI should render the crypto amount plus a blank/skeleton fiat slot when fiat is undefined.

### Asset, wallet, and scoped slices

```ts
export type AssetGroupSlice = Readonly<{
  assetGroupId: string;
  fingerprint: string;
  memberWalletIds: readonly string[];
  memberWalletIdsKey: string;
  series: PerIntervalSeries;
  // Present only for collapsed groups with more than one distinct FiatRateAssetRef.
  // Single-source groups do not publish this field and route to the ordinary
  // market Exchange Rate series through `ExchangeRateRoute.kind === 'marketAsset'`.
  weightedGroupRateSeries?: PerIntervalWeightedGroupRateSeries;
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
  // Updated on wallet touch/cache hit. Used by LRU/touch semantics; not telemetry-only.
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
  // Updated on scoped-cache hit/touch. Used by bounded LRU eviction; not telemetry-only.
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

### Scoped cache bound

`scopedByWalletSet` is bounded by `MAX_SCOPED_CACHE_ENTRIES = 8`.

Eviction rules:

- update `lastAccessedAt` whenever a scoped entry is selected or touched;
- never evict the currently requested `walletIdsKey`;
- delete-triggered recompute drops entries containing deleted wallets before refresh;
- full recompute refreshes cached scoped entries first, then evicts least-recently-used entries beyond the cap;
- wallet/wallets recompute refreshes intersecting cached scoped entries first, then evicts beyond the cap;
- if more than eight entries are protected by currently mounted scopes, the cap may be exceeded temporarily, but LRU resumes once those scopes unmount.

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

### Manifest load validation

`loadManifest()` mirrors `loadQueue()` discipline:

```ts
export function loadManifest(): PortfolioManifestV1 | null {
  const raw = mmkv.getString(MANIFEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 1) {
      logOnce('loadManifest: invalid schemaVersion ' + parsed?.schemaVersion);
      return null;
    }
    return validateManifest(parsed);
  } catch (err) {
    logOnce('loadManifest: parse error ' + String(err));
    return null;
  }
}
```

No silent migration is allowed for business-logic fields such as populated-wallet state, invalid-history state, order, or revisions. Telemetry-only fields may get safe defaults only when explicitly documented.

### Runtime logger contract

```ts
export function logPortfolioRuntimeError(
  err: unknown,
  extra?: {tag?: string; [key: string]: unknown},
): void;
```

The logger never throws, never returns a Promise, always includes `subsystem: 'portfolio-v2'`, and preserves `extra.tag` when provided. It is safe for `.catch(logPortfolioRuntimeError)` and for contextual `.catch(err => logPortfolioRuntimeError(err, {tag}))` call sites.

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

export type PopulateQueuePriority =
  | 'urgentUserVisible'   // send, pull-to-refresh changed-wallet refresh
  | 'normalUserVisible'   // key import, explicit manual refresh
  | 'background';         // initial remainder, app-launch incremental remainder

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};

export type PopulateCheckpoint = Readonly<{
  schemaVersion: 1;
  itemId: string;
  runId: string;
  walletId: string;

  // Staging state that can be resumed or safely discarded without touching
  // committed snapshots from previously completed wallets.
  stagingKeyPrefix: string;
  stagingKeys: readonly string[];
  // `null` means no prior committed snapshot index exists yet, e.g. first-ever
  // populate of this wallet.
  snapshotIndexRevision: number | null;

  // Cursor/page/block/tx state. Shape may be narrowed by the preserved kernel,
  // but persisted checkpoints store only schema-validated JSON. The runtime
  // kernel may carry a richer in-memory cursor shape; checkpoint writes serialize
  // it to JsonValue and checkpoint reads validate it via cursorSchemaVersion
  // before reconstructing runtime cursor state. Do not persist runtime-only
  // objects such as Maps, Sets, class instances, or raw BigInts.
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

export type PopulateQueueItem = Readonly<{
  itemId: string;        // `${runId}:${walletId}`
  runId: string;
  walletId: string;
  reason: PopulateQueueReason;
  priority: PopulateQueuePriority;
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
- appending refresh work: create a new business-event `runId` for that send/pull/app-launch/manual event, assign priority, and insert items by the priority contract below;
- starting a wallet: move the first `pending` item into `active` and persist the queue;
- checkpointing a wallet: update `active.checkpoint` after each durable page/checkpoint step;
- completing a wallet in this run: clear `active`, add `active.itemId` to `completedInRunItemIds`, and update manifest populated state;
- invalid-history skip: clear `active`, update manifest invalid-history state, and add `active.itemId` to `completedInRunItemIds` for this run;
- deletion/reconciliation: prune only deleted/non-livenet wallets. Do not prune hidden livenet wallets.

### Queue dedupe, urgent supersession, and priority insertion

Dedupe is run-scoped. A wallet can be deduped inside one run, but a new business event creates a new `runId` and may enqueue the same wallet again even when valid data already exists in the manifest.

```ts
function hasItemInQueue(queue: PopulateQueueV1, item: PopulateQueueItem): boolean {
  return (
    queue.pending.some(p => p.itemId === item.itemId) ||
    queue.active?.itemId === item.itemId ||
    queue.completedInRunItemIds[item.itemId] === true
  );
}
```

Dedupe is by `itemId` within one run. Supersession is by `walletId` across runs and only fires when an urgent item arrives. They are separate mechanisms.

Never dedupe against `manifest.populatedWalletIds`. Manifest means “valid data exists.” Queue means “work to do now.” A wallet can have valid data and still need new work after a send, receive, pull-to-refresh, app-launch incremental refresh, key import retry, or manual refresh.

Urgent work should supersede stale unstarted work for the same wallet:

- if a new `urgentUserVisible` item arrives for wallet `A`, drop older **unstarted pending** normal/background items for wallet `A`;
- do not drop existing urgent pending items for the same wallet unless they have the same `itemId`;
- do not preempt or delete `active`, even if `active.walletId === A`; if `A` is active from an initial pass and the user sends from `A`, append urgent `A(send)` so it runs immediately after the active pass;
- do not remove completed-in-run records from previous runs; run identity is part of the item.

This enables the important scenario:

```txt
active item: X(initial-1)        // if any; never preempt mid-wallet
initial run pending: B, C, D
initial run already completed: A
user sends from A
append urgent item: {runId: 'send-2', walletId: 'A', priority: 'urgentUserVisible'}
queue pending becomes: A(send-2), B, C, D
```

If `A` was already pending as `A(initial-1)` and the user sends from `A`, the urgent insertion removes that older unstarted `A(initial-1)` item and inserts `A(send-2)` in the urgent lane. This avoids an urgent refresh followed later by a stale older populate of the same wallet.

Priority mapping:

```ts
function priorityForPopulateReason(reason: PopulateQueueReason): PopulateQueuePriority {
  switch (reason) {
    case 'send':
    case 'pullToRefresh':
      return 'urgentUserVisible';
    case 'keyImport':
    case 'manual':
    case 'showPortfolioToggleOn':
      return 'normalUserVisible';
    case 'initial':
    case 'appLaunchIncremental':
    default:
      return 'background';
  }
}
```

Stable insertion rule preserves FIFO within priority classes:

```txt
existing urgent
incoming urgent
existing normal
incoming normal
existing background
incoming background
```

Implementation:

```ts
function supersedeOlderUnstartedSameWalletItems(args: {
  existingPending: readonly PopulateQueueItem[];
  incoming: readonly PopulateQueueItem[];
}): readonly PopulateQueueItem[] {
  const urgentWalletIds = new Set(
    args.incoming
      .filter(i => i.priority === 'urgentUserVisible')
      .map(i => i.walletId),
  );

  if (!urgentWalletIds.size) return args.existingPending;

  return args.existingPending.filter(item => {
    if (!urgentWalletIds.has(item.walletId)) return true;
    if (item.priority === 'urgentUserVisible') return true;
    return false; // drop older normal/background unstarted item for same wallet
  });
}

function insertPendingItemsByPriority(
  existing: readonly PopulateQueueItem[],
  incoming: readonly PopulateQueueItem[],
): readonly PopulateQueueItem[] {
  const prunedExisting = supersedeOlderUnstartedSameWalletItems({
    existingPending: existing,
    incoming,
  });

  const existingUrgent = prunedExisting.filter(i => i.priority === 'urgentUserVisible');
  const existingNormal = prunedExisting.filter(i => i.priority === 'normalUserVisible');
  const existingBackground = prunedExisting.filter(i => i.priority === 'background');

  const incomingUrgent = incoming.filter(i => i.priority === 'urgentUserVisible');
  const incomingNormal = incoming.filter(i => i.priority === 'normalUserVisible');
  const incomingBackground = incoming.filter(i => i.priority === 'background');

  return [
    ...existingUrgent,
    ...incomingUrgent,
    ...existingNormal,
    ...incomingNormal,
    ...existingBackground,
    ...incomingBackground,
  ];
}
```

Load-bearing rule: send and pull-to-refresh changed-wallet items must not sit behind many remaining initial-populate/background wallets. They should run immediately after the current active wallet.

### Append helper

```ts
function appendToQueue(args: {
  walletIds: readonly string[];
  reason: PopulateQueueReason;
  runId?: string;
  priority?: PopulateQueuePriority;
}): void {
  const q = loadQueue() ?? emptyQueue();
  const runId = args.runId ?? createRunId(args.reason);
  const priority = args.priority ?? priorityForPopulateReason(args.reason);
  const now = Date.now();

  const nextItems = args.walletIds.map(walletId => ({
    itemId: `${runId}:${walletId}`,
    runId,
    walletId,
    reason: args.reason,
    priority,
    requestedAtMs: now,
  }));

  const toInsert = nextItems.filter(item => !hasItemInQueue(q, item));
  if (!toInsert.length) return;

  saveQueue({
    ...q,
    pending: insertPendingItemsByPriority(q.pending, toInsert),
    updatedAt: now,
  });
}
```

### Manifest and queue reconciliation

`reconcileManifestAndQueueAgainstPopulateEligible(...)` is the only helper that prunes deleted or non-livenet wallets from manifest and queue state. It is populate-side and therefore uses visibility-ignored eligibility. Hidden livenet wallets must remain in manifest/queue so unhide can use warm data.

```ts
export type ReconcileManifestAndQueueResult = Readonly<{
  manifestChanged: boolean;
  queueChanged: boolean;
  orderChanged: boolean;
  droppedWalletIds: readonly string[];
}>;

export function reconcileManifestAndQueueAgainstPopulateEligible(
  eligibleWalletIds: ReadonlySet<string>,
): ReconcileManifestAndQueueResult {
  if (!canRunPortfolioV2Work()) {
    return {
      manifestChanged: false,
      queueChanged: false,
      orderChanged: false,
      droppedWalletIds: [],
    };
  }

  // Semantics, not full implementation:
  // - prune pending queue items whose walletId is no longer eligible;
  // - prune active only when the caller has already called cancelPopulate() and
  //   awaited waitForPopulateLoopToStop(); callers reconciling while the loop is
  //   running reconcile pending/completed metadata only and leave active for the
  //   loop to observe cancellation or finish naturally;
  // - prune completedInRunItemIds for removed walletIds;
  // - clear stale checkpoints/staging for removed walletIds;
  // - prune manifest populatedWalletIds, invalidHistoryWalletIds, populate order,
  //   and display-order indexes whose asset group has no surviving eligible wallet;
  // - bump manifest.orderRevision iff canonical order changes;
  // - never prune hidden livenet wallets, because visibility is not part of
  //   populate eligibility.
}
```

`onWalletsDeleted(...)` calls this helper after `cancelPopulate()` and `waitForPopulateLoopToStop()`. Normal populate kick paths may also call it before appending work. Recompute/display eligibility remains separate and visibility-respecting.

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

Checkpoint validity is concrete. A checkpoint is valid only when all of the following hold:

- `checkpoint.schemaVersion` matches the current checkpoint schema;
- `checkpoint.walletId` matches the queue item wallet ID;
- `checkpoint.runId` / `itemId` matches the queue item, or the checkpoint is explicitly marked compatible with resumed work;
- every referenced staging key exists in MMKV;
- `checkpoint.snapshotIndexRevision` is not newer than the snapshot/index revision it claims to extend;
- cursor, page, block-height, and tx-position state are internally consistent;
- persisted `cursor` is JSON-serializable, matches `cursorSchemaVersion`, validates against the populate kernel's cursor schema, and contains no runtime-only objects (`Map`, `Set`, class instances, raw `BigInt`, functions, or host objects);
- ingest config and page-size assumptions are compatible with the current queue item;
- the checkpoint was not written under a different wallet/key/account identity;
- the checkpoint is not marked failed, closed, corrupt, or invalid-history-blocked.

If any validity check fails, clear only the incomplete staging data for that wallet, leave committed snapshots for previously completed work alone, and restart that wallet from the last committed safe point using the normal reorg-safe rewind.

This makes app-kill recovery deterministic: completed work stays published; the interrupted wallet is retried first; pending work continues afterward.

New checkpoints write `failed: false`, `closed: false`, `corrupt: false`, and `invalidHistoryBlocked: false` explicitly. Optional booleans are forbidden because a three-state persisted failure marker would make resume behavior ambiguous.

### Refresh priority contract

Do not let user-visible refresh work sit behind a long first-populate tail. `send` and pull-to-refresh changed-wallet items are `urgentUserVisible`; they join the urgent lane immediately after any active wallet completes, preserve FIFO within urgent work, and supersede older unstarted same-wallet normal/background work. Background initial/app-launch work remains behind urgent items.

---

### Populate kick API contracts

```ts
export function startPopulate(args: {
  reason: PopulateQueueReason;
  isFirstPopulate: boolean;
  walletIds?: readonly string[];
  priority?: PopulateQueuePriority;
}): void;
```

`startPopulate` guards first, reconciles manifest/queue against `getPopulateEligibleWalletIdSetFromStore()`, builds a fresh queue when `isFirstPopulate` is true, otherwise appends the supplied run-scoped work, saves manifest/order, clears `populateCancelFlag` immediately before kick, and starts `runPopulate` through the populate runtime. It never reads visibility-respecting wallet sets for populate construction.

```ts
export function resetSharedPortfolioStateForDebugClear(): void {
  sharedPortfolioState.value = EMPTY_PORTFOLIO_STATE;
  populateProgressTick.value = 0;
  populateRetryTick.value = 0;
}

export function getSeriesIdlePoint(series: Series): Point | undefined {
  return series.points[series.points.length - 1];
}
```

`getSeriesIdlePoint(series)` is the named UI contract for idle balance/PnL display. Screens must not fork idle logic; idle reads the final emitted chart point.

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

function computeInitialScopeReadiness(args: {
  scopeWalletIds: readonly string[];
  manifest: PortfolioManifestV1;
  previous?: ScopeReadiness;
  refreshing: boolean;

  // Set by recompute after it actually materializes a non-empty valid Series for
  // this scope in the current publish pass. Metadata readiness alone must not
  // flip hasEverPublishedValidSeries.
  hasPublishedValidSeriesThisPass: boolean;
}): ScopeReadiness {
  const {
    scopeWalletIds,
    manifest,
    previous,
    refreshing,
    hasPublishedValidSeriesThisPass,
  } = args;

  if (scopeWalletIds.length === 0) {
    return {
      empty: true,
      initialScopeReady: false,
      invalidHistoryBlocked: false,
      hasEverPublishedValidSeries: false,
      refreshing,
    };
  }

  const initialScopeReady = scopeWalletIds.every(id =>
    isWalletUsableForInitialChart(id, manifest),
  );

  const invalidHistoryBlocked = scopeWalletIds.every(id =>
    manifest.invalidHistoryWalletIds.includes(id),
  );

  const hasEverPublishedValidSeries =
    previous?.hasEverPublishedValidSeries === true ||
    hasPublishedValidSeriesThisPass === true;

  return {
    empty: false,
    initialScopeReady,
    invalidHistoryBlocked,
    hasEverPublishedValidSeries,
    refreshing,
  };
}
```

An empty scope is not a ready chart. It means the route has no visible wallets after livenet/deleted/visibility filtering. The UI should render the product’s empty/no-portfolio state and should not mount an empty chart. Empty scope resets `hasEverPublishedValidSeries` because the wallet set is effectively a different empty scope; when it becomes non-empty again, the next recompute must publish a valid series before the bit flips true. `hasEverPublishedValidSeries` flips true only when recompute actually publishes a non-empty valid `Series` for that scope and then persists across later incremental refreshes; `refreshing` is set while populate, rate refresh, or recompute work intersects that scope and clears when the publish lands.

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

For a **single-rate-source asset or asset group**, if no balance-change events occur in the selected window:

```ts
pnlPercent === ((rateEnd - rateStart) / rateStart) * 100
```

within numeric tolerance, because the only change is mark-rate movement over the same interval window used by Exchange Rate charts.

For a **collapsed multi-chain / multi-rate-source asset group** such as `usdc` across Ethereum, Polygon, and Solana, the aggregate no-transaction PnL percent is not necessarily equal to one arbitrary USDC deployment’s market rate. The parity target is a runtime-published, scope-specific weighted group exchange-rate series.

The weighted group series is a **baseline-unit weighted market index**, not a transaction-path-dependent PnL series:

```ts
// For each constituent rate source i in the visible portfolio scope:
unitsAtT0_i = holdings in display units at the interval baseline t0;
rate_i(t) = constituent rate at timestamp t in the displayed quote;

groupIndex(t) = sum(unitsAtT0_i * rate_i(t));
baselineUnits = sum(unitsAtT0_i);

weightedRate(t) = baselineUnits > 0
  ? groupIndex(t) / baselineUnits
  : undefined;

weightedPercent(t) = groupIndex(t0) > 0
  ? ((groupIndex(t) - groupIndex(t0)) / groupIndex(t0)) * 100
  : undefined;
```

`weightedRate(t)` is the UX-displayable y-axis value for a portfolio-entered collapsed Exchange Rate chart. `weightedPercent(t)` is the no-transaction parity oracle. `groupIndex(t)` is internal and should not be shown as the chart rate. Use display-unit-normalized units, not atomic units, before summing. Zero-unit members contribute zero weight.

The contract is therefore:

```txt
single rate source:
  portfolio no-tx pnlPercent === ordinary Exchange Rate percent

collapsed multi-rate-source asset group:
  portfolio no-tx pnlPercent === runtime-published weightedGroupRateSeries.weightedPercent
```

When transactions exist inside the selected window, the weighted group exchange-rate series remains a market/index comparison only. Portfolio PnL still comes from the canonical cost-basis formula above. Do not use weighted group exchange-rate math as a shortcut for PnL when transactions exist.

If `baselineUnits === 0` or `groupIndex(t0) <= 0`, the **interval** is unavailable, not the route. Publish `unavailableReason: 'zeroBaseline'`, `points: []`, and a fingerprint that includes the unavailable reason and empty point set. The portfolio-entered weighted Exchange Rate screen should render an interval-local empty state such as “Not available for this interval; no holdings at the start of the window.” Timeframe switching may reveal another interval with a valid baseline. The screen may offer a separate “View market rate” action to a normal single-source market route, but it must not silently substitute a representative constituent series.

If any required constituent rate is missing for a visible nonzero baseline member, publish `unavailableReason: 'missingConstituentRate'`, `points: []`, and render the same interval-local unavailable state with copy appropriate to missing rate data. Do not publish partial weighted group charts.

Build the weighted series only for collapsed groups with more than one distinct `FiatRateAssetRef`. Single-source groups reuse the ordinary market rate series and ordinary Exchange Rate route; they do not publish `weightedGroupRateSeries`. Weighted group series are derived render state; do not persist them in MMKV. Their fingerprint is a full-point hash over every emitted `weightedRate` and `weightedPercent` point, not an endpoint-only hash.

Weighted fingerprints must also hash the index identity: quote, `assetGroupId`, `walletIdsKey`, interval/window, `unavailableReason`, sorted `memberRateSourceKeys`, and `baselineUnitsByRateSourceKey` in the same key order. Two weighted indexes with the same final chart endpoints but different constituent weights are still different derived indexes and must not share a fingerprint.

### Portfolio-entered Exchange Rate route

Navigation must distinguish standalone market rates from portfolio-weighted collapsed asset groups:

```ts
type ExchangeRateRoute =
  | {
      kind: 'marketAsset';
      fiatRateAssetRef: FiatRateAssetRef;
    }
  | {
      kind: 'portfolioWeightedAssetGroup';
      assetGroupId: string;
      walletIdsKey: string;
      scope: PortfolioRouteScope;
    };
```

`ExchangeRateRoute` is owned by `src/portfolio/v2/routes/exchangeRateRoute.ts`. Only portfolio-owned row/detail navigation code may construct `kind: 'portfolioWeightedAssetGroup'`; standalone Exchange Rates and single-source portfolio rows construct `kind: 'marketAsset'`. A portfolio row tap for a collapsed multi-rate-source asset group uses `kind: 'portfolioWeightedAssetGroup'`. A standalone Exchange Rates screen uses `kind: 'marketAsset'`. This is load-bearing: opening one arbitrary token deployment from a collapsed `usdc` portfolio row would silently break the row/detail/exchange-rate parity mental model. UI labels should make this clear, for example “Portfolio-weighted USDC rate” when multiple rate sources are present.

Pinned weighted-group fixture:

```txt
Window t0 → t1. Holdings at t0:
  ETH-USDC: 100 units, rate t0 = 1.0000, rate t1 = 1.0020
  POL-USDC: 40 units,  rate t0 = 1.0050, rate t1 = 1.0060
  SOL-USDC: 40 units,  rate t0 = 1.0048, rate t1 = 1.0038

groupIndex(t0) = 100*1.0000 + 40*1.0050 + 40*1.0048 = 180.392
groupIndex(t1) = 100*1.0020 + 40*1.0060 + 40*1.0038 = 180.592
weightedRate(t1) = 180.592 / 180 = 1.0032888888888889
weightedPercent(t1) = (180.592 - 180.392) / 180.392 * 100 ≈ 0.1108696616%
```

Pin `weightedRate` within `1e-12` and `weightedPercent` within `1e-10` in tests. This catches single-token fallback, wrong weighting, missing constituent rates, and incorrect quote-bridge handling.

### Transfer model

Do not match or net owned-wallet transfers. Display PnL is wallet-local:

- source wallet outflow disposes basis pro rata;
- destination wallet inflow adds basis at the destination event spot rate;
- cross-chain asset-group moves still price each side through its own asset/rate source.

Pinned same-user transfer fixture:

```txt
Window baseline t0:
  A holds 100 USDC, B holds 0 USDC
  baseline USDC rate = $1.00
  A remainingCostBasisFiat = $100.00
  B remainingCostBasisFiat = $0.00

Same-chain event at τ:
  A sends 40 USDC to B
  destination spot rate = $1.005

Expected end state:
  A units = 60, A basis = $100.00 * (60 / 100) = $60.00
  B units = 40, B basis = 40 * $1.005 = $40.20
  collapsed usdc aggregate basis = $100.20
```

An implementation that nets owned-wallet transfers as a no-op produces `$100.00` and must fail the test.

Cross-chain variant:

```txt
A is ETH-side USDC, B is Polygon-side USDC
ETH-side baseline rate at t0 = $1.00
Polygon receive spot at τ = $1.0048
A basis after disposal = $60.00
B basis after receive = 40 * $1.0048 = $40.192
collapsed usdc aggregate basis = $100.192
```

This pins the rule that ticker collapse does not erase per-chain/per-token rate sourcing at event timestamps.

### Row and asset-summary formulas

Row values are endpoint extractions from the same scoped series used by Asset Detail, not a second business-logic path.

```ts
assetSummary.pnlChange = pnlEnd - pnlStart;

assetSummary.pnlPercent = remainingCostBasisFiatEnd > 0
  ? (pnlEnd / remainingCostBasisFiatEnd) * 100
  : 0;

collapsedRow.pnlChange = sum(memberAssetSummaries.map(s => s.pnlChange));

collapsedRow.pnlPercent = sumRemainingCostBasisFiatEnd > 0
  ? (sumPnlEnd / sumRemainingCostBasisFiatEnd) * 100
  : 0;

rowToday = endpointExtraction(assetGroupSeries['1D']);
rowAllTime = endpointExtraction(assetGroupSeries['ALL']);
```

`RowPayload.rateStart`, `rateEnd`, and `ratePercent` come from the ordinary market rate series for single-rate-source groups and from the weighted group rate series for collapsed multi-rate-source groups. This is why row Today equals Asset Detail `1D` final point and row All Time equals Asset Detail `ALL` final point for the same wallet scope and quote.

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

v23 fixes the canonical quote to `USD`:

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

Weighted group exchange-rate series follow the same rule. For quote switches, bridge every constituent rate at every timestamp first, then rebuild the weighted series:

```ts
rate_i(t, targetQuote) =
  rate_i(t, 'USD') * btcRate(t, targetQuote) / btcRate(t, 'USD');

groupIndex(t, targetQuote) = sum(unitsAtT0_i * rate_i(t, targetQuote));

if (baselineUnits <= 0 || groupIndex(t0, targetQuote) <= 0) {
  unavailableReason = 'zeroBaseline';
  points = [];
} else if (missingRequiredConstituentRate) {
  unavailableReason = 'missingConstituentRate';
  points = [];
} else {
  weightedRate(t, targetQuote) = groupIndex(t, targetQuote) / baselineUnits;
  weightedPercent(t, targetQuote) =
    (groupIndex(t, targetQuote) - groupIndex(t0, targetQuote)) / groupIndex(t0, targetQuote) * 100;
}
```

Unavailability is interval-local. A quote switch may leave `1D` unavailable while `1W` / `1M` / `ALL` remain available, or vice versa, depending on baseline holdings and constituent rate availability. Do not compute a USD weighted group series and then multiply it by one scalar. Do not bridge portfolio PnL while leaving `WeightedGroupRateSeries`, `RowPayload.rateStart`, `RowPayload.rateEnd`, or `RowPayload.ratePercent` in USD. Row rate fields must be recomputed from the same bridged constituent rates as the weighted group series.


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

Default v23 wipe prefixes:

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

### MMKV registry discipline

All portfolio v2 MMKV access uses the dedicated portfolio storage instance returned by `getPortfolioMmkvStorageOnRN()`. All writes and deletes go through `getPortfolioKvStore()` / `kvStore.delete(key)` so the registry-backed key tracker remains consistent.

Wipe implementation contract:

```txt
1. enumerate real keys from getPortfolioMmkvStorageOnRN().getAllKeys();
2. filter portfolio-owned prefixes;
3. exclude PORTFOLIO_V2_FLAG_KEY and PORTFOLIO_CACHE_INVALID_KEY;
4. delete through kvStore.delete(key), not raw MMKV.delete(key);
5. assert both storage.getAllKeys() and kvStore.listKeys() are clean after successful wipe.
```

Do not use `kvStore.listKeys()` as the wipe source of truth because a stale registry could miss real MMKV keys. Do not call raw `MMKV.delete` from v2 reset/delete paths because it can leave the registry reporting deleted keys.

### Manifest schema validation

`loadManifest()` follows the same schema discipline as `loadQueue()`:

```ts
function loadManifest(): PortfolioManifestV1 | null {
  const raw = mmkv.getString(MANIFEST_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 1) {
      logOnce('loadManifest: invalid schemaVersion ' + parsed?.schemaVersion);
      return null;
    }
    return validateManifest(parsed);
  } catch (err) {
    logOnce('loadManifest: parse/validation error ' + String(err));
    return null;
  }
}
```

No silent migration of business-logic fields is allowed. Safe defaults are allowed only for telemetry-only fields. Readiness, ordering, populated-wallet semantics, invalid-history semantics, and canonical quote fields require schema validation or a schema bump.

### Runtime error logger

```ts
export function logPortfolioRuntimeError(
  err: unknown,
  extra?: {tag?: string; [key: string]: unknown},
): void;
```

Contract: never throws, never returns a Promise, always tags `subsystem: 'portfolio-v2'`, includes `extra.tag` when present, and is safe for `.catch(logPortfolioRuntimeError)`.

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

Wait timeouts are part of the contract: `waitForPopulateLoopToStop()` defaults to 60s, `waitForRecomputeDrainToStop()` to 30s, and `waitForEnsureFreshToStop()` to 20s. If anything throws before `markPortfolioCacheInvalid`, rethrow and leave `portfolioCacheInvalid = false`. If anything throws after `markPortfolioCacheInvalid`, rethrow and leave `portfolioCacheInvalid = true`; ordinary work remains blocked until a later successful reset/repair clears the bit.

Post-auth startup must check the durable invalid bit. If it is set, run `performResetSequence()` as a repair before any ordinary populate/recompute/rate work. If repair fails, do not resume ordinary work.

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
- builds weighted group exchange-rate series for collapsed visible asset groups with more than one distinct `FiatRateAssetRef`; single-source groups reference the ordinary market rate series;
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

### Scoped cache cap and eviction

```ts
export const MAX_SCOPED_CACHE_ENTRIES = 8;
```

`scopedByWalletSet` is a bounded LRU cache, not an unbounded map.

Eviction policy:

1. Each scoped-cache hit or touch updates `lastAccessedAt` for that `walletIdsKey` through a touch recompute or the next scoped rebuild.
2. The currently requested/mounted `walletIdsKey` is protected from eviction during the recompute that requested it.
3. Delete-triggered recompute first drops entries whose `walletIds` intersect `evictScopedWalletIds`.
4. Full recompute refreshes currently cached scoped entries using the same loaded input set, then evicts down to the cap.
5. Wallet/wallets recompute refreshes intersecting scoped entries, then evicts down to the cap.
6. Eviction chooses least-recently-accessed entries after refresh, never the protected key. If protected entries alone exceed the cap, the cap is soft and the result may temporarily exceed eight.

The ordering is load-bearing: **refresh before eviction** prevents the actively viewed scoped screen from disappearing or staying stale during a full recompute. Delete pruning happens before refresh because entries containing deleted wallets are invalid and must not be rebuilt.

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
export type PortfolioSliceComparatorKind =
  | 'objectIs'
  | 'seriesFingerprint'
  | 'rowFingerprint'
  | 'rowShellScalar'
  | 'shallowScalar';

export function usePortfolioSlice<T>(
  selector: WorkletPortfolioSelector<T>,
  comparator: PortfolioSliceComparatorKind = 'objectIs',
): T | undefined {
  const [slice, setSlice] = useState<T | undefined>(undefined);

  useAnimatedReaction(
    () => selector(sharedPortfolioState.value),
    (next, prev) => {
      const areEqual = getNamedWorkletComparator(comparator);
      if (prev === null || !areEqual(next, prev)) {
        runOnJS(setSlice)(next);
      }
    },
    [selector, comparator],
  );

  return slice;
}
```

Selector rules:

- selector must be worklet-compatible;
- comparator must be one of the named worklet comparators, or a typed façade-owned comparator proven worklet-safe in tests;
- selector and comparator identities must be stable, usually via typed hook façades or primitive deps only;
- selector/comparator may close only over primitives, frozen/shareable values, or other worklet-safe constants;
- selector/comparator must not close over React props objects, Redux objects, class instances, `Map`, `Set`, formatters, non-worklet functions, mutable arrays, or navigation objects;
- equality must use a named worklet comparator selected by `PortfolioSliceComparatorKind`; arbitrary JS comparator closures are not accepted in normal UI code;
- if a custom comparator is ever added for a debug-only path, it must obey the same worklet-safety and closure rules as selectors;
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

1. Force `ensureFresh` via `buildEnsureFreshArgsForVisibleAssetGroups(...)`, which always unions canonical `BTC/USD`.
2. Requeue changed livenet wallets, including already-populated wallets.
3. Schedule recompute for affected wallet set or full scope.

### Quote currency changed

1. Ensure BTC bridge rates for target quote.
2. Run `recomputeQuoteBridgeFromExistingData` on compute runtime.
3. Do not fetch per-asset target-quote rates.
4. Do not touch populate queue.

### Live rates updated

1. Guard before side effects.
2. If Show Portfolio is off, return.
3. Run `ensureFresh` via `buildEnsureFreshArgsForVisibleAssetGroups(...)`, which always unions canonical `BTC/USD`.
4. Guard again after `ensureFresh`.
5. Build fire-time recompute inputs and `scheduleRecompute({scope: 'full'})`.

Live-rate events are freshness signals, so this trigger is ensureFresh-first. Do not warm-publish stale data first for this trigger.

### Key imported

If Show Portfolio is enabled, requeue all livenet wallets in the imported key. Hidden wallets are included because populate is visibility-ignored.

### Wallets/key/account visibility changed

1. If unhidden livenet wallets were imported during a blocked window and are neither manifest-populated nor actively invalid-history-blocked, enqueue them.
2. If a wallet has an active invalid-history marker, do not enqueue it on unhide. If the marker has expired, enqueue the wallet so the populate loop can retry. The visibility trigger may read the marker to avoid burning queue items for still-active cooldowns, but it must not clear invalid-history manifest state itself.
3. Schedule a full recompute using visibility-respecting eligible wallets.
4. Do not delete snapshots.

Invalid-history writes are centralized in the populate/reconcile path. On retry, `runPopulate` rechecks the persisted marker at item start. If the marker is expired, the wallet proceeds through normal populate; successful `markManifestPopulated(walletId)` removes the wallet from `invalidHistoryWalletIds` and clears the stale marker as part of the normal success path. Do not add a separate "clear invalid-history on retry attempt" write path.

### Wallets/key deleted

Deletion restores the v18 triple-guard contract because this path races with reset, populate, and shared-state publishing. The first executable statement must be the guard.

```ts
export async function onWalletsDeleted(args: {walletIds: readonly string[]}): Promise<void> {
  if (!canRunPortfolioV2Work()) return; // GUARD #1, before arg normalization

  const walletIds = unique(args.walletIds);
  if (!walletIds.length) return;

  cancelPopulate();
  await waitForPopulateLoopToStop();

  if (!canRunPortfolioV2Work()) return; // GUARD #2, after quiescing populate

  reconcileManifestAndQueueAgainstPopulateEligible(
    getPopulateEligibleWalletIdSetFromStore(),
  );

  await Promise.all(walletIds.map(id => snapshotStore.clearWallet(id)));

  if (!canRunPortfolioV2Work()) return; // GUARD #3, after async deletes

  if (!getShowPortfolioEnabledFromStore()) return;

  const base = buildBaseRecomputeInputsAtFireTime();
  scheduleRecompute({
    ...base,
    scope: 'full',
    evictScopedWalletIds: walletIds,
  });

  kickPopulateLoopIfIdle();
}
```

`kickPopulateLoopIfIdle()` resumes the already-reconciled queue without appending replacement items:

```ts
export function kickPopulateLoopIfIdle(): void {
  if (!canRunPortfolioV2Work()) return;

  const queue = loadQueue();
  if (!queue?.pending.length && !queue?.active) return;
  if (populateLoopRunning.value) return;

  populateCancelFlag.value = false;
  const ctx = buildPopulateRuntimeContextFromStore();
  runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
    .catch(err => logPortfolioRuntimeError(err, {tag: 'kickPopulateLoopIfIdle'}));
}
```

Do not call `populateWallets(loadQueue().pending.map(...))` here. `populateWallets` appends new run-scoped items; using it for survivors can duplicate pending work, lose original priorities/checkpoints, and rewrite reasons/runIds.

The JS-side `populateLoopRunning.value` check is only an optimization to avoid unnecessary dispatch. SharedValue reads from JS can lag; the authoritative single-flight guard lives inside `runPopulate()` on the populate runtime. A redundant kick must be harmless because the worklet-side guard exits.

Deletion rules:

- use visibility-ignored populate eligibility when reconciling manifest/queue so hidden livenet wallets are not pruned;
- clear deleted wallets’ `snap:*` data through snapshot-store APIs, not raw MMKV loops;
- do not clear shared `rate:v1:*` keys because they are market-rate cache entries still valid for surviving wallets and Exchange Rate surfaces;
- do not write `sharedPortfolioState` directly from the trigger; recompute and scoped-cache eviction must flow through the scheduler/compute runtime;
- `evictScopedWalletIds` is the only trigger-to-compute channel for scoped cache deletion;
- if reset/cache-invalid flips during either await, the later guard returns before any new work is scheduled.

The snapshot clear is delete-only and idempotent. It does not need to join the reset wait-set because a concurrent full wipe deletes a superset of the same keys and the durable cache-invalid bit blocks ordinary work until repair succeeds. The third guard prevents any post-clear recompute/populate kick from racing with reset.

### Per-trigger ordering table

Each trigger has a distinct product intent. Do not “consistency-ize” these into one generic ordering rule.

| Trigger | Order | Why |
|---|---|---|
| `onAppLaunchPostAuth` | repair invalid bit if needed → warm publish from persisted data → await recompute drain → resume populate → background freshen → follow-up recompute | Completed PnL should appear immediately after auth without waiting on network. |
| `onPullToRefresh` | `ensureFresh(force: true)` → urgent `populateWallets(changedWalletIds)` → `scheduleRecompute` | User explicitly asked for fresh rates/snapshots. |
| `onSendCompleted` | urgent `populateWallet(walletId, reason: 'send')` | Sent-from wallet should refresh promptly; recompute publishes from progress tick. |
| `onQuoteCurrencyChanged` | `ensureQuoteCurrencyFxBridge` → `recomputeQuoteBridgeFromExistingData` | Bridge data must exist before target-quote publish. No per-asset target-quote fetch. |
| `onLiveRatesUpdated` | `ensureFresh` → `scheduleRecompute` | The live-rate event is a freshness signal. |
| `onKeyImported` | `populateWallets(livenetWalletIds, reason: 'keyImport')` | New livenet wallets need snapshots before PnL exists. |
| `onWalletsDeleted` | guard → cancel/wait populate → guard → reconcile → clear snapshots → guard → full recompute with `evictScopedWalletIds` → `kickPopulateLoopIfIdle()` | Prevents populate/write races and stale scoped entries. |
| `onWalletsVisibilityChanged` | optional populate for newly visible never-populated wallets → full recompute | Visibility changes display eligibility, not snapshot persistence. |
| `onShowPortfolioVisibilityChanged(false)` | latch wipe obligation → `performResetSequence` | OFF means clear portfolio data and hide portfolio surfaces. |
| `onShowPortfolioVisibilityChanged(true)` | discharge latched wipe → repair invalid bit if needed → start fresh populate | ON must never populate from stale pre-wipe data. |

Default for future freshness triggers: `ensureFresh` first, then publish. Use warm-publish-first only when product explicitly requires “show what we already have before network.”

### Show Portfolio rapid-toggle state machine

Show Portfolio visibility uses serialized last-toggle-wins state with a latched wipe obligation.

Invariant:

```txt
An OFF-created wipe obligation must complete before any later ON may start populate,
even if the OFF event is no longer the final visible setting.
```

Contract:

```ts
let visibilityToggleEpoch = 0;
let visibilityWipeRequired = false;
let visibilityToggleSerial: Promise<void> = Promise.resolve();

function onShowPortfolioVisibilityChanged(enabled: boolean): void {
  const epoch = ++visibilityToggleEpoch;

  if (!enabled) {
    visibilityWipeRequired = true;
  }

  visibilityToggleSerial = visibilityToggleSerial.then(async () => {
    if (!enabled) {
      await performResetSequence();
      visibilityWipeRequired = false;
      return;
    }

    if (visibilityWipeRequired) {
      await performResetSequence();
      visibilityWipeRequired = false;
    }

    if (isPortfolioCacheInvalid()) {
      await performResetSequence();
    }

    if (epoch !== visibilityToggleEpoch) return;
    if (!getShowPortfolioEnabledFromStore()) return;
    if (!canRunPortfolioV2Work()) return;

    startPopulate({reason: 'showPortfolioToggleOn', isFirstPopulate: true});
  }).catch(err => logPortfolioRuntimeError(err, {tag: 'showPortfolioToggle'}));
}
```

Additional invariants:

- `visibilityWipeRequired` is cleared only after `performResetSequence()` succeeds;
- if reset throws, the wipe obligation remains latched and the next ON attempt must retry/await reset before populate;
- no populate may start while `visibilityWipeRequired`, `populateResetInFlight`, or `portfolioCacheInvalid` is true;
- stale toggle completions re-check `epoch`, the current Redux setting, and `canRunPortfolioV2Work()` before side effects.

Off behavior:

1. UI hides portfolio-owned surfaces immediately via setting gate.
2. Latch `visibilityWipeRequired = true`.
3. Run or join `performResetSequence`.
4. Leave Exchange Rate surfaces mounted and market-rate cache intact by default.

On behavior:

1. Discharge any pending OFF-created wipe obligation before populate.
2. Repair cache invalid bit if latched.
3. Re-check epoch and final persisted setting.
4. Start fresh initial populate from empty manifest/queue.

---

## 14. UI migration contracts

### Row/list surfaces

Rows render from row shells. The row shell exists before PnL is ready. The runtime publishes raw aggregate values; the UI formats and masks them.

- `currentCryptoAmount` and `currentFiatValue` come from the runtime shell; UI must not sum `memberWalletIds` to derive row amounts.
- `currentFiatValue` is computed by summing each visible nonzero member wallet at that wallet's own `FiatRateAssetRef` / live-rate key; a collapsed ticker group uses a single group rate only when all nonzero members share the same rate source. If any visible nonzero member lacks a live rate, runtime publishes `currentFiatValue: undefined`; zero-unit members with missing rates do not block the aggregate; visible members with all current units equal to zero publish `currentFiatValue: 0`.
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
- Confirm whether `rate:v1:*` is shared with Exchange Rate screens. v23 default is not to wipe it.

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
- Make `buildEnsureFreshArgsForVisibleAssetGroups(...)` always union canonical `BTC/USD` dependencies for `1D`, `1W`, `1M`, and `ALL`.
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
- Implement quote-bridge reprice from snapshots/rates using per-timestamp formula, including rebuild of `WeightedGroupRateSeries` and row rate fields from bridged constituent rates.

Acceptance:

- Product-oracle PnL fixtures pass.
- No-transaction PnL percent equals the ordinary Exchange Rate percent for single-rate-source assets and equals the baseline-unit weighted group exchange-rate percent for collapsed multi-rate-source asset groups, including the pinned `180.392 → 180.592 → 0.1108696616%` fixture (`weightedRate` tolerance `1e-12`; `weightedPercent` tolerance `1e-10`).
- Row/detail equality passes globally and key-scoped.
- Quote-switch in-window transaction fixture matches from-scratch bridged recompute.
- Mid-series mutation changes fingerprint and re-renders chart.
- Scoped cache cap/LRU tests pass, including refresh-before-eviction and protected current-scope behavior.

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
- Implement queue priority insertion for urgent send/pull refresh work.
- Implement active-item resume normalization and checkpoint/restart behavior.
- Implement visibility-ignored populate eligibility.
- Implement one-wallet-at-a-time populate loop using existing kernels.
- Preserve signing context installation around the same kernel calls as v1.
- Preserve invalid-history quarantine behavior.
- Preserve incremental reorg-safe tail rewind/overwrite behavior.
- Update manifest after wallet success or invalid-history skip.
- Emit progress ticks after success or skip.

Acceptance:

- Already-populated wallet can be requeued after send/pull/app-launch refresh, and send/pull changed-wallet items are inserted as urgent next-pending work after the active item, not behind background first-populate tails.
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
- Show Portfolio rapid toggle serializes, final state wins, and an OFF-created wipe obligation completes before any ON starts populate.

### Phase 7 — UI migration

- Migrate Home portfolio balance/chart and asset list.
- Migrate All Assets and Allocation.
- Migrate WalletDetails, AccountDetails, KeyOverview.
- Migrate AssetBalanceHistoryScreen, scoped asset detail, and portfolio-entered Exchange Rate routing via `ExchangeRateRoute` (`marketAsset` vs `portfolioWeightedAssetGroup`).
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
14. Send and pull-to-refresh changed-wallet items are `urgentUserVisible` and are inserted ahead of existing pending background work so they run immediately after the active wallet finishes.
15. Queue priority does not preempt an already active wallet mid-page; it only controls pending order.
16. Deleted wallets are pruned from manifest and queue.
17. Hidden livenet wallets remain populate-eligible; testnet/regtest wallets never enter queue.

### Display order and visibility

18. Populate order includes hidden livenet wallets.
19. Home display order excludes hidden wallets.
20. Key/account scoped display order excludes hidden wallets inside that scope.
21. Allocation order equals All Assets order for the same scope.
22. Mid-populate Today/All Time toggle does not change row order.

### First-populate readiness

23. Home chart hidden until every visible Home-scope wallet is populated or invalid-history blocked.
24. WalletDetails chart appears as soon as that wallet is populated.
25. Asset Detail chart appears only after every visible wallet in that asset group/scope is populated or invalid-history blocked.
26. KeyOverview chart appears only after every visible wallet in that key scope is populated or invalid-history blocked.
27. Incremental refresh keeps stale chart visible if the scope has previously published valid series.
28. Empty Home/key/account/asset scopes publish `empty: true`, `initialScopeReady: false`, and render empty/no-chart state rather than a ready empty chart.

### PnL and rates

29. First chart point `pnlChange === 0` exactly.
30. Final chart point equals idle header/PnL numbers.
31. Every Point includes `remainingUnrealizedPnlFiat` and scrub UI reads it directly.
32. Single-rate-source no-transaction PnL percent equals the ordinary Exchange Rate percent for each interval.
33. Collapsed multi-rate-source asset groups expose a weighted group exchange-rate series when the interval has a valid baseline, and no-transaction PnL percent equals that weighted group percent. Zero-baseline or missing-constituent-rate intervals publish interval-local unavailability instead of falling back to a representative market route.
34. Buy/sell/partial disposal/zero-balance fixtures match product formula.
35. Same-user transfer fixture proves transfers are not netted and pins `aggregateRemainingCostBasisFiatEnd === 100.20` for same-chain USDC.
36. Cross-chain same-ticker transfer fixture uses per-chain rates and pins `aggregateRemainingCostBasisFiatEnd === 100.192`.
37. Chart output capped to `<= 89` points.
38. Transaction between emitted chart samples affects later emitted PnL.
39. Full-point fingerprint changes when a middle point changes while endpoints stay the same.

### Quote switch and V4 rates

40. `BTC/USD` canonical rates are ensured even with no BTC wallet.
41. Quote switch to EUR fetches only `BTC/EUR` stored intervals.
42. Quote switch to USD performs no target BTC fetch.
43. In-window transaction quote-bridge reprice matches from-scratch bridged recompute.
44. Multi-hop USD → EUR → GBP still bridges from canonical USD, not display EUR.
45. Quote switch during populate does not touch queue and publishes bridged current data.
46. V4 rate fetch uses one native batched request and token-specific requests per token tuple; ETH token addresses are lowercased, SOL/Solana token addresses are case-preserved.
47. Classifier aliases `wbtc -> btc`, `weth -> eth`, `matic -> pol`, and reclassifies legacy ETH-side MATIC/POL token address to native `pol`.
48. Token response extraction handles exact/lower/upper keyed matches and single-key token fallback.
49. `3M`, `1Y`, and `5Y` never produce separate rate URLs or MMKV keys; they resolve to `ALL`.

### Hooks, selectors, scoped cache, and UI

50. `usePortfolioSlice` passes only selected slice to React, not full `PortfolioState`.
51. `usePortfolioSlice` selectors and equality handling are worklet-compatible/stable; typed hooks use named comparators, and tests reject non-worklet objects, Redux objects, formatters, maps/sets, mutable props, or arbitrary JS comparator closures.
52. Scoped selectors do not aggregate wallets or walk points in JS.
53. Scoped row shells publish before scoped PnL is ready, include only visible wallets for that scoped route, compute `currentFiatValue` from per-member rate sources, and update `walletIdsKey` after visibility changes.
54. Row shell `currentFiatValue` is computed by summing each visible nonzero member wallet through its own `FiatRateAssetRef` / live-rate key, not one coarse group rate unless all nonzero members share the same source; missing rate for a nonzero member yields `undefined`, missing rate for a zero-unit member does not block the aggregate, and visible members with all current units equal to zero publish `currentFiatValue: 0`.
55. UI never aggregates row amounts or PnL through `memberWalletIds`; instrumentation fails if row components sum wallets or walk points.
56. Scoped cache honors `MAX_SCOPED_CACHE_ENTRIES = 8`, LRU/touch updates, refresh-before-eviction, delete-first pruning, and protected-current-scope behavior.
57. Timeframe switches cause zero fetch/populate/snapshot/recompute side effects.
58. Chart scrubbing causes zero fetch/populate/snapshot/recompute/MMKV side effects.
59. Scrub timestamp formatting matches interval rules.
60. Scrub survives mid-publish by timestamp or falls back to idle.
61. Hide Crypto Balances causes zero v2 runtime/MMKV/shared-state writes.
62. No maximum-update-depth errors during rapid timeframe toggles or scrubbing.

### Lifecycle

63. Post-auth warm publish lands before populate kick and before network freshen resolves.
64. Send-triggered refresh propagates to Home, All Assets, Asset Detail, WalletDetails, KeyOverview, and scoped rows.
65. Pull-to-refresh rate change propagates to all affected screens.
66. Key import populates only livenet wallets.
67. Key delete clears wallet snapshots and updates all affected screens.
68. Hide/unhide preserves snapshots and updates visible totals/charts.
69. Unhide of a wallet imported during a blocked window triggers populate if it lacks manifest populated state.
70. Invalid-history marker skips wallet without marking populated and does not block unrelated scopes indefinitely.
71. Expired invalid-history marker can retry and successful populate clears marker. Visibility/unhide triggers may read markers to decide whether to enqueue, but only populate/reconcile paths write manifest invalid-history state; there is no separate "clear marker on retry attempt" path.
72. Negative running balances are quarantined, never clamped into valid-looking PnL.
73. Show Portfolio off hides portfolio surfaces, latches a wipe obligation, and leaves Exchange Rate surfaces visible.
74. Rapid Show Portfolio off/on/off/on churn serializes, final setting wins, and no ON populate starts until every prior OFF-created wipe obligation has completed.
75. Show Portfolio reset-failure regression: if `performResetSequence()` throws, `visibilityWipeRequired` remains true, `portfolioCacheInvalid` remains latched when applicable, and the next ON attempt retries/awaits reset before any populate can start.

### V23 lock-blocker tests and anti-regression variants

These tests must exist before the plan is treated as implementation-complete. For the first four, include a paired anti-regression variant that intentionally stubs the historical bug back in and asserts the test fails.

1. **Queue dedupe anti-regression:** stub queue append to dedupe against `manifest.populatedWalletIds`; assert send/pull refresh of an already-populated wallet fails. Restore implementation and assert pass.
2. **Mid-series fingerprint anti-regression:** stub fingerprint to use endpoint-only values; mutate a middle chart point with unchanged endpoints and assert the test catches the stale chart. Restore full-point hash and assert pass.
3. **No-BTC-wallet quote-switch anti-regression:** stub canonical `BTC/USD` ensure so it is skipped when the user owns no BTC; assert quote switch fails or produces missing bridge denominator. Restore canonical BTC ensure and assert pass.
4. **Transfer non-netting anti-regression:** stub owned-wallet transfer matching/netting; assert the `$100.20` and `$100.192` fixtures fail. Restore wallet-local transfer model and assert pass.
5. **Weighted group route test:** portfolio tap on collapsed multi-source `usdc` navigates with `{kind: 'portfolioWeightedAssetGroup'}`; standalone Exchange Rates uses `{kind: 'marketAsset'}`. A portfolio route must not open one arbitrary constituent token deployment.
6. **Weighted group quote-bridge test:** quote switch rebuilds `WeightedGroupRateSeries` and `RowPayload.rateStart/rateEnd/ratePercent` from per-timestamp bridged constituent rates. A scalar-transformed USD weighted series must fail the test.
7. **Weighted full-point fingerprint test:** mutate a middle `WeightedGroupRatePoint` with unchanged endpoints; the fingerprint must change and the Exchange Rate scrub UI must re-render. Also mutate `baselineUnitsByRateSourceKey` while holding emitted endpoint values constant; the fingerprint must still change because the weight vector is part of the derived index identity.
8. **Weighted interval-unavailable route test:** keep the route as `{kind: 'portfolioWeightedAssetGroup'}`. For an interval where `baselineUnits === 0` or `groupIndex(t0) <= 0`, assert `unavailableReason: 'zeroBaseline'`, `points: []`, and an interval-local empty state. Switch to an interval with nonzero baseline and assert the weighted series renders without changing the route kind. Missing required constituent rates similarly publish `unavailableReason: 'missingConstituentRate'`, `points: []`. No silent fallback to `marketAsset` is allowed.
9. **Weighted numeric fixture:** the `180.392 → 180.592 → 0.1108696616%` fixture pins `weightedRate` within `1e-12` and `weightedPercent` within `1e-10`.
10. **Urgent same-wallet supersession test:** incoming urgent send/pull item drops older unstarted same-wallet normal/background pending items, preserves existing urgent items, and does not preempt an active same-wallet item.
11. **Stable priority insertion test:** insertion preserves FIFO within each priority class: existing urgent, incoming urgent, existing normal, incoming normal, existing background, incoming background.
12. **Checkpoint validity test:** each invalidity condition in the checkpoint checklist causes wallet-only staging clear and safe restart, while committed completed-wallet manifest data remains visible. Persisted cursor data must be JSON-serializable, match `cursorSchemaVersion`, and reject runtime-only values such as Maps, Sets, class instances, raw BigInts, functions, or host objects. New checkpoints must write `failed`, `closed`, `corrupt`, and `invalidHistoryBlocked` explicitly as booleans.
13. **Delete survivor re-kick test:** `onWalletsDeleted` resumes the existing reconciled queue with `kickPopulateLoopIfIdle()`; it must not append new manual items, lose priority/checkpoint metadata, or duplicate survivor wallet work.
14. **Manifest/queue reconciliation test:** the helper prunes deleted/non-livenet wallets from manifest and queue, does not prune hidden livenet wallets, clears stale checkpoints/staging, and bumps orderRevision iff canonical order changes.
15. **Publish-driven readiness test:** a scope that is metadata-ready but has not actually published a non-empty valid series keeps `hasEverPublishedValidSeries === false`; a valid published series flips it true.
16. **Wallet/delete triple-guard race tests:** guard #2 flips during populate wait; guard #3 flips during snapshot clear; both return before later side effects.
17. **MMKV registry test:** seed one registered key and one unregistered real MMKV key; wipe deletes both through registry-aware delete and leaves `kvStore.listKeys()` clean.
18. **Manifest schema validation test:** invalid/missing schema or malformed JSON returns `null` and logs once; no business-logic silent migration.
19. **Logger contract test:** `logPortfolioRuntimeError` never throws, never returns a Promise, includes `subsystem: 'portfolio-v2'`, and preserves `extra.tag`.
20. **Hide Crypto Balances orthogonality test:** dispatch `toggleHideAllBalances()` twenty times and assert zero runtime calls, zero MMKV writes, zero trigger invocations, zero `sharedPortfolioState` writes, and only UI re-renders.
21. **Per-trigger ordering test:** table order is enforced; post-auth is the only warm-publish-first trigger, and pull/live/send/quote/delete/show-toggle follow their explicit orders.
22. **Helper contract tests:** `resetSharedPortfolioStateForDebugClear` resets every v23.1 state field/tick, `startPopulate` builds/appends through the pinned API, `getSeriesIdlePoint(series)` returns the final point, and `lastAccessedAt` changes only through scoped/wallet touch semantics.
23. **All-zero row-shell fiat test:** visible member wallets exist but all `currentUnits === 0`; rates may be missing. Assert the shell is still published for the visible group and `currentFiatValue === 0`, not `undefined`, not a partial total, and not hidden.
24. **Expired invalid-history reader/writer ownership test:** on unhide, an active marker is read and not enqueued; an expired marker is read and enqueued, but the trigger does not mutate manifest invalid-history state. `runPopulate` rechecks the marker, and only successful populate clears the marker through `markManifestPopulated`.

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
