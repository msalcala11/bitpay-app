# Portfolio runtime refactor implementation plan

**Status:** implementation-locking standalone plan. This file is the source of truth for implementation. Future feedback during implementation should land as inline corrections in the relevant implementation phase or PR unless it identifies a new violation of the original product requirements.

**Implementation-impact note:** this hardening patch does not reopen the architecture, but it does add medium implementation surface: runtime-kind initializers, the publish helper and metrics seam, `RateReader`, retry/backoff, route normalization, invalid-math quarantine, MMKV wipe helpers, status hooks, and retained-kernel classification all require tests.

**Target:** replace the current screen-specific portfolio computation/caching stack with a canonical worklet-owned portfolio render model. The architecture uses separate queue and manifest state, run-scoped and priority-aware queue items, scope-specific readiness with explicit empty-scope handling, raw row-shell values with per-member rate sourcing, weighted group-rate parity for collapsed multi-chain assets, full-point chart fingerprints, a bounded LRU scoped cache, a dedicated rate-fetch runtime, product-oracle correctness tests, robust Show Portfolio wipe latching, and UI hooks that move only selected slices across to React.

**Executable by:** a senior React Native engineer or a coding agent with strong React Native, `react-native-worklets`, Reanimated UI shared values/reactions, MMKV, Redux, and test-writing context.

---

## 0. Implementation-locking decisions

These decisions are binding for implementation. They are listed up front so an implementing agent can understand the architecture without any external context.

1. **Canonical render state is worklet-owned.** Portfolio math, snapshots, rates, chart series, row payloads, scoped render cache, and quote reprice logic are produced in portfolio worklet runtimes. React screens read selected render slices only.
2. **Weighted group exchange-rate math is pinned.** Collapsed multi-rate-source asset groups use a baseline-unit weighted market index. The runtime exposes `weightedRate(t)` for chart display and `weightedPercent(t)` as the no-transaction parity oracle. It is derived only when needed and is not persisted.
3. **Portfolio-entered Exchange Rate routing is typed.** UI navigation distinguishes standalone market assets from portfolio-scoped weighted asset groups so a collapsed portfolio row cannot accidentally open one arbitrary token deployment.
4. **Weighted group quote bridging is explicit.** Quote switches rebuild weighted group rate series and row `rateStart` / `rateEnd` / `ratePercent` from per-timestamp bridged constituent rates. No scalar transform of a finished USD weighted series is allowed.
5. **Refresh queue insertion is stable and supersedes stale work.** Urgent send/pull work runs after the active wallet, preserves FIFO within each priority class, and drops older unstarted same-wallet normal/background items so stale pending work does not run after fresher work.
6. **Row-shell fiat values have precise all-zero and missing-rate behavior.** No visible members means no shell. Visible members with all zero current units publish `currentFiatValue: 0`. Any visible nonzero member lacking a live rate makes `currentFiatValue` undefined; runtime never publishes a partial fiat sum.
7. **Checkpoint validity is concrete.** Resume is allowed only when schema, wallet/run identity, staging keys, revision relationship, cursor/page/block/tx state, ingest config, and failure markers are internally valid.
8. **Wallet/key deletion uses a triple-guard contract.** Delete triggers guard before side effects, quiesce populate, reconcile, clear snapshots through store APIs, guard again before recompute, and never write shared state directly.
9. **Reset/MMKV registry discipline is required.** Reset uses timeout-bounded quiescence, a durable cache-invalid bit, post-auth repair, real-MMKV key enumeration, and registry-aware deletes.
10. **Per-trigger ordering is tabulated.** Post-auth is warm-publish-first; freshness events are ensureFresh-first; deletion/show-toggle have their own ordering. Future triggers must not be “consistency-ized.”
11. **Row formulas and numeric fixtures are binding.** Row/detail equality is pinned by explicit formulas plus the `$100.20`, `$100.192`, and weighted-group `180.392 → 180.592 → 0.1108696616%` fixtures.
12. **Anti-regression variants are required for load-bearing tests.** Queue dedupe, mid-series fingerprints, no-BTC-wallet quote switch, and transfer non-netting each include a “stub the bug back in and assert failure” variant.
13. **Delete survivor re-kick must not double-enqueue.** `onWalletsDeleted` resumes the already-reconciled queue via `kickPopulateLoopIfIdle()` instead of calling a wallet-append helper with survivor IDs and creating new run-scoped items.
14. **Manifest/queue reconciliation is specified.** `reconcileManifestAndQueueAgainstPopulateEligible(...)` has a defined signature, pruning semantics, return shape, and visibility-ignored eligibility source.
15. **Scope readiness is publish-driven.** `hasEverPublishedValidSeries` flips only after recompute actually publishes a non-empty valid series, not merely because metadata says a scope is ready.
16. **Weighted group series type/prose are aligned.** Single-source groups use `marketAsset` routes and do not publish `weightedGroupRateSeries`; multi-source collapsed groups use `portfolioWeightedAssetGroup` and require full-point weighted fingerprints that include the weight vector.
17. **Small helper contracts are pinned.** `startPopulate`, `resetSharedPortfolioStateForDebugClear`, `getSeriesIdlePoint`, `lastAccessedAt` LRU semantics, manifest validation, logger signature, and canonical BTC dependency ownership are explicit.
18. **Weighted-route zero-baseline behavior is interval-local.** A collapsed portfolio-weighted route can stay valid overall while a specific interval is unavailable because baseline units or baseline index are zero; timeframe switching may reveal another valid interval.
19. **Checkpoint cursor persistence is bounded.** Runtime cursor data may be kernel-defined, but persisted checkpoints accept only JSON-serializable data validated against a cursor schema/version before resume.
20. **Weighted group rate availability is discriminated.** Valid weighted intervals have finite point values. Unavailable intervals publish `availability: 'unavailable'`, an `unavailableReason`, and `points: []`; there are no arrays of undefined chart points.
21. **`missingConstituentRate` is fully specified.** Missing canonical constituent rates, missing BTC bridge rates, interpolation failures, or non-finite constituent values make the selected interval unavailable with no partial weighted chart and no representative fallback.
22. **Invalid-history unhide retry ownership is pinned.** Unhide can enqueue retries, but it does not directly clear manifest invalid-history state. Successful populate through `markManifestPopulated` is the clearing point; failed retries preserve context.
23. **Weighted fingerprints explicitly hash their availability and sort their rate-source keys.** `availability`, `unavailableReason`, and `sortedRateSourceKeys = Object.keys(baselineUnitsByRateSourceKey).sort()` are part of the fingerprint contract.
24. **Passive live-rate churn is a typed current-value touch.** `onLiveRatesUpdated` schedules only `scope: {kind: 'liveRateTouch'}` after debounce and fire-time guards. It never schedules `scope: 'full'`, never calls `ensureFresh`, never fetches historical rates, never refreshes snapshots, and never mutates populate/manifest/order state.
25. **Rollout and rollback semantics are split.** The rollout phase first defaults `PORTFOLIO_V2` on while retaining v1 orchestration for soak, so the kill switch can still roll back to v1. Only after soak passes are v1 orchestration files deleted; after deletion, the remaining switch is explicitly a v2-disable/hide switch, not a v1 rollback.
26. **Hidden livenet wallets get rate coverage while hidden.** Populate and background freshen use visibility-ignored populate eligibility for canonical historical rates, so a hidden-only asset that was populated while hidden has both snapshots and rates ready on unhide. Display recomputes remain visibility-respecting.
27. **Scaffolding contracts are part of the spec.** Module paths, route-scope types, runtime API, shared tick semantics, populate runtime context, Redux fire-time access, and test-fixture locations are pinned so an implementation agent does not invent incompatible infrastructure.
28. **The portfolio runtime substrate is `react-native-worklets`.** Portfolio-owned compute, populate, and rate-fetch runtimes use the installed `react-native-worklets` runtime API. Reanimated remains the UI shared-value/reaction layer; it is not the portfolio runtime creation API.
29. **Runtime initializer scope is explicit.** Compute, populate, and rate-fetch runtimes initialize different globals. Compute never installs wallet signing context. Populate installs tx-history signing/Nitro globals. Rate-fetch installs the Nitro/BWS fetch surface without wallet credentials.
30. **All writes to `sharedPortfolioState.value` go through one helper.** `publishPortfolioState(...)` performs stale-epoch checks, metrics, payload-size warnings, projection, and the `sharedPortfolioState.value` write. Phase 1 publishes the canonical shape unchanged through `projectPortfolioStateForUi(...)`; a smaller typed UI projection is deferred until benchmarks justify it. Coordination SharedValues such as `populateProgressTick`, `populateRetryTick`, `populateCancelFlag`, and `populateLoopRunning` are not published render state and may be written directly by their owning loops/helpers.
31. **Work epoch guards stale async output.** Long-running recompute, populate, rate-fetch, reset, delete, quote, and feature-flag transitions use a monotonic `workEpoch`; stale work may finish CPU/network I/O but must not persist or publish output.
32. **Stored-rate interval safety is type-level.** Provider, URL, MMKV key, and persist helpers accept `StoredRateInterval`, not `Interval`. `3M`, `1Y`, and `5Y` must resolve to `ALL` before crossing into fetch/persist code.
33. **Rate lookup goes through one canonical reader.** Render, row, weighted-rate, and quote-bridge paths use the same `RateReader` and missing-rate contract. Nearest sampling is permitted only for explicitly named snapshot-ingest behavior.
34. **Invalid wallet math is quarantined, not repaired by clamping.** Negative running balances, non-finite basis, impossible disposal math, missing required basis rates, and malformed snapshot state exclude the affected wallet from PnL until repopulated successfully.
35. **Retained v1 kernels must be classified before import.** Every kept/adapted v1 kernel is classified as `reuse unchanged`, `adapt before v2 use`, `test fixture only`, or `delete after soak`; no v2 import is allowed before its v2-contract checklist passes.
36. **Populate and rate-fetch loops never trampoline through JS.** Once dispatched to their runtimes, populate's tx-history signing/request/pagination/response-processing path and `ensureFresh`'s BWS signing/request/response-processing path execute inside their portfolio worklet runtimes through the Nitro hybrid-object path. JS may build the fire-time dispatch context once before kick and may dispatch worklet tasks; the loop body must not `runOnJS` back to JS-thread fetch/signing/request helpers and must not process/persist tx-history or rate responses on the JS thread.
37. **Read-only UI interactions cause zero MMKV mutations.** Timeframe switches, chart scrubbing, and passive live-rate touches are read/current-value-only paths. They must not call any of the v2 MMKV mutation helpers (`writePortfolioMmkvString(...)`, `deletePortfolioMmkvKey(...)`, `clearPortfolioMmkvKeysForReset(...)`), must not write/delete `snap:*`, `rate:v1:*`, or `portfolio:v2:*` keys, must not mutate generated render cache, must not enqueue populate, and must not refresh snapshots/rates. This is enforced with spy-target tests against the named helper family and against the low-level mutation exports the helpers wrap.

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

The dedicated rate-fetch runtime is chosen deliberately. It is simpler than preserving a branch matrix and avoids runtime-global dispatch-context clobbering between populate signing context and rate fetch context. In shorthand, this plan uses three portfolio worklet runtimes: compute, populate, and rate-fetch.

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

### Runtime API and shared signaling

Use `react-native-worklets` as the portfolio-owned runtime substrate. Reanimated remains valid for UI shared values and `useAnimatedReaction`, but portfolio compute/populate/rate-fetch work must not import a separate Reanimated runtime-creation API. Create portfolio-owned runtimes with the installed `react-native-worklets` API and explicit runtime-kind initializers, equivalent to:

```ts
export type PortfolioRuntimeKind = 'compute' | 'populate' | 'rateFetch';

export function initializePortfolioRuntimeGlobals(kind: PortfolioRuntimeKind): void {
  'worklet';

  switch (kind) {
    case 'compute':
      // No wallet signing context and no request-private-key state.
      return;
    case 'populate':
      // Signing/Nitro Fetch globals required by tx-history populate.
      return;
    case 'rateFetch':
      // Nitro Fetch/BWS request surface only; no wallet signing context.
      return;
  }
}

createWorkletRuntime({
  name: 'portfolio-compute',
  initializer: () => {
    'worklet';
    initializePortfolioRuntimeGlobals('compute');
  },
  enableEventLoop: true,
});

createWorkletRuntime({
  name: 'portfolio-populate',
  initializer: () => {
    'worklet';
    initializePortfolioRuntimeGlobals('populate');
  },
  enableEventLoop: true,
});

createWorkletRuntime({
  name: 'portfolio-rate-fetch',
  initializer: () => {
    'worklet';
    initializePortfolioRuntimeGlobals('rateFetch');
  },
  enableEventLoop: true,
});
```

This separation is load-bearing. A rate fetch must not inherit or overwrite a populate wallet's request signing context, and compute must never require wallet credentials.

All async worklet dispatch goes through the installed `react-native-worklets` `runOnRuntimeAsync` surface, wrapped locally only if needed for logging and type normalization:

```ts
runOnRuntimeAsync(runtime, workletFn, ...args): Promise<ReturnType<typeof workletFn>>
```

If the installed `react-native-worklets` API changes shape, implement the adapter once in `src/portfolio/v2/runtimes.ts` and use it everywhere. Fire-and-forget calls must attach `.catch(err => logPortfolioRuntimeError(err, {tag}))`. Do not mix in another runtime library or ad hoc dispatch surface without changing this plan.

Shared portfolio coordination values live in `src/portfolio/v2/sharedState.ts`:

```ts
export const sharedPortfolioState: SharedValue<PortfolioPublishedState>;
export const populateCancelFlag: SharedValue<boolean>;
export const populateLoopRunning: SharedValue<boolean>;
export const populateProgressTick: SharedValue<number>;
export const populateRetryTick: SharedValue<number>;

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
      keyHash: string;
      keyLength: number;
      keyPrefixFamily: PortfolioMmkvPrefixFamily;
      approximateBytes: number;
      durationMs: number;
      warning: boolean;
      allowOversize: boolean;
    }>;

export function recordPortfolioV2Metric(metric: PortfolioV2Metric): void;

export function publishPortfolioState(args: {
  canonical: PortfolioState;
  reason: PortfolioPublishReason;
  startEpoch: number;
}): void;

export function projectPortfolioStateForUi(
  canonical: PortfolioState,
): PortfolioPublishedState;

export type PortfolioWorkEpochReason =
  | 'resetStart'
  | 'showPortfolioOff'
  | 'walletDeletion'
  | 'quoteCurrencyChanged'
  | 'featureFlagChanged'
  | 'postAuthRepair'
  | 'debugClear';

export function getCurrentPortfolioWorkEpoch(): number;
export function bumpPortfolioWorkEpoch(reason: PortfolioWorkEpochReason): number;
```

`publishPortfolioState(...)` is the only legal write path for `sharedPortfolioState.value`. It re-checks `workEpoch`, records publish duration and approximate payload size through `recordPortfolioV2Metric(...)`, warns when the payload exceeds `PORTFOLIO_PUBLISH_WARN_BYTES`, calls `projectPortfolioStateForUi(...)`, and then performs the `sharedPortfolioState.value` write. In Phase 1, `PortfolioPublishedState` is a type alias of `PortfolioState` and `projectPortfolioStateForUi(...)` returns the canonical state unchanged. A smaller typed `PortfolioPublishedState` projection is allowed only after metrics show the shared-value payload or invalidation cost is material on target devices. Coordination SharedValues such as progress/retry/cancel/running ticks are intentionally outside this helper.

