# Portfolio runtime refactor plan (final, v18)

**Target:** transform `src/portfolio/**` and its consumers into a three-runtime-by-default / one-shared-value architecture with scalar fingerprints as the render invalidation heuristic and full point-by-point parity tests as the correctness enforcement. Under Branch C of guardrail #27, the architecture escalates to a fourth runtime dedicated to rate fetches.

**Executable by:** GPT-5.4 (high reasoning) or Claude Opus 4.7, phase by phase.

## Context the agent must internalize before starting

- The current code has not shipped to users. No data migration, no legacy fallback, no schema versioning subsystem.
- Reduce `src/portfolio/` substantially. **Current estimate: ~20.6k non-test LOC after refactor, from ~28.3k starting.** Likely lands in the 18–22k range pending Phase 0 inventory verification and Branch choice in Phase 0.5. Additional ~2.9k LOC deleted outside the module. Goal is structural clarity, not a specific number.
- Architecture rests on **scalar fingerprints as a render invalidation heuristic**, not on cross-runtime object identity. **Numeric correctness is enforced by full point-by-point parity tests against v1 output** (Phase 3). Two distinct correctness properties, two distinct mechanisms.
- Every phase ships green. `PORTFOLIO_V2` flag gates v1 vs v2 until Phase 8.
- **Runtime API hygiene:** `runOnRuntimeAsync(runtime, workletFn, ...args)` — non-curried. Fire-and-forget usages attach `.catch(logPortfolioRuntimeError)`.
- **Redux store access pattern:** `getStore()` in `src/store/index.ts:376` is an async factory returning `{store, persistor}` (from `src/store/index.ts:558`). Existing boot at `index.js:166` uses `getStore().then(({store, persistor}) => {...})` callback. All v2 Redux access goes through `src/portfolio/v2/reduxAccess.ts`, whose module-level `storeGetter` is initialized inside that existing callback before `<Provider>` mount. Accessor calls happen inside function bodies only, never at module top level. Re-init is allowed (Fast Refresh, tests).
- **`orderRevision` monotonicity is a correctness invariant.** The `(sharedPortfolioState, PopulateQueueV1)` pair must stay in lockstep across reset paths (debug-clear, sign-out, any wipe): both reset together, or neither resets. Partial wipes break merge arbitration.
- **Reset / cancellation uses one durable invalid bit, not a full sentinel system.** A JS-side `populateResetInFlight` boolean marks an active joinable `performResetSequence`, and a persisted `portfolio:v2:cacheInvalid` key marks "portfolio cache may be partially wiped / invalid." There is no tri-state sentinel, no banner, and no boot-time retry UI. If a wipe throws after `cacheInvalid` is set, ordinary v2 work stays blocked until a successful repair clears the bit.
- **MMKV key namespaces (verified against repo):** snapshot data lives under `snap:*` (meta, index, chunk, invalid-history, raw points — see `snapshotStore.ts:146-162`); rate data lives under `rate:v1:*` (see `fiatRateStore.ts` `rateKey`); v2-specific data under `portfolio:v2:*` (queue, flag, cache-invalid bit). Wipe must cover all three. See guardrail #23.
- **Portfolio storage is a dedicated MMKV instance, not the app default.** ID is `'bitpay.portfolio.engine'`. Created via `createPortfolioMmkvStorageOnRN()` / accessed via `getPortfolioMmkvStorageOnRN()` in `src/portfolio/adapters/rn/workletMmkvBridge.ts:8-25`. All v2 MMKV access — flag, queue, cache-invalid bit, wipe — must go through this instance, not a bare `new MMKV()` or the default MMKV. Using the wrong instance means writes and reads land in separate namespaces and coordination breaks silently.
- **Portfolio storage uses a registry-backed key tracker.** `MmkvKvStore` in `src/portfolio/adapters/rn/mmkvKvStore.ts` tracks every set/delete through `__bitpay.portfolio.engine.registry.v1__`. `listKeys()` reads from this registry, not from `MMKV.getAllKeys()`. Any wipe that deletes keys directly via `MMKV.delete` without also updating the registry will leave `listKeys()` returning stale deleted keys — breaks debug/stats/reset-path tests and any future code relying on `listKeys()`. Wipe must route through `kvStore.delete(key)` or equivalently clear the registry.
- **Asset rows and allocation are grouped by ticker across chains.** Current UX collapses wallets by lowercased `currencyAbbreviation` across chains and token contracts for list/allocation display. V2 must preserve that behavior for Home, All Assets, Allocation, and key-scoped All Assets. This means the render-state model uses **asset-group ids** (ticker groups) for UI rows/order, while rate lookups and wallet internals still operate on raw `assetId` / `(coin, chain, tokenAddress)` values.
- **Fiat-rate storage is canonicalized to four fetched/persisted intervals.** Only `1D`, `1W`, `1M`, and `ALL` are fetched or stored in MMKV. Displayed `3M`, `1Y`, and `5Y` are derived by windowing `ALL` on the compute runtime; they do not trigger separate rate fetches or persistence.
- **Quote-currency switching must be instant via a BTC FX bridge.** Switching fiat currency must not fan out new-quote fetches for every visible asset. V2 fetches only the BTC bridge series needed for the target quote, then derives portfolio/chart/list values on the compute runtime from already-persisted asset rates plus the bridge factor.
- **"Show Portfolio" settings visibility is a real product mode.** Turning the setting off must clear the portfolio store and hide all portfolio-owned balance charts and asset-list surfaces; turning it back on must repopulate from scratch and re-reveal those surfaces. The Home Exchange Rates section and the Exchange Rate detail screen remain visible regardless of this setting. Because the portfolio store wipe also clears shared `rate:v1:*` cache entries, Exchange Rates may observe a transient cache miss and refetch, but the surfaces stay mounted.
- **Populate publishing is progressive for both initial and incremental populates.** First-ever populate reveals rows progressively as wallets finish. Later incremental populates (app-launch refresh, send-completion refresh, pull-to-refresh refresh) may show a subtle refreshing state while fresh chart/PnL values update progressively as recomputes land.
- **Incremental populate must be reorg-safe.** App-launch refresh, send-triggered refresh, and pull-to-refresh refreshes must start slightly before the latest persisted tip and overwrite the recent tail snapshots rather than strictly appending from the current tip. V2 relies on preserved kernel behavior here; Phase 0 must inventory the exact current mechanism and Phase 5 must keep it intact.
- **Timeframe switches and chart scrubbing are read-only UI operations.** They never trigger `ensureFresh`, snapshot refresh, or populate work. Only the explicit refresh triggers named in Phase 6 may refresh rates or snapshots.
- **Global react-native-worklets bundle mode is out of scope for v18.** V2 assumes the current proven non-bundle worklet path with the existing Quick Crypto / fetch hybrid-object integration for signing and network work. If bundle mode is ever considered, it must be shown to affect only the worklet runtime and must be re-validated separately before adoption.
- **V1 kernels have runtime-wiring requirements v2 must preserve.** The populate kernel in `portfolioPopulateWorklet.ts` calls tx-history fetch paths (`txHistoryRequest.ts:124`, `:188`) that require a hydrated signing dispatch context on the active runtime. The fiat rate provider (`bwsFiatRateProvider.ts:13`) is `'worklet'`-tagged and calls `getPortfolioNitroFetchClientOnRuntime()` which reads the fetch client from the current dispatch context — **not** just from the runtime initializer. The transport file explicitly notes that "even requests that do not need BWS signing can still need Nitro Fetch on the runtime" (`portfolioWorkletTransport.ts:137`). V2 must preserve this pattern: `PopulateRuntimeContext` carries `signingContextsByWalletId`, and v2's new `drivePopulateForWallet(...)` installs those contexts around the same handler calls v1 wraps with `withWalletSigningContext` (`prepare` and each `processNextPage` call), rather than once around an entire wallet session. Rate fetches install a lightweight dispatch context around `loadSeriesWorkletWithContext`. **Failure to preserve these contracts means populate can't fetch tx history and ensureFresh can't fetch rates — the v2 system simply won't work.**
- **Runtime-global dispatch context install/clear is a concurrency seam.** The populate runtime is shared between per-wallet populate work and rate fetches. Both paths install `PortfolioTxHistorySigningDispatchContext` on runtime globals. If `runOnRuntimeAsync` allows same-runtime tasks to interleave at `await` boundaries, two concurrent installs can clobber each other's context — populate's per-wallet context overwritten by a rate fetch's lightweight context mid-populate, or two rate fetches clobbering each other. V1 uses multiple serialization layers (`portfolioHost.ts:46` serial queue for request entry, `portfolioRequestWorklet.ts:265` worklet-side serial gate, `portfolioRequestWorklet.ts:278` allows `rates.ensure` during populate — a deliberate concurrency permission). V2's direct `runOnRuntimeAsync` calls from `ensureFresh` bypass v1's request-path serialization, so v2's concurrency safety requires explicit verification. **Phase 0.5 spike must verify scheduling behavior before Phase 5 commits to a runtime-wiring design.** See guardrail #27.

## Explicit Product Scope Decisions

- **Cross-chain ticker collapse lands in v18.** Home / All Assets / Allocation / key-scoped All Assets use ticker-grouped asset rows (`assetGroupId = lowercased currencyAbbreviation`), matching current UX.
- **Allocation order equals asset-list order in v18.** Allocation does not introduce its own ranking order; it reuses the canonical asset-group order from the portfolio state.
- **`onQuoteCurrencyChanged(...)` lands in v18 as a BTC-bridge flow.** No trigger skeletons remain, quote switches do not refetch every visible asset in the new currency, and quote changes publish immediately from the current shared portfolio state.
- **`onPullToRefresh(...)` lands in v18.** No trigger skeletons remain.
- **`onShowPortfolioVisibilityChanged(...)` lands in v18.** Turning portfolio visibility off clears portfolio-owned cached data and hides all portfolio-owned charts/lists; turning it back on repopulates from scratch. Rapid off/on churn is serialized with last-toggle-wins final visibility plus a latched wipe obligation so ON cannot populate before an OFF-created clear completes.
- **Key-scoped asset list lands in v18.** `AllAssets({keyId})`, row taps from `KeyOverview`, and scoped asset detail all stay within that key's wallet set.
- **Initial and incremental populate both publish progressively.** Initial populate uses skeleton reveal for not-yet-ready rows; incremental refresh may show a lightweight refreshing indicator while values update progressively. V18 intentionally does **not** hold incremental values stable until populate completion.
- **Timeframe switches / scrubbing stay read-only in v18.** No hidden rate fetches, snapshot updates, or populate kicks occur on timeframe-only interaction.

## Files that stay untouched (kernels, not orchestration)

- `src/portfolio/core/pnl/analysisStreaming.ts` (2,197)
- `src/portfolio/core/pnl/snapshotStream.ts` (793)
- `src/portfolio/core/pnl/snapshotStore.ts` (998) — *gets `revision` schema addition in Phase 2*
- `src/portfolio/core/pnl/fiatRateStore.ts` (317)
- `src/portfolio/core/pnl/{fxRates,rates,storedFiatRateSeries,invalidHistory,snapshotHelpers,types,assetId}.ts` (~940)
- `src/portfolio/core/{fiatRatesShared,tokenTxHistory,txHistoryPaging,format,types}.ts`, `core/shared/bws.ts`, `core/kv/types.ts` (~700)
- `src/portfolio/adapters/rn/**`
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts` (837) — *gets mirrored schema addition in Phase 2*
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts` (2,425)
- `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts` (1,525) — per-wallet populate kernel; v2 reuses directly
- `src/portfolio/runtime/worklet/portfolioWorkletRates.ts` (795)
- `src/portfolio/runtime/worklet/portfolioWorkletKv.ts` (173)

Total kept: **~13,805 LOC.**

## Files slated for deletion in Phase 8

- `src/portfolio/runtime/portfolioClient.ts` (248)
- `src/portfolio/runtime/portfolioHost.ts` (~220)
- `src/portfolio/runtime/portfolioRequestRouting.ts` (~40)
- `src/portfolio/runtime/portfolioWorkletTransport.ts` (505)
- `src/portfolio/runtime/portfolioWorkletDispatch.ts` (~140)
- `src/portfolio/runtime/serialQueue.ts` (~15)
- `src/portfolio/runtime/portfolioRuntime.ts` (~70) — v2 ships its own
- `src/portfolio/runtime/worklet/portfolioRequestWorklet.ts` (576)
- `src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts` (679)
- `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts` (732)
- `src/portfolio/core/engine/workerProtocol.ts` (204)
- `src/portfolio/core/engine/portfolioEngine.ts` (1,164) — session/analysis methods deleted; retained helpers absorbed
- `src/portfolio/core/engine/populateJob.ts` (95)
- `src/portfolio/core/engine/populateDebug.ts` (280)
- `src/portfolio/service/portfolioPopulateService.ts` (244)
- `src/portfolio/service/portfolioStaleness.ts` (160)
- `src/portfolio/debug/balanceDiagnostic.ts` (verify exact LOC in Phase 0)
- All of `src/portfolio/ui/hooks/**` (~9,982, verified by Phase 0 `find ... | wc -l`)
- `src/portfolio/ui/selectors/**`
- `src/portfolio/ui/common.ts` (545) — helpers folded into v2
- `src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts` — the file at this path is a 2-line re-export shim that **stays** as a v2 indirection (see Phase 7/8). The 2,892-LOC implementation the shim currently re-exports lives at `src/portfolio/ui/hooks/usePortfolioAssetRows.ts` and is already counted in the `src/portfolio/ui/hooks/**` ~9,982 LOC total above — do not double-count it in the "outside `src/portfolio/`" ledger.
- `src/store/portfolio/**` (~1,236, verified by Phase 0 `find ... | wc -l`) — v1 Redux slice + `portfolio.runtime.effects.ts`. The `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts` that dispatches `clearWalletPortfolioDataWithRuntime({walletIds})` is replaced by `onWalletsDeleted({walletIds})` (Phase 6).
- `src/store/portfolio-charts/**` (~536, verified by Phase 0 `find ... | wc -l`) — v1 chart cache slice. Superseded by `sharedPortfolioState` series. **Outside `src/portfolio/`**.

---

## Terminology

- **UI runtime** — default Reanimated runtime. React components + selectors.
- **Compute runtime** — `createWorkletRuntime({ name: 'portfolio-compute', enableEventLoop: true })`. Owns `recompute()`.
- **Populate runtime** — `createWorkletRuntime({ name: 'portfolio-populate', enableEventLoop: true })`. Owns the populate loop.
- **Rate runtime** — optional fourth runtime selected only by Branch C of guardrail #27. Dedicated to rate fetches if populate-vs-rate interleaving proves unsafe.
- **`sharedPortfolioState`** — `SharedValue<PortfolioState>`, authoritative state.
- **`populateProgressTick`** — `SharedValue<number>`. Per wallet completion. Subscriber triggers recompute so both initial and incremental populates can publish progressively.
- **`populateRetryTick`** — `SharedValue<number>`. On loop-exit with work remaining. Subscriber reconciles + re-kicks.
- **`populateLoopRunning`** — `SharedValue<boolean>`. Single-flight guard.
- **`populateCancelFlag`** — `SharedValue<boolean>`.
- **Fingerprint** — stable scalar string. Render invalidation heuristic. Clone-proof.
- **Asset group** — UI-facing collapsed asset identity. Default `assetGroupId = lowercased currencyAbbreviation`, matching current Home / All Assets / Allocation behavior.
- **Precomputed row payload** — `rowToday` / `rowAllTime` on `AssetGroupSlice`. Global Home / All Assets / Allocation selectors read these as O(1) lookups. Key-scoped selectors use a bounded memoized aggregation cache over the supplied wallet set.
- **Stored fiat-rate interval** — canonical persisted/fetched interval in `{1D, 1W, 1M, ALL}`. Displayed `3M`, `1Y`, and `5Y` are derived from `ALL`.
- **Refreshing portfolio state** — lightweight UI state set by incremental populate triggers. It may show subtle loading affordances, but it does not block progressive chart/PnL updates.
- **Scalar signature** — joined string like `populatedWalletIdsKey`. Fingerprint-input / diff-key.
- **Order revision** — monotonic counter for `orderedAssetGroupIdsForAssetList` mutations. Used for merge arbitration. **Monotonic across queue rebuilds**, not just within one queue's lifetime.
- **`populateResetInFlight`** — JS-side boolean, set only during an active `performResetSequence` invocation. Blocks ordinary kicks during reset; additional reset callers join the active sequence or queue a stronger full reset as described in guardrail #19.
- **`portfolioCacheInvalid`** — JS-side mirror of MMKV key `portfolio:v2:cacheInvalid`. Set before destructive wipe begins; cleared only after wipe + shared-state reset complete successfully. If true on boot, post-auth startup must repair the cache before ordinary v2 work resumes.
- **`canRunPortfolioV2Work()`** — predicate: `!populateResetInFlight && !portfolioCacheInvalid`. First executable statement of every ordinary v2 function that writes to MMKV or `sharedPortfolioState`.
- **`waitForPopulateLoopToStop()`** — polls `populateLoopRunning.value`. Throws on 60s timeout. Used by `performResetSequence`.
- **`waitForRecomputeDrainToStop()`** — polls scheduler's `running` flag. Throws on 30s timeout. Used by `performResetSequence` alongside the populate wait to quiesce both async subsystems before wipe.
- **`waitForEnsureFreshToStop()`** — polls `ratesFetch.ts` in-flight count. Throws on 20s timeout. Third wait in the reset `Promise.all`. Covers rate fetches that started before the reset guard flipped.
- **`logPortfolioRuntimeError(err, extra?)`** — the JS-side logger every `runOnRuntimeAsync(...)` fire-and-forget `.catch(...)` attaches to. Lives at `src/portfolio/v2/logPortfolioRuntimeError.ts`. Signature: `logPortfolioRuntimeError(err: unknown, extra?: { tag?: string; [k: string]: unknown }): void`. Behavior: (1) serialize `err` with `extra` via the existing app error-logging util used elsewhere in `src/store/**` (grep Phase 0 — match the current project-wide pattern so Sentry/console output is consistent); (2) NEVER throw and NEVER return a Promise — the function is called in `.catch(...)` / `.catch(logPortfolioRuntimeError)` and must not itself invalidate the attached chain; (3) attach a fixed `subsystem: 'portfolio-v2'` tag so logs are filterable; (4) include `extra.tag` when provided so call sites can distinguish populate / ensureFresh / fx-bridge / quote-switch / reset / scheduler paths. All `.catch(logPortfolioRuntimeError)` call sites pass the error only (curry-free non-attached usage); call sites that already have contextual info (`logPortfolioRuntimeError(err, {tag: 'populate'})`) use the arity-2 form inside the `catch` lambda.

**Fingerprints do two things:** (1) selector cost — O(1) lookups; numeric work happens once in `recompute`; (2) render invalidation — `React.memo` and `usePortfolioSlice(..., areEqual)` clone-proof.

**Fingerprints are a render invalidation heuristic; numeric correctness is enforced by parity tests.**

## Guardrails

1. **Ship-green** after every phase under `PORTFOLIO_V2=false`.
2. **Don't refactor kernels.** The "untouched" list is binding.
3. **Don't regress MMKV layout** beyond the `revision` addition.
4. **One compute-runtime writer, one state surface.** Only compute-runtime recompute functions write `sharedPortfolioState`: the normal `recompute(...)` path plus the quote-switch-specific `recomputeQuoteBridgeFromSharedState(...)` path described in Phases 2/3. Touch scopes are recompute scopes. **Reset paths (debug-clear, sign-out) also write to `sharedPortfolioState`** — see guardrail #17.
5. **LOC ledger per phase.**
6. **Selectors are pure worklet functions** of state + primitives. No Redux.
7. **Cancellation** via `populateCancelFlag.value` checks at yield points.
8. **Runtime API hygiene.** Non-curried `runOnRuntimeAsync`. `.catch(logPortfolioRuntimeError)` on fire-and-forget.
9. **Rate fetching and snapshot refresh happen only at explicit refresh triggers, never in the scheduler or on timeframe interaction.** `ensureFresh` and populate kicks are allowed only from the Phase 6 trigger set. Timeframe switches and chart scrubbing are read-only view changes and must not trigger rates, snapshots, or populate work.
10. **Touch scopes are metadata-only.** Update `byWallet[id].lastAccessedAt` for existing slices. Never change `computedAtMs`, readiness maps, `byAssetGroup`, `total`, `totalFingerprint`, series, rows, `quoteCurrency`, or `orderedAssetGroupIdsForAssetList` / `orderRevision`. Revision bumps only if at least one slice updated.
11. **Scheduler is three-phase.** Pending = `runFull` + `walletBuildIds` + `touchIds`. Drain: full → wallet-builds → touches. **`full` does NOT subsume pending wallet-builds or touches.**
12. **Queue reconciliation on every JS-side kick.** Prunes removed wallets from `remainingWalletIds`, `doneWalletIds`, AND `orderedAssetGroupIdsForAssetList`. Bumps `orderRevision` iff order changed.
13. **One ordering helper** (`computeOrderedAssetGroupIdsForAssetList`) used by both `buildQueue` and `buildBaseRecomputeInputs` fallback. No drift.
14. **`orderRevision` threads through `PopulateQueueV1`, `RecomputeInputs`, `PortfolioState`.** Merge rule: take higher `orderRevision`. Monotonic across queue rebuilds: `buildQueue` uses `(loadQueue()?.orderRevision ?? 0) + 1`, never resets to 1. Non-order-mutating queue writes (e.g., `markDone`) leave `orderRevision` unchanged.
15. **Fire-time reads, not ref-cached inputs.** `PortfolioV2Root` and triggers call `buildBaseRecomputeInputs(...)` at fire/call time, reading from `reduxAccess` helpers and current queue state.
16. **All Redux store access via `reduxAccess.ts`.** Module-level `storeGetter` initialized inside the existing `getStore().then(...)` callback in `index.js`. Accessor calls inside function bodies only.
17. **Reset paths must reset shared state.** Any code path that wipes portfolio MMKV (debug "clear all storage," sign-out if it clears portfolio data, any future full-reset flow) must also set `sharedPortfolioState.value = EMPTY_PORTFOLIO_STATE`, `populateProgressTick.value = 0`, `populateRetryTick.value = 0`. A partial wipe that zeroes MMKV but leaves stale sharedState alive would cause the next populate cycle's fresh `orderRevision = 1` to lose merge arbitration against state's stale higher value and display stale order. The durable `portfolio:v2:cacheInvalid` bit prevents ordinary work from resuming on half-wiped state until a successful repair clears it.
18. **Heavy scopes may advance `orderedAssetGroupIdsForAssetList` + `orderRevision`.** Any scope in `{'full', 'wallet', 'wallets'}` replaces order + revision in state if `inputs.orderRevision > prev.orderRevision`. Touch scopes never do. This is the single rule — no contradictory variants.
19. **Reset is a simple joinable sequence with one durable invalid bit.** `performResetSequence()`:
    1. If a reset is already active, join the in-flight promise.
    2. Set `populateResetInFlight = true` (before any side effect).
    3. `cancelPopulate()`.
    4. `await Promise.all([waitForPopulateLoopToStop(), waitForRecomputeDrainToStop(), waitForEnsureFreshToStop()])`. On any timeout: throw. Nothing wiped. **All three waits are needed**: populate loop, compute drain, and in-flight rate fetches are independent async subsystems, any of which can write MMKV or publish to `sharedPortfolioState` after the guard flip.
    5. `markPortfolioCacheInvalid()` — durably marks "portfolio cache may be partially wiped / invalid" before destructive deletion starts.
    6. `await wipePortfolioMmkvKeys()` — idempotent, excludes the feature flag key and `PORTFOLIO_CACHE_INVALID_KEY`.
    7. `resetSharedPortfolioStateForDebugClear()`.
    8. `clearPortfolioCacheInvalid()` — only after wipe + state reset succeed.
    9. In `finally`: clear `populateResetInFlight`.
    On any throw before step 5, re-throw and leave `portfolioCacheInvalid = false`. On any throw during steps 5–8, re-throw and leave `portfolioCacheInvalid = true`. Ordinary v2 work stays blocked until a later successful `performResetSequence()` (manual retry or post-auth boot repair) clears the bit.