`populateProgressTick` is the populate-loop → recompute progress signal. The populate loop increments it after every successfully populated wallet and after every invalid-history-skipped wallet. The root scheduler observer debounces the tick and schedules the relevant recompute so initial and incremental populates publish progressively.

`populateRetryTick` is the populate-loop → JS retry signal. The populate loop increments it when it exits with pending work remaining because context was missing, cancellation was observed, or work should be retried after reconciliation. The root observer reconciles and re-kicks the existing queue; it does not append replacement work items.

### Module layout

Create the v2 module tree up front. Paths are normative unless repo inventory requires a minor import-path adjustment:

```txt
src/portfolio/v2/model.ts
src/portfolio/v2/constants.ts
src/portfolio/v2/runtimes.ts
src/portfolio/v2/sharedState.ts
src/portfolio/v2/reduxAccess.ts
src/portfolio/v2/kvStore.ts
src/portfolio/v2/logPortfolioRuntimeError.ts
src/portfolio/v2/manifest.ts
src/portfolio/v2/ordering.ts
src/portfolio/v2/recompute.ts
src/portfolio/v2/scheduler.ts
src/portfolio/v2/selectors.ts
src/portfolio/v2/triggers.ts
src/portfolio/v2/routes/routeScope.ts
src/portfolio/v2/routes/exchangeRateRoute.ts
src/portfolio/v2/hooks/usePortfolioSlice.ts
src/portfolio/v2/hooks/usePortfolioChart.ts
src/portfolio/v2/hooks/usePortfolioAssetRows.ts
src/portfolio/v2/hooks/usePortfolioStatus.ts
src/portfolio/v2/populate/queue.ts
src/portfolio/v2/populate/reconciliation.ts
src/portfolio/v2/populate/populateLoop.ts
src/portfolio/v2/populate/api.ts
src/portfolio/v2/populate/resume.ts
src/portfolio/v2/populate/resetState.ts
src/portfolio/v2/populate/performResetSequence.ts
src/portfolio/v2/workletData/snapshotsKv.ts
src/portfolio/v2/workletData/ratesKv.ts
src/portfolio/v2/workletData/ratesFetch.ts
src/portfolio/v2/debug.ts
src/portfolio/v2/metrics.ts
src/portfolio/v2/__tests__/fixtures/
```

The shared fixture library in `src/portfolio/v2/__tests__/fixtures/` owns the pinned numeric fixtures: transfer `$100.20`, cross-chain transfer `$100.192`, weighted group `180.392 → 180.592 → 0.1108696616%`, no-transaction parity, zero-baseline, missing-constituent-rate, checkpoint, and mid-series mutation fixtures. Phase-specific tests import from this library instead of re-declaring divergent fixture data.

### Constants and key names

Centralize key names in `src/portfolio/v2/constants.ts`:

```ts
export const PORTFOLIO_V2_FLAG_KEY = 'portfolio:v2:flag';
export const PORTFOLIO_CACHE_INVALID_KEY = 'portfolio:v2:cacheInvalid';
export const PORTFOLIO_WORK_EPOCH_KEY = 'portfolio:v2:workEpoch';
export const MANIFEST_KEY = 'portfolio:v2:manifest:v1';
export const POPULATE_QUEUE_KEY = 'portfolio:v2:populate:queue:v1';
export const CANONICAL_RATE_QUOTE = 'USD' as const;
export const MAX_SCOPED_CACHE_ENTRIES = 8;
export const PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS = 150;
export const PORTFOLIO_PUBLISH_WARN_BYTES = 750_000;
export const PORTFOLIO_MMKV_VALUE_WARN_BYTES = 500_000;
export const PORTFOLIO_RECOMPUTE_CHUNK_WALLET_COUNT = 25;
export const PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED = true;
export const PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS = 90;
export const PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET = 128;
```

No module should inline these strings. Reset and wipe code must import them from the constants module.

### Redux access and live-rate ownership

All Redux access is fire-time access through `src/portfolio/v2/reduxAccess.ts`. There are no module-top-level Redux reads and no cached Redux references inside triggers or selectors. The module exports typed accessors for quote currency, wallet metadata, balances, visibility, live rates, rate as-of timestamp, feature flags, and context builders.

The existing app Redux/live-rate effects continue to populate the live-rate slice. Portfolio v2 only reads live rates through `getLiveRatesByAssetIdFromStore()` and `getLiveRatesAsOfMsFromStore()`; it does not own or rewrite the live-rate Redux pipeline. Historical portfolio rates live in MMKV through the fiat-rate store.

Phase 0 must verify one of these live-rate quote contracts:

1. the existing live-rate Redux slice is always maintained in the current display quote, including immediately after quote changes; or
2. `reduxAccess.ts` must also expose `getLiveRatesQuoteCurrencyFromStore()`, and passive live-rate touches must no-op when the live-rate quote does not match the current portfolio quote.

Phase 0 must also determine whether Exchange Rate screens or other non-v2-owned paths can persist new shared historical `rate:v1:*` data outside the v2 trigger that initiated the fetch. If yes, implement `onHistoricalRatesPersisted(...)` as a no-fetch recompute notification. If no, document explicitly that navigation-only Exchange Rate screens do not persist portfolio-relevant historical rates; historical portfolio rate persistence occurs only through v2-owned explicit refresh paths.

`reduxAccess.ts` also owns these fire-time builders so trigger code has one import surface: `buildPopulateRuntimeContextFromStore()`, `buildBaseRecomputeInputsAtFireTime()`, `buildEnsureFreshArgsForVisibleAssetGroups(...)`, `buildEnsureFreshArgsForPopulateEligibleAssetGroups(...)`, `getPopulateEligibleWalletIdSetFromStore()`, and `getEligibleStoredWalletsFromStore()`.

`getEligibleStoredWalletsFromStore()` and `getPopulateEligibleWalletIdSetFromStore()` must not call `getVisibleWalletsFromKeys`, home-carousel visibility helpers, account/key visibility filters, or Hide Crypto Balances selectors. Populate eligibility is visibility-ignored. Display/recompute eligibility is visibility-respecting. Phase 0 must seed a hidden livenet wallet and prove it appears in populate/background-rate eligibility but not in display eligibility.

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

Provider, URL, MMKV key, and persist functions accept `StoredRateInterval`, not `Interval`. UI and chart callers may request any `Interval`, but they must resolve to `StoredRateInterval` before crossing into fetch/persist code.

```ts
export function getFiatRateSeriesUrl(args: {
  cfg: BwsConfig;
  quoteCurrency: string;
  interval: StoredRateInterval;
  asset?: FiatRateAssetRef;
}): string;
```

Passing `3M`, `1Y`, or `5Y` to provider/URL/persist helpers should be a TypeScript error and a runtime assertion failure in test builds.

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

  // Declares whether a passive live-rate touch is allowed to update the final
  // point. Historical points are never live-touched. Series builders own this
  // decision; UI and triggers must not infer it from timestamps.
  finalPointSource: 'historicalRate' | 'liveRate';

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
  // renders for portfolio-entered collapsed groups. Always finite for a valid
  // weighted interval.
  weightedRate: number;

  // No-transaction parity oracle. Derived as
  // (groupIndex(t) - groupIndex(t0)) / groupIndex(t0) * 100. Always finite for
  // a valid weighted interval. Unavailable intervals do not publish points.
  weightedPercent: number;
}>;

type WeightedGroupRateSeriesBase = Readonly<{
  // Full-point hash. Includes quote, assetGroupId, walletIdsKey, interval/window,
  // availability/unavailableReason, the complete baseline weight vector
  // (baselineUnitsByRateSourceKey), memberRateSourceKeys, and every emitted
  // point's ts, weightedRate, and weightedPercent. Endpoint-only fingerprints
  // are forbidden because the Exchange Rate scrub UI can stale on middle-point
  // mutations. The weight vector is part of the identity of the weighted market
  // index even if two emitted point arrays happen to match numerically.
  fingerprint: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;

  // Multiple FiatRateAssetRef keys for collapsed groups such as USDC across
  // chains. Single-source groups do NOT publish this series; they route as
  // ordinary `marketAsset` Exchange Rate screens.
  memberRateSourceKeys: readonly string[];

  // Baseline display units per rate source, sorted/serialized by rate-source key
  // for fingerprints and auditability. Zero-baseline members are omitted or have
  // value 0; they contribute no weight.
  baselineUnitsByRateSourceKey: Readonly<Record<string, number>>;

  weighting: 'baselineUnitWeightedCollapsedGroup';
}>;

export type WeightedGroupRateSeries =
  | Readonly<
      WeightedGroupRateSeriesBase & {
        availability: 'valid';
        unavailableReason?: never;
        // Internal index values are not displayed directly. `groupIndex(t)` is
        // Σ(unitsAtT0_i * rate_i(t)); UI displays weightedRate, while tests use
        // weightedPercent for parity. Every point must contain finite numbers.
        points: readonly WeightedGroupRatePoint[];
      }
    >
  | Readonly<
      WeightedGroupRateSeriesBase & {
        availability: 'unavailable';
        unavailableReason: 'zeroBaseline' | 'missingConstituentRate';
        // Unavailable intervals never publish arrays of undefined points. The
        // chart renders an interval-local empty state instead.
        points: readonly [];
      }
    >;

export type PerIntervalWeightedGroupRateSeries =
  Readonly<Partial<Record<Interval, WeightedGroupRateSeries>>>;

export type PortfolioRouteScope =
  | {kind: 'home'}
  | {kind: 'wallet'; walletId: string}
  | {kind: 'key'; keyId: string}
  | {kind: 'account'; accountId: string}
  | {kind: 'assetGroup'; assetGroupId: string}
  | {kind: 'keyAssetGroup'; keyId: string; assetGroupId: string}
  | {kind: 'accountAssetGroup'; accountId: string; assetGroupId: string}
  | {kind: 'walletIdsKey'; walletIdsKey: string};

export type ResolvedRouteScope = Readonly<{
  scope: PortfolioRouteScope;
  walletIds: readonly string[];
  walletIdsKey: string;
  assetGroupId?: string;
}>;

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

Because current navigation may still provide legacy flat params, the screen boundary must normalize both route shapes:

```ts
export type LegacyExchangeRateParams = Readonly<{
  currencyName?: string;
  currencyAbbreviation?: string;
  chain?: string;
  network?: string;
  tokenAddress?: string;
  chartType?: 'assetBalanceHistory' | string;
  keyId?: string;
}>;

export function normalizeExchangeRateRouteParams(
  params: LegacyExchangeRateParams | {route: ExchangeRateRoute},
): ExchangeRateRoute;

export function serializeExchangeRateRoute(
  route: ExchangeRateRoute,
): {route: ExchangeRateRoute};
```

Legacy flat params always normalize to `marketAsset`. Only portfolio-owned v2 navigation may create `portfolioWeightedAssetGroup`. This protects restored navigation state, deep-link-like paths, and standalone Exchange Rate call sites during migration.

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

export type AssetGroupHealth = Readonly<{
  // True when same ticker includes more than one chain/token/native identity.
  collapsedAcrossDistinctAssets: boolean;

  // True when members use different display decimals. Runtime must sum
  // display-unit amounts, not raw atomic balances formatted through one member.
  decimalConflict: boolean;

  // Optional/debug unless a reliable classifier is available.
  symbolCollisionSuspected?: boolean;

  missingLiveRateMemberWalletIds: readonly string[];
  nonzeroMissingLiveRateMemberWalletIds: readonly string[];
}>;

export type AssetGroupRowShell = Readonly<{
  assetGroupId: string;
  displaySymbol: string;

  // Runtime-computed aggregates. UI formats/localizes/masks these values.
  // `currentCryptoAmount` is computed by converting each member wallet from
  // atomic units to display units first, then summing display units. Runtime
  // must never sum raw atomic balances across members and format through one
  // representative wallet's decimals.
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
  memberRateSourceKeys: readonly string[];
  canonicalUnitDecimals?: number;
  groupHealth: AssetGroupHealth;

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
if (visibleMemberWallets.length === 0) {
  // No row shell is published for this asset group/scope.
  return undefined;
}

const nonzeroMembers = visibleMemberWallets.filter(wallet =>
  currentUnits(wallet) !== 0
);

currentFiatValue = nonzeroMembers.length === 0
  ? 0
  : nonzeroMembers.every(wallet => hasLiveRate(wallet.fiatRateAssetRef))
    ? sum(nonzeroMembers.map(wallet =>
        currentUnits(wallet) * liveRateFor(wallet.fiatRateAssetRef)
      ))
    : undefined;
```

The runtime performs this aggregation. The UI may format, mask, navigate, or render skeletons, but it must not aggregate through `memberWalletIds` or walk wallet balances/points to derive row amounts. This is especially important for collapsed ticker groups and native/token distinctions. No visible members means no row shell is published. Visible members that all have zero current units publish `currentFiatValue: 0`, even if some zero-unit member rates are missing. A visible nonzero member wallet with a missing live rate makes `currentFiatValue` undefined. Runtime must not publish a partial fiat total, and UI should render the crypto amount plus a blank/skeleton fiat slot when fiat is undefined.

`currentCryptoAmount` follows the same runtime-only rule. Collapsed row crypto amount is computed by summing per-member display-unit amounts. Decimal-conflict and multi-source metadata are exposed through `groupHealth`; UI may render a breakdown/debug affordance, but it must not recompute the aggregate from wallet balances.

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
export type PortfolioStaleReason =
  | 'missingSnapshotIndex'
  | 'missingSnapshot'
  | 'balanceMismatch'
  | 'missingHistoricalRate'
  | 'staleHistoricalRate'
  | 'invalidHistory'
  | 'populateRetryPending'
  | 'rateFetchRetryPending';

export type PortfolioStatus = Readonly<{
  // Global/status metadata. Per-scope refresh readiness remains in
  // `ScopeReadiness`; hooks combine both shapes when needed.
  invalidHistoryWalletIds: readonly string[];
  missingRateSourceKeys: readonly string[];
  staleReasons: readonly PortfolioStaleReason[];
  retryScheduledWalletIds: readonly string[];
  retryScheduledRateSourceKeys: readonly string[];
}>;

export const EMPTY_PORTFOLIO_STATUS: PortfolioStatus = {
  invalidHistoryWalletIds: [],
  missingRateSourceKeys: [],
  staleReasons: [],
  retryScheduledWalletIds: [],
  retryScheduledRateSourceKeys: [],
};

export type PortfolioState = Readonly<{
  schemaVersion: 1;
  workEpoch: number;
  revision: number;
  quoteCurrency: string;
  canonicalRateQuoteCurrency: 'USD';
  computedAtMs: number;
  status: PortfolioStatus;

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

// Phase 1 publishes the canonical shape unchanged. Keep selectors and shared
// state typed against this alias so a future smaller projection can replace the
// alias without renaming every selector/hook/publish call site.
export type PortfolioPublishedState = PortfolioState;

export const EMPTY_PORTFOLIO_STATE: PortfolioState = {
  schemaVersion: 1,
  workEpoch: 0,
  revision: 0,
  quoteCurrency: 'USD',
  canonicalRateQuoteCurrency: 'USD',
  computedAtMs: 0,
  status: EMPTY_PORTFOLIO_STATUS,
  populatedWalletIdsKey: '',
  populatedWalletIdsById: {},
  invalidHistoryWalletIdsKey: '',
  invalidHistoryWalletIdsById: {},
  orderedAssetGroupIdsForAssetList: [],
  orderRevision: 0,
  readinessByScopeKey: {},
  byWallet: {},
  byAssetGroup: {},
  rowShells: [],
  total: {},
  totalFingerprint: '',
  scopedByWalletSet: {},
};

export function emptyPortfolioStateForEpoch(args: {
  workEpoch: number;
  quoteCurrency: string;
  computedAtMs: number;
}): PortfolioState {
  return {
    ...EMPTY_PORTFOLIO_STATE,
    workEpoch: args.workEpoch,
    quoteCurrency: args.quoteCurrency,
    computedAtMs: args.computedAtMs,
  };
}
```

`EMPTY_PORTFOLIO_STATE` is a static default only. Reset/debug/Show-Portfolio-off publishes must call `emptyPortfolioStateForEpoch(...)` with the current epoch at publish time, not a stale operation-start epoch, so the publish helper's stale-epoch guard can accept the reset-created empty state.

`PortfolioStatus` is intentionally minimal in early phases. It gives `usePortfolioStatus` a runtime-published place for invalid-history, missing-rate, stale, and retry-pending metadata without forcing UI code to inspect MMKV, manifest, or queue internals. The fuller `PortfolioDataQuality` model may be added later if product needs differentiated status copy beyond this minimal surface.

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
  extra?: PortfolioRuntimeLogExtra,
): void;
```

The logger never throws, never returns a Promise, always includes `subsystem: 'portfolio-v2'`, and preserves `extra.tag` when provided. It is safe for `.catch(logPortfolioRuntimeError)` and for contextual `.catch(err => logPortfolioRuntimeError(err, {tag}))` call sites. It accepts only the allowlisted fields in `PortfolioRuntimeLogExtra`; do not pass arbitrary objects.

### Populate queue

The queue stores run-scoped work items, not just wallet IDs. This prevents a wallet that completed an earlier run from being accidentally blocked from a send or pull-to-refresh refresh.

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

  // null = no prior committed snapshot index, e.g. first-ever populate of this wallet.
  snapshotIndexRevision: number | null;

  // Cursor/page/block/tx state. Persisted cursor data must be JSON-serializable
  // and schema-validated at the MMKV boundary. Phase 5 may narrow this to the
  // preserved populate kernel's concrete cursor schema, but `unknown` is not
  // allowed in persisted checkpoint storage.
  cursor?: JsonValue;
  cursorSchemaVersion?: number;
  lastProcessedBlockId?: string;
  lastProcessedBlockHeight?: number;
  lastProcessedTxId?: string;
  pageSize: number;
  ingestFingerprint: string;

  // Non-optional booleans avoid three-state resume logic. New checkpoints
  // write all four as false unless the state is explicitly true.
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
  itemId: string;        // `${runId}:${walletId}`
  runId: string;
  walletId: string;
  reason: PopulateQueueReason;
  priority: PopulateQueuePriority;
  requestedAtMs: number;
  checkpoint?: PopulateCheckpoint;
  retry?: PopulateRetryState;
}>;

export type RateFetchRetryState = Readonly<{
  quoteCurrency: string;
  storedInterval: StoredRateInterval;
  rateSourceKey: string;
  attempt: number;
  nextRetryAtMs: number;
  lastErrorKind: 'network' | 'bws' | 'parse' | 'rateLimit' | 'unknown';
  lastErrorAtMs: number;
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

### Queue dedupe, supersession, and priority insertion

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

Dedupe is by `itemId` within one run. Supersession is by `walletId` across runs and only fires when an item arrives. They are separate mechanisms.

Never dedupe against `manifest.populatedWalletIds`. Manifest means “valid data exists.” Queue means “work to do now.” A wallet can have valid data and still need new work after a send, receive, pull-to-refresh, app-launch incremental refresh, key import retry, or manual refresh.

Urgent work should supersede stale unstarted work for the same wallet:

- if a new `urgentUserVisible` item arrives for wallet `A`, drop older **unstarted pending** normal/background items for wallet `A`;
- do not drop existing pending items for the same wallet unless they have the same `itemId`;
- do not preempt or delete `active`, even if `active.walletId === A`; if `A` is active from an initial pass and the user sends from `A`, append `A(send)` so it runs immediately after the active pass;
- do not remove completed-in-run records from previous runs; run identity is part of the item.

This enables the important scenario:

```txt
active item: X(initial-1)        // if any; never preempt mid-wallet
initial run pending: B, C, D
initial run already completed: A
user sends from A
append item: {runId: 'send-2', walletId: 'A', priority: 'urgentUserVisible'}
queue pending becomes: A(send-2), B, C, D
```

If `A` was already pending as `A(initial-1)` and the user sends from `A`, the insertion removes that older unstarted `A(initial-1)` item and inserts `A(send-2)` in the lane. This avoids an refresh followed later by a stale older populate of the same wallet.

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
  // - active-item pruning is allowed only after callers have called
  //   cancelPopulate() and awaited waitForPopulateLoopToStop(); callers that
  //   operate while the loop is running reconcile pending/completed metadata
  //   only and let the active loop observe cancellation or finish naturally;
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
- persisted cursor data is JSON-serializable, matches `cursorSchemaVersion`, and validates against the populate kernel cursor schema;
- cursor, page, block-height, and tx-position state are internally consistent;
- ingest config and page-size assumptions are compatible with the current queue item;
- the checkpoint was not written under a different wallet/key/account identity;
- the checkpoint is not marked failed, closed, corrupt, or invalid-history-blocked.

If any validity check fails, clear only the incomplete staging data for that wallet, leave committed snapshots for previously completed work alone, and restart that wallet from the last committed safe point using the normal reorg-safe rewind.

This makes app-kill recovery deterministic: completed work stays published; the interrupted wallet is retried first; pending work continues afterward.

### Refresh priority contract

Do not let user-visible refresh work sit behind a long first-populate tail. `send` and pull-to-refresh changed-wallet items are `urgentUserVisible`; they join the urgent lane immediately after any active wallet completes, preserve FIFO within urgent work, and supersede older unstarted same-wallet normal/background work. Background initial/app-launch work remains behind items.

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

Populate helper wrappers are defined in terms of `appendToQueue(...)` so trigger examples have one consistent call shape:

```ts
export function populateWallet(
  walletId: string,
  options: {reason: PopulateQueueReason; priority?: PopulateQueuePriority},
): void;

export function populateWallets(
  walletIds: readonly string[],
  options: {reason: PopulateQueueReason; priority?: PopulateQueuePriority},
): void;
```

Both helpers filter to livenet/mainnet wallets, reconcile with visibility-ignored populate eligibility, append run-scoped items, clear `populateCancelFlag`, and call `kickPopulateLoopIfIdle()`. They never rebuild the queue and never dedupe against `manifest.populatedWalletIds`.

`PopulateRuntimeContext` is the JS → populate-runtime boundary. It is built by `buildPopulateRuntimeContextFromStore()` in `reduxAccess.ts` immediately before a populate kick:

```ts
export type PopulateRuntimeContext = Readonly<{
  cfg: BwsConfig;
  ingest: SnapshotIngestConfig;
  pageSize: number;
  walletsById: Readonly<Record<string, {
    walletId: string;
    assetGroupId: string;
    fiatRateAssetRef: FiatRateAssetRef;
    summary: WalletSummary;
    credentials: WalletCredentials;
    network: string;
    keyId?: string;
    accountId?: string;
  }>>;
  signingContextsByWalletId: Readonly<Record<string, PortfolioTxHistorySigningDispatchContext>>;
  queueSchemaVersion: 1;
  manifestSchemaVersion: 1;
}>;
```

If a wallet is missing from `walletsById` or lacks a signing context, the populate loop exits with work remaining and increments `populateRetryTick`; it must not mark that wallet populated.

Retry/backoff contract:

- populate and rate-fetch failures record retry state with exponential backoff plus jitter;
- `send`, pull-to-refresh, and explicit manual refresh may bypass the waiting period for the affected wallet/rate dependency;
- background initial/app-launch work respects `nextRetryAtMs`;
- `kickPopulateLoopIfIdle()` skips pending items whose retry window has not opened unless there is another eligible item behind them;
- retry state is cleared when the item completes successfully or is superseded by newer urgent same-wallet work;
- retry metadata is persisted with the queue for populate items but never with wallet credentials;
- rate-fetch retry state follows the same no-spin/urgent-bypass/success-clears contract, whether stored persistently or in runtime memory.

```ts
export function resetSharedPortfolioStateForDebugClear(args: {
  publishEpoch: number;
  quoteCurrency: string;
  computedAtMs?: number;
  reason?: Extract<PortfolioPublishReason, 'reset' | 'debugClear'>;
}): void {
  publishPortfolioState({
    canonical: emptyPortfolioStateForEpoch({
      workEpoch: args.publishEpoch,
      quoteCurrency: args.quoteCurrency,
      computedAtMs: args.computedAtMs ?? Date.now(),
    }),
    reason: args.reason ?? 'debugClear',
    startEpoch: args.publishEpoch,
  });

  // Coordination ticks are not published render state and are intentionally
  // reset directly by this helper.
  populateProgressTick.value = 0;
  populateRetryTick.value = 0;
}

export function getSeriesIdlePoint(series: Series): Point | undefined {
  return series.points[series.points.length - 1];
}
```

`getSeriesIdlePoint(series)` is the named UI contract for idle balance/PnL display. Screens must not fork idle logic; idle reads the final emitted chart point.

Use one helper for deduping string arrays in triggers and queue code:

```ts
export function uniqueStrings(values: readonly string[] | undefined | null): string[] {
  return Array.from(new Set(values ?? []));
}
```

Do not hand-roll subtly different `unique(...)` helpers in individual triggers.

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

An empty scope is not a ready chart. It means the route has no visible wallets after livenet/deleted/visibility filtering. The UI should render the product’s empty/no-portfolio state and should not mount an empty chart. Empty scope resets `hasEverPublishedValidSeries` because the scope's wallet set has effectively become a different scope; when it becomes non-empty again, the next recompute publishes a valid series and flips the bit again. `hasEverPublishedValidSeries` flips true only when recompute actually publishes a non-empty valid `Series` for that scope and then persists across later incremental refreshes; `refreshing` is set while populate, rate refresh, or recompute work intersects that scope and clears when the publish lands.

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

### Invalid math quarantine

V2 must not preserve the legacy pattern of clamping invalid wallet math into valid-looking PnL. During recompute, any of the following conditions quarantine that wallet for the affected publish pass and preserve/add invalid-history context:

- negative running units after applying a snapshot/balance-change event;
- non-finite or negative remaining cost basis;
- non-finite display-unit conversion;
- required basis rate missing at the baseline or transaction timestamp;
- malformed snapshot ordering or duplicate cursor state that cannot be deterministically repaired;
- post-disposal units/basis relationship impossible under the pinned formula.

Quarantined wallets are excluded from generated PnL and row payloads. Their row shell may remain visible with `invalidHistoryBlocked: true` if wallet metadata and current balance are valid. Do not set invalid basis to zero and continue. Existing helper names such as `clampWalletAnalysisState` may be mined for tests but must not be reused in v2 render computation unless rewritten to return an explicit quarantine result.

### Daily snapshot compression

Preserve the existing snapshot compression contract in the v2 populate path.
`PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED` is pinned `true` for production
v2. Tests may override it only through explicit ingest fixtures. When enabled,
tx events older than
`PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS = 90` days are compressed into
one daily snapshot per UTC day instead of one persisted tx-level snapshot per
event. The daily snapshot must carry the day bucket's final `timestamp`,
`markRate`, `balanceAtomic`, and `remainingCostBasisFiat`; debug `txIds` are
preserved when debug mode records them. Recent tx events remain tx-level
snapshots.

Compression is an ingest/storage compaction with pinned old-history semantics.
For compressed days, recompute treats the emitted daily snapshot as the
authoritative state transition for that UTC day and must not infer or
reconstruct missing intra-day tx timing from compressed history. This is the
intentional exception to the dense tx-event processing rule for already
compressed old history; recent uncompressed history still processes every
in-window event. Resume checkpoints must preserve any in-progress daily
compression state so app-kill recovery does not duplicate or drop a daily
snapshot. Phase 0 must verify the retained snapshot kernel checkpoint already
carries that state (`daily` / partial UTC bucket equivalent). If not, classify
the kernel as `adapt before v2 use` and add the missing checkpoint fields before
v2 imports it. Required tests must compare compressed and uncompressed fixtures
on product-supported sample grids or explicitly pin any acceptable old
intra-day divergence.

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
  const eventRate = rateAt(eventTs);
  if (!Number.isFinite(eventRate)) quarantineWallet('missingBasisRate');
  remainingCostBasisFiat += deltaUnits * eventRate;
} else if (deltaUnits < 0) {
  if (beforeUnits <= 0) quarantineWallet('impossibleDisposal');

  const afterUnits = beforeUnits + deltaUnits;
  if (afterUnits < 0) quarantineWallet('negativeRunningUnits');

  if (afterUnits === 0) {
    units = 0;
    remainingCostBasisFiat = 0;
  } else {
    remainingCostBasisFiat *= afterUnits / beforeUnits;
  }
}

if (!Number.isFinite(remainingCostBasisFiat) || remainingCostBasisFiat < 0) {
  quarantineWallet('invalidRemainingCostBasis');
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

If `baselineUnits === 0` or `groupIndex(t0) <= 0`, the `WeightedGroupRateSeries` for that interval publishes `availability: 'unavailable'`, `unavailableReason: 'zeroBaseline'`, and `points: []`. This is interval-local: the `portfolioWeightedAssetGroup` route remains valid overall, and timeframe switching may reveal another interval with a valid baseline. The portfolio-entered weighted Exchange Rate screen should render an empty state such as “Not available for this interval; no holdings at the start of the window.” It may offer a separate “View market rate” action to a normal single-source market route, but it must not silently substitute a representative constituent series.

If baseline units are nonzero but at least one nonzero-baseline constituent rate source cannot produce a finite rate for the interval's required sample grid, the interval publishes `availability: 'unavailable'`, `unavailableReason: 'missingConstituentRate'`, and `points: []`. This covers missing canonical constituent asset rates, missing target/canonical BTC bridge rates, interpolation failures at a boundary or sample timestamp, malformed rate data, and non-finite bridged rate values. The runtime must not publish a partially weighted chart and must not fall back to a representative single-source market series. The timeframe selector remains enabled so the user can switch to another interval that may have all required constituent rates.

Build the weighted series only for collapsed groups with more than one distinct `FiatRateAssetRef`. Single-source groups reuse the ordinary market rate series and ordinary Exchange Rate route; they do not publish `weightedGroupRateSeries`. Weighted group series are derived render state; do not persist them in MMKV. Their fingerprint is a full-point hash over every emitted `weightedRate` and `weightedPercent` point plus the full `baselineUnitsByRateSourceKey` weight vector, not an endpoint-only hash.

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
  finalPointSource: 'historicalRate' | 'liveRate';
  points: readonly Point[];
}): string {
  return stableHash([
    args.inputFingerprint,
    args.interval,
    args.windowStartTs,
    args.windowEndTs,
    args.finalPointSource,
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

Weighted group rate fingerprints use the same full-point rule and also hash the weight vector. The discriminant `availability` must be hashed explicitly because it is part of the series identity, not merely implied by `unavailableReason`:

```ts
const sortedRateSourceKeys = Object.keys(baselineUnitsByRateSourceKey).sort();