20. **`populateCancelFlag` lifecycle.** Set `true` by `cancelPopulate()` and by reset paths. Set `false` by every kick path as its last action immediately before `runOnRuntimeAsync(...)`. Never persists across populate cycles.
21. **Unified guard for ordinary v2 write paths.** Every ordinary function that writes to portfolio MMKV or `sharedPortfolioState` — triggers, kick paths, `scheduleRecompute`, `drain()` iterations, `reconcileQueueAgainstEligible`, `buildQueue` callers — checks `canRunPortfolioV2Work()` as the **first executable statement**, before parameter reads, before any side effect. The sole exception is the post-auth boot repair path in `onAppLaunchPostAuth(...)`, which may call `performResetSequence()` first when `portfolioCacheInvalid` is true, then re-evaluate `canRunPortfolioV2Work()`.
22. **Async writers quiesce before wipe.** Any async portfolio task that can write to MMKV or publish to `sharedPortfolioState` must (a) track its in-flight state in a JS-side counter, (b) expose a `waitForXToStop()` primitive, (c) be included in `performResetSequence`'s `Promise.all`, and (d) re-check `canRunPortfolioV2Work()` immediately before its persist step so a call in-flight at guard-flip time no-ops on its write. The `runPopulate` / `drain` / `ensureFresh` triad is the complete registered set; any new async writer added to the system must extend the wait-set. Async *readers* that don't write do not need to register — they can tolerate reading mid-wipe storage without corrupting state. The trigger for registration is "writes that could land after guard flip," not "any async MMKV touch."
23. **`wipePortfolioMmkvKeys` matches the repo's actual key namespaces.** MMKV keys are split across prefixes: `snap:*` (snapshot meta/index/chunks/invalid-history, per `snapshotStore.ts:146-162`), `rate:v1:*` (fiat rate series, per `fiatRateStore.ts` `rateKey` function ~line 22), and `portfolio:v2:*` (v2-specific keys — queue, flag, cache-invalid bit). Wipe iterates all MMKV keys and deletes any matching `PORTFOLIO_WIPE_PREFIXES = ['snap:', 'rate:v1:', 'portfolio:v2:']` except those in `WIPE_EXCLUDED_KEYS = { PORTFOLIO_V2_FLAG_KEY, PORTFOLIO_CACHE_INVALID_KEY }`. The feature flag is excluded so debug-clear/sign-out during rollout doesn't silently flip v2 off on a developer's device; the cache-invalid bit is excluded so it survives partial wipes until an explicit successful repair clears it. **The prefix set must be verified against Phase 0 inventory output** — if Phase 0 surfaces additional portfolio-related prefixes, they must be added here; the list above is the verified complete set as of v12.
24. **All v2 MMKV access uses the portfolio instance.** `getPortfolioMmkvStorageOnRN()` returns a dedicated `MMKV({ id: 'bitpay.portfolio.engine' })`. Flag, queue, cache-invalid, and reset operations — every read and write in v2 — must route through this instance. A bare `new MMKV()` or the default MMKV puts keys in a different namespace, which would make the wipe's key scan miss everything. Plan snippets that show `mmkv.get/set/delete` are shorthand for "the portfolio MMKV instance," not the default MMKV; implementation must make this explicit.
25. **Wipe must update the key registry.** Portfolio storage tracks keys through `__bitpay.portfolio.engine.registry.v1__`; `listKeys()` reads it. Direct `MMKV.delete` leaves the registry stale. `wipePortfolioMmkvKeys` enumerates keys from `getPortfolioMmkvStorageOnRN().getAllKeys()` (the source of truth) and deletes through `kvStore.delete(key)` (which untracks). Test: `listKeys()` returns empty (except exclusions) after wipe. `getAllKeys()` also returns empty (except exclusions).
26. **V2 runtime wiring preserves v1 kernel integration contracts.** The "untouched" v1 kernels (populate, rate provider, tx-history fetch) are load-bearing but have **runtime-global preconditions** that must hold when they execute:
    - **Every worklet call that uses Nitro fetch requires a dispatch context installed on the runtime for the duration of the call.** The fetch client is obtained via `getPortfolioNitroFetchClientOnRuntime()` (`txHistorySigning.ts:1060`), which reads from `requirePortfolioTxHistorySigningDispatchContextOnRuntime()`. No dispatch context = throw. This applies even when no BWS signing is needed — see the explicit transport-layer comment at `portfolioWorkletTransport.ts:137` ("Even requests that do not need BWS signing can still need Nitro Fetch on the runtime"). Two concrete cases in v2:
      - **Populate (per-wallet, with signing):** `signingContextsByWalletId[walletId]` built via `createPortfolioTxHistorySigningDispatchContextOnRN({requestPrivKey, requestPubKey, requestCount: 4})`. Installed around the same calls v1 wraps with `withWalletSigningContext` inside `drivePopulateForWallet(...)` (`handlePrepareWalletOnPopulateWorklet(...)` and each `handleProcessNextPageOnPopulateWorklet(...)` call), then cleared immediately after that handler returns. Do **not** widen that wrap to `handleFinishWalletOnPopulateWorklet(...)` / `handleCloseWalletSessionOnPopulateWorklet(...)` without separate justification.
      - **Rate fetch (single-shot, no signing):** lightweight context built via `createPortfolioTxHistorySigningDispatchContextOnRN({requestCount: 1})` with no `requestPrivKey`. Installed around `loadSeriesWorklet`, cleared in finally. `boxedNitroFetch` is populated regardless of whether `requestPrivKey` is provided, so this lightweight context is sufficient for non-signing Nitro requests.
    - The populate runtime's initializer must call `initializePortfolioRuntimeGlobals()` (which internally calls `ensurePortfolioRuntimeSigningGlobals()`) — same pattern as `portfolioRuntime.ts:34`. This sets up the *capacity* to hold contexts; per-call installation is still required.
    - `ensureFresh` fetch step runs on the populate runtime via `runOnRuntimeAsync(populateRuntime, loadSeriesWorkletWithContext, {args, dispatchContext})` — the worklet wrapper installs the lightweight context before calling the provider. See Phase 2 for implementation.
    - Any v2 change that bypasses these contracts (e.g., calling any populate handler without installing the signing context, or calling `loadSeriesWorklet` without the lightweight context) results in runtime throws on the first fetch. Future v2 worklet calls that use Nitro fetch must follow the same pattern.