weightedGroupRateFingerprint = stableHash([
  quoteCurrency,
  assetGroupId,
  walletIdsKey,
  interval,
  windowStartTs,
  windowEndTs,
  availability,
  unavailableReason ?? '',
  ...sortedRateSourceKeys.flatMap(key => [
    key,
    stableNumber(baselineUnitsByRateSourceKey[key] ?? 0),
  ]),
  ...points.flatMap(point => [
    point.ts,
    stableNumber(point.weightedRate),
    stableNumber(point.weightedPercent),
  ]),
]);
```

The baseline-unit vector is part of the series identity, not just the total baseline units. Two weighted indexes with the same endpoint values but different constituent weights must remain auditable and produce different fingerprints.

---

## 9. Fiat rates and BTC FX bridge

### Canonical rate reader and sampling policy

All render, row, weighted-rate, and quote-bridge code reads rates through one worklet-safe reader:

```ts
export type RateLookupResult =
  | {kind: 'rate'; rate: number; source: 'historical' | 'live'}
  | {
      kind: 'missing';
      reason:
        | 'missingSeries'
        | 'outsideSeriesWindow'
        | 'interpolationFailure'
        | 'nonFiniteRate'
        | 'missingBridgeRate'
        | 'zeroBridgeDenominator';
    };

export type PortfolioRateSamplingPolicy =
  | 'linearRender'
  | 'nearestSnapshotIngest';

export type RateReader = Readonly<{
  rateAt(args: {
    asset: FiatRateAssetRef;
    quoteCurrency: string;
    storedInterval: StoredRateInterval;
    ts: number;
    policy: PortfolioRateSamplingPolicy;
    allowLiveFinalPoint?: boolean;
  }): RateLookupResult;
}>;
```

Portfolio render and quote-bridge paths must use `linearRender`. Snapshot ingest may keep a separately named nearest/execution-time fallback only if product accepts that behavior and tests pin it. Missing bridge data must produce an unavailable interval or missing series; render code must not silently drop individual chart points.

### Rate-fetch retry/backoff

Rate-fetch failures use the same no-spin principle as populate failures. The exact storage can differ: populate retry state is persisted on queue items; rate-fetch retry state may be persisted or held in runtime memory as long as app-launch behavior is deterministic and tests cover it. Contract:

- network/BWS/parse/rate-limit failures record attempt count, `nextRetryAtMs`, error kind, and `lastErrorAtMs`;
- explicit user actions such as pull-to-refresh or manual refresh may force retry;
- background initial/app-launch freshen respects `nextRetryAtMs`;
- repeated failures cannot spin the rate-fetch runtime or continuously write MMKV;
- successful fetch clears retry state for the affected quote/rate-source/stored-interval dependency.

### Canonical quote

The canonical quote is fixed to `USD`:

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

### Hidden-wallet rate coverage

Hidden livenet wallets remain populate-eligible so their data is warm when unhidden. That only works if rates are warmed for hidden wallets too. Therefore there are two rate-dependency helpers with intentionally different membership rules:

```ts
buildEnsureFreshArgsForPopulateEligibleAssetGroups(args) // visibility-ignored
buildEnsureFreshArgsForVisibleAssetGroups(args)          // visibility-respecting
```

Use `buildEnsureFreshArgsForPopulateEligibleAssetGroups(...)` for initial populate, app-launch background freshen, and any populate-side historical rate coverage. It reads `getPopulateEligibleWalletsFromStore()` and includes hidden livenet/not-deleted wallets. This guarantees a hidden-only asset that was populated while hidden has canonical `USD` historical rates available on unhide.

Use `buildEnsureFreshArgsForVisibleAssetGroups(...)` for display-driven explicit historical refreshes such as pull-to-refresh and manual refresh. It reads visibility-respecting wallet sets and always unions canonical `BTC/USD` bridge dependencies. Passive `onLiveRatesUpdated` does not call this helper; it uses `liveRateTouch` only.

Unhide does not perform an ad hoc hidden-asset rate fetch for already manifest-populated wallets. If a manifest-populated hidden wallet lacks required canonical rates on unhide, that is a violated invariant and should fail tests. Wallets imported during a blocked window are not manifest-populated; their unhide path enqueues populate, and that populate path uses the visibility-ignored rate coverage helper before publishing PnL.

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

Weighted group exchange-rate series follow the same rule. For quote switches, bridge every constituent rate at every timestamp first, then rebuild the weighted series. The unavailable checks happen at the interval level, not point-by-point:

```ts
function buildBridgedWeightedGroupRateSeries(args): WeightedGroupRateSeries {
  const sortedRateSourceKeys = Object.keys(args.baselineUnitsByRateSourceKey).sort();
  const baselineUnits = sum(
    sortedRateSourceKeys.map(key => args.baselineUnitsByRateSourceKey[key] ?? 0),
  );

  const bridgedRateAt = (key: string, t: number): number | undefined => {
    const assetRate = rate_i(key, t, 'USD');
    const targetBtc = btcRate(t, args.targetQuote);
    const canonicalBtc = btcRate(t, 'USD');
    if (!isFinitePositive(assetRate) || !isFinitePositive(targetBtc) || !isFinitePositive(canonicalBtc)) {
      return undefined;
    }
    return assetRate * targetBtc / canonicalBtc;
  };

  const groupIndexAt = (t: number): number | undefined => {
    let total = 0;
    for (const key of sortedRateSourceKeys) {
      const units = args.baselineUnitsByRateSourceKey[key] ?? 0;
      if (units === 0) continue;
      const rate = bridgedRateAt(key, t);
      if (!Number.isFinite(rate)) return undefined;
      total += units * rate;
    }
    return total;
  };

  const groupIndex0 = groupIndexAt(args.windowStartTs);

  if (baselineUnits <= 0 || !Number.isFinite(groupIndex0) || groupIndex0 <= 0) {
    return {
      availability: 'unavailable',
      unavailableReason: !Number.isFinite(groupIndex0) ? 'missingConstituentRate' : 'zeroBaseline',
      points: [],
      // plus fingerprint/window/member/weight metadata
    };
  }

  const points: WeightedGroupRatePoint[] = [];
  for (const t of args.sampleTimestamps) {
    const groupIndexT = groupIndexAt(t);
    if (!Number.isFinite(groupIndexT)) {
      return {
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
        // plus fingerprint/window/member/weight metadata
      };
    }

    const weightedRate = groupIndexT / baselineUnits;
    const weightedPercent = ((groupIndexT - groupIndex0) / groupIndex0) * 100;
    if (!Number.isFinite(weightedRate) || !Number.isFinite(weightedPercent)) {
      return {
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
        // plus fingerprint/window/member/weight metadata
      };
    }

    points.push({
      ts: t,
      weightedRate,
      weightedPercent,
    });
  }

  return {
    availability: 'valid',
    points,
    // plus fingerprint/window/member/weight metadata
  };
}
```

Do not compute a USD weighted group series and then multiply it by one scalar. Do not bridge portfolio PnL while leaving `WeightedGroupRateSeries`, `RowPayload.rateStart`, `RowPayload.rateEnd`, or `RowPayload.ratePercent` in USD. Row rate fields must be recomputed from the same bridged constituent rates as the weighted group series.

The unavailable guard is interval-local. A `portfolioWeightedAssetGroup` route remains valid overall even when a specific interval publishes `availability: 'unavailable'` for `zeroBaseline` or `missingConstituentRate`; the UI renders that interval's weighted-rate chart as unavailable while allowing timeframe switches to intervals with valid weighted series. It must not auto-navigate to a representative `marketAsset` fallback.


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
- Provider, URL, MMKV key, and persist helpers accept `StoredRateInterval`; direct `3M`, `1Y`, or `5Y` arguments are rejected by types and test-build assertions.
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
portfolio:v2:workEpoch
portfolio:v2:manifest:v1
portfolio:v2:populate:queue:v1
portfolio:v2:generated:*       optional generated render cache if persisted later
snap:*                         wallet snapshots and invalid-history markers
rate:v1:*                      shared market-rate cache
```

### MMKV value sharding and write-size guard

Large portfolio data must be sharded across bounded MMKV values. Do not store
all portfolio data, all wallet snapshots, all rates, all chart points, or all
generated render cache in one MMKV value.

Required key granularity:

- manifest and queue keys contain metadata only;
- snapshots use per-wallet meta/index keys plus chunk keys:
  `snap:meta:v2:<walletId>`, `snap:index:v2:<walletId>`,
  `snap:chunk:v2:<walletId>:<chunkId>`;
- snapshot chunk writers must respect
  `PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET` as the target row budget and must also
  respect `PORTFOLIO_MMKV_VALUE_WARN_BYTES`; if a chunk at the row budget would
  exceed the byte warning threshold, split further by byte size before writing;
- rates are keyed per quote + asset/rate-source + stored interval:
  `rate:v1:<QUOTE>:<coin>:<storedInterval>` for native assets and
  `rate:v1:<QUOTE>:<coin>:<storedInterval>:<chain>:<tokenAddress>` for tokens;
- optional generated render cache, if added later, is keyed per scope and
  interval/fingerprint, not as one global render-state blob.

All v2 MMKV mutations go through this named helper family. Each helper carries
its own metric reason so spy tests can assert per-kind/per-reason counts
without inspecting logger strings:

```ts
export function writePortfolioMmkvString(args: {
  key: string;
  value: string;
  reason: PortfolioMmkvWriteReason;
  allowOversize?: boolean;
}): void;

export function deletePortfolioMmkvKey(args: {
  key: string;
  reason: PortfolioMmkvWriteReason;
}): void;

// Real-key-enumeration + registry-aware delete loop, NOT a `clearAll` proxy.
export function clearPortfolioMmkvKeysForReset(args: {
  reason: Extract<PortfolioMmkvWriteReason, 'reset' | 'wipe'>;
}): void;
```

`writePortfolioMmkvString(...)` records redacted key metadata (`keyHash`,
`keyLength`, `keyPrefixFamily`), approximate byte length, reason, and warning
status before delegating to the registry-aware portfolio KV store. Production
metrics must not include raw MMKV keys because keys can contain wallet IDs,
token addresses, account/key identifiers, or asset identifiers. Tests that need
raw keys may use local spies around the helper, not production metric payloads.
If MMKV metrics leave the device, `keyHash` must be omitted. Stable key hashes
are allowed only for local/dev diagnostics.
Writes larger than `PORTFOLIO_MMKV_VALUE_WARN_BYTES` must either be split into
smaller keys or pass `allowOversize: true` with a test-covered justification.
`allowOversize: true` is reviewer-enforced in Phase 1: the call site must
include a nearby grep-able
`portfolio-mmkv-allow-oversize` comment with the reason/ticket, and the
covering test name must mention the oversized write family. Future lint may
promote this convention to an automated check, but implementation must not
invent ad hoc oversized-write escape hatches.

`deletePortfolioMmkvKey(...)` records the same metric shape with `kind:
'mmkvWrite'` and the caller-supplied reason, then delegates to the
registry-aware delete. `clearPortfolioMmkvKeysForReset(...)` is the only legal
v2 reset/wipe entry point: it enumerates real MMKV keys plus registry-tracked
keys and routes each removal through `deletePortfolioMmkvKey(...)` so every
deletion is metric-traced. Direct calls to `workletKvClearAll(...)` or any
registry-only clear-all proxy are forbidden in v2 because they bypass real-key
enumeration; the safer wipe contract requires both surfaces to be reconciled.

Raw `kvStore.setString(...)`, `kvStore.delete(...)`, raw MMKV `.set(...)` /
`.delete(...)`, `workletKvClearAll(...)`, and ad hoc storage bridges are
forbidden outside this helper family and low-level tests. Timeframe switch,
scrub, and passive live-rate touch paths perform zero MMKV mutations through
any of the three helpers and zero direct calls to the wrapped low-level
exports.

The MMKV mutation helper family must be available from portfolio worklet
runtimes, or expose worklet-safe wrappers with identical metrics and guard
semantics. Populate and rate-fetch persistence must not route through JS merely
to satisfy the helper-family requirement.

### Show Portfolio off wipe

Default wipe prefixes:

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
PORTFOLIO_WORK_EPOCH_KEY
```

`PORTFOLIO_WORK_EPOCH_KEY` is excluded so a reset-created epoch bump remains durable while stale async work drains.

Do **not** wipe shared `rate:v1:*` by default because Exchange Rate surfaces remain visible when Show Portfolio is off and use the same market-rate cache. If product decides market-rate cache is portfolio-owned and must also be cleared, introduce a separate explicit option and test that Exchange Rate surfaces refetch without being hidden.

### MMKV registry discipline

All portfolio v2 MMKV access uses the dedicated portfolio storage instance returned by `getPortfolioMmkvStorageOnRN()`. All writes and deletes go through the v2 MMKV mutation helper family so the registry-backed key tracker remains consistent. Low-level helpers such as `kvStore.delete(key)` are implementation details inside that helper family, not reset/wipe orchestration entry points.

Add an RN-only real-key enumeration helper:

```ts
export function listRealPortfolioMmkvKeysOnRN(): readonly string[] {
  return getPortfolioMmkvStorageOnRN().getAllKeys();
}
```

The worklet storage bridge does not need `getAllKeys`; reset/wipe orchestration runs from RN/JS through `clearPortfolioMmkvKeysForReset(...)`.

Wipe implementation contract:

```txt
1. enumerate real keys from getPortfolioMmkvStorageOnRN().getAllKeys();
2. enumerate registry-tracked keys from kvStore.listKeys();
3. union both sets so unregistered real keys and stale registry-only keys are both considered;
4. filter portfolio-owned prefixes;
5. exclude PORTFOLIO_V2_FLAG_KEY, PORTFOLIO_CACHE_INVALID_KEY, and PORTFOLIO_WORK_EPOCH_KEY;
6. delete through deletePortfolioMmkvKey(...), not raw MMKV.delete(...) or direct kvStore.delete(...);
7. assert both storage.getAllKeys() and kvStore.listKeys() are clean after successful wipe.
```

Do not use `kvStore.listKeys()` as the only wipe source of truth because a stale registry could miss real MMKV keys. Do not call raw `MMKV.delete` or direct `kvStore.delete(...)` from v2 reset/delete orchestration because they bypass the mutation helper metrics/guards or can leave the registry reporting deleted keys.
Do not use legacy `PortfolioEngine.clearAllData()` or `kvStore.clearAll()` for v2 reset unless they are rewritten to follow this real-key enumeration contract; registry-only behavior is insufficient for wipe correctness.

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
  extra?: PortfolioRuntimeLogExtra,
): void;

export type PortfolioRuntimeLogExtra = Readonly<{
  tag?: string;
  reason?: string;
  errorName?: string;
  errorCode?: string;
  phase?: string;
  runtimeKind?: PortfolioRuntimeKind;
  walletCount?: number;
  assetGroupCount?: number;
  rateSourceCount?: number;
  pointCount?: number;
  retryAttempt?: number;
  warning?: boolean;
}>;
```

Contract: never throws, never returns a Promise, always tags `subsystem: 'portfolio-v2'`, includes `extra.tag` when present, and is safe for `.catch(logPortfolioRuntimeError)`.

Portfolio v2 off-device telemetry/logging is allowlisted, not best-effort
redacted. Portfolio v2 production code must not call `LogActions`, `logManager`,
or `Sentry` directly; route runtime errors through `logPortfolioRuntimeError`
and structured counters/timing through `recordPortfolioV2Metric(...)`.

Allowed off-device runtime-log fields are only the safe scalar fields in
`PortfolioRuntimeLogExtra` plus the fixed `subsystem: 'portfolio-v2'`. Do not
pass arbitrary `extra` objects. Do not send raw `Error.message`, request URLs,
headers, raw MMKV keys, wallet IDs, key/account IDs, token addresses, txids,
manifests, queues, snapshots, rates, checkpoints, `PortfolioState`, or
tx-history/rate response bodies to Sentry, breadcrumbs, persisted logs, or
metrics. If a local developer build needs the original error message, keep it
behind an explicit local-only diagnostic path and sanitize before display.

Debug copy/export payloads are explicit user/local diagnostics only. They must
remain redacted and must never be auto-attached to Sentry events, log
breadcrumbs, runtime metrics, or error reports.

### Reset sequence

```ts
async function performResetSequence(): Promise<void> {
  if (inFlightReset) return inFlightReset;

  inFlightReset = (async () => {
    setPopulateResetInFlight(true);
    bumpPortfolioWorkEpoch('resetStart');
    try {
      cancelPopulate();
      await Promise.all([
        waitForPopulateLoopToStop(),
        waitForRecomputeDrainToStop(),
        waitForEnsureFreshToStop(),
      ]);
      markPortfolioCacheInvalid();
      await wipePortfolioMmkvKeys();
      const publishEpoch = getCurrentPortfolioWorkEpoch();
      resetSharedPortfolioStateForDebugClear({
        publishEpoch,
        quoteCurrency: getQuoteCurrencyFromStore(),
        reason: 'reset',
      });
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
    | {kind: 'touchWallets'; walletIds: readonly string[]}
    | {kind: 'liveRateTouch'; changedAssetIds?: readonly string[]};

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

  // Scopes currently mounted/requested by UI. Protected from LRU eviction during
  // this recompute. Mount sites pass their resolved walletIdsKey when they
  // schedule scoped recompute; the compute runtime does not maintain a separate
  // hidden mount tracker.
  protectedScopedWalletIdsKeys?: readonly string[];
}>;

export type BaseRecomputeInputs = Omit<RecomputeInputs, 'scope'>;

export function buildBaseRecomputeInputsAtFireTime(): BaseRecomputeInputs;
```

`buildBaseRecomputeInputsAtFireTime()` reads Redux/manifest/queue at call time through `reduxAccess.ts` and returns every field except `scope`. It is the only helper triggers should use before `scheduleRecompute(...)`; do not cache its result in module scope or React refs.

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

### Passive live-rate touch recompute

`{kind: 'liveRateTouch'}` is the only recompute scope that `onLiveRatesUpdated` may schedule. Passive live-rate touches may update in-memory/current-value published render state, including live-rate-backed final points and row payloads, but they must perform zero MMKV mutations and zero historical snapshot/rate refresh work. They consume already-updated live-rate data from Redux and update current-value surfaces only:

- global row-shell `currentFiatValue`;
- current global total/scope fiat aggregates;
- cached `scopedByWalletSet[walletIdsKey]` current-value surfaces using the same rules as global rows/totals;
- final chart points only for `Series` whose `finalPointSource === 'liveRate'`;
- every `RowPayload` derived from any live-updated final point, in the same published revision as that final-point update.

`liveRateTouch` must not rebuild historical chart points before the final point, historical weighted group rate series, persisted historical rate fields, snapshots, manifest readiness, populate queue state, populate order, or `rate:v1:*` MMKV data. It must not call `ensureFresh`, fetch, refresh snapshots, enqueue populate, or change `orderRevision`. Historical point values `points[0..last-1]` must remain unchanged. The series fingerprint changes only when an eligible live-rate final point changes; it must not change solely because passive live-rate churn occurred for a historical-rate-backed series.

If `changedAssetIds` can be mapped exactly to `FiatRateAssetRef` / `assetGroupId` / wallet membership, `liveRateTouch` may narrow to affected current-value surfaces. If mapping is uncertain, especially for collapsed ticker groups, fall back to a `liveRateTouch` over all current-value surfaces. Never use a partial mapping that could omit one member of a collapsed group.

`liveRateTouch` is visibility-respecting for displayed/current-value surfaces. It does not replace the separate visibility-ignored hidden-wallet historical-rate warming performed by populate/background freshen.

### Scheduler

The scheduler coalesces and drains in this order:

```txt
full → wallet/wallets → liveRateTouch → touch/touches
```

A pending full does not discard pending wallet builds or touches unless the merge rule explicitly subsumes them. It does subsume pending `liveRateTouch`, because full historical recompute rebuilds current values as a strict superset. This preserves progressive populate updates and focus/touch bookkeeping while preventing redundant passive live-rate churn.

All scheduler publishes to `sharedPortfolioState.value` occur through `publishPortfolioState(...)` on the compute runtime. No trigger writes published render state directly. No compute path may write `sharedPortfolioState.value` directly.

### Work epoch and stale publish rejection

Every async portfolio operation captures `workEpoch` at start. The epoch is persisted under `PORTFOLIO_WORK_EPOCH_KEY` and mirrored in the compute runtime.

Epoch bumps happen when:

- Show Portfolio OFF latches a wipe obligation;
- `performResetSequence()` begins;
- wallet/key/account deletion reconciliation starts;
- quote currency changes;
- the v2 feature flag changes;
- post-auth repair observes `portfolio:v2:cacheInvalid`;
- debug clear starts.

Before any operation persists queue/manifest/rate/snapshot output or publishes render state, it must re-read the current epoch and guard:

```ts
if (startEpoch !== getCurrentPortfolioWorkEpoch()) {
  logPortfolioRuntimeError(new Error('stale portfolio work discarded'), {
    tag: 'staleWorkEpoch',
    startEpoch,
    currentEpoch: getCurrentPortfolioWorkEpoch(),
  });
  return;
}
```

Populate may finish the currently active wallet after cancellation, but it must not publish or mark manifest state if its captured epoch is stale. Rate fetch may complete network I/O, but stale rate writes are discarded. Recompute may finish CPU work, but stale render output is not published. Long recompute loops should process wallets/assets in chunks and check `workEpoch` between chunks so stale work exits promptly.

Scheduler merge rules are explicit:

| Existing pending work | Incoming work | Result |
|---|---|---|
| none | full | full |
| none | liveRateTouch(A) | liveRateTouch(A) |
| liveRateTouch(A) | liveRateTouch(B) | one coalesced liveRateTouch with `changedAssetIds = A ∪ B`; if either side has no `changedAssetIds`, result is liveRateTouch over all current-value surfaces |
| full | liveRateTouch | full; full subsumes liveRateTouch |
| liveRateTouch | full | full; full subsumes liveRateTouch |
| full | wallet/wallets | full + wallet/wallets; full does not subsume wallet builds |
| wallet(A) | liveRateTouch | both retained; wallet rebuild runs first, then liveRateTouch updates current-value surfaces not covered by the wallet rebuild |
| liveRateTouch | wallet(A) | both retained; wallet rebuild runs first, then liveRateTouch |
| wallet(A) | wallet(A) | wallet(A), deduped |
| wallet(A) | wallet(B) | wallets(A,B), merged |
| wallet(A) | touch(A) | wallet(A), touch dropped as subsumed |
| touch(A) | wallet(A) | wallet(A), prior touch dropped |
| full | touch(A) | full + touch(A); full does not subsume touch bookkeeping |
| touch(A) | liveRateTouch | both retained; liveRateTouch updates values, touch preserves access metadata |
| liveRateTouch | touch(A) | both retained |
| touch(A) | touch(B) | touches(A,B), merged |

Base inputs merge by taking the newest quote/live-rate fields, unioning populated/invalid-history IDs and evict sets, and taking the order/display-order pair with the higher `orderRevision`. `protectedScopedWalletIdsKeys` are unioned. `liveRateTouch` inputs coalesce so passive live-rate churn cannot accumulate unbounded pending work.

### Scoped cache cap and eviction

```ts
export const MAX_SCOPED_CACHE_ENTRIES = 8;
```

`scopedByWalletSet` is a bounded LRU cache, not an unbounded map.

Eviction policy:

1. Each scoped-cache hit or touch updates `lastAccessedAt` for that `walletIdsKey` through a touch recompute or the next scoped rebuild.
2. The currently requested/mounted `walletIdsKey` is protected from eviction during the recompute that requested it. Mount sites pass these keys through `protectedScopedWalletIdsKeys`; there is no hidden runtime-side mount tracker.
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
selectPortfolioStatus(state)
selectScopedSeries(state, walletIdsKey, interval)
selectScopedAssetGroupSeries(state, walletIdsKey, assetGroupId, interval)
selectScopedAssetGroupRows(state, walletIdsKey, mode)
selectScopedOrderedAssetGroupIds(state, walletIdsKey)
stableWalletIdsKey(walletIds)
```

### `usePortfolioStatus`

`usePortfolioStatus` reads the minimal top-level `PortfolioStatus` plus optional `ScopeReadiness` for the requested scope. It exposes status states for invalid history, missing rates, stale data, and retry pending without requiring UI code to inspect manifest, queue, MMKV, or Redux. Full `PortfolioDataQuality` can be added later, but the initial hook surface should remain small and runtime-published.

### `usePortfolioSlice`

Do not copy the entire `sharedPortfolioState` object into React.

Selectors run in the UI worklet and only the selected slice crosses into React:

```ts
export type WorkletPortfolioSelector<T> = (state: PortfolioPublishedState) => T;
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
  populateWallet(walletId, {reason: 'send', priority: 'urgentUserVisible'});
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

```ts
export function onLiveRatesUpdated(args?: {
  changedAssetIds?: readonly string[];
}): void;
```

`onLiveRatesUpdated` is passive-only. It observes that the existing Redux live-rate slice has already changed; it does not initiate historical freshness work.

1. Guard before side effects.
2. If Show Portfolio is off, return.
3. Debounce/coalesce entry calls by `PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS`.
4. When the debounce fires, re-check `canRunPortfolioV2Work()` and `getShowPortfolioEnabledFromStore()`. If either flipped, no-op.
5. Verify quote safety: either Phase 0 proved the live-rate slice is always current-quote, or `getLiveRatesQuoteCurrencyFromStore()` must equal the current portfolio quote. On mismatch, no-op; quote changes are handled by `onQuoteCurrencyChanged`, not by applying wrong-quote live rates.
6. Build fire-time recompute inputs from already-available store/rate data and `scheduleRecompute({scope: {kind: 'liveRateTouch', changedAssetIds}})`.

It must not call `ensureFresh`, fetch historical rates, refresh snapshots, enqueue populate, mutate persisted `rate:v1:*` or `snap:*` MMKV, or schedule `scope: 'full'`. Explicit historical freshness actions go through `onPullToRefresh`, future manual-refresh triggers, or the Phase-0-conditional `onHistoricalRatesPersisted(...)` notification described below.

`liveRateTouch` updates current-value surfaces only. If it updates a live-rate-backed final chart point, every row payload derived from that endpoint must update in the same published revision so row/detail endpoint equality remains true. Cached scoped slices update their current-value surfaces by the same rules as global slices; scoped historical chart points are not rebuilt.

### Historical rates persisted notification 

Phase 0 must decide whether this trigger is needed. Add it only if Exchange Rate screens, debug tools, or other non-v2-owned paths can persist shared historical `rate:v1:*` data that portfolio v2 did not itself fetch and already schedule.

```ts
export function onHistoricalRatesPersisted(args: {
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  source: 'exchangeRateScreen' | 'manualRefresh' | 'externalEffect';
}): void;
```

This trigger is a no-fetch notification. It recomputes from already-persisted rates, with guard-before-side-effects and fire-time inputs, and may target affected assets/scopes or fall back to full historical recompute if mapping is unsafe. It must not fetch rates, refresh snapshots, or enqueue populate. V2 triggers that already orchestrate persist + recompute, such as `onPullToRefresh` or send-driven populate completion, must not also fire `onHistoricalRatesPersisted`; doing so would double-schedule recompute. If Phase 0 verifies navigation-only Exchange Rate screens do not persist portfolio-relevant historical rates, document that and do not add this trigger.

### Key imported

If Show Portfolio is enabled, requeue all livenet wallets in the imported key. Hidden wallets are included because populate is visibility-ignored.

### Wallets/key/account visibility changed

1. If an unhidden livenet wallet is already manifest-populated, do not enqueue it. Warm snapshot data will be re-included by the visibility-respecting recompute.
2. If the wallet has an active invalid-history marker, do not enqueue it on unhide.
3. If the wallet is manifest-invalid-history and the persisted marker is expired, enqueue a retry, but do not clear manifest invalid-history state from this trigger. At item start, the populate loop re-checks the persisted marker and may attempt the wallet. The invalid-history manifest entry is removed only by successful populate through `markManifestPopulated`; if retry fails, the prior context remains or is replaced by a new marker.
4. If the wallet is neither manifest-populated nor manifest-invalid-history-blocked and it lacks populated state because it was imported during a blocked window, enqueue populate.
5. Schedule a full recompute using visibility-respecting eligible wallets.
6. Do not delete snapshots.

### Wallets/key deleted

Deletion uses a triple-guard contract because this path races with reset, populate, and shared-state publishing. The first executable statement must be the guard.

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

The JS-side `populateLoopRunning.value` check is an optimization to avoid unnecessary `runOnRuntimeAsync` dispatch. SharedValue reads from JS can lag by a frame; the worklet-side single-flight guard inside `runPopulate()` is the authoritative guard.

Do not call `populateWallets(loadQueue().pending.map(...))` here. `populateWallets` appends new run-scoped items; using it for survivors can duplicate pending work, lose original priorities/checkpoints, and rewrite reasons/runIds.

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
| `onPullToRefresh` | `ensureFresh(force: true)` → `populateWallets(changedWalletIds, {reason: 'pullToRefresh', priority: 'urgentUserVisible'})` → `scheduleRecompute` | User explicitly asked for fresh rates/snapshots. |
| `onSendCompleted` | `populateWallet(walletId, {reason: 'send', priority: 'urgentUserVisible'})` | Sent-from wallet should refresh promptly; recompute publishes from progress tick. |
| `onQuoteCurrencyChanged` | `ensureQuoteCurrencyFxBridge` → `recomputeQuoteBridgeFromExistingData` | Bridge data must exist before target-quote publish. No per-asset target-quote fetch. |
| `onLiveRatesUpdated` | debounce/coalesce → fire-time guards → `scheduleRecompute({scope: {kind: 'liveRateTouch'}})` | Passive live-rate churn updates current-value surfaces only and never initiates historical freshness. |
| `onKeyImported` | `populateWallets(livenetWalletIds, {reason: 'keyImport', priority: 'normalUserVisible'})` | New livenet wallets need snapshots before PnL exists. |
| `onWalletsDeleted` | guard → cancel/wait populate → guard → reconcile → clear snapshots → guard → full recompute with `evictScopedWalletIds` → `kickPopulateLoopIfIdle()` | Prevents populate/write races and stale scoped entries. |
| `onWalletsVisibilityChanged` | optional populate for newly visible never-populated wallets → full recompute | Visibility changes display eligibility, not snapshot persistence. |
| `onShowPortfolioVisibilityChanged(false)` | latch wipe obligation → `performResetSequence` | OFF means clear portfolio data and hide portfolio surfaces. |
| `onShowPortfolioVisibilityChanged(true)` | discharge latched wipe → repair invalid bit if needed → start fresh populate | ON must never populate from stale pre-wipe data. |