27. **Runtime-global dispatch context must not be clobbered by concurrent installs.** The populate runtime is shared between per-wallet populate work and rate fetches (guardrail #26). Both install `PortfolioTxHistorySigningDispatchContext` on runtime globals. If `runOnRuntimeAsync` allows same-runtime tasks to interleave across `await` boundaries, concurrent installs clobber each other and corrupt in-flight work. **Phase 0.5 spike (see Phase 0.5) must empirically determine the scheduling behavior before Phase 5 commits to a runtime-wiring design.** Implementation path branches on spike results per the table below. `ensureFresh` always dedupes identical-args calls; serialization of non-identical calls is required when Probe 3 is dirty and optional otherwise. An acceptance test verifies the invariant regardless of chosen branch: under deliberately concurrent populate + rate-fetch load, neither operation observes the other's dispatch context mid-flight.
28. **Do not enable global worklets bundle mode in v18.** Keep the current standard non-bundle worklet mode plus the existing Quick Crypto / fetch hybrid-object path for tx-history signing and network work. Any future bundle-mode experiment requires a separate design proving it only affects the target worklet runtime and does not break the existing signing/fetch integration.

---

# Phase 0 — Inventory and feature flag

**Goal:** make the repo safe to refactor.

**Prompt:**

> Read `src/portfolio/**` plus consumers:
> - `src/components/charts/BalanceHistoryChart.tsx`
> - `src/navigation/wallet/screens/{WalletDetails,AccountDetails,KeyOverview}.tsx`
> - `src/navigation/wallet/screens/exchange-rate/{AssetBalanceHistoryScreen,ExchangeRateScreen}.tsx`
> - `src/navigation/tabs/home/components/{AssetsSection,AssetsList,AssetRow,PortfolioBalance,Crypto}.tsx`
> - `src/navigation/tabs/home/screens/{AllAssets,Allocation}.tsx`
> - `src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts`
> - `src/navigation/tabs/settings/about/screens/{PortfolioDebug,PortfolioWalletDebug,StorageUsage}.tsx`
> - `src/store/app/app.effects.ts` (portfolio effects only)
> - `src/store/wallet/effects/send/**`
> - `src/store/wallet/effects/rates/rates.ts` (live-rate refresh effects; note: no `src/store/rate/rate.effects.ts` exists — the `src/store/rate/**` slice is reducer/actions/models/types only)
> - `src/store/index.ts` (confirm `getStore()` async factory returns `{store, persistor}`; note `RootState` export location; also inventory the existing `cleanupPortfolioOnDeleteKeyMiddleware` that dispatches `clearWalletPortfolioDataWithRuntime({walletIds})` on `WalletActionTypes.DELETE_KEY` — v2 replaces this with `onWalletsDeleted({walletIds})`)
> - `index.js` (confirm existing `getStore().then(({store, persistor}) => {...})` callback — v2 init goes inside this callback)
> - **Sign-out / clear-all-storage paths** — grep for `signOut`, `logout`, `clearAllStorage`, `resetApp` or similar. List every code path that wipes portfolio MMKV. Phase 5 and Phase 7.5 will hook shared-state reset into each.
>
> Produce `PORTFOLIO_REFACTOR_INVENTORY.md`:
>
> 1. Mermaid call graph consumer → `getPortfolioRuntimeClient()` methods / portfolio hooks.
> 2. Public exports of `src/portfolio/**/index.ts` labeled `keep`/`delete`/`replace`.
> 3. Redux slices/fields storing portfolio data + v2 retention.
> 4. **Exact state paths** for every piece of Redux data v2 needs: quote currency, eligible wallets, live rates (by asset id), live rates asOfMs, wallet balances, wallet→asset mapping, and the user-facing "Show Portfolio" visibility setting. These paths feed `reduxAccess.ts` accessors in Phase 1.
> 5. **MMKV key prefixes in use.** Grep for `return \`[a-z]+:` patterns in `src/portfolio/core/pnl/**` and `src/portfolio/runtime/worklet/**` to find all key-construction sites. Expected: `snap:meta:v2:*`, `snap:index:v2:*`, `snap:chunk:v2:*`, `snap:invalid-history:v1:*`, `snap:*:*:*` (raw point keys), `rate:v1:*`. V2 adds `portfolio:v2:*`. Report the complete verified set. This list grounds the wipe-prefix constant in guardrail #23 and Phase 7.5's `wipePortfolioMmkvKeys` implementation. **If Phase 0 finds prefixes not in this expected list, they MUST be added** — otherwise debug-clear will leave orphan keys.
> 6. **MMKV adapter layout.** Inspect `src/portfolio/adapters/rn/workletMmkvBridge.ts` and `mmkvKvStore.ts`. Confirm `getPortfolioMmkvStorageOnRN()` returns the dedicated `bitpay.portfolio.engine` MMKV instance. Confirm that there is **no existing** `getPortfolioKvStore()` accessor in the repo and that Phase 1 must create one in v2 using `MmkvKvStore`, `getPortfolioMmkvStorageOnRN()`, `PORTFOLIO_WORKLET_MMKV_STORAGE_ID`, and `PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY`. Report the exact import paths for all four.
> 7. **FiatRateStore fetch/persist separability.** Inspect `src/portfolio/core/pnl/fiatRateStore.ts`. Confirm that `ensureRates` uses an injected provider's `loadSeries` for the network step, `getSeries` for freshness checks, and `setSeries` for persistence. Confirm `extractSeries` is file-local (not exported) and therefore must be cloned/exported intentionally for v2. Confirm `BwsFiatRateProvider` at `adapters/rn/bwsFiatRateProvider.ts` implements `loadSeries`. These are the primitives Phase 2's `ensureFresh` uses.
> 8. **Exact LOC** for every file in the kept/deleted lists. Flag discrepancies >10%, especially `balanceDiagnostic.ts`.
> 9. Baseline `yarn test` counts.
> 10. `getStore()` signature + location where its callback resolves in `index.js`. `RootState` type location.
> 11. **Reset path inventory.** Every code path that wipes portfolio MMKV or equivalent. These become Phase 7.5 integration points for guardrail #17.
> 12. **Product-parity inventory.** Verify and document:
>    - asset rows / allocation collapse wallets by lowercased `currencyAbbreviation` across chains,
>    - All Assets and Allocation use the same ordering semantics,
>    - `AllAssets({keyId})` and row taps from `KeyOverview` preserve key scope,
>    - the exact Redux state path and settings action for the user-facing "Show Portfolio" toggle,
>    - current pull-to-refresh behavior on Home and KeyOverview,
>    - current quote-currency switching behavior for portfolio screens,
>    - whether current quote switches already use a BTC bridge or fetch per-asset quote data,
>    - which intervals are actually fetched/persisted vs derived for display,
>    - whether timeframe switches currently trigger hidden rate/snapshot refresh work,
>    - whether Home Exchange Rates / Exchange Rate detail are already independent from the "Show Portfolio" toggle and, if not, which UI sites need explicit decoupling,
>    - how the current incremental populate path rewinds from the latest persisted tip / overwrites the recent tail for reorg protection,
>    - whether the current app/worklets setup uses global bundle mode and where Quick Crypto / fetch hybrid objects are threaded through signing + fetch,
>    - the specific Redux action/event fired when the PIN / biometric screen is cleared on app launch. `onAppLaunchPostAuth(...)` must be invoked by this post-auth signal, not earlier in app init or store rehydration.
>    These findings ground the v18 product-scope fixes in Phases 3, 5, 6, and 7.
>
> Add `PORTFOLIO_V2` feature flag, default `false`, readable JS + worklet. MMKV at `portfolio:v2:flag`.

**Acceptance:** baseline captured, flag works both sides, inventory with verified LOC, state paths, and reset-path list.

**LOC ledger:** +30 / 0 / +30.

---

# Phase 0.5 — Hard-gate spike

**Goal:** stop/go on SharedValue cross-runtime feasibility.

**Prompt:**

> Spike at `src/portfolio/v2/__spike__/sharedValueSpike.ts` + `__tests__/sharedValueSpike.spec.ts`. **No nav-registered screen.**
>
> Three experiments:
>
> - **Identity preservation** across publishes.
> - **Publish cost** at three sizes (empty / medium / large). Android mid-tier + iOS sim. P50 + P99.
> - **Dual-writer MMKV safety.** Populate + compute runtimes write different keys concurrently, 1000 iters.
>
> Decision matrix → `PORTFOLIO_V2_SPIKE_RESULTS.md`:
>
> | Identity | Publish p99 @ large | Branch |
> |---|---|---|
> | Preserved | < 8ms | A — fingerprints belt-and-suspenders |
> | NOT preserved | < 8ms | B — fingerprints load-bearing |
> | Any | ≥ 8ms | C — stop, escalate |
>
> Dual-writer must be safe; else stop.
>
> **Additional spike: runtime-global dispatch-context interleaving probe (see guardrail #27).**
>
> The populate runtime is shared by per-wallet populate work and rate fetches. Both paths install `PortfolioTxHistorySigningDispatchContext` on runtime globals via `setPortfolioTxHistorySigningDispatchContextOnRuntime`. If `runOnRuntimeAsync` allows same-runtime tasks to interleave across `await` boundaries, concurrent installs clobber each other. This spike determines empirically whether that interleaving happens.
>
> **Four probes total** (run each 1000 iterations, on both iOS and Android, report per-platform pass rates):
>
> 1. **Probe 1 (symmetric, diagnostic):** Two `runOnRuntimeAsync` tasks kicked back-to-back on the populate runtime. Task A installs a synthetic marker on `globalThis`, awaits N ms, checks marker. Task B installs a different marker, awaits M ms, checks. Does A's marker survive B's install? This probes whether symmetric sibling tasks interleave.
>
> 2. **Probe 2 (v2-asymmetric, PRIMARY branch-decider):** Start a background populate-shaped task on the runtime (install marker, begin an async loop, await inside the loop). While the loop is awaiting, kick a direct `runOnRuntimeAsync(runtime, ratesLikeTask, ...)` call — no request-handler wrapping, no serial gate. The rates-like task installs its own marker, awaits, clears. Does the populate-like task resume with its marker intact? **This probe's result is the branch-decider for populate-vs-rate concurrency.** The shape matches v2's planned `ensureFresh` calling pattern directly.
>
> 3. **Probe 3 (rate-vs-rate, PRIMARY branch-decider):** Two direct `runOnRuntimeAsync` rate-fetch-shaped calls overlapping on the same runtime. Each installs a marker, awaits, checks. Does either observe the other's marker? **This probe's result determines whether non-identical `ensureFresh` calls require JS-side serialization; identical-args dedupe is always on.**
>
> 4. **Probe 4 (v1-shape, diagnostic):** Background populate-shaped task + request-handler-wrapped rate-shaped task (simulating v1's `rates.ensure` going through `runSerialOnPopulateWorklet`). Used only to contextualize v1's historical safety; does not affect v2 branch selection.
>
> **Decision table (based on probes 2 and 3 only):**
>
> | Probe 2 | Probe 3 | Chosen approach |
> |---|---|---|
> | Clean | Clean | Branch A: no populate-vs-rate mitigation; `ensureFresh` always dedupes identical args, non-identical calls may remain concurrent |
> | Clean | Dirty | Branch A for populate-vs-rate + non-identical `ensureFresh` calls serialize |
> | Dirty | Clean | Branch C or D for populate-vs-rate. Branch B is diagnostic-only and not a ship target because it blocks reads behind populate. Identical-args dedupe still applies |
> | Dirty | Dirty | Branch C or D for populate-vs-rate + non-identical `ensureFresh` calls serialize. Branch B remains diagnostic-only |
> | Flaky (P2) | Any | Branch C recommended (isolation is robust against unknown scheduling and preserves non-blocking reads); identical-args dedupe still applies; add non-identical serialization if P3 is dirty/flaky |
> | Any | Flaky (P3) | Identical-args dedupe required; non-identical serialization required; populate-vs-rate branch chosen from P2 result |
>
> **Branch descriptions:**
>
> - **Branch A — no mitigation.** Only if both probes are clean on both platforms across 1000 iterations. `ensureFresh` retains `inFlightCount` tracking for reset-wait (guardrail #22) and always dedupes identical-args requests. Populate and rate share the populate runtime without additional coordination.
>
> - **Branch B — shared JS serial executor (diagnostic only, not a ship target).** A `portfolioRuntimeSerial` executor wraps both `runOnRuntimeAsync` kick sites (populate and rate). Implementation ~30 LOC. **Significant behavioral regression from v1:** rate fetches kicked during an active populate kick wait for the *entire* populate loop to complete, not just one wallet. V1's populate iterates all wallets inside one task (`portfolioPopulateJobWorklet.ts:442-456`). For a session with 15 wallets at ~10s each, a rate fetch triggered mid-populate could wait 2+ minutes. V1 explicitly permits `rates.ensure` during populate (`portfolioRequestWorklet.ts:278`) — B forecloses that. Because the product requirements in v18 say reads must not block behind populate, Branch B may be used only as a spike-time diagnostic/reference implementation and must not be the shipped outcome.
>
> - **Branch C — dedicated rate-fetch runtime.** A new `createWorkletRuntime` instance, name `bitpay-portfolio-rate-fetch-runtime` (or similar), with its own initializer calling `initializePortfolioRuntimeGlobals()`. Create lazily on first `ensureFresh` or eagerly at bootstrap (TBD per spike result and init cost measurement). Architectural fork from the default three-runtime model to **four runtimes**. **The new runtime does not hydrate the Nitro fetch client by itself** — `ensureFresh` still builds and installs lightweight dispatch context per call, same as Branches A/B/D. Identical-args dedupe still applies; non-identical serialization on the new runtime is required when Probe 3 is dirty/flaky (isolation from populate does not isolate rate fetches from each other). Reset-sequence integration: `waitForEnsureFreshToStop` already covers `ensureFresh`'s async lifecycle via `inFlightCount` — no new wait primitive needed unless Branch C introduces detached background work on the new runtime (not currently planned). Updated test surface: tests gain runtime-identity distinctions where they matter.
>
> - **Branch D — worklet-side lock.** A mutex or sequence-number primitive installed on the populate runtime that guards dispatch-context install/clear. `setPortfolioTxHistorySigningDispatchContextOnRuntime` becomes wait-for-lock-then-install; clear releases. Most surgical: no new runtime, no JS-side behavioral change. Most complex: requires a worklet-side concurrency primitive that works correctly under `runOnRuntimeAsync` scheduling (which itself needs verification). If the runtime's scheduler doesn't support worklet-side waits cleanly, D is infeasible; fall back to B or C.
>
> **Rate-vs-rate concurrency policy:**
>
> `ensureFresh` baseline tracks `inFlightCount` (guardrail #22).
> - **Dedupe (always on):** calls with identical `(quoteCurrency, intervals, coins, assets, maxAgeMs, force)` args merge into a single in-flight fetch. The second caller awaits the first's result.
> - **Serialize (conditional):** when Probe 3 is dirty or flaky, non-identical calls queue on a JS-side serial executor scoped to rate-runtime kicks. If Probe 3 is clean, this serialization is optional hardening and not required by the plan.
>
> **Spike failure modes:**
> - If the spike infrastructure can't be built in the test environment (worklets tooling limitation): document the limitation, run the probe manually on a debug build, record result. Escalation path, not a blocker.
> - If probe results are contradictory between runs at 1000 iterations: re-run at 10,000. If still contradictory, treat as flaky and use flaky-branch guidance above.
> - If the spike crashes on one platform: that platform defaults to Branch C for safety until the crash is diagnosed.
>
> **Acceptance test for whichever branch is chosen:** under deliberately concurrent populate + rate-fetch load, neither operation observes the other's dispatch context mid-flight. Implementation of the test varies by branch (Branch A: both complete cleanly; Branch B: rate fetch waits; Branch C: rate fetch runs on separate runtime; Branch D: lock serializes installs).

**Acceptance:** results documented, branch chosen.

**LOC ledger:** +400 / 0 / +400.

---

# Phase 1 — Scaffold v2 module + reduxAccess

**Goal:** v2 types, shared values, runtimes, stubs, `reduxAccess` module. Nothing consumes v2 yet.

**Prompt:**

> ### `src/portfolio/v2/model.ts`
>
> ```ts
> import type { StoredWallet } from '../core/types';
>
> // UI exposes seven selectable intervals, but the rate-cache layer only fetches/stores
> // the canonical subset {1D, 1W, 1M, ALL}. 3M / 1Y / 5Y are derived by windowing ALL.
> export type Interval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';
> export type StoredRateInterval = '1D' | '1W' | '1M' | 'ALL';
> export type Point = Readonly<{ ts: number; fiat: number; pnl: number }>;
>
> // Chart-boundary equality keys on Series.fingerprint, NEVER points array identity.
> export type Series = Readonly<{ fingerprint: string; points: readonly Point[] }>;
> export type PerIntervalSeries = Readonly<Partial<Record<Interval, Series>>>;
>
> export type RowPayload = Readonly<{
>   assetGroupId: string;
>   rowFingerprint: string;
>   fiatStart: number; fiatEnd: number;
>   pnlChange: number; pnlPercent: number;
>   rateStart: number; rateEnd: number; ratePercent: number;
> }>;
>
> export type AssetGroupSlice = Readonly<{
>   assetGroupId: string;
>   fingerprint: string;
>   series: PerIntervalSeries;
>   rowToday: RowPayload | undefined;
>   rowAllTime: RowPayload | undefined;
>   memberWalletIds: readonly string[];
>   memberWalletIdsKey: string;
> }>;
>
> export type WalletSlice = Readonly<{
>   walletId: string;
>   assetGroupId: string;
>   fingerprint: string;
>   series: PerIntervalSeries;
>   rowToday: RowPayload | undefined;
>   rowAllTime: RowPayload | undefined;
>   lastWrittenAt: number;
>   lastAccessedAt: number;
> }>;
>
> export type PortfolioState = Readonly<{
>   revision: number;                    // publish counter
>   quoteCurrency: string;
>   computedAtMs: number;                // updated on heavy scopes; NOT on touch scopes
>   populatedWalletIdsKey: string;
>   populatedWalletIdsById: Readonly<Record<string, true>>;
>   populatedAssetGroupIdsKey: string;
>   populatedAssetGroupIdsById: Readonly<Record<string, true>>;
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;               // monotonic across queue rebuilds
>   byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
>   byWallet: Readonly<Record<string, WalletSlice>>;
>   total: PerIntervalSeries;
>   totalFingerprint: string;
> }>;
>
> export type RecomputeScope =
>   | 'full'
>   | { kind: 'wallet'; walletId: string }
>   | { kind: 'wallets'; walletIds: readonly string[] }
>   | { kind: 'touchWallet'; walletId: string }
>   | { kind: 'touchWallets'; walletIds: readonly string[] };
>
> export type RecomputeInputs = Readonly<{
>   scope: RecomputeScope;
>   eligibleWallets: readonly StoredWallet[];
>   quoteCurrency: string;
>   liveRatesByAssetId: Readonly<Record<string, number>>;
>   liveRatesAsOfMs: number | undefined;
>   populatedWalletIds: readonly string[];
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;
> }>;
>
> export const EMPTY_PORTFOLIO_STATE: PortfolioState = {
>   revision: 0,
>   quoteCurrency: 'USD',
>   computedAtMs: 0,
>   populatedWalletIdsKey: '',
>   populatedWalletIdsById: {},
>   populatedAssetGroupIdsKey: '',
>   populatedAssetGroupIdsById: {},
>   orderedAssetGroupIdsForAssetList: [],
>   orderRevision: 0,
>   byAssetGroup: {},
>   byWallet: {},
>   total: {},
>   totalFingerprint: '',
> };
> ```
>
> Verify `Interval` against `FiatRateInterval` in `core/fiatRatesShared.ts`.
>
> ### `src/portfolio/v2/populate/resetState.ts`
>
> ```ts
> import { getPortfolioMmkvStorageOnRN } from '../adapters/rn/workletMmkvBridge';
>
> // Single durable invalid bit. Simpler than the old tri-state sentinel:
> // either the cache is valid, or it is invalid and must be repaired before
> // ordinary v2 work resumes.
> export const PORTFOLIO_CACHE_INVALID_KEY = 'portfolio:v2:cacheInvalid';
> let populateResetInFlight = false;
> let portfolioCacheInvalid = false;
>
> export function initializePortfolioV2ResetState(): void {
>   const storage = getPortfolioMmkvStorageOnRN();
>   portfolioCacheInvalid = storage.getString(PORTFOLIO_CACHE_INVALID_KEY) === '1';
> }
>
> export function canRunPortfolioV2Work(): boolean {
>   return !populateResetInFlight && !portfolioCacheInvalid;
> }
>
> export function isPopulateResetInFlight(): boolean {
>   return populateResetInFlight;
> }
>
> export function isPortfolioCacheInvalid(): boolean {
>   return portfolioCacheInvalid;
> }
>
> // Internal setter used by performResetSequence.
> export function __setPopulateResetInFlight(value: boolean): void {
>   populateResetInFlight = value;
> }
>
> export function markPortfolioCacheInvalid(): void {
>   const storage = getPortfolioMmkvStorageOnRN();
>   storage.set(PORTFOLIO_CACHE_INVALID_KEY, '1');
>   portfolioCacheInvalid = true;
> }
>
> export function clearPortfolioCacheInvalid(): void {
>   const storage = getPortfolioMmkvStorageOnRN();
>   storage.delete(PORTFOLIO_CACHE_INVALID_KEY);
>   portfolioCacheInvalid = false;
> }
> ```

> ### `src/portfolio/v2/sharedState.ts`
>
> ```ts
> export const sharedPortfolioState: SharedValue<PortfolioState>;      // → EMPTY
> export const populateCancelFlag: SharedValue<boolean>;                // → false
> export const populateLoopRunning: SharedValue<boolean>;               // → false
> export const populateProgressTick: SharedValue<number>;               // → 0
> export const populateRetryTick: SharedValue<number>;                  // → 0
> ```
>
> Also export a `resetSharedPortfolioStateForDebugClear()` helper:
>
> ```ts
> // Called by debug-clear and sign-out paths. Resets all v2 shared values to
> // their initial values. See guardrail #17.
> export function resetSharedPortfolioStateForDebugClear(): void {
>   sharedPortfolioState.value = EMPTY_PORTFOLIO_STATE;
>   populateProgressTick.value = 0;
>   populateRetryTick.value = 0;
>   // populateLoopRunning and populateCancelFlag intentionally NOT reset here —
>   // those are coordination primitives for an in-flight loop; the loop owns them.
> }
> ```
>
> And `waitForPopulateLoopToStop` used by the reset sequence:
>
> ```ts
> /**
>  * Polls populateLoopRunning until false. Throws on timeout.
>  * Called from performResetSequence after cancelPopulate().
>  * Default 60s timeout — informed by worst-case single-wallet populate duration.
>  * Callers must surface a progress indicator during the await.
>  */
> export async function waitForPopulateLoopToStop(timeoutMs = 60000): Promise<void> {
>   const start = Date.now();
>   while (populateLoopRunning.value) {
>     if (Date.now() - start > timeoutMs) {
>       throw new Error('waitForPopulateLoopToStop: timed out after ' + timeoutMs + 'ms');
>     }
>     await new Promise(resolve => setTimeout(resolve, 50));
>   }
> }
> ```
>
> ### `src/portfolio/v2/runtimes.ts`
>
> Lazy singletons `getComputeRuntime()` / `getPopulateRuntime()`, both `enableEventLoop: true`, both reuse MMKV bootstrap. If Phase 0.5 selects Branch C, add `getRateFetchRuntime()` here as the optional fourth runtime.
>
> ### `src/portfolio/v2/kvStore.ts`
>
> ```ts
> import { MmkvKvStore } from '../adapters/rn/mmkvKvStore';
> import {
>   getPortfolioMmkvStorageOnRN,
>   PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
>   PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
> } from '../adapters/rn/workletMmkvBridge';
>
> let singleton: MmkvKvStore | null = null;
>
> export function getPortfolioKvStore(): MmkvKvStore {
>   if (!singleton) {
>     singleton = new MmkvKvStore(getPortfolioMmkvStorageOnRN(), {
>       storageId: PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
>       registryKey: PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
>     });
>   }
>   return singleton;
> }
> ```
>
> V2 owns this helper. It does not exist in the repo today. Import the existing bridge constants instead of duplicating string literals so v1 and v2 point at the same registry.
>
> ### `src/portfolio/v2/reduxAccess.ts`
>
> ```ts
> import type { RootState } from '../../store';   // exact path per Phase 0 inventory
>
> type GetState = () => RootState;
> let storeGetter: GetState | null = null;
>
> /**
>  * Called once during app bootstrap inside the existing
>  *   getStore().then(({store, persistor}) => {...})
>  * callback in index.js, before <Provider> is mounted.
>  * Re-init is allowed (Fast Refresh, tests).
>  */
> export function initializePortfolioV2ReduxAccess(getter: GetState): void {
>   storeGetter = getter;
> }
>
> export function __setStoreGetterForTesting(getter: GetState | null): void {
>   storeGetter = getter;
> }
>
> function requireStoreGetter(): GetState {
>   if (!storeGetter) {
>     throw new Error(
>       'Portfolio v2 Redux access used before initializePortfolioV2ReduxAccess(). ' +
>       'App bootstrap must call initializePortfolioV2ReduxAccess(() => store.getState()) ' +
>       'inside the getStore().then(({store, persistor}) => {...}) callback in index.js.',
>     );
>   }
>   return storeGetter;
> }
>
> // Typed accessors. State paths must match Phase 0 inventory.
> // IMPORTANT: all reads inside function bodies. Never at module top level.
> export function getQuoteCurrencyFromStore(): string;
> export function getShowPortfolioEnabledFromStore(): boolean;
> export function getEligibleStoredWalletsFromStore(): readonly StoredWallet[];
> export function getLiveRatesByAssetIdFromStore(): Record<string, number>;
> export function getLiveRatesAsOfMsFromStore(): number | undefined;
> export function getBalancesByWalletIdFromStore(): Record<string, bigint>;
> export function getCurrentEligibleWalletIdSetFromStore(): Set<string>;
> export function getAssetIdForWalletFromStore(walletId: string): string | null;
> export function getAssetGroupIdForWalletFromStore(walletId: string): string | null;
> export function buildPopulateRuntimeContextFromStore(): PopulateRuntimeContext;
> // Builds walletsById AND signingContextsByWalletId. Signing contexts created via
> // createPortfolioTxHistorySigningDispatchContextOnRN({requestPrivKey, requestPubKey, requestCount})
> // from txHistorySigning.ts:716. Inputs (requestPrivKey, requestPubKey) come from each wallet's
> // credentials. See guardrail #26.
> ```
>
> **Rules (in the module's top comment):**
> - All v2 modules import from here. No direct `getStore()` or `store.getState()` calls elsewhere in v2.
> - Accessor reads inside function bodies only. **No module-top-level reads** (e.g., `export const FOO = getFooFromStore()` is forbidden).
> - Exact state paths verified against Phase 0 inventory.
>
> ### `src/portfolio/v2/ordering.ts`
>
> ```ts
> // Single source of truth. Used by buildQueue AND buildBaseRecomputeInputs fallback.
> export function computeOrderedAssetGroupIdsForAssetList(args: {
>   eligibleWallets: readonly StoredWallet[];
>   rates: Record<string, number>;
>   balancesByWalletId: Record<string, bigint>;
> }): string[];
> ```
>
> Phase 1 stubs with `throw new Error('unimplemented')`. Full impl in Phase 5.
>
> ### Stubs for later phases
>
> `scheduler.ts`, `selectors.ts` as stubs.
>
> ### `src/portfolio/v2/index.ts`
>
> Re-exports model, shared values, reset helper, `scheduleRecompute`, `initializePortfolioV2ReduxAccess`, stubs.
>
> ### Tests
>
> - `model.spec.ts` — `EMPTY_PORTFOLIO_STATE` snapshot.
> - `reduxAccess.spec.ts` — accessor throws pre-init; works post-init; re-init allowed; test injection works.
> - `sharedState.spec.ts` — `resetSharedPortfolioStateForDebugClear` sets state to empty, zeros all three ticks, leaves loop/cancel flags alone. `waitForPopulateLoopToStop` resolves immediately if flag already false; throws on timeout.
> - `resetState.spec.ts` — `initializePortfolioV2ResetState()` reads `PORTFOLIO_CACHE_INVALID_KEY`; `canRunPortfolioV2Work` is `false` while `populateResetInFlight` or `portfolioCacheInvalid` is set; `markPortfolioCacheInvalid()` and `clearPortfolioCacheInvalid()` round-trip both MMKV and in-memory state.

**Acceptance:** v2 compiles, tests pass, `tsc` clean, no v1 changes.

**LOC ledger:** +480 / 0 / +480.

---

# Phase 2 — `revision` schema + async v2 readers + invalid-index handling

**Goal:** `SnapshotIndexV2` has monotonic `revision` mirrored in both writers. Async v2 readers. `loadValidIndexOrNull` helper.

**Prompt:**

> ### Part A — mirrored schema
>
> Add required `revision: number` to `SnapshotIndexV2` in both:
> - `src/portfolio/core/pnl/snapshotStore.ts`
> - `src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts`
>
> Semantics: incremented in `saveIndex` on every save. First persisted value is **1**. `0` is the "no index" sentinel — any persisted index reading `0` is invalid. Update fixtures in both writers' spec files.
>
> ### Part B — validation helpers
>
> ```ts
> function validateSnapshotIndex(raw: unknown): SnapshotIndexV2 {
>   const obj = raw as any;
>   if (typeof obj?.revision !== 'number' || !Number.isFinite(obj.revision) || obj.revision < 1) {
>     throw new Error('SnapshotIndexV2: invalid or missing revision (must be >= 1)');
>   }
>   return obj as SnapshotIndexV2;
> }
>
> export async function loadValidIndexOrNull(walletId: string): Promise<SnapshotIndexV2 | null> {
>   try {
>     const raw = await loadRawIndex(walletId);
>     if (raw === null) return null;
>     return validateSnapshotIndex(raw);
>   } catch (err) {
>     logInvalidSnapshotIndex(walletId, err);
>     return null;
>   }
> }
>
> export async function hasAnyWalletSnapshotData(walletId: string): Promise<boolean>;
> ```
>
> All callers migrate to `loadValidIndexOrNull`.
>
> ### Part C — async v2 readers
>
> `src/portfolio/v2/workletData/snapshotsKv.ts`, reusing v1 key builders:
>
> ```ts
> export async function listSnapshotChunksForWallet(walletId: string): Promise<SnapshotChunk[]>;
> export async function loadLatestSnapshot(walletId: string): Promise<BalanceSnapshotStored | null>;
> export async function iteratePoints(walletId: string, opts): Promise<SnapshotPointV2[]>;
> export async function findLastPointAtOrBefore(walletId: string, ts: number): Promise<SnapshotPointV2 | null>;
> export async function loadIndexRevision(walletId: string): Promise<number | null>;
> ```
>
> `ratesKv.ts`:
>
> ```ts
> export async function loadRateSeries(args): Promise<{ points: FiatRatePoint[]; fetchedOn: number } | null>;
> export async function loadRateFetchedOn(args): Promise<number | null>;
> ```
>
> `ratesFetch.ts` (JS):
>
> **Structural requirement:** `ensureFresh` must be implemented as separate **freshness-check + fetch** and **persist** steps with a `canRunPortfolioV2Work()` check between them (guardrail #22's "re-check before persist"). A thin wrapper around v1's `FiatRateStore.ensureRates()` (which bundles freshness-check + fetch + parse + persist at `fiatRateStore.ts:190`) is **not acceptable** — it makes the second guard check structurally impossible.
>
> **Required v18 shape (repo-accurate):**
>
> - V2 keeps this repair **outside** the untouched kernels. Do **not** split/export v1's `ensureRates()`; guardrail #2 still holds.
> - `FiatRateStore.getSeries(...)` and `FiatRateStore.setSeries(...)` are public and reusable from v2.
> - `extractSeries(...)` is **not** reusable today. It is a file-local helper in `fiatRateStore.ts:71` (and separately in `portfolioWorkletRates.ts:104`). V2 must add a v2-owned clone such as `extractSeriesFromFiatRatePayload(...)`; do not refactor kernels just to expose it.
> - The fetch step is still worklet-only and still requires a dispatch context for Nitro fetch. `RnBwsFiatRateProvider.loadSeries` at `bwsFiatRateProvider.ts:13` is `'worklet'`-tagged and calls `getPortfolioNitroFetchClientOnRuntime()`, which reads the fetch client from the runtime's current dispatch context.
> - Preserve v1's freshness semantics: `ensureFresh(...)` accepts `maxAgeMs` and `force`, checks existing persisted series, skips fresh assets, uses the default-coin fallback behavior, and only fetches the missing subset.
> - `resolveStoredFiatRateInterval(...)` is load-bearing: displayed `3M`, `1Y`, and `5Y` map to stored interval `ALL`. `ensureFresh(...)` never persists separate `3M` / `1Y` / `5Y` rows.
> - `ensureFresh(...)` is **not** the quote-switch path. Quote switching uses a BTC FX bridge helper described below; do not force-fetch every visible asset in the new quote.
>
> ```ts
> import {
>   createPortfolioTxHistorySigningDispatchContextOnRN,
>   setPortfolioTxHistorySigningDispatchContextOnRuntime,
>   clearPortfolioTxHistorySigningDispatchContextOnRuntime,
>   type PortfolioTxHistorySigningDispatchContext,
> } from '../adapters/rn/txHistorySigning';
>
> let inFlightCount = 0;
> const ensureFreshInFlightListeners = new Set<() => void>();
>
> function notifyEnsureFreshInFlightListeners(): void {
>   ensureFreshInFlightListeners.forEach(listener => listener());
> }
>
> function setEnsureFreshInFlightCount(next: number): void {
>   const safeNext = Math.max(0, next);
>   if (inFlightCount === safeNext) return;
>   inFlightCount = safeNext;
>   notifyEnsureFreshInFlightListeners();
> }
>
> export function getEnsureFreshInFlightCount(): number {
>   return inFlightCount;
> }
>
> export function subscribeToEnsureFreshInFlight(listener: () => void): () => void {
>   ensureFreshInFlightListeners.add(listener);
>   return () => ensureFreshInFlightListeners.delete(listener);
> }
>
> // V2-owned clone of fiatRateStore.ts:71 / portfolioWorkletRates.ts:104.
> // Keep this helper in v2 so guardrail #2 ("don't refactor kernels") remains true.
> function extractSeriesFromFiatRatePayload(
>   raw: unknown,
>   coin: string,
> ): FiatRateSeries | null;
>
> export async function ensureFresh(args: {
>   cfg: BwsConfig;
>   quoteCurrency: string;
>   interval: FiatRateInterval;
>   coins: string[];
>   assets?: FiatRateAssetRef[];
>   maxAgeMs?: number;
>   force?: boolean;
> }): Promise<void> {
>   if (!canRunPortfolioV2Work()) return;       // GUARD at entry (guardrail #21)
>   setEnsureFreshInFlightCount(inFlightCount + 1);
>   try {
>     const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
>     const interval = resolveStoredFiatRateInterval(args.interval);
>     const assets = normalizeUniqueFiatRateAssets(args.coins, args.assets);
>     const maxAgeMs =
>       typeof args.maxAgeMs === 'number' && Number.isFinite(args.maxAgeMs)
>         ? Math.max(0, args.maxAgeMs)
>         : undefined;
>
>     const missingDefaults: string[] = [];
>     const missingExplicit: FiatRateAssetRef[] = [];
>     const fallbackDefaultCoins = new Set<string>();
>
>     // ---- FRESHNESS GATE (JS-side, mirrors fiatRateStore.ensureRates) ----
>     for (const asset of assets) {
>       const existing = await fiatRateStore.getSeries({
>         quoteCurrency,
>         coin: asset.coin,
>         interval,
>         chain: asset.chain,
>         tokenAddress: asset.tokenAddress,
>       });
>       if (existing?.points?.length) {
>         const hasPersistedFetchedOn =
>           hasStoredFiatRateSeriesPersistedFetchedOn(existing);
>         const isFresh =
>           hasPersistedFetchedOn &&
>           !args.force &&
>           (typeof maxAgeMs !== 'number' ||
>             Date.now() - Number(existing.fetchedOn) <= maxAgeMs);
>         if (isFresh) {
>           continue;
>         }
>         if (!asset.tokenAddress) {
>           fallbackDefaultCoins.add(asset.coin);
>         }
>       }
>
>       if (asset.tokenAddress) missingExplicit.push(asset);
>       else missingDefaults.push(asset.coin);
>     }
>
>     if (!missingDefaults.length && !missingExplicit.length) {
>       return;
>     }
>
>     const dispatchContext = createPortfolioTxHistorySigningDispatchContextOnRN({
>       requestCount: 1,
>     });
>
>     if (missingDefaults.length) {
>       let payload: FiatRateSeriesResponse | null = null;
>       try {
>         payload = await runOnRuntimeAsync(
>           getPopulateRuntime(),
>           loadSeriesWorkletWithContext,
>           {
>             args: {
>               cfg: args.cfg,
>               quoteCurrency,
>               interval,
>               coins: missingDefaults,
>             },
>             dispatchContext,
>           },
>         );
>       } catch (error) {
>         const missingWithoutFallback = missingDefaults.filter(
>           coin => !fallbackDefaultCoins.has(coin),
>         );
>         if (missingWithoutFallback.length) {
>           throw error;
>         }
>       }
>
>       if (!canRunPortfolioV2Work()) return;   // SECOND guard before persist
>
>       if (payload) {
>         for (const coin of missingDefaults) {
>           const series = extractSeriesFromFiatRatePayload(payload, coin);
>           if (series?.points?.length) {
>             await fiatRateStore.setSeries({quoteCurrency, coin, interval, series});
>           }
>         }
>       }
>     }
>
>     for (const asset of missingExplicit) {
>       const payload = await runOnRuntimeAsync(
>         getPopulateRuntime(),
>         loadSeriesWorkletWithContext,
>         {
>           args: {
>             cfg: args.cfg,
>             quoteCurrency,
>             interval,
>             coins: [asset.coin],
>             asset,
>           },
>           dispatchContext,
>         },
>       ).catch(() => null);
>
>       if (!canRunPortfolioV2Work()) return;   // SECOND guard before persist
>       if (!payload) continue;
>
>       const series = extractSeriesFromFiatRatePayload(payload, asset.coin);
>       if (series?.points?.length) {
>         await fiatRateStore.setSeries({
>           quoteCurrency,
>           coin: asset.coin,
>           interval,
>           series,
>           chain: asset.chain,
>           tokenAddress: asset.tokenAddress,
>         });
>       }
>     }
>   } finally {
>     setEnsureFreshInFlightCount(inFlightCount - 1);
>   }
> }
>
> async function loadSeriesWorkletWithContext(params: {
>   args: Parameters<FiatRateProvider['loadSeries']>[0];
>   dispatchContext: PortfolioTxHistorySigningDispatchContext;
> }): Promise<FiatRateSeriesResponse> {
>   'worklet';
>   setPortfolioTxHistorySigningDispatchContextOnRuntime(params.dispatchContext);
>   try {
>     const provider = new RnBwsFiatRateProvider();
>     return await provider.loadSeries(params.args);
>   } finally {
>     clearPortfolioTxHistorySigningDispatchContextOnRuntime();
>   }
> }
>
> /**
>  * Polls inFlightCount. Third wait in performResetSequence's Promise.all.
>  * 20s timeout: network fetch typically 10-15s with its own timeout, plus buffer.
>  * If any fetch is genuinely stuck past this, reset aborts with throw.
>  */
> export async function waitForEnsureFreshToStop(timeoutMs = 20000): Promise<void> {
>   const start = Date.now();
>   while (inFlightCount > 0) {
>     if (Date.now() - start > timeoutMs) {
>       throw new Error('waitForEnsureFreshToStop: timed out after ' + timeoutMs + 'ms');
>     }
>     await new Promise(resolve => setTimeout(resolve, 50));
>   }
> }
> ```
>
> **Quote-switch FX bridge (NEW, product-load-bearing):**
>
> Quote switches must update instantly across Home / All Assets / Allocation / detail screens without fan-out refetches in the new quote currency. Implement a dedicated helper such as:
>
> ```ts
> export async function ensureQuoteCurrencyFxBridge(args: {
>   fromQuoteCurrency: string;
>   toQuoteCurrency: string;
>   intervals: readonly StoredRateInterval[]; // canonical subset only
> }): Promise<FxBridgeSnapshot>;
> ```
>
> Required behavior:
> - Fetch/persist only BTC series for the target quote currency and canonical stored intervals (`1D`, `1W`, `1M`, `ALL`).
> - Derive the old-quote -> new-quote bridge factor from persisted BTC data.
> - Hand the bridge snapshot to `recomputeQuoteBridgeFromSharedState(...)`, a compute-runtime helper from Phase 3 that transforms only the current `sharedPortfolioState` into the new quote.
> - `recomputeQuoteBridgeFromSharedState(...)` must not consult `loadQueue()`, `queue.doneWalletIds`, or raw snapshot/rate MMKV. It is a current-shared-state bridge transform, not a fresh-data recompute.
> - Do **not** call `ensureFresh(...)` for every visible asset group on quote switch.
> - Displayed `3M` / `1Y` / `5Y` still derive from `ALL` after the bridge is applied.
> - This bridge path is what allows quote switches to publish immediately without forcing per-asset new-quote fetches.
>
> **Branch-specific concurrency wrapping:** depending on Phase 0.5 spike results (guardrail #27), `ensureFresh`'s `runOnRuntimeAsync` call and/or the target runtime may be wrapped with additional concurrency primitives. Branch A: no additional populate-vs-rate wrapping. Branch B: `portfolioRuntimeSerial` executor. Branch C: target `getRateFetchRuntime()` instead of `getPopulateRuntime()`. Branch D: worklet-side lock inside `loadSeriesWorkletWithContext`. Identical-args dedupe is always on. If probe 3 is dirty/flaky, additionally serialize non-identical `ensureFresh` calls at the JS level. See Phase 0.5 branch table for exact implementation per spike outcome.
>
> **Two defenses together** (guardrail #22 pattern):
> 1. `waitForEnsureFreshToStop` in `performResetSequence`'s `Promise.all` blocks the wipe until all fetches complete or exit.
> 2. Second `canRunPortfolioV2Work` check after network fetch resolves prevents write-after-guard-flip even if the wait is about to decrement inFlightCount.
> Both are needed: the wait ensures quiescence; the second check ensures no orphan writes during quiescence. Neither alone is sufficient — wait without second-check lets pre-wait-resolved fetches write; second-check without wait can still race with wipe iteration.
>
> **Called by triggers (Phase 6), NEVER by the scheduler.** Timeframe switches and chart scrubbing do not call `ensureFresh(...)`.
>
> ### Tests
>
> Readers match v1; validation tests cover missing/non-number/zero/negative/valid. `ensureFresh` in-flight tracking: `inFlightCount` increments before network fetch, decrements after persist or early-exit, `waitForEnsureFreshToStop` resolves only after count reaches 0.
> Add tests that:
> - `resolveStoredFiatRateInterval('3M' | '1Y' | '5Y') === 'ALL'`.
> - `ensureFresh(...)` never persists standalone `3M` / `1Y` / `5Y` rate keys.
> - `ensureQuoteCurrencyFxBridge(...)` fetches only BTC bridge series for the target quote and does not fan out per-asset quote fetches.

**LOC ledger:** +680 / 0 / +680.

---

# Phase 3 — `recompute()`, three-phase scheduler, fingerprints, orderRevision

**Goal:** compute runtime produces correct `PortfolioState`. Three-phase drain. Interval-specific fingerprints with first+last endpoints. Five scope kinds. **One unified rule: heavy scopes may advance `orderRevision` + order; touch scopes never do.**

**Prompt:**

> Create `src/portfolio/v2/recompute.ts`:
>
> ```ts
> export async function recompute(inputs: RecomputeInputs): Promise<void> { 'worklet';
>   const prev = sharedPortfolioState.value;
>   const next = await buildNextPortfolioState(prev, inputs);
>   if (next !== prev) sharedPortfolioState.value = next;
> }
> ```
>
> ## Scope dispatch
>
> **Heavy scopes (`'full'`, `{ kind: 'wallet' }`, `{ kind: 'wallets' }`):**
> - Update `computedAtMs`.
> - **Advance `orderedAssetGroupIdsForAssetList` + `orderRevision` if `inputs.orderRevision > prev.orderRevision`.** Otherwise preserve prev's order + revision. This is the one rule, applied uniformly across heavy scopes.
> - `'full'`: rebuild `byAssetGroup` + `total`. Maintain `byWallet` (rebuild only changed; never add new).
> - `{ kind: 'wallet' }`: build/update that `byWallet[walletId]`.
> - `{ kind: 'wallets' }`: build/update each listed `byWallet[id]`.
>
> **Touch scopes (`{ kind: 'touchWallet' }`, `{ kind: 'touchWallets' }`):**
> - If any listed slice exists, shallow-copy with new `lastAccessedAt`, publish.
> - Else no-op (return `prev`).
> - **Never** change series/row fingerprints, `computedAtMs`, readiness maps, `byAssetGroup`, `total`, `totalFingerprint`, `quoteCurrency`, `orderedAssetGroupIdsForAssetList`, or `orderRevision`.
>
> ## Asset-group aggregation (full scope)
>
> For each `assetGroupId = lowercased currencyAbbreviation` in both `inputs.eligibleWallets` and `inputs.populatedWalletIds`, call `buildPnlAnalysisSeriesFromStreamed` with **all wallets for that asset group at once**. This preserves current cross-chain collapse behavior (e.g. USDC across ETH / POL / SOL in one row). Do not sum separately-built per-wallet analysis into a group after the fact.
>
> ## Total series (full scope)
>
> `buildPnlAnalysisSeriesFromStreamed` with all eligible populated wallets.
>
> ## Stored vs displayed intervals
>
> Persisted/fetched fiat-rate intervals are only `1D`, `1W`, `1M`, and `ALL`. Displayed `3M`, `1Y`, and `5Y` are derived by windowing `ALL` on the compute runtime. Timeframe switching is therefore a pure compute/selector operation and must not call `ensureFresh(...)` or snapshot update code.
>
> ## Shared interval-window helper
>
> Add one helper such as `resolveDisplayedIntervalWindow(tf, now, ratePoints)` and use it for:
> - asset-group PnL/chart derivation,
> - wallet/detail PnL/chart derivation,
> - Exchange Rate screen parity tests.
>
> This helper is load-bearing for the product contract: if there are no transactions in the chosen window, the asset PnL percentage for that window must equal the Exchange Rate percentage for that same window. Resolve one shared `{startTs, endTs, asOfMs}` window for the requested interval, then produce identical boundary samples for portfolio PnL and Exchange Rate calculations. If the rate series has no raw point exactly at `startTs` or `endTs`, linearly interpolate a synthetic boundary sample from the surrounding rate points. Do not let PnL and Exchange Rate derive their windows or boundary values independently.
>
> ## PnL formula parity (do not change)
>
> V18 must preserve the existing v1 PnL formula exactly. The current source of truth is `src/portfolio/core/pnl/analysisStreaming.ts`:
> - `createWalletAnalysisState(...)` initializes the timeframe-local remaining cost basis.
> - `applyAnalysisPointToWalletState(...)` updates that basis for inflows/outflows inside the window.
> - point construction computes chart `totalPnlChange` / `totalPnlPercent`.
> - `finalizeAnalysisResult(...)` computes `AssetPnlSummary` / `TotalPnlSummary`.
> Asset-list and asset-detail idle rows then reuse `src/portfolio/ui/selectors/buildAssetRowsFromAnalysis.ts`.
> This prose is the v18 behavioral spec; `analysisStreaming.ts` is the current implementation of that spec; Required parity test #3 enforces that v2 matches both.
>
> **Formula, for every displayed timeframe (`1D`, `1W`, `1M`, `3M`, `1Y`, `5Y`, `ALL`):**
>
> 1. Resolve the timeframe window/timeline. The first timeline timestamp is the **baseline timestamp** for that timeframe. Timeframes change only this window/timeline; they do not change the math below.
> 2. For each asset, `baselineRate = rateAt(firstTimelineTimestamp)`.
> 3. For each wallet, initialize `unitsAtomic` from the wallet's `basePoint` at the window start and initialize `remainingCostBasisFiat = unitsAtWindowStart * baselineRate`.
> 4. For each in-window balance-change point:
>    - If `deltaAtomic > 0`, add cost basis for the new units at the event rate: `remainingCostBasisFiat += deltaUnits * rateAt(point.timestamp)`.
>    - If `deltaAtomic < 0` and prior units are positive, dispose cost basis pro rata: `remainingCostBasisFiat *= afterAtomic / beforeAtomic`.
>    - If units become zero or negative, set both units and remaining cost basis to zero.
>    - Clamp non-finite or negative remaining cost basis back to zero.
> 5. At each chart sample timestamp:
>    - `fiatBalance = units * markRate`.
>    - `unrealizedPnlFiat = fiatBalance - remainingCostBasisFiat`.
>    - Per-wallet `pnlPercent = remainingCostBasisFiat > 0 ? (unrealizedPnlFiat / remainingCostBasisFiat) * 100 : 0`.
> 6. For chart/series total points:
>    - `totalFiatBalance = sum(wallet.fiatBalance)`.
>    - `totalRemainingCostBasisFiat = sum(wallet.remainingCostBasisFiat)`.
>    - `totalUnrealizedPnlFiat = totalFiatBalance - totalRemainingCostBasisFiat`.
>    - `firstTotalUnrealizedPnlFiat = totalUnrealizedPnlFiat` at the first emitted point.
>    - `totalPnlChange = totalUnrealizedPnlFiat - firstTotalUnrealizedPnlFiat`.
>    - `totalPnlPercent = totalRemainingCostBasisFiat > 0 ? (totalUnrealizedPnlFiat / totalRemainingCostBasisFiat) * 100 : 0`.
>    - At the final point of a series, these endpoint formulas are equivalent to the asset-summary formulas below when the scope, wallet set, quote currency, and interval window are identical.
> 7. For each raw asset `AssetPnlSummary`:
>    - `pnlStart = sum(firstPoint.wallet.unrealizedPnlFiat for wallets in asset)`.
>    - `pnlEnd = sum(lastPoint.wallet.unrealizedPnlFiat for wallets in asset)`.
>    - `remainingCostBasisFiatEnd = sum(lastPoint.wallet.remainingCostBasisFiat for wallets in asset)`.
>    - `pnlChange = pnlEnd - pnlStart`.
>    - `pnlPercent = remainingCostBasisFiatEnd > 0 ? (pnlEnd / remainingCostBasisFiatEnd) * 100 : 0`.
>    - `ratePercentChange = rateStart > 0 ? ((rateEnd - rateStart) / rateStart) * 100 : 0`.
> 8. For collapsed asset-group rows (`USDC` across chains, etc.), reuse the current row aggregation formula from `buildAssetRowsFromAnalysis.ts`:
>    - `row.pnlFiat = sum(assetSummary.pnlChange)`.
>    - `row.pnlPercent = sum(assetSummary.remainingCostBasisFiatEnd) > 0 ? (sum(assetSummary.pnlEnd) / sum(assetSummary.remainingCostBasisFiatEnd)) * 100 : 0`.
>    - `row.fiatValue = sum(assetSummary.fiatBalanceEnd)`.
>    - Asset-detail idle summaries must use the same row metrics so row and detail match byte-for-byte.
>
> **Row/detail equality rule:** `rowToday` and `rowAllTime` are endpoint extractions from the same scoped series used by Asset Detail, not separate business logic. For a given `(assetGroupId, optional keyId wallet scope, quoteCurrency)`, the asset-list row for Today must equal the Asset Detail `1D` chart's final displayed change row, and the asset-list row for All Time must equal the Asset Detail `ALL` chart's final displayed change row. Equality requires using the same grouped wallet set, same interval window, same quote, same rate boundary samples, and same collapsed-asset aggregation. If an implementation stores row payloads separately for selector speed, those payloads must be derived from the same recompute pass and endpoint values as the corresponding series. Test this byte-for-byte for row/detail endpoint equality; use `1e-8` numeric tolerance for formula parity unless existing v1 output is byte-for-byte stable.
>
> **Do not replace this with `pnlChange / fiatBalanceStart`, `pnlChange / remainingCostBasisFiatStart`, `pnlChange / pnlStart`, or any other return formula.** The displayed PnL percent is the current unrealized PnL divided by current remaining cost basis for the selected timeframe/window. In a no-transaction window, this naturally reduces to the rate percent change because remaining cost basis is initialized from holdings at the baseline rate.
>
> ## Quote-switch shared-state recompute
>
> Add one compute-runtime helper such as `recomputeQuoteBridgeFromSharedState(args)` and call it **only** from `onQuoteCurrencyChanged(...)`.
>
> Required behavior:
> - Read `sharedPortfolioState.value` as the sole portfolio-state input.
> - Apply the BTC bridge snapshot to the currently published chart/row outputs and `quoteCurrency`.
> - Preserve readiness/order state; this helper is a quote transform of currently published data, not a fresh populate publish.
> - Do **not** read `loadQueue()`, `queue.doneWalletIds`, or raw snapshot/rate MMKV state. It transforms the currently published `sharedPortfolioState` only.
>
> ## Fingerprints
>
> **Per-interval primitive:** includes `rateFetchedOnForThisInterval` (per-interval), `liveRate`, `liveRatesAsOfMs`, `quoteCurrency`, `assetId`, `sortedWalletIds`, `snapshotRevisionsByWalletId`, `interval`.
>
> **Asset:** derived from interval fingerprints.
>
> **Series** with first+last endpoints (O(1); mid-series mutations pinned as intentional limitation):
>
> ```ts
> seriesFingerprint = [
>   inputFingerprint, points.length,
>   first?.ts ?? '', first?.fiat ?? '', first?.pnl ?? '',
>   last?.ts ?? '',  last?.fiat ?? '',  last?.pnl ?? '',
> ].join('|');
> ```
>
> **Row:** `[fiatEnd, pnlChange, pnlPercent, rateEnd, ratePercent].map(stableFormat).join('|')`.
>
> ## Precomputed row payloads
>
> `rowToday` from `series['1D']` endpoints. `rowAllTime` from `series['ALL']`. Stored on `AssetGroupSlice`. Also store per-wallet `rowToday` / `rowAllTime` on `WalletSlice` so scoped key views can derive key-local rows without consulting Redux.
>
> ## Reuse-by-reference
>
> Same fingerprint as prev → reuse prev reference.
>
> ## Readiness maps
>
> Build both `populatedWalletIdsById` (O(1) membership) and `populatedWalletIdsKey` (scalar signature). Same for asset groups. Selectors use `*ById`.
>
> ## Eviction (soft cap N=8)
>
> Post-wallet-scope writes. Current scope's walletIds protected. Soft — if protected set > 8, result > 8.
>
> ## Revision
>
> `revision = prev.revision + 1` iff anything changed. Touch scopes bump only if at least one slice updated.
>
> ## Yield points
>
> Every 512 points in asset-group loop: `await Promise.resolve()`.
>
> ## Scheduler — three-phase drain
>
> ```ts
> type PendingWork = {
>   runFull: boolean;
>   walletBuildIds: Set<string>;
>   touchIds: Set<string>;
>   baseInputs: Omit<RecomputeInputs, 'scope'>;
> };
>
> // Drain order: full → wallet-builds → touches.
> // full does NOT subsume walletBuildIds or touchIds.
> const schedulerDrainListeners = new Set<() => void>();
>
> function notifySchedulerDrainListeners(): void {
>   schedulerDrainListeners.forEach(listener => listener());
> }
>
> function setSchedulerDrainRunning(next: boolean): void {
>   if (running === next) return;
>   running = next;
>   notifySchedulerDrainListeners();
> }
>
> export function isRecomputeDrainRunning(): boolean {
>   return running;
> }
>
> export function subscribeToSchedulerDrain(listener: () => void): () => void {
>   schedulerDrainListeners.add(listener);
>   return () => schedulerDrainListeners.delete(listener);
> }
>
> export function scheduleRecompute(next: RecomputeInputs): void {
>   if (!canRunPortfolioV2Work()) return;   // GUARD — first executable statement
>   pending = pending ? mergeInputs(pending, next) : toPendingWork(next);
>   if (!running) void drain();
> }
>
> async function drain(): Promise<void> {
>   setSchedulerDrainRunning(true);
>   try {
>     while (pending) {
>       if (!canRunPortfolioV2Work()) { pending = null; return; }
>       const work = pending;
>       pending = null;
>
>       if (!canRunPortfolioV2Work()) return;
>       if (work.runFull) await runOnRuntimeAsync(getComputeRuntime(), recompute, { ...work.baseInputs, scope: 'full' });
>
>       if (!canRunPortfolioV2Work()) return;
>       if (work.walletBuildIds.size > 0) { /* ... wallets scope ... */ }
>
>       if (!canRunPortfolioV2Work()) return;
>       if (work.touchIds.size > 0) { /* ... touches scope ... */ }
>     }
>   } finally { setSchedulerDrainRunning(false); }
> }
>
> /**
>  * Waits for any in-flight drain to finish. Called by performResetSequence before
>  * wiping MMKV so a mid-recompute runtime can't read post-wipe storage or publish
>  * post-reset state. Same shape as waitForPopulateLoopToStop.
>  *
>  * Drain bails at phase boundaries via canRunPortfolioV2Work checks, but the
>  * currently-awaited runOnRuntimeAsync(recompute) must complete first. That's
>  * what this waits for.
>  *
>  * 30s timeout — a full recompute is bounded by asset count, not wallet-history
>  * depth, so worst-case is several seconds even for large portfolios.
>  */
> export async function waitForRecomputeDrainToStop(timeoutMs = 30000): Promise<void> {
>   const start = Date.now();
>   while (running) {
>     if (Date.now() - start > timeoutMs) {
>       throw new Error('waitForRecomputeDrainToStop: timed out after ' + timeoutMs + 'ms');
>     }
>     await new Promise(resolve => setTimeout(resolve, 50));
>   }
> }
> ```
>
> **`mergeInputs(work, incoming)` — accumulate:**
>
> baseInputs:
> - `quoteCurrency`, `liveRatesAsOfMs`: take incoming.
> - `liveRatesByAssetId`: spread-merge with incoming winning per key.
> - `eligibleWallets`: prefer incoming if defined.
> - `populatedWalletIds`: union.
> - **`orderedAssetGroupIdsForAssetList` + `orderRevision`: take whichever pair has higher `orderRevision`.** Equal: equivalent content, take either.
>
> Scope accumulation:
> - Incoming `'full'` → `work.runFull = true`. Wallet builds and touches preserved.
> - Incoming `wallet` → `walletBuildIds.add`; remove from `touchIds`.
> - Incoming `wallets` → add all; remove overlap from `touchIds`.
> - Incoming `touchWallet` → if in `walletBuildIds`, no-op. Else `touchIds.add`.
> - Incoming `touchWallets` → per id.
>
> ## Tests
>
> `__tests__/recompute.spec.ts`:
>
> **Numeric parity (load-bearing):**
> - ~20 fixtures; `Series.points` matches v1 point-by-point, every interval, 1e-8.
>
> **Fingerprint invalidation + pinned limitation** — per-interval, endpoints, length, live rate, pinned mid-series.
>
> **Scope isolation:**
> - `wallet` scope: `byAssetGroup[*]` reference-equal to prev; `orderedAssetGroupIdsForAssetList` / `orderRevision` advance if incoming newer, else preserved.
> - `wallets` scope: same order-advance behavior as wallet scope.
> - `full` scope: same order-advance behavior.
> - `touchWallet` existing: revision bumps, `lastAccessedAt` updates, all other fields reference-equal, `computedAtMs` unchanged, `orderRevision` unchanged.
> - `touchWallet` missing: returns prev.
>
> **Order revision behavior (unified rule):**
> - Heavy scope with `inputs.orderRevision > prev.orderRevision` → order + revision replaced.
> - Heavy scope with `inputs.orderRevision <= prev.orderRevision` → both preserved.
> - Touch scope → never changes order/revision regardless of incoming.
>
> **Soft-cap eviction + total via kernel.**
>
> `__tests__/scheduler.spec.ts` — three-phase drain:
> - `wallets[A,B]` then `full` → both run; `byWallet[A/B]` exist.
> - Reverse order → same.
> - `full` then `touchWallet X` existing → touch runs as phase C.
> - `wallet A` then `touchWallet A` → touch subsumed.
> - `touchWallet A` then `wallet A` → touch removed from touchIds.
> - 100 rapid touches different ids → 1 drain, phase C runs `touchWallets`.
> - 100 rapid schedules → 1–3 drains.
> - Incremental populate in progress + `onLiveRatesUpdated` queues a heavy recompute → scheduler still drains normally and can publish as recomputes land.
>
> **Order revision merge regression:**
> - work rev=5 [X,Y,Z] + incoming rev=7 [X,Z] → rev=7, [X,Z] wins.
> - work rev=7 [X,Z] + incoming rev=5 [X,Y,Z] → work wins.
>
> **Scope uniformity regression:**
> - wallet-scope recompute with `inputs.orderRevision > prev.orderRevision` → order advances. (Regresses the v7 contradiction where `wallet` scope bullets said "do not touch order.")
>
> **Asset-group parity (NEW, product-load-bearing):**
> - ETH-native + POL-USDC + SOL-USDC fixture → Home / All Assets / Allocation collapse USDC into one `assetGroupId = 'usdc'`.
> - `selectAllocationRows` and `selectOrderedAssetGroupIds` return the same relative order for the same wallet set.
> - Switching `3M` / `1Y` / `5Y` windows reuses `ALL`-derived data and does not invoke rate or snapshot refresh paths.
> - No-transactions-in-window fixture → PnL % equals Exchange Rate % for the same interval window.

**Acceptance:** all parity 1e-8 point-by-point. All scope/order tests pass. `tsc` clean.

**LOC ledger:** +1,220 / 0 / +1,220.

---

# Phase 4 — Selectors and single read hook

**Goal:** JS reads via one hook. Clone-proof equality helpers.

**Prompt:**

> `src/portfolio/v2/selectors.ts` — all `'worklet'`, pure of state + primitives. **No Redux.**
>
> ```ts
> export function selectTotalSeries(s, tf): Series | undefined;
> export function selectAssetGroupSeries(s, assetGroupId, tf): Series | undefined;
> export function selectWalletSeries(s, walletId, tf): Series | undefined;
> export function selectAssetGroupRow(s, assetGroupId, mode): RowPayload | undefined;
> export function selectIsAssetGroupReady(s, assetGroupId): boolean;
> export function selectIsWalletReady(s, walletId): boolean;
> export function selectHasAnyPopulatedWallets(s): boolean;
> export function selectOrderedAssetGroupIds(s): readonly string[];
> export function selectAllocationRows(s): readonly AllocationRow[];
> export function selectKeySeries(s, walletIds, tf): Series | undefined;
> export function selectScopedAssetGroupRows(s, walletIds, mode): readonly RowPayload[];
> export function selectScopedOrderedAssetGroupIds(s, walletIds): readonly string[];
> ```
>
> `src/portfolio/v2/hooks/usePortfolioSlice.ts`:
>
> ```ts
> export function usePortfolioSlice<T>(
>   selector: (s: PortfolioState) => T,
>   areEqual?: (a: T, b: T) => boolean,
> ): T;
> ```
>
> `src/portfolio/v2/hooks/useSharedValueAsState.ts`:
>
> ```ts
> import {useState} from 'react';
> import {runOnJS, useAnimatedReaction, type SharedValue} from 'react-native-reanimated';
>
> export function useSharedValueAsState<T>(sharedValue: SharedValue<T>): T {
>   const [state, setState] = useState(sharedValue.value);
>   useAnimatedReaction(
>     () => sharedValue.value,
>     (current, previous) => {
>       if (current !== previous) runOnJS(setState)(current);
>     },
>   );
>   return state;
> }
> ```
>
> `src/portfolio/v2/hooks/useIsPortfolioRefreshing.ts`:
>
> ```ts
> import {useSyncExternalStore} from 'react';
> import {populateLoopRunning} from '../sharedState';
> import {useSharedValueAsState} from './useSharedValueAsState';
> import {
>   getEnsureFreshInFlightCount,
>   subscribeToEnsureFreshInFlight,
> } from '../workletData/ratesFetch';
> import {
>   isRecomputeDrainRunning,
>   subscribeToSchedulerDrain,
> } from '../scheduler';
>
> export function useIsPortfolioRefreshing(): boolean {
>   const populateRunning = useSharedValueAsState(populateLoopRunning);
>   const ensureFreshActive = useSyncExternalStore(
>     subscribeToEnsureFreshInFlight,
>     () => getEnsureFreshInFlightCount() > 0,
>   );
>   const recomputeActive = useSyncExternalStore(
>     subscribeToSchedulerDrain,
>     isRecomputeDrainRunning,
>   );
>   return populateRunning || ensureFreshActive || recomputeActive;
> }
> ```
>
> The refreshing affordance is derived from work actually running, not from trigger-owned `set true / set false` bookkeeping; it may lag a just-kicked populate by a frame before `populateLoopRunning.value` flips true, which is acceptable because the indicator is not correctness state.
>
> Equality helpers:
>
> ```ts
> // Clone-proof — compares fingerprints, NOT identity.
> export function areEqualByRowFingerprint(a, b): boolean;
> export function areEqualBySeriesFingerprint(a, b): boolean;
> ```
>
> Chart-boundary contract: memoize on `series.fingerprint`, not `series.points`.
>
> Tests cover: re-renders only on !areEqual; cloned state with same fingerprints → no re-render.
>
> `useIsPortfolioRefreshing.spec.tsx`: hook returns true while `populateLoopRunning`, `ensureFresh` in-flight count, or scheduler drain running is active; returns false only when all three are idle; overlapping sources do not flicker false between transitions. Trigger tests assert no trigger owns manual refresh true/false state.
>
> **Key-scoped selector rule (product-load-bearing):** `AllAssets({keyId})` and asset-detail routes reached from `KeyOverview` do **not** read global Home rows and then filter them. They use the scoped selectors above so row values, readiness, and detail charts are all derived from that key's wallet set only.
>
> **Scoped aggregation strategy (explicit, not hand-waved):** keep selectors observationally pure, but memoize scoped aggregations inside the selector module with a bounded cache keyed by `(state.revision, walletIdsKey, assetGroupId, tf, mode)`. Do **not** recompute key-scoped grouped rows/series from scratch on every scrub tick.

**LOC ledger:** +290 / 0 / +290.

---

# Phase 5 — Populate runtime, reconciliation, ordering, fire-time subscriber

**Goal:** populate runs end-to-end. Single-flight, missing-creds exit, invalid-index recovery, queue reconciliation with order pruning. **`buildQueue` monotonic `orderRevision` across rebuilds.** Fire-time reads in `PortfolioV2Root`. Bootstrap wiring inside existing `getStore().then(...)` callback.

**Prompt:**

> ### `src/portfolio/v2/ordering.ts` — full implementation
>
> ```ts
> export function computeOrderedAssetGroupIdsForAssetList(args: {
>   eligibleWallets: readonly StoredWallet[];
>   rates: Record<string, number>;
>   balancesByWalletId: Record<string, bigint>;
> }): string[] {
>   // Group wallets by assetGroupId = lowercased currencyAbbreviation.
>   // Compute per-group total fiat value and sort descending.
>   // Within each group, expand wallets in descending per-wallet fiat value
>   // order, tie-break by walletId for determinism.
> }
> ```
>
> Used by both `buildQueue` and `buildBaseRecomputeInputs` fallback.
>
> ### `src/portfolio/v2/populate/queue.ts`
>
> ```ts
> type PopulateQueueV1 = {
>   schemaVersion: 1;
>   remainingWalletIds: readonly string[];
>   doneWalletIds: readonly string[];
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;               // monotonic across queue rebuilds
>   startedAt: number;
>   cfg: BwsConfig;
>   ingest: SnapshotIngestConfig;
>   pageSize: number;
> };
>
> export function buildQueue(args: {
>   eligibleWallets: readonly StoredWallet[];
>   rates: Record<string, number>;
>   balancesByWalletId: Record<string, bigint>;
>   cfg: BwsConfig;
>   ingest: SnapshotIngestConfig;
>   pageSize: number;
> }): PopulateQueueV1 {
>   const prev = loadQueue();
>   const order = computeOrderedAssetGroupIdsForAssetList({
>     eligibleWallets: args.eligibleWallets,
>     rates: args.rates,
>     balancesByWalletId: args.balancesByWalletId,
>   });
>   // MONOTONIC ACROSS REBUILDS — never reset to 1.
>   const nextOrderRevision = (prev?.orderRevision ?? 0) + 1;
>   const walletIdsInOrder = expandOrderToWalletIds(order, args.eligibleWallets, args.balancesByWalletId);
>   return {
>     schemaVersion: 1,
>     remainingWalletIds: walletIdsInOrder,
>     doneWalletIds: [],
>     orderedAssetGroupIdsForAssetList: order,
>     orderRevision: nextOrderRevision,
>     startedAt: Date.now(),
>     cfg: args.cfg,
>     ingest: args.ingest,
>     pageSize: args.pageSize,
>   };
> }
>
> export function loadQueue(): PopulateQueueV1 | null;
> export function saveQueue(q: PopulateQueueV1): void;
>
> // markDone mutates remainingWalletIds/doneWalletIds ONLY.
> // MUST NOT touch orderRevision — it's not an order mutation.
> export function markDone(walletId: string): void;
> ```
>
> **`loadQueue` must validate `schemaVersion`:**
>
> ```ts
> export function loadQueue(): PopulateQueueV1 | null {
>   const raw = mmkv.getString('portfolio:v2:populate:queue:v1');
>   if (!raw) return null;
>   try {
>     const parsed = JSON.parse(raw);
>     if (parsed?.schemaVersion !== 1) {
>       logOnce('loadQueue: invalid schemaVersion ' + parsed?.schemaVersion);
>       return null;
>     }
>     return parsed as PopulateQueueV1;
>   } catch (err) {
>     logOnce('loadQueue: parse error ' + String(err));
>     return null;
>   }
> }
> ```
>
> Treating invalid version or parse error as null causes populate to fall back to fresh queue on next kick — same recovery path as "no queue exists." Safest behavior for future schema migrations or persisted corruption. `logOnce` deduplicates per-message-per-session so a recurring invalid queue doesn't spam logs.
>
> MMKV key: `portfolio:v2:populate:queue:v1`.
>
> ### `src/portfolio/v2/populate/reconciliation.ts`
>
> ```ts
> export function reconcileQueueAgainstEligible(currentEligibleWalletIds: Set<string>): void {
>   if (!canRunPortfolioV2Work()) return;   // GUARD — first executable statement
>   const queue = loadQueue();
>   if (!queue) return;
>
>   const keptRemaining = queue.remainingWalletIds.filter(id => currentEligibleWalletIds.has(id));
>   const keptDone = queue.doneWalletIds.filter(id => currentEligibleWalletIds.has(id));
>   const dropped = [...queue.remainingWalletIds, ...queue.doneWalletIds]
>     .filter(id => !currentEligibleWalletIds.has(id));
>
>   if (dropped.length === 0) return;
>
>   const stillHeldAssetGroupIds = new Set<string>();
>   for (const walletId of [...keptRemaining, ...keptDone]) {
>     const assetGroupId = getAssetGroupIdForWalletFromStore(walletId);
>     if (assetGroupId) stillHeldAssetGroupIds.add(assetGroupId);
>   }
>   const newOrder = queue.orderedAssetGroupIdsForAssetList.filter(id =>
>     stillHeldAssetGroupIds.has(id),
>   );
>   const orderChanged = newOrder.length !== queue.orderedAssetGroupIdsForAssetList.length;
>
>   logDroppedPopulateWallets(dropped);
>   saveQueue({
>     ...queue,
>     remainingWalletIds: keptRemaining,
>     doneWalletIds: keptDone,
>     orderedAssetGroupIdsForAssetList: newOrder,
>     orderRevision: orderChanged ? queue.orderRevision + 1 : queue.orderRevision,
>   });
> }
> ```
>
> ### `src/portfolio/v2/populate/populateLoop.ts`
>
> ```ts
> import {
>   setPortfolioTxHistorySigningDispatchContextOnRuntime,
>   clearPortfolioTxHistorySigningDispatchContextOnRuntime,
>   type PortfolioTxHistorySigningDispatchContext,
> } from '../adapters/rn/txHistorySigning';
>
> export type PopulateRuntimeContext = {
>   walletsById: Record<string, { summary: WalletSummary; credentials: WalletCredentials }>;
>   // Per-wallet signing dispatch contexts. Built JS-side by createPortfolioTxHistorySigningDispatchContextOnRN.
>   // Installed on the runtime per populate-worklet handler call inside
>   // drivePopulateForWallet(...), cleared immediately after that handler returns.
>   // Required by the tx-history fetch path — see guardrail #26.
>   signingContextsByWalletId: Record<string, PortfolioTxHistorySigningDispatchContext>;
> };
>
> async function drivePopulateForWallet(args: {
>   walletId: string;
>   walletSummary: WalletSummary;
>   walletCredentials: WalletCredentials;
>   signingContext: PortfolioTxHistorySigningDispatchContext;
>   cfg: BwsConfig;
>   ingest: SnapshotIngestConfig;
>   pageSize: number;
> }): Promise<void> { 'worklet';
>   // New v2-owned orchestrator. Mirrors v1's runSingleWalletPopulateOnWorklet():
>   //   prepare -> processNextPage in a loop -> finish -> closeWalletSession.
>   // Only the signing-required handlers get the signing-context wrap:
>   // prepare + processNextPage. finish/close remain unwrapped, matching v1.
>   const withSigning = async <T>(task: () => Promise<T>): Promise<T> => {
>     setPortfolioTxHistorySigningDispatchContextOnRuntime(args.signingContext);
>     try {
>       return await task();
>     } finally {
>       clearPortfolioTxHistorySigningDispatchContextOnRuntime();
>     }
>   };
>
>   const populateState = getOrCreatePortfolioPopulateWorkletState(...);
>   try {
>     const prepared = await withSigning(() =>
>       handlePrepareWalletOnPopulateWorklet(...),
>     );
>     while (!populateCancelFlag.value) {
>       const page = await withSigning(() =>
>         handleProcessNextPageOnPopulateWorklet(...),
>       );
>       if (page.done) break;
>       await Promise.resolve(); // keep the runtime cooperative between pages
>     }
>     await handleFinishWalletOnPopulateWorklet(...);
>   } finally {
>     await handleCloseWalletSessionOnPopulateWorklet(...);
>   }
> }
>
> export async function runPopulate(ctx: PopulateRuntimeContext): Promise<void> { 'worklet';
>   if (populateLoopRunning.value) return;   // single-flight
>   populateLoopRunning.value = true;
>
>   let exitedWithWorkRemaining = false;
>
>   try {
>     while (true) {
>       if (populateCancelFlag.value) return;
>       const queue = loadQueue();
>       if (!queue || queue.remainingWalletIds.length === 0) return;
>
>       const walletId = queue.remainingWalletIds[0];
>       const walletCtx = ctx.walletsById[walletId];
>       const signingCtx = ctx.signingContextsByWalletId[walletId];
>       if (!walletCtx || !signingCtx) {
>         // Missing creds OR signing context — do NOT markDone. Exit, let JS reconcile+retry.
>         logMissingWalletContext(walletId);
>         exitedWithWorkRemaining = true;
>         return;
>       }
>
>       // Invalid-index recovery.
>       const existingIndex = await loadValidIndexOrNull(walletId);
>       if (existingIndex === null && await hasAnyWalletSnapshotData(walletId)) {
>         await clearWorkletWalletSnapshots(walletId);
>         logInvalidIndexRecovery(walletId);
>       }
>
>       await drivePopulateForWallet({
>         walletId,
>         walletSummary: walletCtx.summary,
>         walletCredentials: walletCtx.credentials,
>         signingContext: signingCtx,
>         cfg: queue.cfg,
>         ingest: queue.ingest,
>         pageSize: queue.pageSize,
>       });
>
>       markDone(walletId);
>       populateProgressTick.value = populateProgressTick.value + 1;
>     }
>   } finally {
>     populateLoopRunning.value = false;
>     if (exitedWithWorkRemaining) {
>       populateRetryTick.value = populateRetryTick.value + 1;
>     } else {
>       const final = loadQueue();
>       if (final && final.remainingWalletIds.length > 0) {
>         populateRetryTick.value = populateRetryTick.value + 1;
>       }
>     }
>   }
> }
> ```
>
> `drivePopulateForWallet(...)` is a **new v2 orchestrator**, not an existing kernel surface. It composes the existing v1 handlers in `portfolioPopulateWorklet.ts` (`handlePrepareWalletOnPopulateWorklet`, `handleProcessNextPageOnPopulateWorklet`, `handleFinishWalletOnPopulateWorklet`, `handleCloseWalletSessionOnPopulateWorklet`) and mirrors v1's orchestration from `portfolioPopulateJobWorklet.ts`. **Default v18 behavior is v1-parity wrap granularity: signing context around `prepare` and each `processNextPage` call only, not one long wrap around the entire wallet session.**
>
> **Incremental reorg protection (product-load-bearing):** later incremental populates must preserve the v1 kernel's "rewind before tip and overwrite recent tail snapshots" behavior rather than strictly appending from the latest persisted point. Phase 0 inventories the exact current mechanism; Phase 5 must keep passing the same effective tip-rewind inputs/config through the preserved populate kernel so app-launch refreshes, send refreshes, and pull-to-refresh refreshes remain reorg-safe.
>
> **Populate publish contract (simplified, product-load-bearing):**
> - Every completed wallet bumps `populateProgressTick`, which lets Home / All Assets progressively reveal or refresh rows in descending fiat order.
> - First-ever populate still uses skeletons for unready rows/charts.
> - Later incremental populates may show a lightweight refreshing indicator while fresh chart/PnL values publish progressively as wallets finish.
>
> ### `src/portfolio/v2/populate/api.ts` (JS)
>
> ```ts
> export function startPopulate(args): void {
>   if (!canRunPortfolioV2Work()) return;          // GUARD first
>   reconcileQueueAgainstEligible(getCurrentEligibleWalletIdSetFromStore());
>   buildAndSaveQueue(args);
>   populateCancelFlag.value = false;              // clear cancel BEFORE kick
>   const ctx = buildPopulateRuntimeContextFromStore();
>   runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>     .catch(err => logPortfolioRuntimeError(err));
> }
>
> export function populateWallet(walletId: string): void {
>   if (!canRunPortfolioV2Work()) return;
>   reconcileQueueAgainstEligible(getCurrentEligibleWalletIdSetFromStore());
>   appendToQueue(walletId);
>   populateCancelFlag.value = false;
>   const ctx = buildPopulateRuntimeContextFromStore();
>   runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>     .catch(err => logPortfolioRuntimeError(err));
> }
>
> export function populateWallets(walletIds: string[]): void {
>   if (!canRunPortfolioV2Work()) return;
>   // ... same shape, appending wallet ids to the queue
> }
>
> export function cancelPopulate(): void {
>   // NOT guarded — cancelPopulate must run during reset.
>   populateCancelFlag.value = true;
> }
> ```
>
> Every kick path: guard first, reconcile, set cancel flag false, kick. The cancel-flag clear happens only inside a guarded kick — `canRunPortfolioV2Work` being true means we're not in reset, so clearing is safe. Initial and incremental populates both publish progress via `populateProgressTick`; the refreshing affordance is derived from in-flight state and does not change populate queue semantics.
>
> ### `src/portfolio/v2/populate/resume.ts` (JS)
>
> `maybeResumePopulateOnLaunch()` — post-auth only. Guards first, then reconciles, builds ctx, kicks.
>
> ### `src/portfolio/v2/populate/performResetSequence.ts`
>
> ```ts
> import { cancelPopulate } from './api';
> import { waitForPopulateLoopToStop, resetSharedPortfolioStateForDebugClear } from '../sharedState';
> import { waitForRecomputeDrainToStop } from '../scheduler';
> import { waitForEnsureFreshToStop } from '../workletData/ratesFetch';
> import { wipePortfolioMmkvKeys } from '../debug';
> import {
>   __setPopulateResetInFlight,
>   markPortfolioCacheInvalid,
>   clearPortfolioCacheInvalid,
> } from './resetState';
>
> let inFlightReset: Promise<void> | null = null;
>
> export async function performResetSequence(): Promise<void> {
>   // NOT guarded by canRunPortfolioV2Work — this IS the reset.
>   if (inFlightReset) return inFlightReset;
>
>   const promise = (async () => {
>     __setPopulateResetInFlight(true);
>     try {
>       cancelPopulate();
>       // Wait for ALL THREE async subsystems concurrently. Each can write MMKV or
>       // publish sharedPortfolioState after the guard flip. All must quiesce before wipe.
>       // Serial waiting would triple latency for no benefit.
>       await Promise.all([
>         waitForPopulateLoopToStop(),        // 60s default
>         waitForRecomputeDrainToStop(),       // 30s default
>         waitForEnsureFreshToStop(),          // 20s default
>       ]);
>       // Mark the cache invalid before destructive deletion begins. If anything
>       // throws after this point, ordinary v2 work stays blocked until a later
>       // successful repair clears the bit.
>       markPortfolioCacheInvalid();
>       await wipePortfolioMmkvKeys();
>       resetSharedPortfolioStateForDebugClear();
>       clearPortfolioCacheInvalid();
>     } finally {
>       __setPopulateResetInFlight(false);
>       inFlightReset = null;
>     }
>   })();
>
>   inFlightReset = promise;
>   return promise;
> }
> ```
>
> UI contract: reset call sites are async and fallible. Callers must:
> - Show a progress indicator during the await.
> - Catch thrown errors and surface a one-shot native Alert ("Clear storage failed. Try again.").
> - If the reset was part of sign-out / logout / account-switch, abort the enclosing flow on error. Do **not** continue account teardown/navigation while `portfolioCacheInvalid` remains set.
> - Not retry automatically — user-initiated only.
>
> ### `buildBaseRecomputeInputs` — fire-time
>
> ```ts
> export function buildBaseRecomputeInputs(args): Omit<RecomputeInputs, 'scope'> {
>   const queue = loadQueue();
>   const populatedWalletIds = queue?.doneWalletIds ?? [];
>   const orderedAssetGroupIdsForAssetList = queue?.orderedAssetGroupIdsForAssetList
>     ?? computeOrderedAssetGroupIdsForAssetList({
>       eligibleWallets: args.wallets,
>       rates: args.rates,
>       balancesByWalletId: getBalancesByWalletIdFromStore(),
>     });
>   const orderRevision = queue?.orderRevision ?? 0;   // 0 always loses to real queue
>   return {
>     eligibleWallets: args.wallets,
>     quoteCurrency: args.quote,
>     liveRatesByAssetId: args.rates,
>     liveRatesAsOfMs: args.ratesAsOfMs,
>     populatedWalletIds,
>     orderedAssetGroupIdsForAssetList,
>     orderRevision,
>   };
> }
> ```
>
> Called at fire time from `PortfolioV2Root` and from each trigger. Never module-top-level, never cached in a ref.
>
> ### `src/portfolio/v2/PortfolioV2Root.tsx` — fire-time read pattern
>
> ```tsx
> export function PortfolioV2Root(): null {
>   const debounceRecomputeRef = useRef<NodeJS.Timeout | null>(null);
>   const debounceRetryRef = useRef<NodeJS.Timeout | null>(null);
>
>   const scheduleDebouncedRecompute = useCallback(() => {
>     if (debounceRecomputeRef.current) clearTimeout(debounceRecomputeRef.current);
>     debounceRecomputeRef.current = setTimeout(() => {
>       if (!canRunPortfolioV2Work()) return;   // GUARD at fire time
>       const base = buildBaseRecomputeInputs({
>         quote: getQuoteCurrencyFromStore(),
>         wallets: getEligibleStoredWalletsFromStore(),
>         rates: getLiveRatesByAssetIdFromStore(),
>         ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>       });
>       scheduleRecompute({ ...base, scope: 'full' });
>     }, 50);
>   }, []);
>
>   const scheduleDebouncedRetryPopulate = useCallback(() => {
>     if (debounceRetryRef.current) clearTimeout(debounceRetryRef.current);
>     debounceRetryRef.current = setTimeout(() => {
>       if (!canRunPortfolioV2Work()) return;   // GUARD at fire time
>       const eligibleIds = getCurrentEligibleWalletIdSetFromStore();
>       reconcileQueueAgainstEligible(eligibleIds);
>       const queue = loadQueue();
>       if (!queue || queue.remainingWalletIds.length === 0) return;
>       populateCancelFlag.value = false;
>       const ctx = buildPopulateRuntimeContextFromStore();
>       runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>         .catch(err => logPortfolioRuntimeError(err));
>     }, 50);
>   }, []);
>
>   useEffect(() => {
>     return () => {
>       if (debounceRecomputeRef.current) clearTimeout(debounceRecomputeRef.current);
>       if (debounceRetryRef.current) clearTimeout(debounceRetryRef.current);
>     };
>   }, []);
>
>   useAnimatedReaction(
>     () => populateProgressTick.value,
>     (tick, prev) => {
>       if (prev === null || tick === prev) return;
>       runOnJS(scheduleDebouncedRecompute)();
>     },
>   );
>
>   useAnimatedReaction(
>     () => populateRetryTick.value,
>     (tick, prev) => {
>       if (prev === null || tick === prev) return;
>       runOnJS(scheduleDebouncedRetryPopulate)();
>     },
>   );
>
>   return null;
> }
> ```
>
> **No `useAppSelector`, no `currentInputsRef`, no `useEffect` rebuilding cached inputs.** Fire-time reads only.
>
> ### Bootstrap wiring in `index.js`
>
> The existing code at `index.js:166` uses:
>
> ```js
> getStore().then(({store, persistor}) => {
>   // ... existing bootstrap code, including <Provider> mount ...
> });
> ```
>
> Add the v2 init **inside that existing callback**, **before** the `<Provider>` mount:
>
> ```js
> import { initializePortfolioV2ReduxAccess } from './src/portfolio/v2/reduxAccess';
> import { initializePortfolioV2ResetState } from './src/portfolio/v2/populate/resetState';
>
> getStore().then(({store, persistor}) => {
>   initializePortfolioV2ReduxAccess(() => store.getState());   // NEW
>   initializePortfolioV2ResetState();                          // NEW — reads durable cache-invalid bit
>   // ... existing <Provider store={store}> mount ...
> });
> ```
>
> Do not restructure the existing boot flow. Two added lines inside the existing callback. Order matters: initialize Redux access first, then read the durable cache-invalid bit into memory before any v2 code runs.
>
> ### Wire `app.effects.ts` post-auth transition
>
> `PORTFOLIO_V2` on: hook `onAppLaunchPostAuth(...)` to the **specific post-auth Redux action/event identified in Phase 0 item #12** — the dispatch that fires only after the PIN / biometric gate clears on launch, not app init and not store rehydration.
>
> If `isPortfolioCacheInvalid()` is true at that point, `onAppLaunchPostAuth(...)` first runs `performResetSequence()` as a best-effort repair path, then re-checks `canRunPortfolioV2Work()`. Only after the repair succeeds does it proceed with `maybeResumePopulateOnLaunch()` and first-ever-launch / wallet-set-changed `startPopulate(...)` decisions.
>
> ### Tests
>
> - `ordering.spec.ts` — helper contract.
> - `queue.spec.ts`:
>   - `buildQueue` called against no prior queue → `orderRevision = 1`.
>   - `buildQueue` called with prior `orderRevision = 5` → new queue has `orderRevision = 6`.
>   - **`buildQueue` called twice sees strictly increasing `orderRevision`.** (Regresses the monotonicity bug.)
>   - **`markDone` does NOT bump `orderRevision`.** (Pins the "non-order saves don't bump" invariant.)
> - `reconciliation.spec.ts` — drops removed wallets; bumps `orderRevision` iff order changed; preserves revision if only wallet-sets changed but order unchanged.
> - `populateLoop.spec.ts` — single-flight; cancel; missing creds exit + retry + no `markDone`; invalid-index recovery.
> - `drivePopulateForWallet.spec.ts` (NEW):
>   - prepare → page loop → finish → close sequence matches v1 `runSingleWalletPopulateOnWorklet(...)` behavior on the same fixture.
>   - cleanup-on-error still calls `handleCloseWalletSessionOnPopulateWorklet(...)`.
>   - signing-context wrap matches v1 exactly: installed for `prepare` and each `processNextPage` call, not for `finish` / `close`, and cleared between wrapped calls.
>   - incremental refresh fixtures preserve v1's tip-rewind / overwrite-tail behavior so the most recent snapshots are re-written on reorg-sensitive refreshes instead of strictly appended.
> - `resume.spec.ts` — kill/resume.
> - `populatePublish.spec.ts` (NEW):
>   - first-ever populate reveals ready rows incrementally in queue order.
>   - later app-launch/send/pull-to-refresh populates also publish progress ticks as wallets complete; populate emits only progress/retry ticks.
> - `retryStorm.spec.ts` — permanently missing wallet → 1 kick + 1 retry + reconciliation prunes → no loop.
> - `portfolioV2Root.spec.tsx` — fire-time reads verified; 5 ticks → 1 debounced recompute call; independent retry handler; unmount clears timers; `prev` arg usage.
> - `reduxAccess.spec.ts` — throws pre-init; works post-init; re-init allowed; test injection.
> - `debugClearReset.spec.ts` (NEW) — see Phase 7.5 + Phase 8 for full coverage; stub here that verifies `resetSharedPortfolioStateForDebugClear` clears state correctly.
> - `cancelFlagLifecycle.spec.ts` (NEW):
>   - Cancel, then `startPopulate` — cancel flag is cleared, new loop runs.
>   - Cancel, then `populateWallet` — same.
>   - Cancel during loop, wait, confirm flag still true post-wait. Then kick — flag cleared.
> - `performResetSequence.spec.ts` (NEW):
>   - Happy path: cancel → wait → `markPortfolioCacheInvalid()` → wipe → state reset → `clearPortfolioCacheInvalid()` → `populateResetInFlight = false` in `finally`.
>   - Wait timeout: throws before the invalid bit is set, nothing wiped, `populateResetInFlight` cleared in `finally`, `portfolioCacheInvalid = false`.
>   - Wipe throws mid-wipe: propagates to caller; `populateResetInFlight` cleared; `portfolioCacheInvalid` remains `true`. Ordinary kicks no-op until a later successful retry clears it.
>   - State-reset throws: same propagation + cleanup; `portfolioCacheInvalid` remains `true`. Retry completes and clears it.
>   - Re-entry: two concurrent `performResetSequence()` calls join the same in-flight promise; both resolve/reject with the same result.
> - `postAuthRepair.spec.ts` (NEW):
>   - Boot with `PORTFOLIO_CACHE_INVALID_KEY = 1`; `onAppLaunchPostAuth(...)` runs `performResetSequence()` before `maybeResumePopulateOnLaunch()` / `startPopulate(...)`.
>   - If the repair succeeds, ordinary v2 work resumes in the same post-auth flow.
>   - If the repair fails, `canRunPortfolioV2Work()` stays false and no ordinary populate/recompute path runs until a later successful retry.
> - `resetInFlightGuard.spec.ts` (NEW):
>   - While `performResetSequence` is mid-wait, invoke `populateWallet(X)`. Assert no new `runPopulate` kick, no cancel-flag clear.
>   - While mid-wait, invoke `onLiveRatesUpdated`. Assert no `ensureFresh` call, no `scheduleRecompute` call.
>   - While mid-wait, invoke `scheduleRecompute` directly. Assert no `pending` mutation, no `drain`.
> - `computeDrainRace.spec.ts` (NEW):
>   - Kick a full-scope recompute; while drain is awaiting the `runOnRuntimeAsync(recompute)`, invoke `performResetSequence`. Assert: `waitForRecomputeDrainToStop` awaits until drain's `running` flag flips false. Wipe starts only after drain stops. No compute publish lands after state-reset.
>   - Kick reset with compute idle → `waitForRecomputeDrainToStop` resolves immediately (`running` was false).
>   - `Promise.all` semantics: inject a stuck populate wait; assert reset blocks on populate even though compute wait resolves.
> - `queueSchemaVersion.spec.ts` (NEW):
>   - Seed `schemaVersion: 2` → `loadQueue() === null`, logs once.
>   - Seed malformed JSON → returns null, logs once.
>   - Seed missing `schemaVersion` → returns null.
>   - Three successive calls with same invalid state → one log, not three.

**Acceptance:** all tests pass including monotonicity regression. Flag off unchanged. Flag on: full correctness.

**LOC ledger:** +1,650 / 0 / +1,650. Newly orphaned: `populateJob.ts`, `portfolioPopulateJobWorklet.ts`, `portfolioPopulateService.ts`.

---

# Phase 6 — Triggers (fire-time `buildBaseRecomputeInputs`)

**Goal:** six triggers route through v2. Rate fetching at triggers. `buildBaseRecomputeInputs` called fire-time.

**Prompt:**

> `src/portfolio/v2/triggers.ts`:
>
> ```ts
> export async function onAppLaunchPostAuth(ctx): Promise<void> {
>   if (isPortfolioCacheInvalid()) {
>     await performResetSequence();              // best-effort repair before ordinary v2 work
>   }
>   if (!canRunPortfolioV2Work()) return;        // ordinary GUARD after repair path
>   if (!getShowPortfolioEnabledFromStore()) return;
>   maybeResumePopulateOnLaunch();
>   const quote = getQuoteCurrencyFromStore();
>   await ensureFresh(buildEnsureFreshArgsForVisibleAssetGroups({quoteCurrency: quote}));
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({ ...base, scope: 'full' });
> }
>
> export function onSendCompleted(args: { walletId: string }): void {
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   populateWallet(args.walletId);
> }
>
> export async function onWalletsDeleted(args: { walletIds: readonly string[] }): Promise<void> {
>   // Replaces v1's `cleanupPortfolioOnDeleteKeyMiddleware` dispatch of
>   // `clearWalletPortfolioDataWithRuntime({walletIds})` in `src/store/index.ts`.
>   //
>   // Reset-safety model: this trigger is guarded like every other ordinary
>   // trigger. If `canRunPortfolioV2Work()` is false (reset in flight, or the
>   // durable `portfolioCacheInvalid` bit is latched), we no-op here. The
>   // active `performResetSequence()` or the post-auth repair path wipes all
>   // wallet data during its sequence, including the just-deleted walletIds.
>   // Redux's own `WalletActionTypes.DELETE_KEY` reducer is authoritative for
>   // "this walletId no longer exists"; the next fire-time `buildBaseRecomputeInputs`
>   // after reset/repair completes will see the updated eligible-wallet set
>   // naturally, so no separate forget is needed during a reset window.
>   //
>   // Normal path: quiesce populate before clearing per-wallet data so we never
>   // race the populate loop writing to `snap:*` keys for a walletId we are
>   // about to delete. Same `cancelPopulate()` + `waitForPopulateLoopToStop()`
>   // discipline `performResetSequence` uses, scoped here to per-wallet clear
>   // instead of full wipe. Parity with v1: v1's `client.clearWallet(...)` ran
>   // serialized with populate via `serialQueue.ts` + the
>   // `snapshots.clearWallet` allowlist in `portfolioRequestRouting.ts` /
>   // `portfolioRequestWorklet.ts`; v2 deletes that infrastructure, so we
>   // re-establish the same ordering guarantee explicitly here.
>   const walletIds = Array.from(new Set(args.walletIds ?? []));
>   if (!walletIds.length) return;
>   if (!canRunPortfolioV2Work()) return;            // GUARD — reset/repair wipes these anyway
>
>   cancelPopulate();
>   await waitForPopulateLoopToStop();               // same primitive `performResetSequence` uses
>
>   pruneQueueForDeletedWallets(walletIds);          // drop deleted walletIds from persisted queue + shared queue state
>   forgetDeletedWalletsInSharedState(walletIds);    // drop walletsById / populatedWalletIdsById / per-wallet series
>   forgetDeletedWalletsInMmkv(walletIds);           // wallet-scoped `snap:*` keys only. NOT `rate:v1:*` (those are `(coin, quote, interval)`-scoped and still valid for the surviving wallets).
>
>   if (!getShowPortfolioEnabledFromStore()) return;
>   const quote = getQuoteCurrencyFromStore();
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({ ...base, scope: 'full' });   // resume work for the surviving wallet set
> }
>
> export async function onPullToRefresh(args): Promise<void> {
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   if (!getShowPortfolioEnabledFromStore()) return;
>   const quote = getQuoteCurrencyFromStore();
>   await ensureFresh({
>     ...buildEnsureFreshArgsForVisibleAssetGroups({
>       quoteCurrency: quote,
>       force: true,
>     }),
>     force: true,
>   });
>   const changedWalletIds = Array.from(new Set(args.changedWalletIds ?? []));
>   if (changedWalletIds.length) {
>     populateWallets(changedWalletIds);
>   }
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({
>     ...base,
>     scope: changedWalletIds.length
>       ? {kind: 'wallets', walletIds: changedWalletIds}
>       : 'full',
>   });
> }
>
> export async function onQuoteCurrencyChanged(newQuote): Promise<void> {
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   if (!getShowPortfolioEnabledFromStore()) return;
>   const quote = String(newQuote || '').toUpperCase() || getQuoteCurrencyFromStore();
>   const bridge = await ensureQuoteCurrencyFxBridge({
>     fromQuoteCurrency: getQuoteCurrencyFromStore(),
>     toQuoteCurrency: quote,
>     intervals: ['1D', '1W', '1M', 'ALL'],
>   });
>   await runOnRuntimeAsync(
>     getComputeRuntime(),
>     recomputeQuoteBridgeFromSharedState,
>     {bridge, toQuoteCurrency: quote},
>   );
> }
>
> export async function onLiveRatesUpdated(): Promise<void> {
>   if (!canRunPortfolioV2Work()) return;        // GUARD — before ensureFresh
>   if (!getShowPortfolioEnabledFromStore()) return;
>   const quote = getQuoteCurrencyFromStore();
>   await ensureFresh(
>     buildEnsureFreshArgsForVisibleAssetGroups({quoteCurrency: quote}),
>   );
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({ ...base, scope: 'full' });
> }
>
> let visibilityToggleEpoch = 0;
> let visibilityWipeRequired = false;
> let visibilityToggleSerial: Promise<void> = Promise.resolve();
>
> export function onShowPortfolioVisibilityChanged(enabled: boolean): void {
>   const epoch = ++visibilityToggleEpoch;
>   if (!enabled) {
>     // OFF creates a durable obligation: the next ON must not populate until
>     // the portfolio store wipe has completed, even if this OFF event becomes stale.
>     visibilityWipeRequired = true;
>   }
>
>   visibilityToggleSerial = visibilityToggleSerial.then(async () => {
>     if (!enabled) {
>       if (epoch !== visibilityToggleEpoch) return; // later event owns the final state
>       await performResetSequence();
>       visibilityWipeRequired = false;
>       return;
>     }
>
>     if (visibilityWipeRequired) {
>       await performResetSequence();
>       visibilityWipeRequired = false;
>     }
>
>     if (isPortfolioCacheInvalid()) {
>       await performResetSequence();            // full repair before re-enable populate
>     }
>
>     if (epoch !== visibilityToggleEpoch) return;
>     if (!getShowPortfolioEnabledFromStore()) return;
>     if (!canRunPortfolioV2Work()) return;
>
>     startPopulate({
>       isFirstPopulate: true,                  // repopulate from scratch after explicit disable
>       // ... same args as app-launch populate path
>     });
>   }).catch(err => {
>     logPortfolioRuntimeError(err);
>   });
> }
> ```
>
> Every ordinary trigger: `canRunPortfolioV2Work()` is the first executable statement. Before `ensureFresh`, before FX-bridge fetch, before queue writes, before `scheduleRecompute`, before anything. The only exception is `onAppLaunchPostAuth(...)`, which may first repair a latched `portfolioCacheInvalid` bit via `performResetSequence()`, then re-check `canRunPortfolioV2Work()`.
>
> `ensureFresh` lives here, NEVER in scheduler. `ensureQuoteCurrencyFxBridge(...)` also lives here and is called only by `onQuoteCurrencyChanged(...)`.
>
> The refreshing affordance is derived by `useIsPortfolioRefreshing()`, not set by triggers. It is visible while populate, `ensureFresh`, or scheduler drain work is actually in flight. It is not part of correctness: selectors keep reading the latest published `sharedPortfolioState` and may update progressively as recomputes land.
>
> `onShowPortfolioVisibilityChanged(...)` is the other intentional exception to the ordinary-trigger rule. It must remain callable even while portfolio work is disabled so that:
> - turning the setting **off** always clears cached portfolio data via `performResetSequence()`,
> - turning it **on** first discharges any latched `visibilityWipeRequired` obligation, then repairs a latched invalid bit if needed, then starts a fresh from-scratch populate,
> - rapid off/on churn is serialized by `visibilityToggleSerial` and resolved by `visibilityToggleEpoch` with **last-toggle-wins** semantics for final visibility, while `visibilityWipeRequired` preserves the "OFF requires a wipe before next ON populate" obligation.
>
> A re-entry into `performResetSequence(...)` from this toggle path is expected when another reset is already running (post-auth repair, debug-clear, sign-out, or a prior toggle). `performResetSequence(...)` is joinable: the toggle waits for the active reset, then re-checks epoch/store state before deciding whether to start populate. Do not turn these ordinary joined resets into user-facing alerts.
>
> `onQuoteCurrencyChanged(...)` intentionally does **not** queue a scheduler-managed full recompute for the immediate quote switch. Instead it applies `recomputeQuoteBridgeFromSharedState(...)` directly on the compute runtime using the current shared portfolio state only.
>
> `buildEnsureFreshArgsForVisibleAssetGroups(...)` is a new v2 helper that:
> - reads the currently relevant wallet set (all eligible wallets, or a supplied key-scoped wallet set),
> - derives the collapsed `assetGroupId` list used by Home / All Assets / Allocation,
> - expands each group to the raw `(coin, chain, tokenAddress)` requests the rate store needs,
> - emits the `coins` + `assets` arrays for `ensureFresh(...)`.
>
> This preserves the product rule that UI rows are grouped by ticker while the rate-cache layer still fetches/stores by raw asset identity.
>
> **Portfolio visibility gate:** `getShowPortfolioEnabledFromStore()` gates portfolio-owned recompute/populate work only. It must not be reused to hide or suppress the Home Exchange Rates section or the Exchange Rate detail screen, which continue on their own rate/display path even when portfolio surfaces are disabled. The Show Portfolio disable path uses the normal portfolio wipe and may clear shared `rate:v1:*` cache entries; Exchange Rates remain mounted and refetch on demand if they observe a cache miss.
>
> **Explicit non-triggered interactions (product-load-bearing):**
> - Timeframe switches on Home / Wallet / Asset Detail / KeyOverview / Exchange Rate do **not** call `ensureFresh(...)`, `ensureQuoteCurrencyFxBridge(...)`, populate kicks, or snapshot refresh code.
> - Chart scrubbing does **not** call any trigger or scheduler entrypoint; it reads existing points only.
>
> Wire call sites behind `PORTFOLIO_V2`.
>
> Use the Phase 0 inventory as the call-site source of truth, not ad hoc grep:
> - post-auth app-launch wiring from `src/store/app/app.effects.ts`,
> - send-completion wiring from `src/store/wallet/effects/send/**`,
> - live-rate-update wiring from `src/store/wallet/effects/rates/rates.ts`,
> - wallet-deletion wiring from the `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts` (replace its `clearWalletPortfolioDataWithRuntime({walletIds})` dispatch with a call to `onWalletsDeleted({walletIds})` so v2 sees key deletions; the middleware itself stays but swaps its payload),
> - pull-to-refresh wiring from the Home / KeyOverview / Wallet / Account screens/hooks documented in inventory item #12,
> - quote-currency-change wiring from the settings/rate-change path documented in inventory item #12,
> - show-portfolio-toggle wiring from the settings path documented in inventory item #12.
>
> Tests:
> - Each trigger mocked; fire-time freshness verified.
> - **Guard-before-side-effects regression:** while `populateResetInFlight` is set, invoke each trigger. Assert `ensureFresh` NOT called (for triggers that call it), `scheduleRecompute` NOT called, `populateWallet` NOT called. Zero side effects per trigger.
> - `onQuoteCurrencyChanged(...)` regression: calls `ensureQuoteCurrencyFxBridge(...)`, does **not** call per-asset `ensureFresh(...)`, and applies `recomputeQuoteBridgeFromSharedState(...)` immediately from the BTC bridge to the current shared state.
> - `onShowPortfolioVisibilityChanged(false)` regression: immediately hides portfolio-owned UI via the setting, runs `performResetSequence()`, clears portfolio MMKV/shared state, and leaves Exchange Rates surfaces visible even if their next read refetches after a `rate:v1:*` cache miss.
> - `onShowPortfolioVisibilityChanged(true)` regression: after a prior disable, starts a fresh from-scratch populate (`isFirstPopulate: true`) instead of resuming stale queue state.
> - Rapid toggle regression: off/on/off/on in quick succession serializes cleanly, stale completions no-op, `visibilityWipeRequired` prevents ON from populating until the OFF-created wipe has completed, no overlapping populate loops start, and the final persisted setting wins.
> - Toggle-during-reset regression: if another reset is already active, the toggle joins/waits for it, then re-checks epoch/store state before starting any fresh populate.
> - `onWalletsDeleted(...)` normal-path regression: when `canRunPortfolioV2Work()` is true, calls `cancelPopulate()`, awaits `waitForPopulateLoopToStop()`, prunes the queue of deleted walletIds, forgets them from shared state and the `snap:*` MMKV keys, then (if `getShowPortfolioEnabledFromStore()`) queues a full `scheduleRecompute`. Empty `walletIds` is a no-op.
> - `onWalletsDeleted(...)` snap-only wipe regression: forgets only wallet-scoped `snap:*` MMKV keys for the deleted wallets; shared `rate:v1:*` keys (which are `(coin, quote, interval)`-scoped) are untouched and remain valid for the surviving wallet set. Write a test that seeds `rate:v1:*` keys for assets the deleted wallets held and asserts they are still present after `onWalletsDeleted`.
> - `onWalletsDeleted(...)` reset-window regression: while `performResetSequence` is active (`populateResetInFlight === true`), invoke `onWalletsDeleted({walletIds})`. Assert zero side effects from the trigger (no `cancelPopulate`, no wait, no MMKV writes, no `scheduleRecompute`). The in-flight reset completes its wipe, which removes the deleted wallets' data as part of the full wipe; the next fire-time trigger after reset sees the Redux-authoritative eligible wallet set and recomputes correctly.
> - `onWalletsDeleted(...)` cache-invalid regression: with `portfolioCacheInvalid === true` (durable invalid bit latched), invoke the trigger. Assert no-op. The next `onAppLaunchPostAuth` / repair path wipes and clears the bit, then normal work resumes with the updated wallet set.
> - `onWalletsDeleted(...)` no populate-vs-clear race regression: while an active populate loop is mid-`handleProcessNextPageOnPopulateWorklet` for one of the deleted walletIds, invoke `onWalletsDeleted({walletIds: [thatWalletId]})`. Assert the loop observes cancel and exits before any `snap:*` key delete fires, and no populate-side `snap:*` writes land after the clear.
> - Wallet-deletion middleware parity regression: asserting the existing `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts` now calls `onWalletsDeleted({walletIds})` instead of dispatching `clearWalletPortfolioDataWithRuntime({walletIds})`, and that every `walletIds` collected from the deleted key reaches the v2 trigger.
> - Refreshing indicator regression: triggers do not set/clear refreshing state directly; `useIsPortfolioRefreshing()` derives it from populate / `ensureFresh` / scheduler in-flight signals.
> - Timeframe-switch regression: changing `tf` on any portfolio screen triggers zero calls to `ensureFresh(...)`, `ensureQuoteCurrencyFxBridge(...)`, populate APIs, or snapshot refresh helpers.

**LOC ledger:** +320 / 0 / +320.

---

# Phase 7 — Migrate UI consumers (flag-gated)

**Global UI contract:** quote-currency switches are special. They immediately re-bridge the current `sharedPortfolioState` chart/row values into the new quote currency without waiting for a fresh full recompute or per-asset new-quote fetch.
>
> **Show Portfolio contract (NEW, product-load-bearing):**
> - When `getShowPortfolioEnabledFromStore()` is `false`, hide all portfolio-owned charts and asset-list surfaces: Home portfolio balance/chart, Home asset list section, All Assets, Allocation, Wallet/Account/Key portfolio charts, and `AssetBalanceHistoryScreen`.
> - The Home **Exchange Rates** section and the **Exchange Rate** detail screen remain visible and continue to update whether the portfolio setting is on or off. Because Show Portfolio off uses the normal portfolio wipe, these surfaces may observe a transient `rate:v1:*` cache miss and refetch on demand, but they must not be hidden by the portfolio setting.
> - Toggling the setting off hides portfolio-owned surfaces immediately via UI gating while `performResetSequence()` clears cached portfolio data in the background.
> - Toggling it back on starts a fresh populate-from-empty flow; portfolio-owned surfaces reappear by the same first-populate progressive reveal rules used for a cold start.

## 7a. Asset list
> `AssetsList`: `selectOrderedAssetGroupIds`, render `AssetRowV2`. Memo on `(assetGroupId, mode)`, `areEqualByRowFingerprint`. Rows are collapsed by `assetGroupId = lowercased currencyAbbreviation`, matching current Home behavior across chains.
>
> Product contract:
> - Rows are visible immediately from the canonical queue-backed order, even when their PnL is not ready yet.
> - `selectIsAssetGroupReady(...)` controls the right-side content only: ready rows show PnL, unready rows show skeletons/placeholders. Do **not** hide unready rows.
> - Home and All Assets use the same `orderedAssetGroupIdsForAssetList` mid-populate so navigation preserves continuity.
> - Switching Today vs All Time mid-populate changes only which precomputed row payload is displayed; it must not change populate order or row visibility.
> - When "Show Portfolio" is off, this entire asset-list surface is hidden. The setting turning back on restarts from empty and re-reveals rows by the normal progressive populate rules.

## 7b. Home chart + PortfolioBalance
> Under flag: `selectTotalSeries` + `areEqualBySeriesFingerprint`. Chart keys on `series.fingerprint`. Gate on all eligible wallets ready. During first-ever populate this chart stays hidden until all eligible wallets are ready; during later incremental populates it may show a lightweight refreshing state while values update progressively.
>
> **First-ever chart gate predicate:** use `selectHasAnyPopulatedWallets(s)`. If published populated state is empty, hide charts until ready. If published populated state is non-empty, charts can continue showing current data while incremental refresh progresses.
> Quote-currency switches remain immediate because they transform current chart state directly.
> If "Show Portfolio" is off, hide this Home portfolio chart/balance surface entirely, but leave the Home Exchange Rates section visible.

## 7c. Wallet / Account / Key detail
> `WalletDetails`/`AccountDetails`: mount → `scheduleRecompute({ scope: { kind: 'wallet', walletId }, ...base })`. Subscribe `selectWalletSeries` + `areEqualBySeriesFingerprint`. `useFocusEffect` → `touchWallet`. Wallet/account charts stay hidden on first populate until that wallet is ready; on later incremental populates they may show a lightweight refreshing state while values update progressively. Use `selectHasAnyPopulatedWallets(s)` for first-ever chart gating.
> Quote-currency switches still update the current wallet/account chart immediately.
> If "Show Portfolio" is off, hide these portfolio chart surfaces entirely.
>
> `KeyOverview`: resolve key → walletIds from Redux. Mount → `scheduleRecompute({ scope: { kind: 'wallets', walletIds }, ...base })`. Subscribe `selectKeySeries(s, walletIds, tf)`. The "See All Assets" route passes `keyId`, and the downstream All Assets / asset-detail screens use the **scoped** selectors (`selectScopedAssetGroupRows`, `selectScopedOrderedAssetGroupIds`, scoped detail series) so the key view never falls back to global Home rows.

## 7d. Asset balance history + exchange rate
> `AssetBalanceHistoryScreen`: default path uses `selectAssetGroupSeries` + `areEqualBySeriesFingerprint`. If the route carries `keyId`, use the scoped detail selector for that key's wallet set instead of the global Home asset-group slice. Required consistency test: row and detail match byte-for-byte under both global and key-scoped navigation.
>
> Product contract:
> - Asset-detail charts stay hidden on first populate until the relevant asset group is ready; later incremental populates may show a lightweight refreshing state while values update progressively.
> - Asset detail and Exchange Rate use the same interval-window helper from Phase 3.
> - If there are no transactions in the chosen interval window, asset PnL % for that window must equal Exchange Rate % for that same window.
> - This equality must continue to hold after quote-currency switches, including BTC-bridge quote changes.
> - Use the same `selectHasAnyPopulatedWallets(s)` predicate for first-ever chart gating.
> - Quote-currency switches immediately re-bridge the current asset-detail / exchange-rate values into the new quote.
> - If asset detail renders a constituent wallet list, that list uses the same scoped `memberWalletIds` / wallet set as the chart and row. A key-scoped asset detail must not show wallets from outside that key.
> - If "Show Portfolio" is off, hide `AssetBalanceHistoryScreen`; the separate Exchange Rate detail screen remains available and unaffected.

## 7e. All Assets + Allocation
> `AllAssets`: global route uses `selectOrderedAssetGroupIds`; key-scoped route uses `selectScopedOrderedAssetGroupIds`. `Allocation`: `selectAllocationRows`. **Order must match**: Allocation reuses the same canonical asset-group ordering as All Assets / Home rows; do not introduce a second value-ranked sort. Test asserts orders stay identical for the same wallet set. Mid-populate, All Assets shows the same ready-vs-skeleton continuity as Home. When "Show Portfolio" is off, hide both All Assets and Allocation entirely.

**LOC ledger:** +600 / 0 / +600.

---

# Phase 7.5 — Migrate debug screens + integrate reset paths

**Goal:** debug screens stop calling v1 methods Phase 8 deletes. **Every reset path inventoried in Phase 0 gets shared-state reset integrated (guardrail #17).**

**Prompt:**

> ### `src/portfolio/v2/debug.ts`
>
> ```ts
> export async function readKvStats(): Promise<KvStats>;
> export async function listRates(quoteCurrency?: string): Promise<...>;
> export async function clearRateStorage(): Promise<void>;
> export async function clearAllStorage(): Promise<void>;       // delegates to performResetSequence
> export async function readPopulateTrace(walletId: string): Promise<...>;
> export async function quickCryptoPubKeyProbe(): Promise<...>;
>
> // Internal — used by performResetSequence. MUST be idempotent and MUST exclude
> // PORTFOLIO_V2_FLAG_KEY and PORTFOLIO_CACHE_INVALID_KEY from its wipe scope.
> export async function wipePortfolioMmkvKeys(): Promise<void>;
> ```
>
> `clearAllStorage` is a thin wrapper around `performResetSequence`:
>
> ```ts
> export async function clearAllStorage(): Promise<void> {
>   await performResetSequence();
> }
> ```
>
> `wipePortfolioMmkvKeys` implementation:
> - Enumerates keys from `getPortfolioMmkvStorageOnRN().getAllKeys()` (the real storage, source of truth — guardrail #25).
> - Filters by `PORTFOLIO_WIPE_PREFIXES` and excludes `WIPE_EXCLUDED_KEYS`.
> - Deletes each matched key via `kvStore.delete(key)` so the registry stays consistent.
> - NOT `kvStore.listKeys()` as the iteration source — a stale registry would miss real keys.
>
> ```ts
> import { getPortfolioMmkvStorageOnRN } from '../adapters/rn/workletMmkvBridge';
> import { PORTFOLIO_V2_FLAG_KEY } from '../featureFlag';
> import { PORTFOLIO_CACHE_INVALID_KEY } from '../populate/resetState';
>
> const PORTFOLIO_WIPE_PREFIXES: readonly string[] = [
>   'snap:',           // snapshot meta/index/chunk/invalid-history/raw-points
>   'rate:v1:',        // fiat rate series
>   'portfolio:v2:',   // v2-specific: queue, flag
> ];
>
> const WIPE_EXCLUDED_KEYS = new Set<string>([
>   PORTFOLIO_V2_FLAG_KEY,
>   PORTFOLIO_CACHE_INVALID_KEY,
> ]);
>
> export async function wipePortfolioMmkvKeys(): Promise<void> {
>   const storage = getPortfolioMmkvStorageOnRN();
>   const kvStore = getPortfolioKvStore();    // v2 helper added in Phase 1
>
>   // Enumerate REAL keys from MMKV, not the registry.
>   const allKeys = storage.getAllKeys();
>
>   for (const key of allKeys) {
>     const matchesPortfolioPrefix = PORTFOLIO_WIPE_PREFIXES.some(p => key.startsWith(p));
>     if (!matchesPortfolioPrefix) continue;
>     if (WIPE_EXCLUDED_KEYS.has(key)) continue;
>     await kvStore.delete(key);   // untracks from registry (no-op if wasn't tracked)
>   }
> }
> ```
>
> - Idempotent on missing keys.
> - If a delete throws mid-iteration, propagate; caller (`performResetSequence`) handles the failure.
> - Future additions to `PORTFOLIO_WIPE_PREFIXES` or `WIPE_EXCLUDED_KEYS` must be explicit and justified.
>
> ### Reset path integration
>
> For every reset path identified in Phase 0 inventory (sign-out, logout, any "reset app" flow that wipes portfolio data):
>
> 1. Identify the exact code location.
> 2. Replace direct MMKV wipes with `await performResetSequence()`.
> 3. Wrap the call in a try/catch that surfaces a one-shot native Alert on failure ("Clear storage failed. Try again.").
> 4. If the reset was part of sign-out / logout / account-switch, abort the enclosing flow on error. Do **not** continue navigation/account teardown until a later successful reset clears `portfolioCacheInvalid`.
> 5. Gate behind `PORTFOLIO_V2` if the path is v1-specific.
>
> ### Tests (per reset path)
>
> `resetPaths.spec.ts`:
>
> - Set up non-empty `sharedPortfolioState` with `orderRevision = 7`.
> - Set up a non-empty queue with `orderRevision = 7`.
> - **Seed real v1-shape MMKV keys** to verify wipe covers all prefixes:
>   - `snap:meta:v2:<testWalletId>` with valid meta JSON
>   - `snap:index:v2:<testWalletId>` with valid index JSON (revision ≥ 1)
>   - `snap:chunk:v2:<testWalletId>:0` with valid chunk data
>   - `snap:invalid-history:v1:<testWalletId>` with a marker
>   - `rate:v1:USD:btc:1d:...` with valid rate series
>   - `portfolio:v2:populate:queue:v1` (the v2 queue)
> - Seed should write via `kvStore.setString` so the registry tracks the keys.
> - Invoke the reset path.
> - Assert **via `kvStore.listKeys()`** that the tracked set is empty except for the feature-flag exclusion. This catches the bug where wipe deletes keys at the MMKV level but leaves them in the registry.
> - Assert `portfolio:v2:flag` still readable via direct MMKV access (it bypasses the registry by design — guardrail #24).
> - Assert `portfolio:v2:cacheInvalid` is cleared after a successful reset path, even though wipe itself excludes it.
> - Assert `sharedPortfolioState.value === EMPTY_PORTFOLIO_STATE`, ticks zero.
> - Invoke `startPopulate`; assert new queue's `orderRevision === 1`.
> - Schedule recompute; assert state advances.
>
> This test is the load-bearing coverage for guardrails #23, #24, and #25: if wipe only matches `portfolio:` prefix, uses the wrong MMKV instance, bypasses the registry, or forgets to clear the durable invalid bit after success, this test fails hard.
>
> ### Debug screens
>
> Update `PortfolioDebug.tsx`, `PortfolioWalletDebug.tsx`, `StorageUsage.tsx` with `PORTFOLIO_V2` branches.

**Acceptance:** debug works under both flag states. All reset paths covered by tests. **Reset paths do not break `orderRevision` monotonicity** — the test asserts this explicitly.

**LOC ledger:** +490 / 0 / +490.

---

# Phase 8 — Flip flag, delete v1 orchestration

**Prompt:**

> 1. `PORTFOLIO_V2` default → `true`.
> 2. Delete listed v1 files after verifying zero imports.
> 3. Delete Redux fields flagged in Phase 0. Keep `quoteCurrency`, `lastPopulateStartedAtMs`, `hydratedSummary`. `recompute` tail writes `hydratedSummary`.
> 4. Delete v1 store subtrees and unwire them from the root reducer / store:
>    - Remove `src/store/portfolio/**` (`portfolio.actions.ts`, `portfolio.models.ts`, `portfolio.reducer.ts`, `portfolio.runtime.effects.ts`, `portfolio.types.ts`, `portfolio.utils.ts`, `index.ts`). Remove the slice's entry from `combineReducers` / whitelist / blacklist / persistor config in `src/store/index.ts` and any typed selectors in `src/store/index.types.ts` / `RootState`.
>    - Remove `src/store/portfolio-charts/**` (`portfolio-charts.actions.ts`, `portfolio-charts.models.ts`, `portfolio-charts.reducer.ts`, `portfolio-charts.types.ts`, `index.ts`). Same combineReducers / persistor cleanup.
>    - Keep `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts`; ensure its action payload is `onWalletsDeleted({walletIds})` (wired in Phase 6), not the deleted `clearWalletPortfolioDataWithRuntime`.
> 5. Merge `src/portfolio/v2/**` up one level.
> 6. Full test suite green — **including the reset-path tests from Phase 7.5.** Additionally run a typecheck pass to catch any dangling imports of `src/store/portfolio/**` or `src/store/portfolio-charts/**`.
> 7. Update inventory.

**LOC ledger:** inside `src/portfolio/`: +50 / ~13,500 / ~−13,450. Outside: 0 / ~1,800 / ~−1,800 (~1,236 for `src/store/portfolio/**` + ~536 for `src/store/portfolio-charts/**` + a few dozen lines of store-index glue). The 2-line nav-hook shim at `src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts` stays; its 2,892-LOC implementation lives inside `src/portfolio/ui/hooks/**` and is counted inside.

---

# Phase 9 — Polish

**Prompt:**

> 1. Delete spike files.
> 2. `yarn tsc && yarn test && yarn lint`.
> 3. Final inventory update.
> 4. Flag stays as kill switch.
> 5. Optional, benchmark-gated optimization only: if Phase 3/5 measurements show post-auth-to-first-portfolio-render latency exceeds the product bar, add persisted-derived-state hydration for the last published `sharedPortfolioState`. This is not required for correctness; it introduces a derived-state schema, hydration invalidation, write coalescing, and additional wipe tests, so do it only if cold-start measurements justify the complexity.

**LOC ledger:** 0 / ~200 / −200.

---

# Required parity + regression tests (before Phase 8)

1. Numeric parity (load-bearing): point-by-point, every interval, 1e-8, across ~20 fixtures.
2. Cross-screen consistency: asset row and asset detail match byte-for-byte.
3. Rate ↔ PnL consistency, including the "no transactions in window => PnL % equals Exchange Rate %" case.
   Formula pinning fixtures must cover buys, sells, partial disposals, zero-balance exits, no-transaction windows, and collapsed multi-chain asset groups. Include a named no-transaction fixture: 10 units held across a full `1D` window with no transactions; assert `pnlPercent === ratePercentChange` within `1e-8`. Assert the exact v1 formulas from Phase 3: chart `totalPnlChange = totalUnrealizedPnlFiat - firstTotalUnrealizedPnlFiat`, chart `totalPnlPercent = totalUnrealizedPnlFiat / totalRemainingCostBasisFiat * 100`, asset-summary `pnlChange = pnlEnd - pnlStart`, asset-summary `pnlPercent = pnlEnd / remainingCostBasisFiatEnd * 100`, and collapsed-row `pnlPercent = sum(pnlEnd) / sum(remainingCostBasisFiatEnd) * 100`. Use `1e-8` tolerance for numeric formula parity unless existing v1 output is byte-for-byte stable. Also assert endpoint equivalence: for the same `assetGroupId`, optional `keyId` wallet scope, quote, and interval window, row Today equals Asset Detail `1D` final chart change row and row All Time equals Asset Detail `ALL` final chart change row byte-for-byte.
4. Non-blocking recompute.
5. Non-blocking populate.
6. Coalescing: 100 rapid schedules → 1–3 drains.
7. Progress tick debounce.
8. Retry tick debounce.
9. Tick handlers independent.
10. Kill-and-resume.
11. Fingerprint determinism + invalidation.
12. Clone-proof equality.
13. Fingerprint pinned limitation (mid-series unchanged).
14. Soft-cap eviction.
15. Single-flight populate.
16. Missing creds → exit, retry, no `markDone`.
17. Invalid-index recovery.
18. Touch doesn't bump `computedAtMs`.
19. Three-phase drain (`wallets[A,B]` + `full` → both run).
20. Three-phase drain reverse order.
21. Retry-storm prevention.
22. Order prune on reconciliation + `orderRevision` bumps.
23. Order helper drift: `buildQueue(x)` and `computeOrderedAssetGroupIdsForAssetList(x)` agree.
24. Order revision merge: higher revision wins.
25. Fire-time input freshness.
26. `reduxAccess` init/throw/re-init/injection.
27. `PortfolioV2Root` unmount clears timers.
28. **`buildQueue` monotonic revision** — two successive builds see strictly increasing `orderRevision`. `markDone` doesn't bump.
29. **Scope uniformity** — `wallet`-scope recompute advances order when `inputs.orderRevision > prev.orderRevision` (regresses the v7 contradiction).
30. **Reset paths preserve monotonicity invariant** — debug-clear / sign-out reset shared state; subsequent `buildQueue` produces `orderRevision = 1`; subsequent recompute advances state correctly.
31. **Cancel flag lifecycle** — cancel, then fresh start, populate actually runs.
32. **Wait-for-loop-to-stop timeout** — throws before `markPortfolioCacheInvalid()`, `populateResetInFlight` is cleared in `finally`, and subsequent kicks may proceed because `portfolioCacheInvalid` is still false.
33. **Wipe-during-populate safety** — reset blocks until loop stops; no MMKV writes land after wipe.
34. **Reset-in-flight guard** — during `performResetSequence` await, concurrent `populateWallet`/`onLiveRatesUpdated`/`scheduleRecompute` no-op; no side effects.
35. **Mid-wipe failure recovery** — wipe throws after `markPortfolioCacheInvalid()` and partial deletes; caller receives error; `portfolioCacheInvalid` stays true; ordinary v2 work remains blocked; retry completes the wipe/reset and clears the bit.
36. **Compute drain race regression:** start `performResetSequence` while `drain()` is mid-full-recompute. Assert: wipe happens only after drain's `runOnRuntimeAsync` resolves; no compute publish lands after `resetSharedPortfolioStateForDebugClear()`; final `sharedPortfolioState === EMPTY_PORTFOLIO_STATE`.
37. **Both waits required:** start reset with populate idle and compute drain active. Assert `waitForRecomputeDrainToStop` is called; `Promise.all` waits for it even though populate wait resolves immediately. Conversely: reset with compute idle and populate active — populate wait holds, `Promise.all` waits for it.
38. **Queue schema validation:**
   - `loadQueue` with `schemaVersion: 2` in MMKV → returns null, logs once.
   - `loadQueue` with malformed JSON → returns null, logs once.
   - `loadQueue` with missing `schemaVersion` → returns null.
   - Repeated `loadQueue` calls with same invalid state → log fires once, not N times.
39. **`ensureFresh` race regression:** start `ensureFresh` with a slow network fetch. Before the fetch resolves, invoke `performResetSequence`. Assert: `waitForEnsureFreshToStop` blocks wipe until the fetch resolves. The second `canRunPortfolioV2Work` check causes `persistRates` to be skipped when the fetch lands mid-reset. No rate-cache MMKV writes after reset begins.
40. **All three waits required in `Promise.all`:** reset with populate active / compute idle / ensureFresh idle → populate wait holds others. Reset with all three active → all three resolved before wipe. Reset with compute active and fetch in-flight → both hold, populate (idle) resolves immediately.
41. **Feature flag and invalid bit survive raw wipe:** set `PORTFOLIO_V2 = true` and `PORTFOLIO_CACHE_INVALID_KEY = 1`. Invoke `wipePortfolioMmkvKeys`. Assert flag value unchanged and the invalid bit still present. `performResetSequence()` is responsible for clearing the invalid bit only after success.
42. **Wipe targets correct MMKV instance:** seed `snap:*` and `rate:v1:*` keys in `getPortfolioMmkvStorageOnRN()`. Seed identical-looking keys in a different MMKV instance (app default). Invoke wipe. Assert portfolio instance's keys are deleted; other instance's keys untouched. Regresses guardrail #24.
43. **Registry stays consistent with wipe:** write several keys via `kvStore.setString` (which tracks in registry). Invoke wipe. Assert `kvStore.listKeys()` returns empty list (except excluded keys). Regresses guardrail #25.
44. **Populate signing context wrap parity (guardrail #26):** unit test `runPopulate` / `drivePopulateForWallet` with mock populate handlers that assert the signing context is active via `getPortfolioTxHistorySigningDispatchContextOnRuntime()`. Verify: context is installed for `handlePrepareWalletOnPopulateWorklet(...)` and each `handleProcessNextPageOnPopulateWorklet(...)` call, not for `handleFinishWalletOnPopulateWorklet(...)` / `handleCloseWalletSessionOnPopulateWorklet(...)`, and is cleared immediately after each wrapped call returns. A wallet with missing signing context causes loop exit without `markDone`.
45. **Rate fetch runs on the correct worklet runtime:** `ensureFresh` mocks `runOnRuntimeAsync` and asserts the fetch step is called on `getPopulateRuntime()` by default, or `getRateFetchRuntime()` under Branch C — never invoked from JS directly. Verify the second guard check happens after fetch resolves and before `setSeries`.
46. **Wipe enumeration uses real storage:** pre-seed MMKV with a key that's NOT in the registry (simulates registry staleness). Invoke wipe. Assert the unregistered key is deleted via `storage.getAllKeys()` iteration + `kvStore.delete(key)`. Regresses guardrail #25 using real storage enumeration.
47. **`ensureFresh` dispatch context lifecycle (guardrail #26):** invoke `ensureFresh` with a mock `runOnRuntimeAsync` that synchronously inspects the runtime's dispatch context via `getPortfolioTxHistorySigningDispatchContextOnRuntime()`. Verify: context is set before provider call, context has `boxedNitroFetch` populated, context is cleared in `finally` even when provider throws. Also verify the v2-owned `extractSeriesFromFiatRatePayload(...)` path mirrors v1 behavior for bundled BWS payloads. Without the context, `getPortfolioNitroFetchClientOnRuntime()` would throw — test that path too (call `loadSeriesWorkletWithContext` with a broken context and verify the throw propagates cleanly, inFlightCount decrements).
48. **Runtime-global dispatch-context invariant (guardrail #27):** under deliberately concurrent populate + rate-fetch load, neither operation observes the other's dispatch context mid-flight. Test implementation varies by chosen branch:
   - Branch A: both complete successfully; markers remain consistent.
   - Branch C: rate fetch runs concurrently on the separate runtime; populate unaffected.
   - Branch D: worklet-side lock serializes installs; both complete without marker corruption.
   Test asserts the invariant regardless of branch; implementation detects which branch is active via a module constant set after Phase 0.5 spike results.
49. **Rate-vs-rate concurrency policy:** two overlapping `ensureFresh` calls with identical `(quoteCurrency, interval, coins, assets, maxAgeMs, force)` args dedupe — only one network call fires, both callers receive the result. Two overlapping calls with different args serialize only if probe 3 is dirty/flaky; otherwise they may remain concurrent. In either case, no runtime-global context clobber. `inFlightCount` accurately reflects in-flight calls regardless of dedupe/serialization behavior.
50. **Allocation order parity:** `selectAllocationRows` and `selectOrderedAssetGroupIds` produce the same order for the same wallet set globally and under `keyId`.
51. **Key-scoped asset list parity:** `AllAssets({keyId})` shows only that key's grouped assets, row taps carry `keyId`, and the asset detail chart/row/**wallet-list** values stay scoped to the key instead of falling back to Home-global data.
52. **Quote-switch BTC bridge:** changing fiat currency fetches only BTC bridge data for canonical stored intervals, does not fan out per-asset new-quote fetches, and updates Home / All Assets / Asset Detail / Exchange Rate consistently.
53. **Canonical stored intervals only:** only `1D`, `1W`, `1M`, and `ALL` are fetched/persisted. `3M`, `1Y`, and `5Y` are derived from `ALL` and do not create separate rate keys.
54. **Timeframe switches are read-only:** switching timeframe on Home / Wallet / Asset Detail / KeyOverview / Exchange Rate causes zero `ensureFresh`, FX-bridge, populate, or snapshot-refresh side effects.
55. **Chart scrubbing is read-only:** long-press/scrub reads existing points only and triggers no refresh or scheduler work.
56. **Initial populate progressive reveal:** Home and All Assets show rows immediately in canonical order; ready rows reveal PnL, unready rows show skeletons; switching Today / All Time mid-populate does not perturb order.
57. **Incremental populate progressive refresh:** app-launch refresh, send-triggered populate, and pull-to-refresh may show a lightweight refreshing state while chart/PnL values update progressively as affected wallets finish.
58. **Cross-screen refresh propagation:** send-triggered populates and pull-to-refresh updates propagate to every affected Home / All Assets / Asset Detail / Wallet / Exchange Rate surface as recomputes publish, with no stale divergence between screens.
59. **Heavy recomputes drain during incremental populate:** while an incremental populate has remaining wallets, heavy `scheduleRecompute` work from non-populate triggers drains normally.
60. **First-ever chart gate predicate:** first-ever hide behavior keys off populated state (`selectHasAnyPopulatedWallets(s)`), not queue metadata.
61. **Interval-window boundary sampling:** the shared window helper resolves exact interval boundaries and linearly interpolates synthetic rate samples when no raw point exists at `startTs` / `endTs`; PnL and Exchange Rate calculations consume the same sampled boundary values so the no-tx-window parity test is deterministic and faithful to the displayed interval.
62. **Quote-switch during populate:** while populate is active, `onQuoteCurrencyChanged(...)` applies `recomputeQuoteBridgeFromSharedState(...)` immediately to the current shared state and visible screens switch quote right away.
63. **No recursive render / max-depth regression:** rapid timeframe toggles and chart scrubbing on Home / Wallet / Asset Detail / Exchange Rate do not produce "maximum update depth exceeded" errors, recursive scheduler churn, or blank intermediate flashes between valid series.
64. **Post-auth repair path for durable invalid bit:** boot with `PORTFOLIO_CACHE_INVALID_KEY = 1`; `onAppLaunchPostAuth(...)` repairs via `performResetSequence()` before any ordinary v2 populate/recompute work runs, and only a successful repair clears the bit.
65. **Show Portfolio off clears + hides:** toggling the user-facing setting off runs `performResetSequence()`, clears portfolio MMKV/shared state, hides all portfolio-owned charts/list surfaces, and leaves Home Exchange Rates / Exchange Rate detail visible even if those surfaces refetch after a `rate:v1:*` cache miss.
66. **Show Portfolio on repopulates from scratch:** toggling the setting back on after a prior disable starts a fresh populate-from-empty flow (`isFirstPopulate: true`) and re-reveals portfolio-owned surfaces by the normal progressive populate rules.
67. **Rapid Show Portfolio toggle churn:** repeated off/on/off/on toggles serialize cleanly with last-toggle-wins semantics for final visibility; `visibilityWipeRequired` guarantees an OFF-created wipe obligation completes before a later ON can start fresh populate; no overlapping populate loops survive, stale completions no-op, and the final setting determines whether portfolio surfaces are hidden or repopulating.
68. **Joinable reset during Show Portfolio toggle:** toggling portfolio visibility while post-auth repair / debug-clear / sign-out reset is already in flight joins or waits for that reset, re-checks epoch and store state afterward, and never surfaces an "already in flight" error for normal toggle churn.
69. **Key deletion clears portfolio data (guarded + quiesced):** dispatching `WalletActionTypes.DELETE_KEY` routes through `cleanupPortfolioOnDeleteKeyMiddleware` → `onWalletsDeleted({walletIds})`. Normal path: the trigger (a) checks `canRunPortfolioV2Work()` first, (b) calls `cancelPopulate()` + awaits `waitForPopulateLoopToStop()` before writes, (c) prunes the queue, (d) forgets shared state + `snap:*` MMKV keys for the deleted wallets only (shared `rate:v1:*` keys stay intact), then (e) re-kicks populate/recompute for the surviving wallet set behind `getShowPortfolioEnabledFromStore()`. Reset-window path: if `performResetSequence` is in flight or `portfolioCacheInvalid` is latched, the trigger no-ops — the active reset/repair wipe removes the deleted wallets' data as part of its full wipe, and Redux's `DELETE_KEY` reducer is authoritative for the updated eligible-wallet set observed by the next fire-time trigger. In both paths, Home / All Assets / Allocation stop counting the deleted wallets' balances and PnL at the first publish after the Redux deletion is reflected in `getEligibleStoredWalletsFromStore()`.

---

# Split LOC ledger

### Inside `src/portfolio/`

| Phase | Added | Deleted | Net |
|---|---|---|---|
| 0 | +30 | 0 | +30 |
| 0.5 | +380 | 0 | +380 |
| 1 | +480 | 0 | +480 |
| 2 | +680 | 0 | +680 |
| 3 | +1,220 | 0 | +1,220 |
| 4 | +290 | 0 | +290 |
| 5 | +1,600 | 0 | +1,600 |
| 6 | +340 | 0 | +340 |
| 7a–e | +600 | 0 | +600 |
| 7.5 | +360 | 0 | +360 |
| 8 | +50 | ~13,500 | ~−13,450 |
| 9 | 0 | ~200 | −200 |
| **Total** | **~+6,030** | **~13,700** | **~−7,670** |

Start: ~28,268. End: ~20,600. Target 18–22k pending Phase 0 inventory verification. Actual end-of-phase LOC varies by Branch chosen in Phase 0.5: Branch A adds ~0, Branch C adds ~150 (new runtime infra), Branch D adds ~100 (lock primitive + integration). Branch B is diagnostic-only per guardrail #27.

### Outside `src/portfolio/`

| Phase | Added | Deleted | Net |
|---|---|---|---|
| 8 | 0 | ~1,800 | ~−1,800 |

Breakdown of the ~1,800 deleted LOC outside `src/portfolio/`:
- `src/store/portfolio/**` — ~1,236 LOC across 7 files (`portfolio.actions.ts`, `portfolio.models.ts`, `portfolio.reducer.ts`, `portfolio.runtime.effects.ts`, `portfolio.types.ts`, `portfolio.utils.ts`, `index.ts`). Slice is removed from `combineReducers` / persistor config in `src/store/index.ts` and from `RootState` typing.
- `src/store/portfolio-charts/**` — ~536 LOC across 5 files (`portfolio-charts.actions.ts`, `portfolio-charts.models.ts`, `portfolio-charts.reducer.ts`, `portfolio-charts.types.ts`, `index.ts`). Same `combineReducers` / persistor / `RootState` cleanup.
- `src/store/index.ts` glue — a few dozen lines of imports, reducer wiring, persistor entries, and the `cleanupPortfolioOnDeleteKeyMiddleware` payload swap (`clearWalletPortfolioDataWithRuntime` → `onWalletsDeleted`). Middleware itself stays.

**Not counted here** (already counted in the inside-`src/portfolio/` ledger above): the 2,892-LOC `src/portfolio/ui/hooks/usePortfolioAssetRows.ts` implementation is deleted as part of `src/portfolio/ui/hooks/**` (~9,982 LOC). The ~2-line re-export shim at `src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts` stays.

### Combined

Starting: ~30,000. Ending: ~20,600. Eliminated: ~9,400, ~31%. (Approximate — pending Phase 0 inventory verification of exact file LOCs and exact glue cost in `src/store/index.ts`.)

---

# Summary

- **Three runtimes by default** (UI / compute / populate), with an **optional fourth rate runtime** under Branch C, **one state value**, **progress + retry ticks** (distinct), **single-flight guard**, **debounced app-root subscriber with two independent reactions and unmount cleanup**, **six triggers**, **one read hook**, **~10 selectors**, **five scope kinds**, **three-phase scheduler drain**.
- **Fingerprints are a render invalidation heuristic; numeric correctness is enforced by full point-by-point parity tests.**
- **Interval-specific fingerprints** with first+last endpoint values. Mid-series mutations pinned.
- **Precomputed row payloads** make the global row selectors O(1); key-scoped selectors use a bounded memoized aggregation cache keyed by state revision and wallet scope.
- **Scheduler accumulates, never subsumes.**
- **One unified order-update rule:** heavy scopes may advance order + revision when incoming is newer; touch scopes never do.
- **Touch scopes** never change `computedAtMs`, readiness, series, rows, total, order, or `orderRevision`.
- **Readiness O(1)** via `populated*IdsById`.
- **Chart-boundary equality** keys on `Series.fingerprint`.
- **Only four fiat-rate intervals are fetched/persisted:** `1D`, `1W`, `1M`, and `ALL`. Displayed `3M`, `1Y`, and `5Y` derive from `ALL` on the compute runtime.
- **Quote-currency switching uses a BTC FX bridge.** Quote changes fetch only BTC bridge data for the target quote and recompute portfolio/chart/list values instantly on the compute runtime from the current shared portfolio state instead of refetching every visible asset in the new quote.
- **Incremental populates remain reorg-safe.** Incremental refresh populates inherit the preserved kernel's "rewind before tip and overwrite the recent tail" behavior instead of strictly appending from the latest persisted point.
- **Queue persists IDs + config + `orderRevision`.** `buildQueue` monotonic: `(prev?.orderRevision ?? 0) + 1`. `markDone` does not bump.
- **Reconciliation on every kick.** Bumps `orderRevision` iff order changed.
- **Single ordering helper** used by `buildQueue` and `buildBaseRecomputeInputs` fallback.
- **Fire-time reads** in `PortfolioV2Root` and triggers. No ref-cached inputs.
- **Populate publishing is explicit, not incidental.** First-ever populate is progressive and reveals ready rows in queue order; later incremental populates also publish progressively and may show a lightweight refreshing indicator.
- **`reduxAccess.ts`** single Redux access module. Initialized inside the existing `getStore().then(({store, persistor}) => {...})` callback before `<Provider>` mount. Accessor calls inside function bodies only.
- **Reset paths reset shared state** (guardrail #17). Every wipe path — debug-clear, sign-out — goes through `performResetSequence`. Preserves `orderRevision` monotonicity invariant.
- **Reset uses one durable invalid bit.** `performResetSequence(...)` is joinable, while persisted key `portfolio:v2:cacheInvalid` blocks ordinary v2 work whenever a destructive wipe may have left partial state behind. There is no tri-state sentinel and no banner UI, but failures after `markPortfolioCacheInvalid()` do not let work resume until a successful repair clears the bit.
- **`performResetSequence`:** join active reset if needed → set in-flight → cancel → `Promise.all` wait for populate loop, compute drain, and in-flight `ensureFresh` → `markPortfolioCacheInvalid()` → wipe (idempotent, excludes feature flag + invalid bit) → reset shared state → `clearPortfolioCacheInvalid()` → clear in-flight in `finally`. Any throw after the invalid bit is marked leaves ordinary v2 work blocked until repair succeeds.
- **V2 kernel integration (guardrail #26):** `PopulateRuntimeContext` carries `signingContextsByWalletId` alongside `walletsById`. `runPopulate` delegates each wallet to a new v2-owned `drivePopulateForWallet(...)` orchestrator, which wraps the signing-required populate handlers with the signing context at the same granularity as v1 (`prepare` and each `processNextPage` call, not `finish` / `close`) — matching `withWalletSigningContext` in `portfolioPopulateJobWorklet.ts:315`. `ensureFresh` builds a **lightweight dispatch context** JS-side (no wallet signing, but `boxedNitroFetch` populated) and its worklet wrapper installs/clears it around the `RnBwsFiatRateProvider.loadSeries` call — matches the "non-signing requests still need Nitro fetch context" rule from `portfolioWorkletTransport.ts:137`. **Every worklet call that uses Nitro fetch requires a dispatch context for the duration of the call**, whether or not it signs.
- **Runtime-global concurrency verification (guardrail #27):** Phase 0.5 spike runs four probes (two branch-deciders, two diagnostic) on both platforms at 1000 iterations. Probes 2 (v2-asymmetric populate-vs-rate) and 3 (rate-vs-rate) determine branch selection from A (no mitigation), C (dedicated rate-fetch runtime — architectural fork to four runtimes total, still requires per-call lightweight dispatch context), or D (worklet-side lock — most surgical but most complex). Branch B remains diagnostic-only because it violates the non-blocking-read product requirement. `ensureFresh` always dedupes identical args; serialization of non-identical calls is only required when Probe 3 is dirty/flaky.
- **V18 keeps the current non-bundle worklet path.** Global `react-native-worklets` bundle mode is out of scope unless a future design proves it is isolated to the intended worklet runtime and preserves the existing Quick Crypto / fetch hybrid-object integration.
- **Wipe scope (guardrail #23):** matches actual repo prefixes `snap:*`, `rate:v1:*`, `portfolio:v2:*`. Excludes `PORTFOLIO_V2_FLAG_KEY` (don't silently disable v2 during rollout) and `PORTFOLIO_CACHE_INVALID_KEY` (so the durable invalid bit survives partial wipes until a successful repair clears it). Verified against repo at `snapshotStore.ts:146-162` and `fiatRateStore.ts` `rateKey` function.
- **Portfolio MMKV is a dedicated instance (guardrail #24):** `getPortfolioMmkvStorageOnRN()` returns `new MMKV({ id: 'bitpay.portfolio.engine' })`. All v2 MMKV access — flag, queue, wipe — goes through this instance, never the default MMKV.
- **Wipe goes through the key registry (guardrail #25):** portfolio storage tracks keys via `__bitpay.portfolio.engine.registry.v1__`. Wipe uses `kvStore.delete(key)` (untracks) or equivalently clears the registry. `listKeys()` empty after wipe.
- **`populateCancelFlag` lifecycle:** set true by cancel and reset; cleared false by every kick path before `runOnRuntimeAsync`. Never persists across cycles.
- **Invalid indexes recover via clear-and-rebuild** before populate.
- **Soft eviction cap** (N=8).
- **Asset rows and allocation stay ticker-grouped across chains.** `assetGroupId = lowercased currencyAbbreviation` is the canonical UI row identity for Home / All Assets / Allocation, matching current UX.
- **Allocation order equals asset-list order.** No second ranking system.
- **Key-scoped All Assets and asset detail stay scoped.** `AllAssets({keyId})` and row taps from `KeyOverview` use scoped selectors instead of Home-global rows, including any constituent wallet list rendered inside asset detail.
- **Rate fetching and snapshot refresh happen only at explicit triggers**, not in the scheduler and not on timeframe switches or chart scrubbing.
- **The user-facing "Show Portfolio" toggle is a first-class trigger.** Off clears cached portfolio data and hides portfolio-owned surfaces immediately; on repopulates from scratch after the wipe obligation is discharged. Home Exchange Rates and the Exchange Rate detail screen stay visible regardless of the setting and refetch on demand if the shared `rate:v1:*` cache was cleared.
- **Mid-populate UI behavior is explicit.** Asset-list rows stay visible immediately in canonical order with skeletons for unready right-side content; charts stay hidden during first populate until their relevant data is ready. Later incremental populates may update charts/rows progressively while a lightweight refreshing state is shown.
- **`runOnRuntimeAsync` non-curried**; fire-and-forget attaches `.catch(log)`.
- **Rapid timeframe/scrub interaction has an explicit no-recursive-render bar.** The plan now requires a dedicated regression for no maximum-update-depth errors, no recursive scheduler churn, and no blank flashes during timeframe toggles or chart scrubbing.
- **No data migration.** `SnapshotIndexV2.revision` required, starts at 1.
- **Every phase ships green.** Flag gates v1 vs v2 until Phase 8.
- **LOC estimate ~20.6k inside `src/portfolio/`**, 18–22k range pending Phase 0 inventory.