Default for future explicit historical freshness triggers: `ensureFresh` first, then publish. Use warm-publish-first only when product explicitly requires “show what we already have before network.” Passive live-rate notifications are not historical freshness triggers; they must use `liveRateTouch`.

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
- `currentFiatValue` is computed by summing each visible nonzero member wallet at that wallet's own `FiatRateAssetRef` / live-rate key; a collapsed ticker group uses a single group rate only when all nonzero members share the same rate source. If there are visible members and all have zero current units, runtime publishes `currentFiatValue: 0`. If any visible nonzero member lacks a live rate, runtime publishes `currentFiatValue: undefined`; zero-unit members with missing rates do not block the aggregate. If no visible members exist, no shell is published.
- Ready Today uses `rowToday`.
- Ready All Time uses `rowAllTime`.
- Not ready uses skeleton/right-side placeholder.
- Invalid-history blocked uses skeleton footprint plus error-ready affordance.
- Switching Today/All Time never changes order.
- Home and All Assets use the same global display order.
- Allocation uses the same display order as All Assets for the same scope.

### Charts

A balance chart receives a `Series | undefined` and a `ScopeReadiness`.

First-populate behavior:

- if no prior valid series and `initialScopeReady === false`, hide chart;
- if invalid-history blocked and no valid series, show error-ready affordance where product wants it;
- if ready, show chart.

Incremental behavior:

- if `hasEverPublishedValidSeries`, keep stale chart visible while `refreshing` is true;
- replace chart atomically when new series publishes.

For a portfolio-entered `portfolioWeightedAssetGroup` Exchange Rate route, the selected interval reads `WeightedGroupRateSeries` instead of `Series`. If that interval has `availability: 'unavailable'`, the chart pane renders an interval-local empty state, keeps the timeframe selector enabled, and does not navigate to or silently substitute a `marketAsset` route. Switching intervals may reveal a valid weighted series. If `availability: 'valid'`, every point is finite and the chart renders normally.

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
- Inventory all current populate wallet-source helpers. Existing helpers that derive populate wallets from visible/home-carousel wallets must not be reused for v2 populate construction. V2 populate eligibility is built from all stored wallets under `WALLET.keys`, filtered only by livenet/mainnet, not-deleted, credential completeness, pending-TSS status, and runtime eligibility.
- Classify every retained v1 kernel as `reuse unchanged`, `adapt before v2 use`, `test fixture only`, or `delete after soak`.
- Add `PORTFOLIO_V2` feature flag, default false.
- Confirm dedicated portfolio MMKV instance and registry behavior.
- Confirm whether `rate:v1:*` is shared with Exchange Rate screens. The default is not to wipe shared market-rate cache entries.
- Inventory the live-rate Redux slice: verify whether it is always maintained in the current display quote. If not, add a `getLiveRatesQuoteCurrencyFromStore()` accessor and make passive live-rate touches no-op on quote mismatch.
- Inventory Exchange Rate screen/navigation behavior: determine whether navigation-only or screen-local refresh paths persist shared historical `rate:v1:*` data outside v2-owned triggers. If yes, implement the no-fetch `onHistoricalRatesPersisted(...)` notification; if no, document that historical rate persistence is only from v2-owned pull/manual refresh paths.
- Inventory the JS-thread helper module/export surface that Nitro boundary tests must spy on. Record tx-history signing/request helpers and BWS fiat-rate signing/request/fetch helpers so tests can assert populate and `ensureFresh` never trampoline through those JS helpers after dispatch. The JS-side context creator may be called once at kick time.
- Inventory the v2 MMKV mutation spy-target surface. Record the helper family
  (`writePortfolioMmkvString(...)`, `deletePortfolioMmkvKey(...)`,
  `clearPortfolioMmkvKeysForReset(...)`), the low-level mutation exports each
  helper wraps, and the explicitly **un**wrapped exports (`workletKvClearAll`,
  raw MMKV `.set`/`.delete`) so zero-mutation tests can assert that timeframe
  switches, chart scrubbing, and passive live-rate touches perform no MMKV
  writes, deletes, or clears.
- Verify retained snapshot compression checkpoint state. If the current kernel
  does not persist in-progress daily/UTC-bucket compression state across resume,
  classify the snapshot kernel as `adapt before v2 use` instead of
  `reuse unchanged`.
- Classify each RN adapter module separately as `v2 adapter, keep in place`, `v2 adapter, relocate to src/portfolio/v2/adapters/rn/**`, `v1-only adapter, delete after soak`, or `shared low-level adapter, keep and document owner`.

Acceptance:

- Inventory document checked in.
- Feature flag readable on JS and worklet paths.
- Inventory proves every v2 populate/background-rate path uses visibility-ignored eligible wallets, and every display/recompute path uses visibility-respecting wallets.
- Hidden livenet wallet fixture appears in populate eligibility and background rate coverage, but not display eligibility.
- Retained-kernel classification document checked in; no v2 import is allowed before its adapter checklist passes.
- Nitro boundary spy-target inventory is checked in and names the JS helper modules/exports that populate and rate-fetch loop bodies must not call.
- MMKV mutation spy-target inventory is checked in and names the helper family
  exports plus the wrapped/un-wrapped low-level mutations used by zero-mutation
  UI-interaction tests.
- Snapshot compression checkpoint inventory is checked in; retained snapshot
  kernels are classified `reuse unchanged` only if in-progress daily compression
  state survives resume.
- RN adapter classification document checked in; no directory-wide keep/delete decision is allowed for `src/portfolio/adapters/rn/**`.
- No behavior change with flag off.

### Phase 1 — V2 scaffolding

Create:

```txt
src/portfolio/v2/model.ts
src/portfolio/v2/constants.ts
src/portfolio/v2/runtimes.ts
src/portfolio/v2/sharedState.ts
src/portfolio/v2/reduxAccess.ts
src/portfolio/v2/kvStore.ts
src/portfolio/v2/logPortfolioRuntimeError.ts
src/portfolio/v2/manifest.ts
src/portfolio/v2/ordering.ts
src/portfolio/v2/recompute.ts
src/portfolio/v2/scheduler.ts
src/portfolio/v2/selectors.ts
src/portfolio/v2/triggers.ts
src/portfolio/v2/routes/routeScope.ts
src/portfolio/v2/routes/exchangeRateRoute.ts
src/portfolio/v2/hooks/usePortfolioSlice.ts
src/portfolio/v2/hooks/usePortfolioChart.ts
src/portfolio/v2/hooks/usePortfolioAssetRows.ts
src/portfolio/v2/hooks/usePortfolioStatus.ts
src/portfolio/v2/populate/queue.ts
src/portfolio/v2/populate/reconciliation.ts
src/portfolio/v2/populate/populateLoop.ts
src/portfolio/v2/populate/api.ts
src/portfolio/v2/populate/resume.ts
src/portfolio/v2/populate/resetState.ts
src/portfolio/v2/populate/performResetSequence.ts
src/portfolio/v2/workletData/snapshotsKv.ts
src/portfolio/v2/workletData/ratesKv.ts
src/portfolio/v2/workletData/ratesFetch.ts
src/portfolio/v2/debug.ts
src/portfolio/v2/metrics.ts
src/portfolio/v2/__tests__/fixtures/
```

Define model types from this plan, including `Point.remainingUnrealizedPnlFiat`, `PortfolioManifestV1`, `PopulateQueueV1`, `ScopeReadiness`, and `AssetGroupRowShell`.

Acceptance:

- Typecheck green.
- Unit tests for empty state, `emptyPortfolioStateForEpoch(...)`, manifest load/save, queue load/save, reset invalid bit, Redux access init, shared values (`sharedPortfolioState`, cancel/running flags, progress/retry ticks), `resetSharedPortfolioStateForDebugClear`, and portfolio telemetry/logging allowlists.
- Runtime scaffolding tests prove `react-native-worklets` is the portfolio runtime substrate and runtime-kind initializers install only the allowed globals.
- `publishPortfolioState(...)` is the only legal write path for `sharedPortfolioState.value`, checks `workEpoch`, records metrics, and initially projects canonical state unchanged through the `PortfolioPublishedState = PortfolioState` alias.
- `resetSharedPortfolioStateForDebugClear(...)` publishes through `publishPortfolioState(...)` with a current-epoch empty state and may only reset coordination ticks directly.
- Metrics module records publish duration, approximate payload size, MMKV
  mutation value size (writes; deletes/clears report bytes as zero), revision,
  reason, redacted key metadata (`keyHash`, `keyLength`, `keyPrefixFamily`),
  and warning state without failing CI on initial thresholds. Each MMKV mutation
  helper (`writePortfolioMmkvString`,
  `deletePortfolioMmkvKey`, `clearPortfolioMmkvKeysForReset`) emits a
  `PortfolioV2Metric { kind: 'mmkvWrite' }` record so tests can assert
  per-kind/per-reason counts without inspecting logger strings.
- `logPortfolioRuntimeError` rejects or drops non-allowlisted fields and never
  sends raw IDs/URLs/keys/error messages to Sentry breadcrumbs, persisted logs,
  or metrics.

### Phase 2 — Snapshot/rate readers and canonical rates

- Add snapshot index `revision` if needed.
- Add async v2 readers for snapshots and rates.
- Implement `resolveStoredRateInterval`.
- Implement `ensureFresh` with freshness-check/fetch/persist separation and a second guard before persist.
- Use dedicated rate-fetch runtime.
- Implement both rate-dependency helpers: `buildEnsureFreshArgsForPopulateEligibleAssetGroups(...)` for visibility-ignored populate/background coverage, and `buildEnsureFreshArgsForVisibleAssetGroups(...)` for explicit display refreshes. Both always union canonical `BTC/USD` dependencies for `1D`, `1W`, `1M`, and `ALL`.
- Implement `ensureQuoteCurrencyFxBridge` for target BTC rates only.
- Implement canonical `RateReader` with `linearRender` for render/quote bridge and explicitly named `nearestSnapshotIngest` only where accepted.
- Implement rate-fetch retry/backoff so repeated network/BWS/parse failures cannot spin.

Acceptance:

- `3M`/`1Y`/`5Y` never create separate rate keys.
- `3M`/`1Y`/`5Y` never create separate BWS URLs, even if provider/URL helpers are called directly in tests.
- Provider, URL, MMKV key, and persist helpers accept only `StoredRateInterval`.
- Render/quote-bridge paths use the canonical `RateReader`; nearest lookup is allowed only in the explicitly named snapshot-ingest path.
- Missing BTC bridge or constituent rates fail the interval deterministically instead of silently dropping chart points.
- `BTC/USD` is ensured even if portfolio has no BTC wallet.
- Quote switch fetches only `BTC/<target>`, except `target === 'USD'`, which performs no target BTC fetch and uses canonical USD rates directly.
- Hidden livenet wallet rate coverage test passes: a hidden-only populated asset has canonical USD historical rates warmed by the visibility-ignored populate/background freshen helper and can unhide without an ad hoc rate fetch.
- Rate fetch context lifecycle tests pass.
- Rate-fetch Nitro boundary acceptance passes: BWS fiat-rate signing/request fetching and response processing occur through the rate-fetch runtime's worklet/Nitro path, with zero JS-thread rate request/signing calls during `ensureFresh`.
- Rate-fetch retry/backoff tests pass: repeated failures do not spin, background work respects `nextRetryAtMs`, explicit user refresh can force retry, and successful fetch clears retry state.

### Phase 3 — Recompute, formula, fingerprints, scoped cache

- Implement shared interval-window helper used by portfolio and Exchange Rate tests.
- Implement capped chart sample grid with endpoint preservation.
- Implement PnL formula consuming all balance-change events, not only emitted timestamps.
- Implement full-point series fingerprint.
- Implement global and scoped recompute.
- Implement scope readiness.
- Implement row shells and row payloads derived from series endpoints.
- Implement row-shell crypto amount by summing per-member display units and publish minimal `groupHealth` metadata for decimal conflicts, distinct collapsed assets, and missing live-rate members.
- Implement invalid-math quarantine and remove/avoid v1-style clamping in v2 render computation.
- Implement quote-bridge reprice from snapshots/rates using per-timestamp formula, including rebuild of `WeightedGroupRateSeries` and row rate fields from bridged constituent rates.

Acceptance:

- Product-oracle PnL fixtures pass.
- No-transaction PnL percent equals the ordinary Exchange Rate percent for single-rate-source assets and equals the baseline-unit weighted group exchange-rate percent for collapsed multi-rate-source asset groups, including the pinned `180.392 → 180.592 → 0.1108696616%` fixture (`weightedRate` tolerance `1e-12`; `weightedPercent` tolerance `1e-10`).
- Row/detail equality passes globally and key-scoped.
- Quote-switch in-window transaction fixture matches from-scratch bridged recompute.
- Mid-series mutation changes the relevant full-point fingerprint. Chart re-render from that fingerprint is asserted in Phase 4, after hooks are wired.
- Weighted `missingConstituentRate` acceptance passes in Phase 3: any missing/non-finite constituent rate or required BTC bridge rate makes only that selected weighted interval unavailable with `points: []`, no partial chart, and no representative fallback.
- Collapsed row crypto amount is computed by summing per-member display-unit amounts, not raw atomic balances. Decimal-conflict and missing-rate metadata publish through `groupHealth`.
- Invalid wallet math fixtures quarantine affected wallets rather than clamping non-finite/negative basis or negative running balances into valid-looking PnL.
- Scoped cache cap/LRU tests pass, including refresh-before-eviction and protected current-scope behavior.

### Phase 4 — Scheduler and hooks

- Implement scheduler drain order `full → wallet/wallets → liveRateTouch → touch/touches`.
- Implement `usePortfolioSlice` with UI-runtime selector evaluation.
- Implement typed hooks: `usePortfolioChart`, `usePortfolioAssetRows`, `usePortfolioStatus`.
- `usePortfolioStatus` exposes top-level `PortfolioStatus` plus scope readiness without reading manifest, queue, MMKV, or Redux from UI components.
- Implement selectors as pure worklet functions.
- Add import restrictions so UI cannot call generic compute/request APIs.

Acceptance:

- No hook copies full `PortfolioState` into React except debug-only helpers.
- Timeframe switch triggers no runtime/fetch/populate/snapshot work.
- Scoped selector cache misses return skeleton state, not JS aggregation.
- Status hooks render differentiated invalid-history, missing-rate, stale, and retry-pending states from published runtime state only.
- Scheduler merge table tests pass: full+wallet preservation, wallet+touch subsumption, touch+wallet replacement, `liveRateTouch` coalescing/subsumption, evict/protected-key union, and FIFO-preserving drain behavior.
- A changed series/weighted-series fingerprint causes the relevant chart/hook consumer to re-render; cloned state with unchanged fingerprints does not.

### Phase 5 — Populate runtime

- Implement manifest-aware run-scoped queue operations.
- Implement queue priority insertion for urgent send/pull refresh work.
- Implement active-item resume normalization and checkpoint/restart behavior.
- Implement visibility-ignored populate eligibility.
- Implement one-wallet-at-a-time populate loop using existing kernels.
- Implement populate retry/backoff with persisted `PopulateRetryState` on queue items and no-spin scheduling.
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
- Checkpoint JSON/non-optional-boolean acceptance passes in this phase: persisted cursor data must be JSON-serializable/schema-validated, failure booleans are non-optional, and invalid checkpoints clear only wallet staging before safe restart.
- Testnet/regtest wallets never enter queue.
- Nitro boundary acceptance passes: populate's tx-history signing/request/pagination/response-processing loop body makes zero JS-thread fetch/signing/request calls; the JS-side context creator is called once at kick time and never inside the loop body.
- Populate retry/backoff tests pass: missing context, network, and BWS failures respect `nextRetryAtMs`, do not spin, manual/pull/send paths can force retry, and success or urgent supersession clears retry state.

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
- Invalid-history unhide ownership tests pass in this phase: unhide may enqueue a retry for expired markers, but trigger code does not clear manifest invalid-history; only successful populate through `markManifestPopulated` clears it.
- Send requeues already-populated wallet.
- Pull-to-refresh requeues already-populated changed wallets and refreshes rates.
- Quote switch fetches only BTC bridge rates, except target `USD`/canonical quote which performs no target BTC fetch.
- Passive `onLiveRatesUpdated` schedules only `liveRateTouch`, never `full`, never `ensureFresh`, and obeys debounce/fire-time guards.
- Show Portfolio rapid toggle serializes, final state wins, and an OFF-created wipe obligation completes before any ON starts populate.

### Phase 7 — UI migration

- Migrate Home portfolio balance/chart and asset list.
- Migrate All Assets and Allocation.
- Migrate WalletDetails, AccountDetails, KeyOverview.
- Migrate AssetBalanceHistoryScreen, scoped asset detail, and portfolio-entered Exchange Rate routing via `ExchangeRateRoute` (`marketAsset` vs `portfolioWeightedAssetGroup`).
- Add `normalizeExchangeRateRouteParams(...)` at the Exchange Rate screen boundary so legacy flat params normalize to `marketAsset` while portfolio v2 row/detail navigation serializes typed routes.
- Keep Exchange Rate screens independent from Show Portfolio.
- Implement shared scrub hook.
- Implement Hide Crypto Balances UI-only masking.

Acceptance:

- First-populate chart gates are scope-specific.
- Rows visible immediately and reveal right-side PnL progressively.
- Scrub first/final point invariants pass.
- No maximum-update-depth errors on rapid timeframe/scrub interactions.
- Hide Crypto Balances causes zero v2 runtime side effects.
- Legacy Exchange Rate params restore and navigate as `marketAsset`; only portfolio-owned v2 navigation can create `portfolioWeightedAssetGroup`.

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

### Phase 7.75 — Portfolio UI preference migration

- Move UI-only portfolio preferences out of `PORTFOLIO_CHARTS` before deleting v1 chart-cache state.
- Preserve `homeChartCollapsed` in a small non-runtime UI preference location, such as `APP.homePortfolioChartCollapsed` or `PORTFOLIO_UI_PREFS`.
- Do not migrate `cacheByScopeId`, `lruScopeIds`, chart arrays, generated points, or v1 remount/cache nonce data.
- Replace `homeChartRemountNonce` with a local v2 chart key/revision if still needed, not persisted Redux.

Acceptance:

- Toggling Home chart collapse persists across app restart.
- No portfolio chart arrays or generated PnL data are persisted in Redux.
- Deleting `src/store/portfolio-charts/**` does not remove a user-visible preference.

### Phase 8a — Default v2 on and soak with v1 retained

- Default `PORTFOLIO_V2` to true.
- Retain v1 orchestration files, v1 Redux slices, and v1 chart-cache code during soak so the feature flag remains a true rollback switch to v1.
- Keep all v2 import restrictions and UI routing behind the flag.
- During soak, the kill switch means: disable v2 and route portfolio surfaces back through v1.
- Do not delete v1 until soak criteria pass.

Acceptance:

- Full test suite, typecheck, and lint green.
- Flag-on path uses v2; flag-off path still works through retained v1.
- No persisted Redux arrays are written by v2 while the flag is on.
- Rollback drill: toggle flag off on a populated development device and verify portfolio surfaces use the retained v1 path without corrupting v2 MMKV state.

### Phase 8b — Delete v1 orchestration after soak

- Delete v1 runtime request/client/session/chart-cache/store orchestration after soak sign-off.
- Delete persisted Redux portfolio chart caches and remove v1 portfolio store subtrees from root reducer/persist config after Phase 7.75 has migrated UI-only preferences.
- Keep kernels used by v2.
- Do not sweep-delete `src/portfolio/adapters/rn/**`; delete or relocate only modules classified as v1-only or migrated to v2 adapter paths.
- Update imports so no UI or store code references deleted v1 APIs.
- After this phase, the remaining switch is **not** a rollback-to-v1 switch. It is a v2-disable/hide switch that suppresses portfolio-owned v2 surfaces and ordinary v2 work while leaving Exchange Rate surfaces available.

Acceptance:

- Full test suite, typecheck, and lint green.
- No UI imports banned v1 APIs.
- No persisted Redux arrays for portfolio charts/snapshots/rates.
- Kill-switch documentation and QA scripts explicitly use the post-deletion meaning: v2-disable/hide, not v1 rollback.

### Phase 9 — Polish and benchmark

- Delete spikes and unused helpers.
- Benchmark post-auth warm publish, first-populate reveal, timeframe switch, scrub, quote switch, pull-to-refresh, publish payload size, MMKV read counts, rate lookup counts, and scoped-cache refresh time.
- Use `recordPortfolioV2Metric(...)` data gathered since Phase 1 to tune warning thresholds. Initial thresholds are warnings, not hard CI failures.
- Initial budgets are checked in as warning thresholds and may be tuned after baseline measurement:
  - timeframe switch and scrub: zero network, zero MMKV mutations (writes, deletes, or clears), zero populate;
  - passive live-rate touch: no historical point rebuild and bounded publish payload;
  - quote switch: BTC bridge fetch only and no queue mutation;
  - post-auth warm publish: publish from persisted data before network freshen;
  - published UI state warns when approximate payload size exceeds `PORTFOLIO_PUBLISH_WARN_BYTES`.
- Decide whether to replace the Phase-1 no-op `projectPortfolioStateForUi(...)` with a smaller typed UI projection only if benchmarks show shared-value publish cost is material on target devices.
- Add persisted derived render-state hydration only if measured cold-start latency requires it. This is optional and should not be added preemptively.

---

## 16. Required tests before Phase 8a default-on and Phase 8b deletion

### Architecture and storage

1. Large portfolio chart/rate/snapshot data is absent from persisted Redux.
2. Portfolio MMKV instance is used for all v2 keys.
3. Wipe uses registry-aware delete and leaves registry clean.
4. Show Portfolio off wipe excludes shared `rate:v1:*` by default; Exchange Rate surfaces remain visible.
5. Cache invalid bit blocks ordinary work after mid-wipe failure and repair clears it.
6. Reset waits for populate, recompute, and ensureFresh.
7. Snapshot/rate/generated-cache MMKV writes are sharded by the required key
granularity, record approximate value size with redacted key metadata, and warn
or split when exceeding `PORTFOLIO_MMKV_VALUE_WARN_BYTES`. Snapshot chunk tests
must prove byte-size splitting takes precedence over the
`PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET` target when a row-budget-sized chunk is
too large.
8. Daily snapshot compression preserves the existing 90-day UTC-day behavior:
older tx events compress to one daily snapshot per UTC day, recent tx events
remain tx-level, and app-kill resume does not duplicate/drop an in-progress
daily snapshot. Tests compare compressed and uncompressed fixtures on
product-supported sample grids or explicitly pin any acceptable old intra-day
divergence.
9. Timeframe switch, chart scrub, and passive live-rate touch spy tests assert
zero calls to the v2 MMKV mutation helper family
(`writePortfolioMmkvString(...)`, `deletePortfolioMmkvKey(...)`,
`clearPortfolioMmkvKeysForReset(...)`) and zero direct calls to the low-level
mutation exports the helpers wrap, including the explicitly forbidden
`workletKvClearAll(...)` and raw MMKV `.set`/`.delete` paths.

### Manifest and queue

10. Manifest populated state and queue pending state are independent.
11. Already-populated wallet requeues after send.
12. Already-populated wallet requeues after pull-to-refresh.
13. App-launch incremental refresh can requeue populated wallets.
14. Queue append dedupes within the same run against pending, active, and completed-in-run item IDs; it never dedupes against manifest populated state.
15. New run ID can enqueue a wallet that completed in an earlier run, including the case where initial run completed A and a later send run enqueues A while B/C/D remain pending.
16. Active queue item resume after app kill: persisted active item is moved to the front of pending; valid checkpoint resumes; missing/invalid checkpoint clears incomplete staging and restarts that wallet; completed manifest data remains visible.
17. Send and pull-to-refresh changed-wallet items are `urgentUserVisible` and are inserted ahead of existing pending background work so they run immediately after the active wallet finishes.
18. Queue priority does not preempt an already active wallet mid-page; it only controls pending order.
19. Deleted wallets are pruned from manifest and queue.
20. Hidden livenet wallets remain populate-eligible; testnet/regtest wallets never enter queue.

### Display order and visibility

21. Populate order includes hidden livenet wallets.
22. Home display order excludes hidden wallets.
23. Key/account scoped display order excludes hidden wallets inside that scope.
24. Hidden-only livenet asset rate coverage: a hidden wallet that was populate-eligible while hidden has canonical USD historical rates ensured by visibility-ignored populate/background freshen; unhide does not issue an ad hoc rate fetch for an already manifest-populated wallet.
25. Allocation order equals All Assets order for the same scope.
26. Mid-populate Today/All Time toggle does not change row order.

### First-populate readiness

27. Home chart hidden until every visible Home-scope wallet is populated or invalid-history blocked.
28. WalletDetails chart appears as soon as that wallet is populated.
29. Asset Detail chart appears only after every visible wallet in that asset group/scope is populated or invalid-history blocked.
30. KeyOverview chart appears only after every visible wallet in that key scope is populated or invalid-history blocked.
31. Incremental refresh keeps stale chart visible if the scope has previously published valid series.
32. Empty Home/key/account/asset scopes publish `empty: true`, `initialScopeReady: false`, and render empty/no-chart state rather than a ready empty chart.

### PnL and rates

33. First chart point `pnlChange === 0` exactly.
34. Final chart point equals idle header/PnL numbers.
35. Every Point includes `remainingUnrealizedPnlFiat` and scrub UI reads it directly.
36. Single-rate-source no-transaction PnL percent equals the ordinary Exchange Rate percent for each interval.
37. Collapsed multi-rate-source asset groups expose a weighted group exchange-rate series, and no-transaction PnL percent equals that weighted group percent.
38. Buy/sell/partial disposal/zero-balance fixtures match product formula.
39. Same-user transfer fixture proves transfers are not netted and pins `aggregateRemainingCostBasisFiatEnd === 100.20` for same-chain USDC.
40. Cross-chain same-ticker transfer fixture uses per-chain rates and pins `aggregateRemainingCostBasisFiatEnd === 100.192`.
41. Chart output capped to `<= 89` points.
42. Transaction between emitted chart samples affects later emitted PnL.
43. Full-point fingerprint changes when a middle point changes while endpoints stay the same.

### Quote switch and V4 rates

44. `BTC/USD` canonical rates are ensured even with no BTC wallet.
45. Quote switch to EUR fetches only `BTC/EUR` stored intervals.
46. Quote switch to USD performs no target BTC fetch.
47. In-window transaction quote-bridge reprice matches from-scratch bridged recompute.
48. Multi-hop USD → EUR → GBP still bridges from canonical USD, not display EUR.
49. Quote switch during populate does not touch queue and publishes bridged current data.
50. V4 rate fetch uses one native batched request and token-specific requests per token tuple; ETH token addresses are lowercased, SOL/Solana token addresses are case-preserved.
51. Classifier aliases `wbtc -> btc`, `weth -> eth`, `matic -> pol`, and reclassifies legacy ETH-side MATIC/POL token address to native `pol`.
52. Token response extraction handles exact/lower/upper keyed matches and single-key token fallback.
53. `3M`, `1Y`, and `5Y` never produce separate rate URLs or MMKV keys; they resolve to `ALL`.

### Hooks, selectors, scoped cache, and UI

54. `usePortfolioSlice` passes only selected slice to React, not full `PortfolioState`.
55. `usePortfolioSlice` selectors and equality handling are worklet-compatible/stable; typed hooks use named comparators, and tests reject non-worklet objects, Redux objects, formatters, maps/sets, mutable props, or arbitrary JS comparator closures.
56. Scoped selectors do not aggregate wallets or walk points in JS.
57. Scoped row shells publish before scoped PnL is ready, include only visible wallets for that scoped route, compute `currentFiatValue` from per-member rate sources, and update `walletIdsKey` after visibility changes.
58. Row shell `currentFiatValue` is computed by summing each visible nonzero member wallet through its own `FiatRateAssetRef` / live-rate key, not one coarse group rate unless all nonzero members share the same source; missing rate for a nonzero member yields `undefined`, missing rate for a zero-unit member does not block the aggregate, visible all-zero members publish `currentFiatValue: 0`, and no visible members means no shell is published.
59. UI never aggregates row amounts or PnL through `memberWalletIds`; instrumentation fails if row components sum wallets or walk points.
60. Scoped cache honors `MAX_SCOPED_CACHE_ENTRIES = 8`, LRU/touch updates, refresh-before-eviction, delete-first pruning, and protected-current-scope behavior.
61. Timeframe switches cause zero fetch/populate/snapshot/recompute side effects.
62. Chart scrubbing causes zero fetch/populate/snapshot/recompute/MMKV side effects.
63. Scrub timestamp formatting matches interval rules.
64. Scrub survives mid-publish by timestamp or falls back to idle.
65. Hide Crypto Balances causes zero v2 runtime mutations, zero MMKV mutations (writes, deletes, or clears), and zero shared-state writes.
66. No maximum-update-depth errors during rapid timeframe toggles or scrubbing.

### Lifecycle

67. Post-auth warm publish lands before populate kick and before network freshen resolves.
68. Send-triggered refresh propagates to Home, All Assets, Asset Detail, WalletDetails, KeyOverview, and scoped rows.
69. Pull-to-refresh rate change propagates to all affected screens.
70. Key import populates only livenet wallets.
71. Key delete clears wallet snapshots and updates all affected screens.
72. Hide/unhide preserves snapshots and updates visible totals/charts.
73. Visibility-change invalid-history/import matrix: unhide does not requeue an already manifest-populated wallet; skips wallets with active invalid-history markers; enqueues retry for manifest-invalid-history wallets whose persisted marker is expired without clearing manifest state; and enqueues populate for a livenet wallet imported during a blocked window when it lacks manifest populated state.
74. Invalid-history marker skips wallet without marking populated and does not block unrelated scopes indefinitely.
75. Expired invalid-history marker can retry; the trigger never clears manifest invalid-history directly, and successful populate clears the manifest marker through `markManifestPopulated`.
76. Negative running balances are quarantined, never clamped into valid-looking PnL.
77. Show Portfolio off hides portfolio surfaces, latches a wipe obligation, and leaves Exchange Rate surfaces visible.
78. Rapid Show Portfolio off/on/off/on churn serializes, final setting wins, and no ON populate starts until every prior OFF-created wipe obligation has completed.
79. Show Portfolio reset-failure regression: if `performResetSequence()` throws, `visibilityWipeRequired` remains true, `portfolioCacheInvalid` remains latched when applicable, and the next ON attempt retries/awaits reset before any populate can start.

### Implementation lock-blocker tests and anti-regression variants

These tests must exist before the plan is treated as implementation-complete. For the first four, include a paired anti-regression variant that intentionally stubs the historical bug back in and asserts the test fails.

80. **Queue dedupe anti-regression:** stub queue append to dedupe against `manifest.populatedWalletIds`; assert send/pull refresh of an already-populated wallet fails. Restore implementation and assert pass.
81. **Mid-series fingerprint anti-regression:** stub fingerprint to use endpoint-only values; mutate a middle chart point with unchanged endpoints and assert the test catches the stale chart. Restore full-point hash and assert pass.
82. **No-BTC-wallet quote-switch anti-regression:** stub canonical `BTC/USD` ensure so it is skipped when the user owns no BTC; assert quote switch fails or produces missing bridge denominator. Restore canonical BTC ensure and assert pass.
83. **Transfer non-netting anti-regression:** stub owned-wallet transfer matching/netting; assert the `$100.20` and `$100.192` fixtures fail. Restore wallet-local transfer model and assert pass.
84. **Weighted group route test:** portfolio tap on collapsed multi-source `usdc` navigates with `{kind: 'portfolioWeightedAssetGroup'}`; standalone Exchange Rates uses `{kind: 'marketAsset'}`. A portfolio route must not open one arbitrary constituent token deployment.
85. **Weighted group quote-bridge test:** quote switch rebuilds `WeightedGroupRateSeries` and `RowPayload.rateStart/rateEnd/ratePercent` from per-timestamp bridged constituent rates. A scalar-transformed USD weighted series must fail the test.
86. **Weighted full-point and weight-vector fingerprint test:** mutate a middle valid `WeightedGroupRatePoint` with unchanged endpoints; the fingerprint must change and the Exchange Rate scrub UI must re-render. Then change `baselineUnitsByRateSourceKey` while keeping emitted endpoints unchanged; the fingerprint must still change because the weight vector is part of the index identity. The fingerprint must derive `sortedRateSourceKeys = Object.keys(baselineUnitsByRateSourceKey).sort()`, not rely on publish-time input order.
87. **Weighted zero-baseline interval test:** for a valid `portfolioWeightedAssetGroup` route, an interval with `baselineUnits === 0` or `groupIndex(t0) <= 0` publishes interval-local `availability: 'unavailable'`, `unavailableReason: 'zeroBaseline'`, and `points: []`; switching to an interval with nonzero baseline renders a valid weighted series. No fallback navigation to `marketAsset` occurs.
88. **Weighted numeric fixture:** the `180.392 → 180.592 → 0.1108696616%` fixture pins `weightedRate` within `1e-12` and `weightedPercent` within `1e-10`.
89. **Urgent same-wallet supersession test:** incoming send/pull item drops older unstarted same-wallet normal/background pending items, preserves existing items, and does not preempt an active same-wallet item.
90. **Stable priority insertion test:** insertion preserves FIFO within each priority class: existing urgent, incoming urgent, existing normal, incoming normal, existing background, incoming background.
91. **Checkpoint validity test:** each invalidity condition in the checkpoint checklist causes wallet-only staging clear and safe restart, while committed completed-wallet manifest data remains visible. Persisted cursor values must be JSON-serializable and schema-validated; unserializable or wrong-version cursor data is invalid.
92. **Delete survivor re-kick test:** `onWalletsDeleted` resumes the existing reconciled queue with `kickPopulateLoopIfIdle()`; it must not append new manual items, lose priority/checkpoint metadata, or duplicate survivor wallet work.
93. **Manifest/queue reconciliation test:** the helper prunes deleted/non-livenet wallets from manifest and queue, does not prune hidden livenet wallets, clears stale checkpoints/staging, and bumps orderRevision iff canonical order changes.
94. **Publish-driven readiness test:** a scope that is metadata-ready but has not actually published a non-empty valid series keeps `hasEverPublishedValidSeries === false`; a valid published series flips it true.
95. **Wallet/delete triple-guard race tests:** guard #2 flips during populate wait; guard #3 flips during snapshot clear; both return before later side effects.
96. **MMKV registry test:** seed one registered key and one unregistered real MMKV key; wipe deletes both through registry-aware delete and leaves `kvStore.listKeys()` clean.
97. **Manifest schema validation test:** invalid/missing schema or malformed JSON returns `null` and logs once; no business-logic silent migration.
98. **Logger/telemetry allowlist test:** `logPortfolioRuntimeError` never throws, never returns a Promise, includes `subsystem: 'portfolio-v2'`, preserves safe scalar allowlisted fields such as `extra.tag`, and drops/rejects non-allowlisted fields. Feed it an `Error` and `extra` containing `wallet-123`, `0xAbC123`, `txid`, `rate:v1:USD:usdc:1D:eth:0xAbC123`, `snap:chunk:v2:wallet-123:1`, a request URL, a manifest/queue fragment, and a raw checkpoint; assert the Sentry/log/metric sinks receive none of those raw values and no raw `Error.message`. Debug copy/export payloads remain user-local and are never auto-attached to runtime errors.
99. **Hide Crypto Balances orthogonality test:** dispatch `toggleHideAllBalances()` twenty times and assert zero runtime calls, zero MMKV mutations (no calls to the v2 helper family or its wrapped low-level mutation exports), zero trigger invocations, zero `sharedPortfolioState` writes, and only UI re-renders.
100. **Per-trigger ordering test:** table order is enforced; post-auth is the only warm-publish-first trigger, pull/send/quote/delete/show-toggle follow their explicit orders, and passive live-rate updates use only `liveRateTouch`.
101. **Passive live-rate update no-fetch test:** trigger `onLiveRatesUpdated` from passive/background live-rate churn and assert: (1) entry calls debounce/coalesce through `PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS`; (2) the debounced callback re-checks `canRunPortfolioV2Work()` and `getShowPortfolioEnabledFromStore()` at fire time and no-ops if either flipped; (3) it schedules `scope: {kind: 'liveRateTouch'}`, never `scope: 'full'`; (4) it makes zero `ensureFresh` calls, zero historical rate fetches, zero snapshot refreshes, zero MMKV mutations of any kind (no calls to the v2 mutation helper family or its wrapped low-level exports against historical or current-value keys), and zero populate queue mutations; (5) historical chart point values `points[0..last-1]` are unchanged; historical-rate-backed series fingerprints are unchanged; live-rate-backed series fingerprints change only if their final point changes; (6) only series with `finalPointSource === 'liveRate'` update their final point; (7) every `RowPayload` derived from updated final points updates in the same published revision; (8) cached `scopedByWalletSet` entries update current-value surfaces by the same rules as global slices, without rebuilding scoped historical points; (9) quote metadata mismatch no-ops per the Phase 0 decision; (10) uncertain `changedAssetIds` mapping falls back to all-current-value `liveRateTouch`. Anti-regression variant: stub the implementation to call `scope: 'full'` from `onLiveRatesUpdated` and assert historical point mutation causes the test to fail.
102. **Historical rates persisted decision test:** if Phase 0 requires `onHistoricalRatesPersisted(...)`, assert it recomputes from already-persisted rates without fetching, refreshing snapshots, enqueueing populate, or double-scheduling v2-owned pull/send flows. If Phase 0 proves it is unnecessary, assert the inventory documents that navigation-only Exchange Rate screens do not persist portfolio-relevant historical rates.
103. **Helper contract tests:** `resetSharedPortfolioStateForDebugClear` publishes an epoch-correct empty render state through `publishPortfolioState(...)` and resets coordination ticks, `startPopulate` builds/appends through the pinned API, `getSeriesIdlePoint(series)` returns the final point, and `lastAccessedAt` changes only through scoped/wallet touch semantics.
104. **All-zero shell fiat test:** visible member wallets exist, every current unit amount is zero, and one or more zero-unit rates may be missing; runtime still publishes a row shell with `currentFiatValue: 0`. A no-visible-members fixture publishes no shell.
105. **Weighted route per-interval zero-baseline test:** a collapsed route remains `kind: 'portfolioWeightedAssetGroup'` when one interval is unavailable due to zero baseline, that interval renders the weighted-rate empty state without crashing, and switching to another valid interval renders normally without opening a representative market route.
106. **Weighted missing-constituent-rate test:** seed a collapsed weighted route where one nonzero-baseline constituent has no canonical rate, no required BTC bridge rate, failed interpolation, or a non-finite bridged value at a required sample. The selected interval must publish `availability: 'unavailable'`, `unavailableReason: 'missingConstituentRate'`, and `points: []`; the UI keeps the timeframe selector enabled, does not render a partial chart, and does not navigate to `marketAsset`.
107. **Expired invalid-history ownership test:** seed a wallet in manifest invalid-history state with an expired persisted marker, unhide it, and assert the trigger enqueues a retry but does not directly remove manifest invalid-history. If the retry fails before successful finish, invalid-history context remains or is replaced by a new marker. Only successful populate through `markManifestPopulated` clears manifest invalid-history and marks the wallet populated.
108. **Phase-local acceptance placement test:** assert the missing-constituent-rate fixture is part of Phase 3, checkpoint JSON/non-optional boolean checks are part of Phase 5, invalid-history unhide ownership is part of Phase 6, and passive live-rate no-fetch behavior is part of Phase 6 so these contracts cannot drift until the final pre-Phase-8 suite.

109. **Publish helper and stale epoch test:** all writes to `sharedPortfolioState.value` go through `publishPortfolioState(...)`; start a long recompute/rate-fetch/populate operation, bump `PORTFOLIO_WORK_EPOCH_KEY` through Show Portfolio OFF, quote change, or wallet deletion, then let the old operation complete. Assert it does not write manifest, queue, MMKV rate/snapshot data, or published render state. Coordination SharedValues may still be written by their owning loops/helpers.
110. **Runtime substrate and initializer test:** portfolio runtimes are created through `react-native-worklets`; compute initializes no wallet signing context, populate initializes tx-history signing/Nitro globals, and rate-fetch initializes BWS/Nitro fetch globals without wallet credentials.
111. **Stored-rate helper type/URL test:** provider, URL, MMKV key, and persist helpers accept only `StoredRateInterval`; direct `3M`, `1Y`, or `5Y` calls fail type/runtime assertions and never produce `days=90/365/1825` URLs.
112. **Canonical RateReader sampling test:** render and quote-bridge paths use `linearRender`; nearest lookup is confined to explicitly named snapshot-ingest behavior; missing bridge/constituent rates produce deterministic missing/unavailable results with no point dropping.
113. **Invalid basis quarantine anti-regression:** non-finite or negative remaining cost basis, missing required basis rates, impossible disposal math, and negative running units quarantine the wallet. Stub v1-style clamping to zero and assert the fixture fails.
114. **Collapsed display-unit amount and health test:** collapsed row crypto amount sums per-member display units, not raw atomics through one representative decimals value; decimal conflicts and missing live-rate member IDs publish through `groupHealth`.
115. **Retry/backoff tests:** repeated populate and rate-fetch failures do not spin; background work respects `nextRetryAtMs`; send/pull/manual refresh can force retry; successful completion or urgent supersession clears retry state.
116. **Legacy Exchange Rate route compatibility test:** existing flat `currencyAbbreviation`/`chain`/`tokenAddress` params normalize to `marketAsset`; restored navigation state and standalone Exchange Rates do not create weighted routes accidentally.
117. **Portfolio status hook test:** `usePortfolioStatus` exposes invalid-history, missing-rate, stale, and retry-pending status from published runtime state only; UI code does not inspect manifest, queue, MMKV, or Redux.
118. **Home chart collapsed preference migration test:** `homeChartCollapsed` survives Phase 7.75 migration and app restart; deleting `src/store/portfolio-charts/**` does not delete that user-visible preference.
119. **Retained-kernel classification test:** every kept/adapted v1 kernel has a checked-in classification and v2-contract adapter tests before import; retained kernels cannot reintroduce legacy chart caps, nearest/drop FX behavior, invalid clamping, raw atomic row sums, persisted Redux arrays, or manifest/queue bypasses.
120. **Nitro boundary tests:** using the Phase 0-inventoried JS helper module/export list, instrument JS-tagged tx-history signing/request helpers and BWS fiat-rate signing/request/fetch helpers. Run populate and assert tx-history signing, request fetching, pagination, and response processing occur through the worklet/Nitro hybrid-object path with zero JS-thread tx-history request/signing calls during the loop body; the JS-side context creator may be called once at kick time only. Run `ensureFresh` and assert BWS rate-fetch signing/request/response processing occurs through the rate-fetch runtime's worklet/Nitro path with zero JS-thread rate request/signing calls. Anti-regression variants stub populate to call a JS-thread signing helper from the loop body and stub `ensureFresh` to call a JS-thread BWS fetch/signing helper; both variants must fail.
121. **Reset publish-helper test:** debug clear and reset paths call `publishPortfolioState({reason: 'debugClear' | 'reset'})`, record publish metrics, check the epoch, and never assign `sharedPortfolioState.value` directly. Coordination ticks may be reset directly.
122. **Epoch-correct empty-state test:** after `bumpPortfolioWorkEpoch('resetStart')`, `emptyPortfolioStateForEpoch(...)` produces an empty state with the current epoch/quote/computed timestamp, and publishing it through `publishPortfolioState(...)` succeeds instead of failing the stale-epoch guard.

---
## 17. Plan lock status

**This is the implementation-locking plan.** Future feedback during implementation should be handled as inline corrections in the relevant phase/PR unless it identifies a new violation of the original product requirements. Do not create another design iteration for wording-only clarifications.

---

## 18. Deletion targets

After Phase 8b, remove:

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
```

Do not delete or retain `src/portfolio/adapters/rn/**` by directory sweep. Phase 0/8b must classify each RN adapter module as one of:

```txt
v2 adapter, keep in place
v2 adapter, relocate to src/portfolio/v2/adapters/rn/**
v1-only adapter, delete after soak
shared low-level adapter, keep and document owner
```

V2-dependent Nitro/MMKV/rate/signing adapter modules must remain available until equivalent v2 adapter modules exist and all imports are migrated. Adapter classification is separate from kernel behavior classification: adapters need namespace/ownership decisions as well as v2-contract tests.

“Keep/adapt” does not mean preserve behavior unchanged. Before a retained kernel can be used by v2, it must pass the v2 contract checklist:

- chart point cap is `MAX_CHART_POINTS = 89`, not legacy defaults;
- render/quote bridge uses the canonical `RateReader` sampling policy;
- `3M`, `1Y`, and `5Y` resolve to `ALL` before provider/URL/persist paths;
- invalid wallet math returns quarantine/invalid-history state, not clamped PnL;
- row amounts sum per-member display units, not raw atomic units through a representative wallet;
- no retained API writes large chart/snapshot/rate arrays to persisted Redux;
- no retained session/client API can bypass manifest/queue separation;
- no retained debug clear can wipe shared `rate:v1:*` unless explicitly asked.

Phase 0 inventory must classify every retained kernel as:

```txt
reuse unchanged | adapt before v2 use | test fixture only | delete after soak
```

No retained kernel may be imported by v2 until its classification and required adapter tests are checked in.

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
