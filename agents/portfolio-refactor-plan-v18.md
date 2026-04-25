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
- **`onQuoteCurrencyChanged(...)` lands in v18 as a BTC-bridge flow.** No trigger skeletons remain, quote switches do not refetch every visible asset in the new currency, and quote changes publish promptly via `recomputeQuoteBridgeFromExistingData(...)` — a targeted compute-runtime reprice from existing snapshots/rates using the per-τ bridge formula pinned in Phase 3 (correct under in-window txs, not a scalar transform).
- **`onPullToRefresh(...)` lands in v18.** No trigger skeletons remain.
- **`onShowPortfolioVisibilityChanged(...)` lands in v18.** Turning portfolio visibility off clears portfolio-owned cached data and hides all portfolio-owned charts/lists; turning it back on repopulates from scratch. Rapid off/on churn is serialized with last-toggle-wins final visibility plus a latched wipe obligation so ON cannot populate before an OFF-created clear completes.
- **"Hide Crypto Balances" (`hideAllBalances`) is a UI-local mask, not a portfolio data gate.** The setting at `state.APP.hideAllBalances` (defined at `src/store/app/app.reducer.ts:133`) toggles a pure presentational mask (`maskIfHidden(...)` → `'****'`) and hides chart surfaces, but does NOT cancel populate, stop recompute, clear caches, suppress `ensureFresh`, or affect `sharedPortfolioState`. V2 continues populating / computing / caching as normal while the mask is on; toggling it off reveals already-warm data instantly with zero populate or fetch latency. This is orthogonal to the "Show Portfolio" setting: Show Portfolio off clears portfolio cache; Hide Crypto Balances ON only masks display while the cache stays warm. Both can be on simultaneously.
- **Key-scoped asset list lands in v18.** `AllAssets({keyId})`, row taps from `KeyOverview`, and scoped asset detail all stay within that key's wallet set.
- **Key/account scoped render data is compute-runtime output, not JS selector math.** Scoped chart series, rows, order, and asset-detail payloads are built by heavy `wallet` / `wallets` recompute scopes on the compute runtime and published into a bounded scoped cache on `sharedPortfolioState`. JS selectors only look up the published scoped payload by `walletIdsKey` / asset / timeframe / mode; they never aggregate wallets, walk chart points, or compute PnL during timeframe switches or chart scrubbing.
- **Balance and Exchange Rate charts render at most 89 points.** This preserves the current chart-density target (`FIAT_RATE_SERIES_TARGET_POINTS = 89` in `src/store/rate/rate.models.ts:49`). Portfolio balance `Series.points` are capped by the compute runtime before publish; Exchange Rate charts may keep denser raw cached rate series, but the rendered chart data must be downsampled/capped before reaching the chart component. First/last window endpoints remain present so scrub/idle parity and Exchange Rate percent parity stay intact.
- **Chart sample grids reuse the existing downsample utilities and are chosen before portfolio math.** For each interval/window, v2 resolves a chart sample grid with `<= MAX_CHART_POINTS` timestamps up front, pins the first/final timestamps to the resolved window endpoints, then runs PnL/balance formulas only over that grid. Reuse the existing primitives in `src/utils/portfolio/rate.ts` (`downsampleSeries(...)` / `downsampleTimestamps(...)`) and extract the current Exchange Rate wrapper (`downsampleExchangeRateSeriesPreservingExtrema(...)` from `useExchangeRateChartData.ts`) into a shared non-React utility if v2 needs first/last/min/max preservation outside that hook. Do not invent a third downsample algorithm.
- **Corrupted tx histories with negative running balances are quarantined, not clamped.** V18 preserves v1's invalid-history behavior for wallets whose fetched tx history is missing incoming transactions and drives the snapshot running balance negative: throw/save a `negative_balance` invalid-history marker, clear that wallet's snapshot data while preserving the marker, skip the wallet without marking it populated, and suppress automatic retries until the marker cooldown expires.
- **Initial and incremental populate both publish progressively.** Initial populate uses skeleton reveal for not-yet-ready rows; incremental refresh may show a lightweight refreshing indicator while values update progressively. V18 intentionally does **not** hold incremental values stable until populate completion.
- **Timeframe switches / scrubbing stay read-only in v18.** No hidden rate fetches, snapshot updates, or populate kicks occur on timeframe-only interaction.
- **Populate runs on livenet wallets only.** Testnet / regtest wallets are excluded from the populate queue at every construction site (initial populate, incremental populate, `onKeyImported`, `onSendCompleted`, `onPullToRefresh`, `onWalletsVisibilityChanged` unhide path). Eligibility for populate is `isLivenetWallet(wallet) && !wallet.deleted`, where `isLivenetWallet(w)` is the normalized predicate defined in Terminology (accepts both `'livenet'` and `'mainnet'` strings, case-insensitive, whitespace-trimmed — matches v1's `isMainnetLikeWallet` at [portfolio.runtime.effects.ts:237](src/store/portfolio/portfolio.runtime.effects.ts#L237)). This matches current app behavior — portfolio charts / PnL are a mainnet-only concept.
- **Key import triggers populate for new livenet wallets.** When a key is successfully imported (`WalletActionTypes.SUCCESS_IMPORT`) and the user has Show Portfolio enabled, `onKeyImported({key})` kicks populate for the key's livenet wallets through the normal `populateWallets(...)` kick helper. Testnet wallets in the same key are skipped. Reset/cache-invalid guards apply normally.
- **Hide/unhide changes eligibility, not snapshot persistence.** Hiding a key (`hideKeyBalance`), an EVM account (`evmAccountsInfo[*].hideAccount`), or a wallet (`hideWallet` / `hideWalletByAccount` / `hideBalance`) removes the affected wallets from *displayed* portfolio totals/charts/lists — but does NOT delete their MMKV snapshot data. Unhiding re-includes affected wallets instantly from warm data without a re-populate. Edge case — "populated-late" livenet wallets: if a wallet was imported during a populate-blocked window (any of `getShowPortfolioEnabledFromStore() === false`, `populateResetInFlight === true`, or `portfolioCacheInvalid === true`), `onKeyImported` no-oped and the walletId was never added to the populate queue. Unhide then kicks populate for any newly-visible livenet walletId not present in `queue.doneWalletIds`. Home / All Assets / Allocation / KeyOverview / AccountDetails / Wallet detail surfaces all honor visibility filtering.
- **Chart scrubbing updates the balance header and PnL row with per-point values + a formatted timestamp.** On scrub, the big balance above the chart and the PnL row under it update to the scrubbed point's `fiatBalance` and `pnlChange` / `pnlPercent`. The PnL row also displays the scrubbed point's timestamp, formatted per interval (see Phase 7). On scrub end (release), the chart returns to idle: big balance = last point's `fiatBalance`, PnL row = last point's `pnlChange` / `pnlPercent` without a timestamp.
- **Chart scrubbing endpoint invariants are load-bearing.** At the first chart point, scrubbed `pnlChange` must be exactly `0` (the baseline point is always zero-change relative to itself). At the final chart point, scrubbed `fiatBalance` and `pnlChange` / `pnlPercent` must exactly match the idle (non-scrubbing) balance header and PnL row shown above the chart in the same screen / interval / quote / wallet scope. These are pinned in Phase 3 formula + parity tests, not left to UI formatting logic.

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
- All of `src/portfolio/ui/hooks/**` (~9,982 LOC per a current-repo spot-check via `find ... | wc -l`; Phase 0 inventory reverifies)
- `src/portfolio/ui/selectors/**`
- `src/portfolio/ui/common.ts` (545) — helpers folded into v2
- `src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts` — the file at this path is a 2-line re-export shim that **stays** as a v2 indirection (see Phase 7/8). The 2,892-LOC implementation the shim currently re-exports lives at `src/portfolio/ui/hooks/usePortfolioAssetRows.ts` and is already counted in the `src/portfolio/ui/hooks/**` ~9,982 LOC total above — do not double-count it in the "outside `src/portfolio/`" ledger.
- `src/store/portfolio/**` (~1,236 LOC per a current-repo spot-check via `find ... | wc -l`; Phase 0 inventory reverifies) — v1 Redux slice + `portfolio.runtime.effects.ts`. The `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts` that dispatches `clearWalletPortfolioDataWithRuntime({walletIds})` is replaced by `onWalletsDeleted({walletIds})` (Phase 6).
- `src/store/portfolio-charts/**` (~536 LOC per a current-repo spot-check via `find ... | wc -l`; Phase 0 inventory reverifies) — v1 chart cache slice. Superseded by `sharedPortfolioState` series. **Outside `src/portfolio/`**.

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
- **Precomputed row payload** — `rowToday` / `rowAllTime` on `AssetGroupSlice`. Global Home / All Assets / Allocation selectors read these as O(1) lookups. Key/account scoped selectors read precomputed `ScopedPortfolioSlice` entries published by the compute runtime; they do not aggregate wallets or chart points on the JS thread.
- **Scoped render cache** — bounded `sharedPortfolioState.scopedByWalletSet[walletIdsKey]` cache of compute-runtime-produced render payloads for key/account/custom wallet scopes. Entries contain scoped total series, scoped asset-group slices, scoped row payloads, scoped order, readiness, invalid-history status, and fingerprints. JS selectors only select from this cache; missing entries return `undefined` / skeleton state until an explicit heavy recompute publishes the scope.
- **Invalid-history marker** — v1-compatible `snap:invalid-history:v1:<walletId>` marker produced when snapshot building detects a corrupted tx history that drives the wallet's running balance negative. Shape comes from `src/portfolio/core/pnl/invalidHistory.ts`: `{v: 1, walletId, reason: 'negative_balance', detectedAt, retryAfter, message, source?, txId?, balanceAtomic?}` with a 24h default cooldown. Active markers suppress auto-populate for that wallet; successful later populate clears the marker.
- **Stored fiat-rate interval** — canonical persisted/fetched interval in `{1D, 1W, 1M, ALL}`. Displayed `3M`, `1Y`, and `5Y` are derived from `ALL`.
- **Canonical rate quote currency** — the stable quote currency in which asset rate series are persisted under `rate:v1:<QUOTE>:*`. Distinct from the user's currently-displayed quote (`getQuoteCurrencyFromStore()`). Determined at populate time by whichever quote `ensureFresh` originally fetched/persisted asset rates under (typically `'USD'`). Quote-switch reprice always bridges from this canonical quote to the target quote regardless of what the user is currently viewing — that invariant is what makes multi-hop chains (USD → EUR → GBP → JPY) correct. Switching the canonical quote itself is out of scope; it would require re-fetching every asset rate series, which is exactly what the BTC bridge exists to avoid. Phase 1 surfaces this via `getCanonicalRateQuoteCurrencyFromStore()` in `reduxAccess.ts`. See Phase 2's canonical-rate-quote rule and parity test #101.
- **Chart point cap** — `MAX_CHART_POINTS = 89`, matching the current `FIAT_RATE_SERIES_TARGET_POINTS` constant in `src/store/rate/rate.models.ts:49`. Every balance chart's published `Series.points` array and every rendered Exchange Rate chart data array must have `length <= 89`. Raw MMKV rate series may contain more points; render/publish payloads may not.
- **`FiatRateAssetRef`** — `{coin, chain?, tokenAddress?}` (defined at `src/portfolio/core/fiatRatesShared.ts:8`). Output of `getFiatRateAssetRef(...)` in `src/portfolio/core/pnl/rates.ts:28`, the canonical classifier for the v2 rate path. A kernel-local parity copy exists in `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts:91` for analysis-side use (retained per guardrail #2); v2 paths must import from `rates.ts`, not duplicate the logic a third time. A native coin has only `coin` populated and routes through the batched multi-coin path `GET /v4/fiatrates/{QUOTE}?days={N}`. A valid token wallet has all three fields populated and routes through the per-token path `GET /v4/fiatrates/{QUOTE}?days={N}&chain={chain}&tokenAddress={tokenAddress}`. Classifier rules: coin-normalization aliases (`wbtc→btc`, `weth→eth`, `matic→pol`), legacy ETH-side MATIC token (normalized `coin='pol'` with `chain='eth' + tokenAddress='0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0'` — applies to both `currencyAbbreviation='pol'` and `'matic'` inputs since normalization maps `matic → pol`) reclassified to native POL, chain-case normalization (lowercase), token-address case-sensitivity (`{'sol', 'solana'}` preserve case; others lowercased). See Phase 2 "V4 fiat-rates endpoint contract" for the full fetch semantics.
- **Refreshing portfolio state** — lightweight UI state set by incremental populate triggers. It may show subtle loading affordances, but it does not block progressive chart/PnL updates.
- **Scalar signature** — joined string like `populatedWalletIdsKey`. Fingerprint-input / diff-key.
- **Order revision** — monotonic counter for `orderedAssetGroupIdsForAssetList` mutations. Used for merge arbitration. **Monotonic across queue rebuilds**, not just within one queue's lifetime.
- **`populateResetInFlight`** — JS-side boolean, set only during an active `performResetSequence` invocation. Blocks ordinary kicks during reset; additional reset callers join the active sequence or queue a stronger full reset as described in guardrail #19.
- **`portfolioCacheInvalid`** — JS-side mirror of MMKV key `portfolio:v2:cacheInvalid`. Set before destructive wipe begins; cleared only after wipe + shared-state reset complete successfully. If true on boot, post-auth startup must repair the cache before ordinary v2 work resumes.
- **`canRunPortfolioV2Work()`** — predicate: `!populateResetInFlight && !portfolioCacheInvalid`. First executable statement of every ordinary v2 function that writes to MMKV or `sharedPortfolioState`.
- **`waitForPopulateLoopToStop()`** — polls `populateLoopRunning.value`. Throws on 60s timeout. Used by `performResetSequence`.
- **`waitForRecomputeDrainToStop()`** — polls scheduler's `running` flag. Throws on 30s timeout. Used by `performResetSequence` alongside the populate wait to quiesce both async subsystems before wipe.
- **`waitForEnsureFreshToStop()`** — polls `ratesFetch.ts` in-flight count. Throws on 20s timeout. Third wait in the reset `Promise.all`. Covers rate fetches that started before the reset guard flipped.
- **`isLivenetWallet(w)`** — normalized mainnet-like check matching v1 behavior. Implementation: `const n = String(w?.network ?? '').trim().toLowerCase(); return n === 'livenet' || n === 'mainnet';`. Mirrors `isMainnetLikeWallet` in `src/store/portfolio/portfolio.runtime.effects.ts:237`. A naive `w.network === Network.mainnet` would under-include because `Network.mainnet === 'livenet'` in `src/constants/index.ts:6`, so literal `'mainnet'` strings (seen in some wallet objects) would be rejected. Used everywhere populate-eligibility is decided. Testnet / regtest wallets are excluded from populate. Parity test #70 (livenet-only construction) must seed fixtures containing both `'livenet'` and `'mainnet'` literal strings and assert both are treated as livenet.
- **`isWalletVisibleInStore(walletId)`** — JS-side predicate combining the key-level `hideKeyBalance`, EVM-account-level `evmAccountsInfo[accountName].hideAccount`, and wallet-level `hideWallet` / `hideWalletByAccount` / `hideBalance` flags. Returns true iff every applicable flag allows the wallet to appear in portfolio-owned surfaces. Does NOT interact with the global Show Portfolio setting (that is a separate, higher-priority gate via `getShowPortfolioEnabledFromStore()`). Also does NOT consult `hideAllBalances` — that is a UI-only mask on already-visible data.
- **`hideAllBalances`** — the "Hide Crypto Balances" user setting at `state.APP.hideAllBalances` (`src/store/app/app.reducer.ts:133`). Toggled via `toggleHideAllBalances(value?: boolean)` (`src/store/app/app.actions.ts:237`) from Settings → General and from a long-press gesture on the Home portfolio balance. **Purely presentational**: when true, UI rendering code replaces balance / PnL-delta / fiat strings with `'****'` via `maskIfHidden(...)` and hides chart surfaces entirely. It does NOT cancel populate, recompute, fetches, or cache writes. Portfolio v2 code paths (`reduxAccess.ts`, selectors, triggers, recompute, populate, scheduler, ratesFetch) must not read this flag — it belongs to the UI rendering layer only (guardrail #34).
- **`maskIfHidden(hidden, value, mask?)` / `HIDDEN_BALANCE_MASK`** — rendering helper at `src/utils/hideBalances.ts`. `HIDDEN_BALANCE_MASK = '****'`. When `hidden` is true, returns the mask; otherwise returns `value ?? ''` (numbers stringified). Every portfolio-owned UI surface that displays a balance, fiat amount, delta-fiat, or PnL percent value must route its formatted string through this helper with `hideAllBalances` as the flag, matching v1 rendering behavior exactly.
- **`getPopulateEligibleWalletsFromStore()`** — returns livenet, not-deleted wallets **regardless of visibility**. Drives `buildQueue(...)` inputs and every populate-kick helper. Hidden wallets ARE populated so their data is warm when unhidden (no populate latency on unhide for wallets that existed while hidden). The only exception is the edge case of a wallet imported while already hidden — `onWalletsVisibilityChanged(...)` unhide path kicks populate for any newly-visible livenet wallet not present in `queue.doneWalletIds`.
- **`getEligibleStoredWalletsFromStore()`** — returns livenet, not-deleted, **visible** wallets (`isLivenetWallet(w) && !w.deleted && isWalletVisibleInStore(w.walletId)`). Drives `buildBaseRecomputeInputs(...)` → `scheduleRecompute` inputs. Because hidden wallets are excluded here, `recompute`'s `byWallet` slice and totals naturally drop them. `getEligibleStoredWalletsFromStore()` and `getPopulateEligibleWalletsFromStore()` are **distinct**: populate operates on the broader set; recompute operates on the visible-only set. Do not conflate them.
- **`formatScrubTimestamp(ts, args)`** — Phase 7 timestamp formatter for the PnL-row-under-balance scrub display. Signature: `formatScrubTimestamp(ts: number, args: { interval: Interval; windowStartTs: number; windowEndTs: number }): string`. Callers pass the currently-displayed `Series`'s fields (`series.interval`, `series.windowStartTs`, `series.windowEndTs`) so the formatter has full window metadata without reaching into UI state. For `{1D, 1W, 1M}`: `"March 29, 2026 at 5:22 PM"` (locale-formatted date + short time). For `{3M, 1Y, 5Y}`: `"March 29, 2026"` (date only, no time). For `ALL`: if `(windowEndTs - windowStartTs) < 90 * 24 * 60 * 60 * 1000` (strictly less than ~3 months — e.g., account is freshly funded), include hours; otherwise omit hours. The helper is locale-aware and uses the app's existing date-formatting utilities — it is not reimplemented from scratch.
- **`logPortfolioRuntimeError(err, extra?)`** — the JS-side logger every `runOnRuntimeAsync(...)` fire-and-forget `.catch(...)` attaches to. Lives at `src/portfolio/v2/logPortfolioRuntimeError.ts`. Signature: `logPortfolioRuntimeError(err: unknown, extra?: { tag?: string; [k: string]: unknown }): void`. Behavior: (1) serialize `err` with `extra` via the existing app error-logging util used elsewhere in `src/store/**` (grep Phase 0 — match the current project-wide pattern so Sentry/console output is consistent); (2) NEVER throw and NEVER return a Promise — the function is called in `.catch(...)` / `.catch(logPortfolioRuntimeError)` and must not itself invalidate the attached chain; (3) attach a fixed `subsystem: 'portfolio-v2'` tag so logs are filterable; (4) include `extra.tag` when provided so call sites can distinguish populate / ensureFresh / fx-bridge / quote-switch / reset / scheduler paths. All `.catch(logPortfolioRuntimeError)` call sites pass the error only (curry-free non-attached usage); call sites that already have contextual info (`logPortfolioRuntimeError(err, {tag: 'populate'})`) use the arity-2 form inside the `catch` lambda.

**Fingerprints do two things:** (1) selector cost — O(1) lookups; numeric work happens once in `recompute`; (2) render invalidation — `React.memo` and `usePortfolioSlice(..., areEqual)` clone-proof.

**Fingerprints are a render invalidation heuristic; numeric correctness is enforced by parity tests.**

## Guardrails

1. **Ship-green** after every phase under `PORTFOLIO_V2=false`.
2. **Don't refactor kernels.** The "untouched" list is binding.
3. **Don't regress MMKV layout** beyond the `revision` addition.
4. **One compute-runtime writer, one state surface.** Only compute-runtime recompute functions write `sharedPortfolioState`: the normal `recompute(...)` path plus the quote-switch-specific `recomputeQuoteBridgeFromExistingData(...)` path described in Phases 2/3. Touch scopes are recompute scopes. **Reset paths (debug-clear, sign-out) also write to `sharedPortfolioState`** — see guardrail #17.
5. **LOC ledger per phase.**
6. **Selectors are pure worklet functions** of state + primitives. No Redux.
7. **Cancellation** via `populateCancelFlag.value` checks at yield points.
8. **Runtime API hygiene.** Non-curried `runOnRuntimeAsync`. `.catch(logPortfolioRuntimeError)` on fire-and-forget.
9. **Rate fetching and snapshot refresh happen only at explicit refresh triggers, never in the scheduler or on timeframe interaction.** `ensureFresh` and populate kicks are allowed only from the Phase 6 trigger set. Timeframe switches and chart scrubbing are read-only view changes and must not trigger rates, snapshots, or populate work.
10. **Touch scopes are metadata-only.** Update `byWallet[id].lastAccessedAt` for existing slices. Never change `computedAtMs`, readiness maps, invalid-history maps, `byAssetGroup`, `total`, `totalFingerprint`, series, rows, `quoteCurrency`, or `orderedAssetGroupIdsForAssetList` / `orderRevision`. Revision bumps only if at least one slice updated.
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
29. **Populate is livenet-only at every construction site.** `buildQueue(...)`, `populateWallet(...)`, `populateWallets(...)`, `startPopulate(...)`, and every trigger that calls them filter wallet candidates through `isLivenetWallet(w)`. Testnet / regtest wallets never enter `PopulateQueueV1.remainingWalletIds` and never reach `runPopulate`. The sole source of "candidate wallets for populate" is `getPopulateEligibleWalletsFromStore()` — no ad hoc eligibility logic. `onKeyImported(key)` filters its walletIds by `isLivenetWallet` before kicking; `onSendCompleted({walletId})` no-ops on testnet walletIds.
30. **Populate eligibility and recompute eligibility are distinct.** `getPopulateEligibleWalletsFromStore()` (livenet, not deleted, visibility-**ignored**) drives populate. `getEligibleStoredWalletsFromStore()` (livenet, not deleted, visibility-**respected**) drives `buildBaseRecomputeInputs(...)`. Hidden wallets are populated (data warm) but excluded from displayed totals/series/rows. Unhide is instant — no populate-latency window — because the next fire-time recompute simply sees the wallet as eligible again and reads its already-warm snapshot data. **Edge case — "populated-late" livenet walletIds.** In normal flow, `onKeyImported` immediately kicks populate for livenet wallets regardless of visibility, so a hidden wallet imported while Show Portfolio is on gets populated at import time and its data is warm on unhide. The edge case is when the import lands during a populate-blocked window — `getShowPortfolioEnabledFromStore()` is false, `populateResetInFlight` is true, or `portfolioCacheInvalid` is latched — so `onKeyImported` no-ops and the walletId is never added to the queue. On unhide, `onWalletsVisibilityChanged(...)` handles this by kicking `populateWallets(...)` for any newly-visible livenet walletId absent from `queue.doneWalletIds`. Show-Portfolio re-enable also covers the Show-Portfolio-off case: it runs a fresh full populate that picks up the previously-unpopulated walletIds. Never call `buildBaseRecomputeInputs(...)` with `getPopulateEligibleWalletsFromStore()` or vice versa — the two sets have intentionally different membership rules and swapping them would cause hidden wallets to appear in totals or visible wallets to miss populate.
31. **Chart-point endpoint invariants are load-bearing.** Every published `Series` satisfies: (a) `series.points[0].pnlChange === 0` exactly (the baseline point is zero-change against itself per the Phase 3 PnL formula step 6 — `firstTotalUnrealizedPnlFiat = totalUnrealizedPnlFiat` at the first emitted point means `totalPnlChange` at that point is `0 - 0 === 0`); (b) `series.points[last].fiatBalance`, `pnlChange`, and `pnlPercent` are the exact values the idle (non-scrubbing) balance header and PnL row display for the same screen / interval / quote / wallet scope. These are not a UI formatting concern — they are recompute output invariants pinned by Phase 3 formula tests and Phase 7 scrub parity tests.
32. **Scoped aggregation is compute-runtime/precomputed only.** Key/account/scoped asset-detail rows and series are produced by `recompute(...)` on the compute runtime during heavy `wallet` / `wallets` scopes and stored under `sharedPortfolioState.scopedByWalletSet[walletIdsKey]`. JS selectors (`selectKeySeries`, `selectScopedAssetGroupRows`, `selectScopedOrderedAssetGroupIds`, scoped asset-detail selectors) are cache lookups over already-published payloads. They must not sum wallet series, walk `Series.points`, rebuild collapsed asset groups, or compute PnL in React/JS during render, timeframe switches, or scrubbing. A missing scoped cache entry returns `undefined` / skeleton-ready state until an explicit mount/trigger-scheduled recompute publishes it; selectors never synchronously "fix" a miss by doing heavy aggregation.
33. **Invalid tx history / negative running balance parity.** Preserve v1 behavior from `snapshotStream.ts`, `portfolioWorkletSnapshotBuilder.ts`, `invalidHistory.ts`, `portfolioPopulateWorklet.ts`, and `portfolioStaleness.ts`: same-timestamp/block batches may be reordered greedily to avoid artificial underflow, but if processing still drives `balanceAtomic < 0`, throw `PortfolioInvalidHistoryError` / `PORTFOLIO_INVALID_HISTORY_NEGATIVE_BALANCE`, save an invalid-history marker, clear wallet snapshots while preserving that marker, do not mark the wallet populated, and do not retry that wallet while the marker is active. Recompute must omit wallets with no valid snapshots rather than publishing negative balances or clamping them into apparently-valid PnL.
34. **`hideAllBalances` is UI-rendering-only — portfolio v2 code paths must not consume it.** `reduxAccess.ts` must not export a `getHideAllBalancesFromStore()` accessor. Triggers (`onAppLaunchPostAuth`, `onSendCompleted`, `onPullToRefresh`, `onQuoteCurrencyChanged`, `onLiveRatesUpdated`, `onShowPortfolioVisibilityChanged`, `onKeyImported`, `onWalletsDeleted`, `onWalletsVisibilityChanged`) must not branch on it. Scheduler, recompute, selectors, populate queue, `ensureFresh`, fingerprints, and `sharedPortfolioState` publish decisions must all be independent of the flag. The mask lives strictly at the UI rendering boundary: portfolio-owned components read `state.APP.hideAllBalances` directly via `useAppSelector` and apply `maskIfHidden(...)` to formatted strings + conditionally hide chart surfaces. A toggle produces zero `runOnRuntimeAsync`, zero MMKV writes, zero trigger fires, and zero recompute publishes — only React re-renders. This preserves orthogonality with "Show Portfolio" (which DOES affect data/cache) and guarantees instant reveal when the user toggles hide off.
35. **Chart render point cap is load-bearing.** Balance chart `Series.points` and Exchange Rate chart render data must never exceed `MAX_CHART_POINTS = 89` points. For portfolio balance charts, the compute-runtime series builder applies the cap before publishing global, wallet, asset-group, and scoped series. For Exchange Rate charts, raw cached rate series may be denser, but the chart formatter/downsampler caps the rendered data before it reaches the chart component. Downsampling must preserve the resolved first and final window endpoints so first-point `pnlChange = 0`, last-point idle/scrub equality, and Exchange Rate window percent parity remain valid.
36. **Chart sample-grid selection precedes heavy PnL math and reuses existing downsample primitives.** `resolveChartSampleGrid(...)` (name flexible) chooses at most `MAX_CHART_POINTS` timestamps for the resolved `{interval, windowStartTs, windowEndTs}` before the compute runtime runs portfolio math. The PnL formula iterates over that capped grid, not over a dense raw daily/hourly history and then trims afterward. This helper must be built on the existing shared primitives in `src/utils/portfolio/rate.ts`: `downsampleSeries(...)` / `downsampleTimestamps(...)`, with the Exchange Rate endpoint/extrema-preserving behavior extracted from `downsampleExchangeRateSeriesPreservingExtrema(...)` in `src/navigation/wallet/hooks/useExchangeRateChartData.ts` when needed. Exchange Rate chart formatting and balance-chart series construction must not maintain independent "89 point" algorithms.
37. **UI must not call generic v1 analysis / query / request APIs.** Portfolio-owned screens, components, and hooks must not import or call any of the following from `src/portfolio/v2/**` or anywhere else: `computeAnalysis(...)`, `prepareAnalysisSession(...)`, `computeSessionScope(...)`, `computeAnalysisChart(...)`, the v1 `getPortfolioRuntimeClient(...)` request methods, `portfolioClient.*` request methods, or any future "compute now from React" API. UI reads happen through `usePortfolioSlice(...)`, the typed hook façades (`usePortfolioChart`, `usePortfolioAssetRows`, `usePortfolioStatus`), or named selectors that perform O(1) lookups over `sharedPortfolioState`. Mounts schedule recompute through `scheduleRecompute(...)`; they do not invoke compute paths directly. Enforcement: an `eslint-no-restricted-imports` rule plus a v2 import-check test that greps `src/{components,navigation}/**` for any of the banned identifiers and asserts zero hits. Adding a new computation API to v2 requires either (a) routing it through `scheduleRecompute(...)` so it lands in `sharedPortfolioState`, or (b) adding it explicitly to this guardrail's allowlist with rationale. This guardrail prevents the v1 sprawl (per-screen analysis sessions, scoped query caches, chart-cache slices) from re-emerging behind new names.

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
> 4. **Exact state paths** for every piece of Redux data v2 needs: quote currency, eligible wallets, live rates (by asset id), live rates asOfMs, wallet balances, wallet→asset mapping, the user-facing "Show Portfolio" visibility setting, plus the wallet-and-key visibility + network fields required by guardrails #29–30:
>    - `wallet.network` field (`Network.mainnet` / `Network.testnet` / `Network.regtest`) — source for `isLivenetWallet(w)` in `getPopulateEligibleWalletsFromStore()`.
>    - Key-level `hideKeyBalance` (`src/store/wallet/wallet.models.ts:76`) — hides all wallets in that key from portfolio totals.
>    - EVM-account-level `evmAccountsInfo[accountName].hideAccount` (`src/store/wallet/wallet.models.ts:78-84`) — hides all wallets under an EVM account.
>    - Wallet-level `hideWallet` / `hideWalletByAccount` / `hideBalance` (`src/store/wallet/wallet.models.ts:155-157`) — per-wallet visibility flags.
>    - The Redux action(s) that mutate each of the above (grep `hideKeyBalance`, `hideWallet`, `hideWalletByAccount`, `hideAccount`, `hideBalance`). `onWalletsVisibilityChanged({affectedWalletIds})` must be wired to every one of these action types.
>    - The `WalletActionTypes.SUCCESS_IMPORT` payload shape — the imported `Key` plus its wallets. `onKeyImported({key})` consumes this.
>    These paths feed `reduxAccess.ts` accessors in Phase 1 plus the `isWalletVisibleInStore(walletId)` predicate in Terminology.
> 5. **MMKV key prefixes in use.** Grep for `return \`[a-z]+:` patterns in `src/portfolio/core/pnl/**` and `src/portfolio/runtime/worklet/**` to find all key-construction sites. Expected: `snap:meta:v2:*`, `snap:index:v2:*`, `snap:chunk:v2:*`, `snap:invalid-history:v1:*`, `snap:*:*:*` (raw point keys), `rate:v1:*`. V2 adds `portfolio:v2:*`. Report the complete verified set. This list grounds the wipe-prefix constant in guardrail #23 and Phase 7.5's `wipePortfolioMmkvKeys` implementation. **If Phase 0 finds prefixes not in this expected list, they MUST be added** — otherwise debug-clear will leave orphan keys.
> 6. **MMKV adapter layout.** Inspect `src/portfolio/adapters/rn/workletMmkvBridge.ts` and `mmkvKvStore.ts`. Confirm `getPortfolioMmkvStorageOnRN()` returns the dedicated `bitpay.portfolio.engine` MMKV instance. Confirm that there is **no existing** `getPortfolioKvStore()` accessor in the repo and that Phase 1 must create one in v2 using `MmkvKvStore`, `getPortfolioMmkvStorageOnRN()`, `PORTFOLIO_WORKLET_MMKV_STORAGE_ID`, and `PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY`. Report the exact import paths for all four.
> 7. **FiatRateStore fetch/persist separability.** Inspect `src/portfolio/core/pnl/fiatRateStore.ts`. Confirm that `ensureRates` uses an injected provider's `loadSeries` for the network step, `getSeries` for freshness checks, and `setSeries` for persistence. Confirm `extractSeries` is file-local (not exported) and therefore must be cloned/exported intentionally for v2. Confirm `BwsFiatRateProvider` at `adapters/rn/bwsFiatRateProvider.ts` implements `loadSeries`. These are the primitives Phase 2's `ensureFresh` uses.
> 8. **Invalid-history / negative-running-balance inventory.** Verify the current flow end-to-end and cite exact files/functions: `reorderTxBatchToPreventUnderflow(...)`, `createNegativeBalanceInvalidHistoryError(...)`, `toSnapshotInvalidHistoryMarker(...)`, `saveInvalidHistoryMarker(...)` / `saveWorkletInvalidHistoryMarker(...)`, `clearWallet(... {preserveInvalidHistoryMarker: true})` / `clearWorkletWalletSnapshots(... {preserveInvalidHistoryMarker: true})`, `clearInvalidHistoryMarker(...)` on successful finish, and `getPortfolioPopulateDecisionForWallet(...)` suppressing auto-populate while `isSnapshotInvalidHistoryMarkerActive(...)` is true. These are guardrail #33's parity source of truth.
> 9. **Exact LOC** for every file in the kept/deleted lists. Flag discrepancies >10%, especially `balanceDiagnostic.ts`.
> 10. Baseline `yarn test` counts.
> 11. `getStore()` signature + location where its callback resolves in `index.js`. `RootState` type location.
> 12. **Reset path inventory.** Every code path that wipes portfolio MMKV or equivalent. These become Phase 7.5 integration points for guardrail #17.
> 13. **Product-parity inventory.** Verify and document:
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
>    - the "Hide Crypto Balances" Redux path: confirm `state.APP.hideAllBalances` (boolean, default false) at `src/store/app/app.reducer.ts:133`, the toggle action `toggleHideAllBalances(value?: boolean)` at `src/store/app/app.actions.ts:237`, and the user-facing toggle dispatch sites verified against current repo — Settings → General (`General.tsx:178`), long-press on Home `PortfolioBalance` (`PortfolioBalance.tsx:573`), long-press/toggle on `WalletDetails` (`WalletDetails.tsx:1308`), long-press/toggle on `AccountDetails` (`AccountDetails.tsx:1447`), and long-press/toggle on `KeyOverview` (`KeyOverview.tsx:1136`) — plus the non-user-facing programmatic reset at `src/store/app/app.effects.ts:1041` (`dispatch(AppActions.toggleHideAllBalances(false))`). Phase 0 must run `rg -n "toggleHideAllBalances" src` as the source of truth and flag any additional sites added since this plan was written. Also confirm the `maskIfHidden(...)` / `HIDDEN_BALANCE_MASK` util at `src/utils/hideBalances.ts`. Grep `src/portfolio/**` for `hideAllBalances` and `maskIfHidden` — both must return zero hits; the mask is strictly a UI-rendering concern per guardrail #34. Inventory the v1 portfolio-owned UI surfaces that currently consume the flag so Phase 7 reproduces parity: Home `PortfolioBalance` (masks big balance + hides chart + hides `ChartChangeRow`), `AssetRow` (masks crypto amount + fiat amount + delta-fiat ONLY — percent pill is NOT masked and still honors `shouldShowSkeleton`; see v1 `AssetRow.tsx:390-420` vs `:453-469`), `Crypto` home container, `Allocation` (masks fiat amount), `KeyOverview` (masks key-level balance + per-wallet amounts), `WalletDetails` / `AccountDetails`, `AssetBalanceHistoryScreen`, and the **Exchange Rate detail screen's user-balance subviews** (`useExchangeRateSharedModel.ts:115` reads the flag; `ExchangeRateScreenLayout.tsx:450-455` masks `ui.cryptoBalance` / balance fiat while keeping the rate market values + rate chart unmasked). Note that skeleton loaders are bypassed for amount/delta fields when the flag is on, but the percent pill's skeleton is NOT bypassed — `****` renders directly for amount/delta only.
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
> // Matches the existing Exchange Rate chart density target
> // (`FIAT_RATE_SERIES_TARGET_POINTS` in src/store/rate/rate.models.ts).
> export const MAX_CHART_POINTS = 89;
> // Point carries every field the UI displays — UI never computes fiat/PnL on the fly.
> // `fiatBalance`: fiat value of wallet/group/total at this sample timestamp (units * markRate).
> // `pnlChange`: delta from first-series-point unrealized PnL (zero at index 0 by Phase 3 step 6).
> // `pnlPercent`: unrealizedPnlFiat / remainingCostBasisFiat * 100 (zero when basis is zero or non-finite).
> export type Point = Readonly<{
>   ts: number;
>   fiatBalance: number;
>   pnlChange: number;
>   pnlPercent: number;
> }>;
>
> // Series carries the interval + resolved window bounds so UI scrub/axis code can read
> // them from the displayed series instead of recomputing. Chart-boundary equality keys
> // on Series.fingerprint, NEVER points array identity.
> export type Series = Readonly<{
>   fingerprint: string;
>   points: readonly Point[];
>   interval: Interval;         // which displayed timeframe this series represents
>   windowStartTs: number;      // resolved window start (ms), matches Phase 3 interval-window helper
>   windowEndTs: number;        // resolved window end (ms, typically "now" rounded)
> }>;
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
> export type ScopedPortfolioSlice = Readonly<{
>   walletIdsKey: string;
>   walletIds: readonly string[];
>   fingerprint: string;
>   computedAtMs: number;
>   total: PerIntervalSeries;
>   totalFingerprint: string;
>   byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   populatedAssetGroupIdsKey: string;
>   populatedAssetGroupIdsById: Readonly<Record<string, true>>;
>   invalidHistoryWalletIdsKey: string;
>   invalidHistoryWalletIdsById: Readonly<Record<string, true>>;
>   invalidHistoryAssetGroupIdsKey: string;
>   invalidHistoryAssetGroupIdsById: Readonly<Record<string, true>>;
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
>   // Active invalid-history marker status published for O(1) UI reads. Source
>   // is RecomputeInputs.invalidHistoryWalletIds from the queue; selectors must
>   // not read queue/MMKV during render just to decide skeleton/error-ready state.
>   invalidHistoryWalletIdsKey: string;
>   invalidHistoryWalletIdsById: Readonly<Record<string, true>>;
>   invalidHistoryAssetGroupIdsKey: string;
>   invalidHistoryAssetGroupIdsById: Readonly<Record<string, true>>;
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;               // monotonic across queue rebuilds
>   byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
>   byWallet: Readonly<Record<string, WalletSlice>>;
>   // Bounded cache of compute-runtime-produced scoped render payloads.
>   // JS selectors only look up these entries; they never aggregate scoped rows/series.
>   scopedByWalletSet: Readonly<Record<string, ScopedPortfolioSlice>>;
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
>   invalidHistoryWalletIds: readonly string[];
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;
>   // WalletIds whose scoped-cache entries must be evicted before scoped
>   // rebuild in this recompute pass. Used by triggers (notably
>   // `onWalletsDeleted`) to request atomic eviction + refresh through the
>   // registered scheduler publish path instead of mutating
>   // `sharedPortfolioState.scopedByWalletSet` directly (guardrails #22, #32).
>   // `recompute(...)` drops any `state.scopedByWalletSet[*]` entry whose
>   // `walletIds` intersects this set, then refreshes remaining entries, then
>   // publishes once. Undefined / empty array means no evictions requested.
>   evictScopedWalletIds?: readonly string[];
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
>   invalidHistoryWalletIdsKey: '',
>   invalidHistoryWalletIdsById: {},
>   invalidHistoryAssetGroupIdsKey: '',
>   invalidHistoryAssetGroupIdsById: {},
>   orderedAssetGroupIdsForAssetList: [],
>   orderRevision: 0,
>   byAssetGroup: {},
>   byWallet: {},
>   scopedByWalletSet: {},
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
> // Stable persisted-rates quote — the quote in which asset rate series are stored
> // under `rate:v1:<QUOTE>:*`. NOT the user's currently-displayed quote (that is
> // `getQuoteCurrencyFromStore()`). Used by `onQuoteCurrencyChanged(...)` and
> // `recomputeQuoteBridgeFromExistingData(...)` so multi-hop quote switches
> // (USD → EUR → GBP → ...) always bridge from the same canonical source.
> // Phase 0 inventory must identify the exact state path; default expectation
> // is "whatever quote ensureFresh originally fetched/persisted asset rates under
> // at populate time" (typically `'USD'`). Switching the canonical quote is out
> // of scope — it would require re-fetching every asset rate series. See Phase 2's
> // canonical-rate-quote rule.
> export function getCanonicalRateQuoteCurrencyFromStore(): string;
> export function getShowPortfolioEnabledFromStore(): boolean;
> // Livenet + not deleted + VISIBLE (respects hideKeyBalance / hideAccount / hideWallet / hideWalletByAccount / hideBalance).
> // Drives buildBaseRecomputeInputs → scheduleRecompute inputs. Guardrail #30.
> export function getEligibleStoredWalletsFromStore(): readonly StoredWallet[];
> // Livenet + not deleted, VISIBILITY-IGNORED. Drives buildQueue / populate kick helpers.
> // Hidden wallets ARE populated so data is warm when unhidden. Guardrails #29, #30.
> export function getPopulateEligibleWalletsFromStore(): readonly StoredWallet[];
> // Low-level predicate used by both getters above plus onKeyImported's filter.
> export function isLivenetWallet(w: StoredWallet): boolean;       // normalized: n === 'livenet' || n === 'mainnet' (see Terminology for the full predicate)
> // Composite visibility predicate: key-level hideKeyBalance, EVM-account-level hideAccount,
> // wallet-level hideWallet / hideWalletByAccount / hideBalance. Returns true iff ALL applicable
> // flags allow the wallet to appear. Does NOT consult getShowPortfolioEnabledFromStore — that is a
> // separate, higher-priority gate checked in Phase 6 triggers.
> export function isWalletVisibleInStore(walletId: string): boolean;
> export function getLiveRatesByAssetIdFromStore(): Record<string, number>;
> export function getLiveRatesAsOfMsFromStore(): number | undefined;
> export function getBalancesByWalletIdFromStore(): Record<string, bigint>;
> // Visibility-respected id-set. Matches `getEligibleStoredWalletsFromStore()` semantics
> // (livenet + not deleted + visible). Used by RECOMPUTE-side code only — e.g.,
> // recompute-time walletId membership checks, row/selector scoping, and the
> // visible-set view any future scheduler helper exposes. Do NOT use this for populate
> // queue reconciliation: every populate-side reconcile call (`startPopulate`,
> // `populateWallet`, `populateWallets`, `onWalletsDeleted`) routes through
> // `getPopulateEligibleWalletIdSetFromStore()` below so hidden livenet wallets are
> // not pruned from the populate queue (guardrails #29–30).
> export function getCurrentEligibleWalletIdSetFromStore(): Set<string>;
> // Visibility-IGNORED populate-side id-set. Matches `getPopulateEligibleWalletsFromStore()`
> // semantics (livenet + not deleted). Used by every populate-side
> // `reconcileQueueAgainstEligible` call — `populateWallet`, `populateWallets`,
> // `startPopulate`, `runPopulate`'s in-loop reconciliation. Ensures hidden-but-livenet
> // walletIds stay in the queue and get populated so their data is warm on unhide.
> // Guardrails #29–30.
> export function getPopulateEligibleWalletIdSetFromStore(): Set<string>;
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
> **V4 fiat-rates endpoint contract (repo-accurate, preserve v1 behavior exactly):**
>
> The BWS endpoint is `${cfg.baseUrl}/v4/fiatrates/${QUOTE_UPPER}` (see `getFiatRateSeriesUrl` in `src/portfolio/core/fiatRatesShared.ts:148`). Query params:
> - `days={N}` for bounded intervals (`1D=1`, `1W=7`, `1M=30`); omitted for `ALL`. `3M`/`1Y`/`5Y` are not fetched — they resolve to `ALL` via `resolveStoredFiatRateInterval(...)` per the canonical-stored-intervals rule.
> - `chain={chain}` ONLY when the asset is a token.
> - `tokenAddress={tokenAddress}` ONLY when the asset is a token.
>
> **Two distinct fetch paths — do not merge them:**
>
> 1. **Native-coin request (batched, multi-coin payload):** `GET /v4/fiatrates/USD?days=1` with no `chain` / `tokenAddress` params. BWS returns a JSON object keyed by coin symbol, e.g., `{btc: {...}, eth: {...}, sol: {...}, ...}`. All native-coin rates for the requested interval come back in **one round trip**. `ensureFresh` calls `loadSeries({coins: missingDefaults})` exactly once per interval/quote per `ensureFresh` invocation to get every native coin needed.
>
> 2. **Token-specific request (individual, per-token):** `GET /v4/fiatrates/USD?days=1&chain=eth&tokenAddress=0xa0b86...` — one request per `(chain, tokenAddress)` tuple. BWS returns a response that may be keyed by the token symbol or may be a single-key object whose key does not match the requested symbol exactly; `extractSeriesFromFiatRatePayload(...)` handles this with a single-value fallback. Tokens cannot be batched into the native-coin call because the endpoint only accepts one `chain`+`tokenAddress` pair per request. `ensureFresh` iterates `missingExplicit` sequentially and swallows per-token errors so one bad token does not abort the batch.
>
> **Asset classification rule (canonical classifier for the v2 rate path):** `getFiatRateAssetRef({currencyAbbreviation, chain, tokenAddress, credentials})` in `src/portfolio/core/pnl/rates.ts:28` is the canonical classifier v2 uses. A kernel-local parity copy also lives in `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts:91` for analysis-side use; that copy is retained (kernel untouched per guardrail #2) but v2 code paths must import from `rates.ts`, not duplicate the logic a third time. Output `FiatRateAssetRef` is `{coin, chain?, tokenAddress?}`:
> - `coin` is always present and normalized to lowercase via `normalizeFiatRateSeriesCoin(...)`.
> - For valid token wallets, `chain` and `tokenAddress` are both populated. Native coins leave both fields `undefined` so they route through path (1) above. The helper tolerates a misbehaving caller that passes `tokenAddress` without `chain`: `normalizeFiatRateSeriesTokenAddress(undefined, raw)` keeps the token address (lowercased) rather than stripping it, so the returned ref is `{coin, tokenAddress: '<lowercased>', chain: undefined}`. The URL/key helpers can then emit a token-address suffix/query without a chain, which BWS may not handle correctly. V2 callers must always supply both fields for tokens.
>
> **Coin-normalization aliases (preserve v1 exactly, `rates.ts:12-26`):**
> - `wbtc` → `btc` (wrapped BTC reuses native BTC rates)
> - `weth` → `eth` (wrapped ETH reuses native ETH rates)
> - `matic` → `pol` / `pol` → `pol` (MATIC rebranded to POL; same native rates)
> - All other coins: `lowercase(currencyAbbreviation)`.
>
> **Legacy ETH-side MATIC token special case (`rates.ts:52-62`):** A wallet whose inputs classify to `chain='eth'`, normalized `coin='pol'`, and `tokenAddress='0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0'` is intentionally reclassified to native POL (`{coin: 'pol'}` with no `chain`/`tokenAddress`), so it routes through the native-coin batched path instead of the generic token-address endpoint. The `coin='pol'` condition matches both incoming `currencyAbbreviation='pol'` and incoming `currencyAbbreviation='matic'` because `normalizeFiatRateSeriesCoin('matic') → 'pol'` — so a ticker-MATIC wallet holding the legacy ERC-20 address is also caught. V2 must keep this reclassification — removing it would push those wallets to a token URL that would return empty/mismatched data.
>
> **Chain + tokenAddress normalization (preserve case-sensitivity rule, `fiatRatesShared.ts:82-109`):**
> - `chain`: lowercase + trim via `normalizeFiatRateSeriesChain(...)`.
> - `tokenAddress`: trim; then **lowercase UNLESS the chain is in `CASE_SENSITIVE_TOKEN_ADDRESS_CHAINS = {'sol', 'solana'}`** — Solana token addresses are base58 and case-distinguishing. V2 must use the same `normalizeFiatRateSeriesTokenAddress(...)` helper (already exported from `fiatRatesShared.ts`) — do not reimplement lowercase-all token-address handling, or Solana token rates will cache-miss against the case-sensitive MMKV key.
>
> **MMKV rate key format (`fiatRateStore.ts:30`, preserve exactly):**
> - Native coin: `rate:v1:${QUOTE}:${coin}:${storedInterval}` (e.g., `rate:v1:USD:btc:1D`).
> - Token: `rate:v1:${QUOTE}:${coin}:${storedInterval}:${chain}:${tokenAddress}` (e.g., `rate:v1:USD:usdc:1D:eth:0xa0b86...`).
> - The token variant extends the base key with `:chain:tokenAddress` suffix via `rateKey(...)`. Persist the same coin entry separately per `(chain, tokenAddress)` when tokens need distinct rates — one USDC ticker may have different on-chain rates per deployment.
>
> **Response-parsing contract (`fiatRateStore.ts:71` / preserved in `extractSeriesFromFiatRatePayload`):**
> - Direct match: response is already a series shape (`{fetchedOn, points}`) or an array of `{ts, rate}` points.
> - Keyed match: response is `{[coin]: series}` — try exact key, then lowercase, then uppercase.
> - Single-key token fallback: for token-specific responses that return a single-key object whose key does not match the requested symbol, use `Object.values(record)[0]` as the candidate. This is common for token endpoints; do not drop it.
>
> **Exchange Rate chart render cap:** Preserve the current `FIAT_RATE_SERIES_TARGET_POINTS = 89` behavior from `src/store/rate/rate.models.ts:49` and `formatExchangeRateChartData(...)` in `src/navigation/wallet/hooks/useExchangeRateChartData.ts`. Raw `rate:v1:*` MMKV series can remain denser for freshness/windowing, but the rendered Exchange Rate chart data array must be downsampled to `<= 89` points before it reaches the graph. The downsampled render series must preserve the resolved first and final window points so the Exchange Rate percentage change uses the same displayed window endpoints as portfolio PnL parity. Reuse the existing downsample primitives from `src/utils/portfolio/rate.ts`; if v2 needs `downsampleExchangeRateSeriesPreservingExtrema(...)` outside the Exchange Rate hook, extract it into a shared utility instead of copying/reimplementing it.
>
> **Dedupe rule for `ensureFresh(coins, assets)` inputs:** `normalizeUniqueFiatRateAssets(coins, assets)` (mirrors `ensureRates`'s dedupe at `fiatRateStore.ts:200-217`) canonicalizes each input via `getFiatRateAssetRef(...)`, keys by `${coin}|${chain || ''}|${tokenAddress || ''}`, and keeps one entry per unique tuple. A caller passing both `coins: ['usdc']` and `assets: [{coin: 'usdc', chain: 'eth', tokenAddress: '0x...'}]` produces two distinct fetch targets — a native USDC batch request AND a token-specific request — because their normalized tuples differ. This is the correct v1 behavior for multi-deployment tokens.
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
>   // The quote in which asset rates are persisted. NOT the user's currently-displayed
>   // quote — that distinction is load-bearing for multi-hop switches (USD → EUR → GBP).
>   // See the canonical-rate-quote rule below.
>   canonicalRateQuoteCurrency: string;
>   targetQuoteCurrency: string;
>   intervals: readonly StoredRateInterval[]; // canonical subset only
> }): Promise<FxBridgeSnapshot>;
> ```
>
> **Canonical rate quote (load-bearing for multi-hop quote switches).**
>
> The bridge always sources from a single stable `canonicalRateQuoteCurrency` — the quote in which asset rate series are persisted under `rate:v1:<QUOTE>:*` — never from whatever quote the user happens to be displaying right now. Otherwise USD → EUR → GBP would either need EUR-quoted asset rate series persisted between hops (which the spec doesn't fetch) or it would compose `bridge(USD→EUR) ∘ bridge(EUR→GBP)` against EUR asset rates that don't exist. Always bridge `canonicalRateQuoteCurrency → targetQuoteCurrency` directly using the formula in Phase 3, regardless of the user's current display quote.
>
> The canonical quote is fixed for a given populate (it's whatever quote `ensureFresh` originally fetched / persisted asset rates under at populate time — typically `'USD'`, but determined by the populate path's quote selection, not by user display preference). Implementations must surface a stable accessor like `getCanonicalRateQuoteCurrencyFromStore()` so triggers, the bridge helper, and the reprice helper all read the same value. Switching the canonical quote is out of scope — it would require re-fetching every asset rate series, which is exactly what the bridge exists to avoid.
>
> Required behavior:
> - Fetch/persist only BTC series for the **target** quote currency and canonical stored intervals (`1D`, `1W`, `1M`, `ALL`). BTC series for the canonical quote are already persisted (they were fetched as part of normal populate).
> - The bridge factor at any timestamp τ is `btcRate(τ, targetQuoteCurrency) / btcRate(τ, canonicalRateQuoteCurrency)`. Both BTC series come from MMKV after the fetch step above.
> - Hand the bridge snapshot to `recomputeQuoteBridgeFromExistingData(...)`, a compute-runtime helper from Phase 3 that re-prices the existing portfolio data into the target quote currency using the per-τ formula.
> - `recomputeQuoteBridgeFromExistingData(...)` may read existing persisted snapshots and persisted asset rate series in `canonicalRateQuoteCurrency` on the compute runtime, but must not fetch per-asset rates in any quote. It is a targeted reprice, not a scalar transform of `sharedPortfolioState`. It is **not** a "shared-state-only" transform — that wording was a correctness loophole because cost basis is built from per-tx-event rate lookups that cannot be reconstructed from a single bridge factor applied to published values. See Phase 3's pinned per-τ rate-lookup formula.
> - Do **not** call `ensureFresh(...)` for every visible asset group on quote switch. The only network work is the BTC-bridge fetch above.
> - Displayed `3M` / `1Y` / `5Y` still derive from `ALL` after the bridge is applied.
> - This bridge path is what allows quote switches to publish correctly without forcing per-asset new-quote fetches and supports arbitrary-length hop chains (USD → EUR → GBP → JPY → ...) because every hop bridges from the same canonical source.
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
> - **Never** change series/row fingerprints, `computedAtMs`, readiness maps, invalid-history maps, `byAssetGroup`, `total`, `totalFingerprint`, `quoteCurrency`, `orderedAssetGroupIdsForAssetList`, or `orderRevision`.
>
> ## Asset-group aggregation (full scope)
>
> For each `assetGroupId = lowercased currencyAbbreviation` in both `inputs.eligibleWallets` and `inputs.populatedWalletIds`, call `buildPnlAnalysisSeriesFromStreamed` with **all wallets for that asset group at once**. This preserves current cross-chain collapse behavior (e.g. USDC across ETH / POL / SOL in one row). Do not sum separately-built per-wallet analysis into a group after the fact.
>
> Snapshot-empty behavior (guardrail #33): `inputs.populatedWalletIds` is the primary readiness filter, but recompute must still tolerate a wallet whose snapshot keys are absent because invalid-history cleanup cleared them or because MMKV was repaired. A wallet snapshot read that returns no valid index/chunks is skipped for that recompute pass: no throw, no zero/negative clamp, no synthetic row. If every wallet in an asset group is skipped this way, omit that asset group's PnL/series for the pass and leave the row unready/error-ready via the invalid-history maps below.
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
> **Shared chart sample grid:** the same interval-window helper also feeds `resolveChartSampleGrid(...)`, which returns at most `MAX_CHART_POINTS` timestamps for renderable chart series. It always includes the resolved first and final window endpoints, then selects intermediate timestamps by reusing the current downsample utilities: `downsampleSeries(...)` / `downsampleTimestamps(...)` from `src/utils/portfolio/rate.ts`. If balance charts need the Exchange Rate chart's "preserve extrema in addition to endpoints" behavior, extract `downsampleExchangeRateSeriesPreservingExtrema(...)` out of `src/navigation/wallet/hooks/useExchangeRateChartData.ts` into a shared utility and use that from both paths. Portfolio recompute runs PnL math over this capped grid directly; it does not compute dense chart points first and downsample afterward. This keeps ALL/5Y recomputes bounded and prevents balance-chart vs Exchange Rate-chart sample drift.
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
> **Transfer/accounting model (load-bearing v1 parity):** for display PnL, every positive wallet balance delta is treated as an inflow / buy and every negative wallet balance delta is treated as an outflow / sell. V18 does **not** identify, net, or exclude transfers between wallets owned by the same user. The formula is intentionally wallet-local: a same-asset movement from user-owned wallet A to user-owned wallet B applies pro-rata disposal in A and adds cost basis in B at the receiving event's rate. The same rule applies to cross-chain moves within the same `assetGroupId` (e.g., USDC on ETH → USDC on Polygon) — outflow on the source chain, inflow on the destination chain, each priced at its own per-chain spot rate at the event timestamp. Aggregate cost basis after such a move can differ from pre-move aggregate basis even though total units are unchanged, because the source's pro-rata disposal removes basis at the source wallet's current window-local average basis while the destination adds basis at the spot rate (see test #3's named same-user transfer fixture for the exact arithmetic). Do not add owned-wallet transfer matching unless product explicitly changes the PnL model.
>
> **Cost-basis method (display PnL, not tax accounting):** v18 uses a window-local average-cost-style remaining basis. At the window baseline, `remainingCostBasisFiat = unitsAtWindowStart * baselineRate`. Inflows add basis at the receiving wallet's asset/rate source spot rate at the event timestamp. Outflows dispose basis pro rata via `remainingCostBasisFiat *= afterUnits / beforeUnits`, equivalent to removing units at the wallet's current window-local average basis. These two phrasings describe the same operation: pro-rata disposal removes `disposedUnits * (currentRemainingCostBasisFiat / currentUnits)`, which is algebraically equivalent to the multiplicative form above. This is not tax-lot accounting, FIFO, LIFO, realized PnL, or historical acquisition-cost tracking.
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
> **Chart-point endpoint invariants (load-bearing for UI scrub parity, guardrail #31):**
> - **First-point `pnlChange = 0` exactly.** At the first emitted series point, step 6 sets `firstTotalUnrealizedPnlFiat = totalUnrealizedPnlFiat`, so `totalPnlChange = totalUnrealizedPnlFiat - firstTotalUnrealizedPnlFiat = 0` by construction. Same for per-wallet and asset-group first points (`pnlChange = pnlEnd - pnlStart` with `pnlEnd === pnlStart` at the first emitted point). The recompute MUST preserve this property — do not add smoothing / interpolation that nudges the first point off zero. The chart's y-axis baseline and the scrubbed "start of window" display both rely on this being exactly zero.
> - **Last-point values match the idle balance header + PnL row byte-for-byte.** For every series (total / wallet / asset-group / key-scoped detail) and every interval, `series.points[last].fiatBalance`, `pnlChange`, and `pnlPercent` are the values the idle chart header + row display. The idle header's big number is `series.points[last].fiatBalance`; the idle PnL subtext below it is formatted from `series.points[last].pnlChange` and `series.points[last].pnlPercent`. There is no separate "idle" compute path — the idle display and the scrubbed-to-last-point display read from the same published point. Required parity test #76 enforces this for all series in the publishable set.
> - **Scope consistency.** The two invariants apply per scope. For Home total, first-point = 0 across total series; last-point equals the Home idle big balance + total PnL subtext. For wallet detail, same per-wallet. For key-scoped detail, same per-key. For asset-group detail, same per-group. Cross-scope equality continues to be enforced by the existing Row/detail equality rule above.
> - **Point cap.** Every emitted balance chart series has `series.points.length <= MAX_CHART_POINTS` (`89`). The compute runtime receives/derives a capped chart sample grid up front: if the resolved window has 89 or fewer sample timestamps, emit them all; if it has more, `resolveChartSampleGrid(...)` selects at most 89 timestamps before PnL math runs, preserving the first and final resolved window endpoints. This applies uniformly to Home total, wallet, account, key-scoped, asset-group detail, and every `scopedByWalletSet` series. Do not compute dense balance-chart arrays and trim them in React — the published render payload itself is capped, and the heavy formula only iterates the capped grid.
>
> ## Quote-switch targeted reprice
>
> Add one compute-runtime helper such as `recomputeQuoteBridgeFromExistingData(args)` and call it **only** from `onQuoteCurrencyChanged(...)`.
>
> **Why this is a reprice, not a transform.** A scalar bridge of published `fiatBalance(t)` is correct because `fiatBalance(t) = units(t) * rate(t)` is linear at a single timestamp. But `remainingCostBasisFiat` accumulates over prior tx events at *different* τ's: `Σ deltaUnits(τ) * rate(τ, quote)`. Each event has its own bridge factor `bridge(τ) = btcRate(τ, newQuote) / btcRate(τ, fromQuote)`, so the new cost basis is **not** equal to `oldCostBasis(t) * bridge(t)` whenever the window contains in-window balance changes. The only correct path is to recompute cost basis with bridge-aware rate lookups at every τ.
>
> Required behavior:
> - Run on the compute runtime. Read existing persisted snapshots (per-tx events) and existing asset rate series in `canonicalRateQuoteCurrency`. **Do not fetch per-asset rates in any quote currency.** The only network input is the BTC bridge series the trigger already fetched via `ensureQuoteCurrencyFxBridge(...)`.
> - Always bridge from `canonicalRateQuoteCurrency` (the persisted-rates quote) to the target quote, regardless of the user's currently-displayed quote. See Phase 2's canonical-rate-quote rule.
> - Use the pinned per-τ rate formula below at every rate lookup the recompute performs — baseline `t0`, every chart sample `ti`, and every in-window balance-change / tx timestamp `τ`.
> - Reprice all global slices, wallet slices, and every bounded `scopedByWalletSet` entry. Preserve readiness / invalid-history / order state; this helper does not change populate eligibility or queue state.
> - Do not consult `loadQueue()` / `queue.doneWalletIds`. Reprice operates on whatever is already populated; the queue is unchanged by a quote switch.
>
> **Pinned per-τ rate-lookup formula (load-bearing for quote-switch correctness, including multi-hop):**
>
> ```
> rate(τ, targetQuote) = assetRate(τ, canonicalRateQuoteCurrency)
>                      * btcRate(τ, targetQuote)
>                      / btcRate(τ, canonicalRateQuoteCurrency)
> ```
>
> Note: `canonicalRateQuoteCurrency` is the stable persisted-rates quote, NOT the user's current display quote. A USD → EUR → GBP chain is two separate `(canonical → target)` bridges (USD → EUR, then USD → GBP), not a composition of consecutive (display → target) bridges. See Phase 2's canonical-rate-quote rule and parity test #101.
>
> This formula must be applied at:
> - **Baseline `t0`** — `baselineRate = rate(t0, targetQuote)` for every wallet's window-start cost basis.
> - **Every chart sample `ti`** — `markRate = rate(ti, targetQuote)` for `fiatBalance(ti)`.
> - **Every in-window balance-change / tx timestamp `τ`** — `rateAtChange = rate(τ, targetQuote)` for cost-basis updates `remainingCostBasisFiat += deltaUnits * rate(τ, targetQuote)`.
>
> A previous version of this plan described `recomputeQuoteBridgeFromExistingData(...)` as a "shared-state-only transform." That wording was a correctness loophole — applying a single bridge factor to published `pnlChange` / `pnlPercent` produces wrong values whenever a window contains in-window txs, because cost basis is path-dependent on per-event rates. The reprice above is the correct contract.
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
> ## Scoped render cache
>
> Heavy `wallet` / `wallets` recompute scopes also materialize a `ScopedPortfolioSlice` for the exact supplied wallet set and store it in `state.scopedByWalletSet[walletIdsKey]`. This cache is the only source for key/account scoped chart series, scoped asset rows, scoped asset order, and key-scoped asset-detail payloads.
>
> - `walletIdsKey = stableWalletIdsKey(walletIds)`; the helper canonicalizes the wallet-id set (dedupe + deterministic sort/join) so equivalent key/account scopes share one cache entry. Callers may compute/pass this scalar, but only the compute runtime builds the scoped payload behind it.
> - Scoped asset-group slices are collapsed by the same `assetGroupId = lowercased currencyAbbreviation` rule as global rows.
> - Scoped `rowToday` / `rowAllTime` are endpoint extractions from the scoped series, so key-scoped All Assets and key-scoped Asset Detail remain byte-for-byte consistent.
> - The cache is bounded by the Phase 3 eviction cap (N=8 by default). Evict least-recently-accessed scoped entries, never the currently requested `walletIdsKey`.
> - JS selectors must treat this as a published render cache: cache hit returns the scoped payload; cache miss returns `undefined` / skeleton-ready state and waits for the mount-triggered recompute. Selectors do **not** aggregate wallets or chart points as a fallback.
>
> ### Scoped cache invalidation / rebuild rules (load-bearing)
>
> When and how each recompute / trigger affects `scopedByWalletSet`:
>
> - **Default on `full` recompute: refresh all currently cached scoped entries** within the same recompute pass, alongside the global rebuild. Bounded by the N=8 cap; rebuilding up to eight scoped slices every full recompute is acceptable and avoids stale scoped screens for surfaces the user recently visited.
> - **Efficiency rule: load global inputs once per recompute pass, then fan into scoped rebuilds.** `recompute(...)` receives `RecomputeInputs` once from the JS-side `buildBaseRecomputeInputs(...)` call (global rates map, wallet-balances map, base wallet maps, etc.). The compute runtime reuses those same inputs for (a) the global rebuild and (b) each cached scoped rebuild within the same pass. Do not re-read rates / snapshots / Redux / MMKV per scoped entry. Eviction fires **after** the full-recompute-refreshes-all step so we never evict an entry we just rebuilt in the same pass.
> - **Visibility rule: mount sites pass visibility-filtered walletIds.** `KeyOverview` / key-scoped `AllAssets` / scoped `AssetBalanceHistoryScreen` derive their `walletIds` from Redux with visibility filters already applied (`hideKeyBalance` / `hideAccount` / `hideWallet` / `hideWalletByAccount` / `hideBalance`). Consequently `walletIdsKey = stableWalletIdsKey(walletIds)` naturally changes when visibility flips — a hide/unhide produces a new cache-miss key and schedules a fresh scoped recompute. Old entries remain in cache under their prior `walletIdsKey` for quick flip-back until LRU eviction. The compute runtime never filters visibility internally at scope level — that concern lives at the caller, same two-set model as `getPopulateEligibleWalletsFromStore()` vs `getEligibleStoredWalletsFromStore()` (guardrail #30).
> - **`wallet` / `wallets` recompute: intersection refresh.** For each cached scoped entry, refresh it iff its `walletIds` set intersects `inputs.scope.walletIds`. Non-intersecting entries are left alone. Same fan-out-from-shared-inputs rule applies.
> - **`onWalletsDeleted(...)` requests scoped eviction via the scheduler, not directly.** `scopedByWalletSet` lives inside `sharedPortfolioState`, so only the compute runtime publishes changes to it (guardrail #22 — no unregistered writers). The trigger passes the deleted walletIds into the tail `scheduleRecompute` inputs (e.g., `scheduleRecompute({scope: 'full', evictScopedWalletIds: walletIds, ...base})`). Inside the compute-runtime `recompute(...)`, the scoped-rebuild step first drops any `scopedByWalletSet[*]` entry whose `walletIds` intersects `inputs.evictScopedWalletIds`, then refreshes the remaining cached entries, then publishes once. Scoped eviction and global `full` rebuild land in the same published `sharedPortfolioState` revision — no intermediate state where global drops the wallet but scoped entries still contain it.
> - **Quote switch: `recomputeQuoteBridgeFromExistingData(...)` reprices every cached scoped entry.** Already pinned earlier in Phase 3 — applies the per-τ bridge formula to global slices, wallet slices, and every `scopedByWalletSet[*]` entry uniformly using the same persisted snapshot/rate inputs the original recompute used. Non-bridged scoped entries would drift from global state and violate cross-screen consistency.
> - **Cache miss is always skeleton + scheduled recompute, never synchronous JS aggregation.** Guardrail #32 forbids the fallback path. Selectors return `undefined` on miss; the UI shows skeleton-ready state; the mount-site `scheduleRecompute({scope: {kind: 'wallets', walletIds}, ...base})` publishes the scoped entry asynchronously.
> - **Singleton rule: route type decides, not wallet count.** `WalletDetails` is the one route that is singleton-by-design — it always renders a single walletId and reads `byWallet[walletId]` directly. It does NOT write to `scopedByWalletSet` even though conceptually it's a scope-of-one. Every other scoped route — `KeyOverview`, EVM `AccountDetails`, key-scoped `AllAssets`, key-scoped `AssetBalanceHistoryScreen` — always uses the scoped cache, even when the effective wallet count is 1 (e.g., a key with one visible wallet after visibility filtering, or an EVM account with a single wallet under it). Route uniformity trumps the micro-optimization of falling back to `byWallet` on singleton scopes: the mount path is the same, the scoped-cache read is O(1) either way, and implementation stays consistent across visibility changes that push a multi-wallet scope down to one wallet and back.
>
> ## Reuse-by-reference
>
> Same fingerprint as prev → reuse prev reference.
>
> ## Readiness maps
>
> Build both `populatedWalletIdsById` (O(1) membership) and `populatedWalletIdsKey` (scalar signature). Same for asset groups. Selectors use `*ById`.
>
> Also build invalid-history status maps from `inputs.invalidHistoryWalletIds`: `invalidHistoryWalletIdsById` / `invalidHistoryWalletIdsKey` and `invalidHistoryAssetGroupIdsById` / `invalidHistoryAssetGroupIdsKey`. These maps are render metadata, not PnL math inputs. They let UI selectors distinguish "not ready yet" from "populate-blocked by active invalid-history marker" without reading the populate queue or MMKV during render. Scoped entries build the same invalid-history maps restricted to their `walletIds` set.
>
> Asset-group invalid-history derivation is **all-blocked, not any-blocked**: `invalidHistoryAssetGroupIdsById[groupId] === true` iff every wallet that would contribute to that asset group in the current visible scope is present in `invalidHistoryWalletIdsById`. Partial blockage leaves the group out of the blocked map and publishes PnL/series from the valid subset. Example: one corrupted Polygon USDC wallet must not make the whole collapsed USDC row error-ready if Ethereum/Solana USDC wallets have valid snapshots.
>
> ## Eviction (soft cap N=8)
>
> Post-wallet-scope writes. Current scope's walletIds / `walletIdsKey` protected. Soft — if protected set > 8, result > 8. Applies to `scopedByWalletSet` as well as wallet-scope caches.
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
> - `invalidHistoryWalletIds`: union.
> - **`orderedAssetGroupIdsForAssetList` + `orderRevision`: take whichever pair has higher `orderRevision`.** Equal: equivalent content, take either.
> - **`evictScopedWalletIds`: union across pending work.** Multiple triggers coalesced into one drain (e.g., two consecutive `onWalletsDeleted` calls) accumulate their evict sets so the drain's scoped-rebuild step drops every intersecting entry in one pass. Dedupe while accumulating. Undefined / empty `evictScopedWalletIds` on incoming leaves the accumulated set unchanged.
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
> export function selectIsAssetGroupInvalidHistoryBlocked(s, assetGroupId): boolean;
> export function selectIsWalletInvalidHistoryBlocked(s, walletId): boolean;
> export function selectHasAnyPopulatedWallets(s): boolean;
> export function selectOrderedAssetGroupIds(s): readonly string[];
> export function selectAllocationRows(s): readonly AllocationRow[];
> export function stableWalletIdsKey(walletIds: readonly string[]): string;
> export function selectKeySeries(s, walletIdsKey, tf): Series | undefined;
> export function selectScopedAssetGroupSeries(s, walletIdsKey, assetGroupId, tf): Series | undefined;
> export function selectScopedAssetGroupRows(s, walletIdsKey, mode): readonly RowPayload[];
> export function selectScopedOrderedAssetGroupIds(s, walletIdsKey): readonly string[];
> export function selectScopedIsAssetGroupInvalidHistoryBlocked(s, walletIdsKey, assetGroupId): boolean;
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
> ### Typed route-scope descriptor
>
> `src/portfolio/v2/routeScope.ts`:
>
> ```ts
> // Single typed taxonomy for every route that reads portfolio data. Mount sites
> // build one of these from props/Redux, then resolve it JS-side into the
> // visibility-filtered walletIds + walletIdsKey the selectors actually consume.
> // The compute runtime never receives a PortfolioRouteScope — it receives
> // resolved walletIds (see guardrail #32 / scoped-cache rules in Phase 3).
> export type PortfolioRouteScope =
>   | { kind: 'home' }
>   | { kind: 'wallet'; walletId: string }
>   | { kind: 'key'; keyId: string }
>   | { kind: 'account'; accountId: string }
>   | { kind: 'assetGroup'; assetGroupId: string }
>   | { kind: 'keyAssetGroup'; keyId: string; assetGroupId: string }
>   | { kind: 'accountAssetGroup'; accountId: string; assetGroupId: string };
>
> export type ResolvedRouteScope = Readonly<{
>   scope: PortfolioRouteScope;
>   // Visibility-filtered walletIds. Mount sites apply hideKeyBalance /
>   // hideAccount / hideWallet / hideWalletByAccount / hideBalance before
>   // calling resolve. Empty array is a valid resolved scope (skeleton state).
>   walletIds: readonly string[];
>   walletIdsKey: string;                // stableWalletIdsKey(walletIds)
>   assetGroupId?: string;
> }>;
>
> // Pure JS resolver. Reads Redux via reduxAccess accessors, applies visibility
> // filters at the caller (mount-site) layer, and returns the resolved scope.
> // Does not write to sharedPortfolioState, does not call scheduleRecompute.
> export function resolvePortfolioRouteScope(
>   scope: PortfolioRouteScope,
> ): ResolvedRouteScope;
> ```
>
> Mount sites construct the scope, resolve it, then call `scheduleRecompute({scope: {kind: 'wallets', walletIds: resolved.walletIds}, ...base})` for non-singleton routes (every scope kind except `'home'` and `'wallet'`; the singleton-rule exception in Phase 3 still applies).
>
> ### Hook façades
>
> `src/portfolio/v2/hooks/usePortfolioChart.ts`, `usePortfolioAssetRows.ts`, `usePortfolioStatus.ts`. Thin wrappers over `usePortfolioSlice` so screens read uniformly without growing bespoke selector orchestration:
>
> ```ts
> // Returns the Series for a resolved scope + interval. For `home` / `wallet`
> // singletons, reads global slices directly; for every other scope, reads
> // the bounded scopedByWalletSet[walletIdsKey] entry. Cache miss returns
> // undefined (skeleton-ready); the mount site is responsible for kicking
> // the scheduleRecompute that publishes the scoped entry.
> export function usePortfolioChart(
>   resolved: ResolvedRouteScope,
>   interval: Interval,
> ): Series | undefined;
>
> // Returns rows for a resolved scope. `mode` is 'today' | 'allTime'.
> export function usePortfolioAssetRows(
>   resolved: ResolvedRouteScope,
>   mode: 'today' | 'allTime',
> ): readonly RowPayload[] | undefined;
>
> // Returns whichever readiness/error-ready/refreshing state the surface needs.
> // Internally composes selectIsAssetGroupReady / selectHasAnyPopulatedWallets /
> // useIsPortfolioRefreshing as appropriate.
> export function usePortfolioStatus(
>   resolved: ResolvedRouteScope,
> ): { ready: boolean; refreshing: boolean; invalidHistoryBlocked: boolean };
> ```
>
> These façades exist so screens don't reach for `usePortfolioSlice` + bespoke selector composition every time — the Phase 8 deletion target is "no per-screen orchestration hooks," and these façades are the v2 replacement surface.
>
> Tests cover: façade output equals direct selector output for the same scope; scope resolution applies visibility filters correctly; cache-miss returns `undefined` without crashing.
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
> **Scoped aggregation strategy (explicit, not hand-waved):** selectors are cache lookups only. `stableWalletIdsKey(walletIds)` may build the scalar key from the route's wallet ids via dedupe + deterministic sort/join, but `selectKeySeries`, `selectScopedAssetGroupSeries`, `selectScopedAssetGroupRows`, and `selectScopedOrderedAssetGroupIds` only read `state.scopedByWalletSet[walletIdsKey]` and return already-published series/rows/order. They must not iterate `state.byWallet`, sum wallet rows, walk `Series.points`, rebuild collapsed asset groups, or calculate PnL on the JS thread. Cache miss means "not ready yet" until `scheduleRecompute({scope: {kind: 'wallets', walletIds}, ...base})` publishes the scoped entry.

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
> // Telemetry-only; classifies why the queue was last *rebuilt* via `buildQueue`.
> // Used by log tags and Sentry breadcrumbs so production populate behavior can
> // be diagnosed without inferring from which trigger fired. NOT consulted by
> // any business logic — populate ordering, eligibility, and recompute behavior
> // are all independent of `reason`.
> //
> // SCOPE: rebuild paths only. Append paths (`appendToQueue` / `populateWallet` /
> // `populateWallets`) do NOT update `reason` — they don't rebuild the queue, so
> // there is nothing to relabel. The "last kick reason" is implicit in the
> // populate-progress publish path and does not need a separate field.
> //
> // Rebuild paths are limited to `startPopulate(...)`-style cold/fresh kicks:
> //   - `'initial'`              — first-ever populate after install / clear
> //   - `'appLaunchIncremental'` — post-auth `maybeResumePopulateOnLaunch` rebuilt
> //                                 the queue because the wallet set changed
> //                                 across sessions (key imported between launches,
> //                                 etc.). Pure resume of an unchanged queue does
> //                                 NOT rebuild and does NOT update `reason`.
> //   - `'showPortfolioToggleOn'` — fresh populate after Show Portfolio re-enable
> //   - `'manual'`               — debug screen or other explicit force-rebuild path
> //
> // If a future kick path needs telemetry granularity that's *not* rebuild-shaped
> // (e.g., per-send breadcrumbs), add a separate event/log tag at the kick site
> // rather than extending this enum and updating it from append paths.
> type PopulateQueueReason =
>   | 'initial'
>   | 'appLaunchIncremental'
>   | 'showPortfolioToggleOn'
>   | 'manual';
>
> type PopulateQueueV1 = {
>   schemaVersion: 1;
>   reason: PopulateQueueReason;        // telemetry only; see PopulateQueueReason comment
>   remainingWalletIds: readonly string[];
>   doneWalletIds: readonly string[];
>   // Wallets skipped because an active invalid-history marker exists or because
>   // this populate run just detected negative running balance. Not readiness.
>   invalidHistoryWalletIds: readonly string[];
>   orderedAssetGroupIdsForAssetList: readonly string[];
>   orderRevision: number;               // monotonic across queue rebuilds
>   startedAt: number;
>   cfg: BwsConfig;
>   ingest: SnapshotIngestConfig;
>   pageSize: number;
> };
>
> // INVARIANT (guardrail #29): args.eligibleWallets MUST be `getPopulateEligibleWalletsFromStore()`
> // — livenet-only, visibility-IGNORED. Do NOT pass `getEligibleStoredWalletsFromStore()` here
> // (that set is visibility-respecting; using it would mean hidden wallets never get populated and
> // unhide would have populate-latency). `buildQueue` itself does not re-filter; callers are
> // authoritative for supplying the correct candidate set. Every populate-construction site in v2
> // reads through `getPopulateEligibleWalletsFromStore()`.
> export function buildQueue(args: {
>   eligibleWallets: readonly StoredWallet[];
>   rates: Record<string, number>;
>   balancesByWalletId: Record<string, bigint>;
>   cfg: BwsConfig;
>   ingest: SnapshotIngestConfig;
>   pageSize: number;
>   reason: PopulateQueueReason;          // telemetry only; see type comment
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
>     reason: args.reason,
>     remainingWalletIds: walletIdsInOrder,
>     doneWalletIds: [],
>     invalidHistoryWalletIds: [],
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
> // markDone moves walletId from remainingWalletIds to doneWalletIds and removes any
> // stale invalidHistoryWalletIds entry for that walletId. It MUST NOT touch
> // orderRevision — readiness/status changes are not order mutations.
> export function markDone(walletId: string): void;
>
> // Invalid-history skip removes the wallet from remainingWalletIds and doneWalletIds
> // (if present) and records it separately; it MUST NOT append to doneWalletIds
> // because the wallet is not populated/ready. It preserves orderedAssetGroupIdsForAssetList
> // so the row can remain visible with skeleton/error-ready state instead of disappearing.
> export function markSkippedInvalidHistory(walletId: string): void;
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
>     return {
>       ...(parsed as PopulateQueueV1),
>       // Forward-compatible dev migration within schemaVersion 1: queues written
>       // before invalid-history status existed normalize to "no skipped wallets"
>       // instead of being treated as corrupt.
>       invalidHistoryWalletIds: Array.isArray(parsed.invalidHistoryWalletIds)
>         ? parsed.invalidHistoryWalletIds
>         : [],
>       // Forward-compatible dev migration within schemaVersion 1: queues written
>       // before `reason` existed normalize to 'manual' (the most neutral telemetry
>       // tag) instead of being treated as corrupt. `reason` is telemetry-only so
>       // a stale 'manual' tag has no behavioral consequence.
>       reason:
>         parsed.reason === 'initial' ||
>         parsed.reason === 'appLaunchIncremental' ||
>         parsed.reason === 'showPortfolioToggleOn' ||
>         parsed.reason === 'manual'
>           ? parsed.reason
>           : 'manual',
>     };
>   } catch (err) {
>     logOnce('loadQueue: parse error ' + String(err));
>     return null;
>   }
> }
> ```
>
> Treating invalid version or parse error as null causes populate to fall back to fresh queue on next kick — same recovery path as "no queue exists." Safest behavior for future schema migrations or persisted corruption. `logOnce` deduplicates per-message-per-session so a recurring invalid queue doesn't spam logs.
>
> Two narrow schemaVersion-1 forward-compatible normalizations are allowed because both fields default safely and neither affects populate ordering, eligibility, or recompute math:
>
> 1. **Missing `invalidHistoryWalletIds`** — defaults to `[]` (empty). Only affects in-flight queue status display.
> 2. **Missing or unknown `reason`** — defaults to `'manual'` (the most neutral telemetry tag). `reason` is telemetry-only per its type comment; a stale `'manual'` tag has no behavioral consequence.
>
> Any future required persisted field that affects business logic (populate eligibility, queue ordering, recompute inputs, etc.) must bump `schemaVersion` instead of adding more silent migrations. The schema-version validation tests below cover both normalizations explicitly.
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
>   const keptInvalidHistory = (queue.invalidHistoryWalletIds ?? [])
>     .filter(id => currentEligibleWalletIds.has(id));
>   const dropped = [
>     ...queue.remainingWalletIds,
>     ...queue.doneWalletIds,
>     ...(queue.invalidHistoryWalletIds ?? []),
>   ]
>     .filter(id => !currentEligibleWalletIds.has(id));
>
>   if (dropped.length === 0) return;
>
>   const stillHeldAssetGroupIds = new Set<string>();
>   for (const walletId of [...keptRemaining, ...keptDone, ...keptInvalidHistory]) {
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
>     invalidHistoryWalletIds: keptInvalidHistory,
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
>       const invalidHistoryMarker = await loadWorkletInvalidHistoryMarker(walletId);
>       if (isSnapshotInvalidHistoryMarkerActive(invalidHistoryMarker)) {
>         // V1 parity: active negative-balance marker suppresses auto-populate
>         // until retryAfter. Remove from remaining, but do NOT mark populated.
>         markSkippedInvalidHistory(walletId);
>         populateProgressTick.value = populateProgressTick.value + 1;
>         continue;
>       }
>
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
>       try {
>         await drivePopulateForWallet({
>           walletId,
>           walletSummary: walletCtx.summary,
>           walletCredentials: walletCtx.credentials,
>           signingContext: signingCtx,
>           cfg: queue.cfg,
>           ingest: queue.ingest,
>           pageSize: queue.pageSize,
>         });
>       } catch (error) {
>         if (isSnapshotInvalidHistoryError(error)) {
>           // Existing v1 handlers save `snap:invalid-history:v1:<walletId>`
>           // and clear this wallet's snapshots with preserveInvalidHistoryMarker.
>           // V2 queue handling must continue to the next wallet rather than
>           // immediately retrying this corrupted history forever.
>           markSkippedInvalidHistory(walletId);
>           populateProgressTick.value = populateProgressTick.value + 1;
>           continue;
>         }
>         throw error;
>       }
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
> **Invalid-history / negative-balance contract (v1 parity, guardrail #33):**
> - Preserve the existing kernel behavior that first tries `reorderTxBatchToPreventUnderflow(...)` for txs in the same fetched group, then throws `createNegativeBalanceInvalidHistoryError(...)` if the running balance still goes negative.
> - `handleProcessNextPageOnPopulateWorklet(...)` and `handleFinishWalletOnPopulateWorklet(...)` already catch invalid-history errors, write `snap:invalid-history:v1:<walletId>` via `toSnapshotInvalidHistoryMarker(...)` / `saveWorkletInvalidHistoryMarker(...)`, clear wallet snapshots via `clearWorkletWalletSnapshots(... {preserveInvalidHistoryMarker: true})`, delete the worklet session, and rethrow. V2 must not bypass those handlers or swallow the error before the marker is saved.
> - `runPopulate(...)` catches `isSnapshotInvalidHistoryError(error)` after `drivePopulateForWallet(...)`, calls `markSkippedInvalidHistory(walletId)`, bumps `populateProgressTick`, and continues with the next wallet. It must **not** call `markDone(walletId)` for this wallet and must **not** leave it at the head of `remainingWalletIds`, otherwise the loop will retry the same corrupted tx history forever.
> - Before starting a wallet, `runPopulate(...)` checks the wallet's marker. If `isSnapshotInvalidHistoryMarkerActive(marker)` is true, skip the wallet the same way: remove from remaining, record in `invalidHistoryWalletIds`, do not mark done, and continue. If the marker is expired, the wallet is eligible to retry on the next populate trigger.
> - A later successful `handleFinishWalletOnPopulateWorklet(...)` clears the invalid-history marker. Full portfolio wipes / Show Portfolio off / key deletion delete the marker with the rest of `snap:*`; metadata/index resets that are part of retry preserve the marker until success.
> - Recompute never publishes negative running balances. Wallets skipped for active invalid history have no valid snapshots and are omitted from PnL math/readiness until a later successful populate; their asset-list row can remain visible from canonical order with skeleton/error-ready right-side state, but their corrupted data must not be clamped into a valid-looking chart.
> - While an invalid-history marker is active, that wallet is treated as **populate-blocked**, not still-pending. It is excluded from first-populate chart-gate denominators so one corrupted wallet does not hide every Home / Account / Key chart indefinitely after the other eligible wallets have published valid snapshots. It is also not counted as populated/ready. When the marker expires, a later populate trigger may append it again; successful finish clears the marker and moves the wallet back into normal readiness.
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
>   // POPULATE-SIDE reconcile — visibility-IGNORED so hidden livenet wallets
>   // remain queued and populate warm data for unhide (guardrails #29–30).
>   reconcileQueueAgainstEligible(getPopulateEligibleWalletIdSetFromStore());
>   buildAndSaveQueue(args);
>   populateCancelFlag.value = false;              // clear cancel BEFORE kick
>   const ctx = buildPopulateRuntimeContextFromStore();
>   runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>     .catch(err => logPortfolioRuntimeError(err));
> }
>
> export function populateWallet(walletId: string): void {
>   if (!canRunPortfolioV2Work()) return;
>   // Livenet filter (guardrail #29). No-op for testnet / regtest wallets.
>   const w = getStoredWalletByIdFromStore(walletId);
>   if (!w || !isLivenetWallet(w)) return;
>   // POPULATE-SIDE reconcile — visibility-IGNORED (guardrails #29–30).
>   reconcileQueueAgainstEligible(getPopulateEligibleWalletIdSetFromStore());
>   appendToQueue(walletId);
>   populateCancelFlag.value = false;
>   const ctx = buildPopulateRuntimeContextFromStore();
>   runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>     .catch(err => logPortfolioRuntimeError(err));
> }
>
> export function populateWallets(walletIds: string[]): void {
>   if (!canRunPortfolioV2Work()) return;
>   // Livenet filter (guardrail #29). Testnet / regtest walletIds are dropped silently
>   // before reaching `appendToQueue`. Callers may pass mixed lists (e.g., an imported
>   // key's walletIds include both); this helper does the filtering.
>   const livenetIds = walletIds.filter(id => {
>     const w = getStoredWalletByIdFromStore(id);
>     return !!w && isLivenetWallet(w);
>   });
>   if (!livenetIds.length) return;
>   // POPULATE-SIDE reconcile — visibility-IGNORED (guardrails #29–30), same as
>   // `startPopulate` and `populateWallet` above. Prunes deleted / non-livenet
>   // walletIds from the queue without pruning hidden ones.
>   reconcileQueueAgainstEligible(getPopulateEligibleWalletIdSetFromStore());
>   for (const id of livenetIds) appendToQueue(id);   // each append is idempotent per the contract below
>   populateCancelFlag.value = false;
>   const ctx = buildPopulateRuntimeContextFromStore();
>   runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ctx)
>     .catch(err => logPortfolioRuntimeError(err));
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
> **`appendToQueue(walletId)` / `populateWallets(walletIds)` idempotency contract (load-bearing):**
> - **Dedupe scope.** `appendToQueue(walletId)` dedupes against `queue.remainingWalletIds` and `queue.doneWalletIds`. `invalidHistoryWalletIds` is different: it records populate-blocked wallets, not successful readiness. **Non-idempotent retry seam:** `appendToQueue(B)` when `B ∈ invalidHistoryWalletIds` intentionally moves B out of `invalidHistoryWalletIds` and into `remainingWalletIds` so `runPopulate` can re-check the persisted marker. If the marker is still active, `runPopulate` re-skips B without fetching; if the marker expired, B retries. A walletId the populate loop is *currently processing* remains in `remainingWalletIds` until `markDone(walletId)` moves it to `doneWalletIds` at the end of its lifecycle. Therefore a `populateWallets([X])` call during active processing of X is an idempotent no-op against `remainingWalletIds`, and a `populateWallets([Y])` call after Y was already marked done is an idempotent no-op against `doneWalletIds`. No duplicate append in either case.
> - **`orderRevision` rule.** `appendToQueue` does NOT bump `orderRevision` when the resulting set of walletIds (remaining ∪ done) is unchanged. It advances `orderRevision` by exactly one only when a genuinely new walletId is added that extends the ordering. Matches the `buildQueue` monotonicity invariant (guardrail #14).
> - **Kick semantics.** `populateWallets(walletIds)` is the correct "kick the existing reconciled queue" helper when callers pass walletIds already in the queue (e.g., `onWalletsDeleted`'s post-reconcile survivors). It is NOT a "rebuild the queue from these ids" helper — pass walletIds that belong in the current queue, not a fresh replacement set. Passing exclusively already-queued ids is strictly "clear cancel flag + runPopulate kick," which is the semantic `onWalletsDeleted`, `onSendCompleted`, and `onPullToRefresh` all rely on. Callers that want a fresh queue go through `startPopulate({isFirstPopulate: true, ...})` → `buildAndSaveQueue`, not `populateWallets`.
> - **Single-flight interaction.** `populateWallets(...)` clears `populateCancelFlag` and dispatches `runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ...)`. The populate loop is single-flight guarded by `populateLoopRunning` (guardrail #15), so a kick during an already-running loop is a no-op inside `runPopulate` (parity test #15). The kick is therefore always safe to call after `appendToQueue`, whether the loop is running or idle.
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
>   const invalidHistoryWalletIds = queue?.invalidHistoryWalletIds ?? [];
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
>     invalidHistoryWalletIds,
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
> `PORTFOLIO_V2` on: hook `onAppLaunchPostAuth(...)` to the **specific post-auth Redux action/event identified in Phase 0 item #13** — the dispatch that fires only after the PIN / biometric gate clears on launch, not app init and not store rehydration.
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
>
>   // POST-AUTH ORDER (load-bearing for "completed PnL appears immediately on
>   // resume" — see required parity test "post-auth no-network publish"):
>   //   1. Warm publish from already-persisted snapshots/rates so completed
>   //      wallets render at first frame.
>   //   2. AWAIT the warm publish to actually land. The drain is bounded and
>   //      non-networked (MMKV reads + math; no fetches), so its latency scales
>   //      with portfolio size but is independent of network availability.
>   //      Without this await, scheduleRecompute is
>   //      fire-and-forget, and the populate kick at step 3 races the warm
>   //      publish: populate writes to `snap:*` and bumps populateProgressTick,
>   //      which can trigger another recompute before the warm one publishes.
>   //      The "completed PnL visible before populate starts" requirement
>   //      needs the warm publish to be *committed*, not just *scheduled*.
>   //   3. Resume populate so any pending wallets continue.
>   //   4. Background freshen rates and schedule a follow-up recompute when
>   //      fresh rates land. NOT awaited here — awaiting blocks reveal on a
>   //      network round trip.
>   //
>   // This is the ONE trigger that flips the usual "ensureFresh first, then
>   // recompute" order. See Phase 6's per-trigger ordering table for why every
>   // other trigger keeps the original order.
>   const quote = getQuoteCurrencyFromStore();
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({ ...base, scope: 'full' });   // (1) schedule warm publish
>   await waitForRecomputeDrainToStop();             // (2) await the warm publish to land
>   if (!canRunPortfolioV2Work()) return;            // re-check after the await
>   maybeResumePopulateOnLaunch();                   // (3) resume populate
>   runBackgroundFreshenAndRefresh({quote});         // (4) background freshen — not awaited
> }
>
> /**
>  * Guarded background freshen path. Same in-flight tracking, error logging, and
>  * canRunPortfolioV2Work re-checks as any other ensureFresh caller — just not
>  * awaited at the trigger boundary so the warm reveal isn't blocked. Used by
>  * onAppLaunchPostAuth and any future trigger that wants "show what we've got
>  * now, refresh in the background" semantics.
>  *
>  * `inFlightCount` inside ensureFresh still increments/decrements normally, so
>  * `waitForEnsureFreshToStop` (third wait in performResetSequence's Promise.all)
>  * still observes this work — a reset that fires while a background freshen is
>  * in flight blocks the wipe until the freshen settles, exactly like an awaited
>  * ensureFresh would.
>  */
> function runBackgroundFreshenAndRefresh(args: { quote: string }): void {
>   void (async () => {
>     try {
>       if (!canRunPortfolioV2Work()) return;
>       await ensureFresh(
>         buildEnsureFreshArgsForVisibleAssetGroups({ quoteCurrency: args.quote }),
>       );
>       if (!canRunPortfolioV2Work()) return;
>       const refreshed = buildBaseRecomputeInputs({
>         quote: args.quote,
>         wallets: getEligibleStoredWalletsFromStore(),
>         rates: getLiveRatesByAssetIdFromStore(),
>         ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>       });
>       scheduleRecompute({ ...refreshed, scope: 'full' });
>     } catch (err) {
>       logPortfolioRuntimeError(err, { tag: 'postAuthBackgroundFreshen' });
>     }
>   })();
> }
>
> export function onSendCompleted(args: { walletId: string }): void {
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   // `populateWallet` internally filters testnet walletIds to no-op per guardrail #29.
>   populateWallet(args.walletId);
> }
>
> export function onKeyImported(args: { key: Key }): void {
>   // Wired from the `WalletActionTypes.SUCCESS_IMPORT` action (Phase 0 inventory item #4).
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   if (!getShowPortfolioEnabledFromStore()) return; // Show Portfolio off ⇒ import does nothing portfolio-side
>   // Filter the imported key's wallets to livenet only (guardrail #29). Testnet wallets
>   // in the same key are silently dropped — they are not portfolio-eligible. `populateWallets`
>   // also filters livenet internally, so this filter is belt-and-suspenders; doing it here
>   // keeps the trigger contract obvious to readers.
>   const livenetWalletIds = (args.key.wallets ?? [])
>     .filter(isLivenetWallet)
>     .map(w => w.walletId);
>   if (!livenetWalletIds.length) return;        // e.g. testnet-only imported key
>   populateWallets(livenetWalletIds);           // kick populate via normal kick helper (reconcile + append + runPopulate)
>   // No immediate scheduleRecompute — initial populate's progressive publish will update UI
>   // as wallets finish, same as any other first-time populate.
> }
>
> export function onWalletsVisibilityChanged(args: {
>   affectedWalletIds: readonly string[];        // walletIds whose effective visibility flipped (hide OR unhide)
> }): void {
>   // Wired from every Redux action that mutates hideKeyBalance / hideAccount /
>   // hideWallet / hideWalletByAccount / hideBalance (Phase 0 inventory item #4).
>   // The caller (the middleware or effect) resolves which walletIds were affected by
>   // the action and passes only those — this trigger does not re-derive the delta.
>   if (!canRunPortfolioV2Work()) return;        // GUARD
>   if (!getShowPortfolioEnabledFromStore()) return;
>   const walletIds = Array.from(new Set(args.affectedWalletIds ?? []));
>   if (!walletIds.length) return;
>
>   // "Populated-late" edge case (guardrail #30): a livenet wallet whose import
>   // landed during a populate-blocked window (Show Portfolio off, reset in flight,
>   // or cache-invalid latched) has no MMKV snapshot data because `onKeyImported`
>   // was a no-op at the time. If any affected wallet is now visible AND not in
>   // `queue.doneWalletIds`, kick populate for it. This path is also safe when
>   // data IS warm — `populateWallets` is idempotent against already-queued or
>   // already-done walletIds per the Phase 5 idempotency contract.
>   const queue = loadQueue();
>   const doneSet = new Set(queue?.doneWalletIds ?? []);
>   const nowVisibleUnpopulated = walletIds.filter(id => {
>     if (!isWalletVisibleInStore(id)) return false;
>     const w = getStoredWalletByIdFromStore(id);
>     return !!w && isLivenetWallet(w) && !doneSet.has(id);
>   });
>   if (nowVisibleUnpopulated.length) {
>     populateWallets(nowVisibleUnpopulated); // guardrail #29-filtered internally too
>   }
>
>   // Republish state with the new visibility-filtered eligible set. Hidden wallets
>   // drop out of `byWallet` / totals / series because `getEligibleStoredWalletsFromStore()`
>   // now excludes them; unhidden wallets reappear because they're back in that set and
>   // their populate data is already warm (or is being populated per above).
>   const quote = getQuoteCurrencyFromStore();
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(), // visibility-respecting (guardrail #30)
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   scheduleRecompute({ ...base, scope: 'full' });  // full scope so Home/All-Assets/Allocation/KeyOverview all update
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
>   if (!canRunPortfolioV2Work()) return;            // GUARD #1 — literal first executable statement per guardrail #21. Reset/repair wipes these anyway.
>   const walletIds = Array.from(new Set(args.walletIds ?? []));
>   if (!walletIds.length) return;
>
>   cancelPopulate();
>   await waitForPopulateLoopToStop();               // same primitive `performResetSequence` uses
>
>   // GUARD #2 — reset or cache-invalid state can flip during the wait above
>   // (an overlapping `performResetSequence` call, a debug-clear, a post-auth
>   // repair, etc.). Mirrors the post-await re-check `ensureFresh` performs
>   // after its own network fetch resolves, before `persistRates`.
>   if (!canRunPortfolioV2Work()) return;
>
>   // Reuse the existing queue reconciliation primitive — do NOT introduce a
>   // second queue-prune implementation. Redux's `WalletActionTypes.DELETE_KEY`
>   // reducer has already applied by the time this middleware-dispatched
>   // trigger runs, so both `getCurrentEligibleWalletIdSetFromStore()` and
>   // `getPopulateEligibleWalletIdSetFromStore()` exclude the deleted walletIds.
>   // Use the POPULATE-SIDE set here (guardrails #29–30): the queue is a
>   // populate artifact, and using the visibility-ignored set ensures any
>   // currently-hidden livenet wallets remain queued. `reconcileQueueAgainstEligible`
>   // then prunes `remainingWalletIds` / `doneWalletIds` / `orderedAssetGroupIdsForAssetList`
>   // and bumps `orderRevision` iff order changed — same semantics populate
>   // kicks use (see Phase 5 / guardrail #12).
>   reconcileQueueAgainstEligible(getPopulateEligibleWalletIdSetFromStore());
>
>   // Use the existing kernel API — `SnapshotStore.clearWallet(walletId)` —
>   // which deletes each wallet's `snap:*` keys through `kvStore.delete` +
>   // registry bookkeeping. See `snapshotStore.ts:509` and
>   // `mmkvKvStore.ts:193`. Parity with v1's serialized `client.clearWallet(...)`
>   // path, minus the deleted v1 runtime/serialQueue layer. `rate:v1:*` keys
>   // are intentionally NOT touched: they are `(coin, quote, interval)`-scoped
>   // and still valid for the surviving wallet set.
>   //
>   // Reset-wait-set carve-out (guardrail #22 exception): these clears are
>   // deliberately NOT observed by `performResetSequence`'s `Promise.all` (no
>   // `waitForWalletClearsToStop()`). Rationale: the clears are (a) delete-only
>   // — they never publish shared state or write any non-delete MMKV entry,
>   // (b) idempotent under `kvStore.delete` + registry, (c) scoped to walletIds
>   // that Redux's `DELETE_KEY` reducer has already removed from the eligible
>   // set, and (d) a strict subset of what a concurrent `performResetSequence`
>   // wipe would delete anyway via `wipePortfolioMmkvKeys` (all `snap:*`).
>   // Therefore a race produces at worst a redundant delete — never a stale
>   // write landing after a reset. The third guard below ensures we don't
>   // schedule any new work if reset flipped during this await.
>   //
>   // Known partial-progress failure mode (intentionally tolerated): internally
>   // `snapshotStore.clearWallet(walletId)` reads the wallet's index before
>   // iterating chunk keys (see `snapshotStore.ts:513-523`). If a concurrent
>   // `wipePortfolioMmkvKeys` deletes the index key first, our `readIndexCached`
>   // can return null (or a stale cached index) and we may skip the per-chunk
>   // delete loop (or try to delete already-deleted keys — both are no-ops).
>   // This means our clear may leave some chunks undeleted in the interleaved
>   // case. Acceptable because: (i) the concurrent wipe itself deletes every
>   // `snap:*` key including those chunks by prefix iteration, so the final
>   // state converges; (ii) the durable `portfolio:v2:cacheInvalid` bit set
>   // by `markPortfolioCacheInvalid()` within the reset blocks ordinary v2
>   // work until a successful repair wipe clears the bit — so even a
>   // pathological leftover is cleaned up by the next post-auth repair path
>   // before any consumer sees it. Full wipe/repair remains authoritative.
>   await Promise.all(walletIds.map(id => snapshotStore.clearWallet(id)));
>
>   // GUARD #3 — reset/cache-invalid can flip during the `Promise.all` above,
>   // just like during `waitForPopulateLoopToStop()`. This check matches the
>   // post-await discipline `ensureFresh` uses before `persistRates`, and
>   // prevents any follow-on scheduling (recompute, populate kick) from
>   // racing with a concurrent reset even though the clears themselves are
>   // safe under the carve-out above.
>   if (!canRunPortfolioV2Work()) return;
>
>   // NO direct `sharedPortfolioState` forget. `scheduleRecompute({scope: 'full'})`
>   // below publishes a post-delete state through the registered scheduler
>   // path — observable by `waitForRecomputeDrainToStop` during a reset. Full
>   // scope rebuilds `byWallet` / order / totals from `inputs.walletsById`,
>   // which comes from the post-`DELETE_KEY` eligible set and excludes the
>   // deleted walletIds, so they drop out naturally. This avoids introducing
>   // an unregistered async writer outside the reset wait-set — if we wrote
>   // shared state directly here, `performResetSequence`'s `Promise.all`
>   // couldn't wait for it and the forget could land after a concurrent reset
>   // wipe, resurrecting deleted-wallet slices.
>
>   if (!getShowPortfolioEnabledFromStore()) return;
>
>   const quote = getQuoteCurrencyFromStore();
>   const base = buildBaseRecomputeInputs({
>     quote,
>     wallets: getEligibleStoredWalletsFromStore(),
>     rates: getLiveRatesByAssetIdFromStore(),
>     ratesAsOfMs: getLiveRatesAsOfMsFromStore(),
>   });
>   // `scheduleRecompute` publishes the compute-side state update through the
>   // registered scheduler; it does NOT re-kick populate. The populate loop is
>   // resumed explicitly via the `populateWallets(...)` kick helper below —
>   // same mechanism `onPullToRefresh` uses after cancel/reconcile.
>   // `populateWallets(...)` clears the cancel flag and starts a fresh loop
>   // (parity test #31 "Cancel flag lifecycle"). Without this call the queue
>   // still has surviving `remainingWalletIds` but the populate loop would sit
>   // idle until the next populate trigger (send / pull-to-refresh / launch).
>   //
>   // `evictScopedWalletIds` is the channel for scoped-cache eviction —
>   // `scopedByWalletSet` lives in `sharedPortfolioState` and is
>   // compute-runtime-owned, so the trigger cannot drop scoped entries
>   // directly (guardrail #22). Compute-runtime `recompute(...)` reads
>   // `inputs.evictScopedWalletIds`, drops any `scopedByWalletSet[*]` entry
>   // intersecting the set before the scoped-rebuild step, then refreshes
>   // remaining entries. Eviction and global rebuild land atomically in one
>   // published `sharedPortfolioState` revision.
>   //
>   // Contract reliance: the walletIds passed here are already in
>   // `queue.remainingWalletIds` (we just reconciled the queue above, and
>   // `loadQueue()?.remainingWalletIds ?? []` reads directly from it).
>   // `appendToQueue` is idempotent for already-queued ids per the Phase 5
>   // "idempotency contract" — no duplicates, no `orderRevision` bump, just
>   // "clear cancel flag + runPopulate kick." See Phase 5 / guardrail #14.
>   scheduleRecompute({ ...base, scope: 'full', evictScopedWalletIds: walletIds });
>   const remainingWalletIds = loadQueue()?.remainingWalletIds ?? [];
>   if (remainingWalletIds.length) {
>     populateWallets(remainingWalletIds);
>   }
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
>   const targetQuote = String(newQuote || '').toUpperCase() || getQuoteCurrencyFromStore();
>   // CANONICAL, not current. Bridges always source from the quote in which
>   // asset rate series are persisted; the user's currently-displayed quote is
>   // irrelevant to the bridge math. See Phase 2's canonical-rate-quote rule
>   // and parity test #101 (multi-hop USD → EUR → GBP).
>   const canonical = getCanonicalRateQuoteCurrencyFromStore();
>   const bridge = await ensureQuoteCurrencyFxBridge({
>     canonicalRateQuoteCurrency: canonical,
>     targetQuoteCurrency: targetQuote,
>     intervals: ['1D', '1W', '1M', 'ALL'],
>   });
>   await runOnRuntimeAsync(
>     getComputeRuntime(),
>     recomputeQuoteBridgeFromExistingData,
>     {
>       bridge,
>       canonicalRateQuoteCurrency: canonical,
>       targetQuoteCurrency: targetQuote,
>     },
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
> `onQuoteCurrencyChanged(...)` intentionally does **not** queue a scheduler-managed full recompute for the immediate quote switch. Instead it applies `recomputeQuoteBridgeFromExistingData(...)` directly on the compute runtime — a targeted reprice from existing snapshots/rates using the per-τ bridge formula pinned in Phase 3 (no per-asset new-quote fetches).
>
> ### Per-trigger ordering table (load-bearing — do not "consistency-ize" these)
>
> Each trigger has its own product intent for "show what we have" vs "wait for fresh." The post-auth flip is the *only* exception to the ensureFresh-first ordering; do not generalize it to other triggers without product sign-off.
>
> | Trigger | Order | Why |
> |---|---|---|
> | `onAppLaunchPostAuth` | warm publish → resume populate → background freshen → follow-up recompute | First-reveal latency: completed PnL must render before any network round trip resolves. |
> | `onPullToRefresh` | `ensureFresh(force: true)` → `populateWallets(changedWalletIds)` → `scheduleRecompute` | User explicitly asked for fresh data; stale-during-refresh is acceptable and matches v1. |
> | `onSendCompleted` | `populateWallet(walletId)` only | Affected wallet is repopulated; recompute publishes via `populateProgressTick`. No rate path. |
> | `onQuoteCurrencyChanged` | `ensureQuoteCurrencyFxBridge` → `recomputeQuoteBridgeFromExistingData` | Bridge data must land before any new-quote publish is even possible. |
> | `onLiveRatesUpdated` | `ensureFresh` → `scheduleRecompute` | The live-rate event itself is the freshness signal — fetching first then publishing is the whole point. |
> | `onKeyImported` | `populateWallets(livenetWalletIds)` only | New wallets need to be populated; recompute publishes via `populateProgressTick`. |
> | `onWalletsDeleted` | quiesce populate → reconcile queue → clear `snap:*` keys → `scheduleRecompute({scope: 'full', evictScopedWalletIds})` → `populateWallets(survivors)` | Order pinned by guardrail #22 + the three-guard reset-safety contract; not a freshness ordering question. |
> | `onWalletsVisibilityChanged` | (optionally `populateWallets(nowVisibleUnpopulated)`) → `scheduleRecompute({scope: 'full'})` | No rate path; visibility just changes which wallets count toward eligible/totals. |
> | `onShowPortfolioVisibilityChanged(false)` | `performResetSequence` (joined/serialized) | Wipe is the entire point; no recompute needed (state is empty). |
> | `onShowPortfolioVisibilityChanged(true)` | discharge `visibilityWipeRequired` if latched → `startPopulate({isFirstPopulate: true})` | Fresh populate from empty; no warm path exists. |
>
> If a future trigger is added, default to the "ensureFresh first, then publish" order unless the product requirement is explicitly "show what we have, refresh in the background." In that case, use the `runBackgroundFreshenAndRefresh(...)` helper pattern from `onAppLaunchPostAuth` rather than inventing a new background-fresh path — same in-flight tracking, same guards, same error handling.
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
> - key-import wiring from the `WalletActionTypes.SUCCESS_IMPORT` handler — add a sibling middleware (or extend the deletion middleware into a general "wallet lifecycle" middleware) that calls `onKeyImported({key})` on each successful import,
> - visibility-change wiring from every Redux action that mutates `hideKeyBalance` / `evmAccountsInfo[*].hideAccount` / `hideWallet` / `hideWalletByAccount` / `hideBalance` — wire each action through a middleware that resolves the delta set of walletIds whose effective visibility flipped and dispatches `onWalletsVisibilityChanged({affectedWalletIds})`. The delta resolution is caller responsibility; the trigger does not re-derive it from full state diffs,
> - pull-to-refresh wiring from the Home / KeyOverview / Wallet / Account screens/hooks documented in inventory item #13,
> - quote-currency-change wiring from the settings/rate-change path documented in inventory item #13,
> - show-portfolio-toggle wiring from the settings path documented in inventory item #13.
>
> Tests:
> - Each trigger mocked; fire-time freshness verified.
> - **Guard-before-side-effects regression:** while `populateResetInFlight` is set, invoke each trigger. Assert `ensureFresh` NOT called (for triggers that call it), `scheduleRecompute` NOT called, `populateWallet` NOT called. Zero side effects per trigger.
> - `onQuoteCurrencyChanged(...)` regression: calls `ensureQuoteCurrencyFxBridge(...)`, does **not** call per-asset `ensureFresh(...)` in the new quote, and dispatches `recomputeQuoteBridgeFromExistingData(...)` on the compute runtime — a targeted reprice that reads existing persisted snapshots/rates and applies the per-τ bridge formula at every rate lookup (baseline `t0`, every `ti`, every in-window τ). See parity test #99 for the in-window-tx correctness regression.
> - `onShowPortfolioVisibilityChanged(false)` regression: immediately hides portfolio-owned UI via the setting, runs `performResetSequence()`, clears portfolio MMKV/shared state, and leaves Exchange Rates surfaces visible even if their next read refetches after a `rate:v1:*` cache miss.
> - `onShowPortfolioVisibilityChanged(true)` regression: after a prior disable, starts a fresh from-scratch populate (`isFirstPopulate: true`) instead of resuming stale queue state.
> - Rapid toggle regression: off/on/off/on in quick succession serializes cleanly, stale completions no-op, `visibilityWipeRequired` prevents ON from populating until the OFF-created wipe has completed, no overlapping populate loops start, and the final persisted setting wins.
> - Toggle-during-reset regression: if another reset is already active, the toggle joins/waits for it, then re-checks epoch/store state before starting any fresh populate.
> - `onWalletsDeleted(...)` normal-path regression: when `canRunPortfolioV2Work()` is true at all three guard checks, GUARD #1 runs as the literal first statement (before argument normalization), then `cancelPopulate()` → `await waitForPopulateLoopToStop()` → GUARD #2 → `reconcileQueueAgainstEligible(getPopulateEligibleWalletIdSetFromStore())` (populate-side set; guardrails #29–30) → `await Promise.all(walletIds.map(id => snapshotStore.clearWallet(id)))` → GUARD #3 → (if `getShowPortfolioEnabledFromStore()`) `scheduleRecompute({scope: 'full'})` → `populateWallets(loadQueue()?.remainingWalletIds ?? [])`. Empty `walletIds` is a no-op. No direct `sharedPortfolioState` writer is invoked outside the scheduler.
> - `onWalletsDeleted(...)` second-guard regression: set up a scenario where `canRunPortfolioV2Work()` is true on entry, the `cancelPopulate() + waitForPopulateLoopToStop()` await takes non-trivial time, and during that await another code path invokes `performResetSequence()` (setting `populateResetInFlight = true`) or latches `portfolioCacheInvalid = true`. After the wait resolves, assert the trigger detects the flipped state via GUARD #2 and returns before any `reconcileQueueAgainstEligible` / `snapshotStore.clearWallet` / `scheduleRecompute` / `populateWallets` call fires. No side effects post-flip.
> - `onWalletsDeleted(...)` third-guard regression: set up a scenario where `canRunPortfolioV2Work()` is true through GUARD #1 and GUARD #2, reconcile runs, and the `await Promise.all(walletIds.map(id => snapshotStore.clearWallet(id)))` takes non-trivial time. During that await, another code path invokes `performResetSequence()` or latches `portfolioCacheInvalid = true`. After the clear resolves, assert: (a) the clears themselves completed (delete-only carve-out, safe to race per the plan); (b) GUARD #3 detects the flipped state and returns before `buildBaseRecomputeInputs`, `scheduleRecompute`, or `populateWallets` fires; (c) zero scheduler publishes, zero populate kicks, zero new queue writes post-flip.
> - `onWalletsDeleted(...)` clearWallet carve-out parity regression: run `onWalletsDeleted({walletIds: ['B']})` concurrently with `performResetSequence()`. Assert `performResetSequence`'s `Promise.all` wait set does NOT include `snapshotStore.clearWallet(...)` in-flight tracking (no `waitForWalletClearsToStop`). Assert both sequences complete without error: the trigger's clears and the reset's `wipePortfolioMmkvKeys` can overlap because they target subset MMKV keys with idempotent deletes. Assert neither operation produces a non-delete MMKV write or a shared-state publish from outside the scheduler.
> - `onWalletsDeleted(...)` reuses `reconcileQueueAgainstEligible`: unit test asserts the trigger calls `reconcileQueueAgainstEligible(...)` with the post-DELETE_KEY eligible set; the returned queue has deleted walletIds removed from `remainingWalletIds`, `doneWalletIds`, and `orderedAssetGroupIdsForAssetList`; `orderRevision` bumps iff order changed. Verifies no second prune path exists.
> - `onWalletsDeleted(...)` MMKV wipe uses `snapshotStore.clearWallet`: unit test stubs `snapshotStore.clearWallet(id)` and asserts the trigger calls it once per deleted walletId — not a raw `kvStore.delete(...)` loop. Confirms kernel-API parity with v1's `client.clearWallet(...)` path and that the registry tracked by `mmkvKvStore.ts` stays consistent (same discipline as guardrails #24 and #25).
> - `onWalletsDeleted(...)` no stale keys via enumeration: seed `snap:*` keys for wallets `[A, B, C]` by running a short populate. Invoke `onWalletsDeleted({walletIds: ['B']})`. Then call `kvStore.listKeys()` and assert no key containing wallet B's id remains — and that A's and C's `snap:*` keys are present. Regresses against a `snapshotStore.clearWallet` that might miss a chunk/index/invalid-history key.
> - `onWalletsDeleted(...)` no direct shared-state writer regression: in a test with `waitForRecomputeDrainToStop` stubbed to track all `runOnRuntimeAsync(getComputeRuntime(), ...)` calls, invoke `onWalletsDeleted({walletIds: ['B']})` concurrently with `performResetSequence()`. Assert: zero `runOnRuntimeAsync(getComputeRuntime(), ...)` calls are made by `onWalletsDeleted` itself outside the scheduler; all shared-state publishes originate from the scheduler's `drain()`; the reset's `Promise.all` wait can observe and wait on every shared-state publisher. Regresses against reintroducing an unregistered async writer.
> - `onWalletsDeleted(...)` post-delete recompute drops deleted wallets: seed shared state containing `byWallet[A]`, `byWallet[B]`, `byWallet[C]`. Invoke `onWalletsDeleted({walletIds: ['B']})`. Assert the next published state from the scheduler drain has no `byWallet[B]` entry, no entry in `orderedAssetGroupIdsForAssetList` from B-only asset groups, and correct new totals. Regresses the "full scope rebuilds from `inputs.walletsById`" assumption that replaces the removed direct writer.
> - `onWalletsDeleted(...)` surviving-queued-wallets resume regression: seed the queue with walletIds `[A, B, C]` and start populate. While the populate loop is mid-`handleProcessNextPageOnPopulateWorklet` for wallet A, invoke `onWalletsDeleted({walletIds: ['B']})`. Assert: (1) populate loop observes cancel and exits cleanly; (2) post-reconcile queue contains `[A, C]` with `orderRevision` preserved since relative order between surviving wallets is unchanged; (3) the trailing `populateWallets(remainingWalletIds)` call — not `scheduleRecompute` — re-kicks the populate loop by clearing the cancel flag and starting a fresh iteration (parity with test #31); (4) A completes and C runs to completion; (5) no `snap:*` writes for wallet B land after the clear.
> - `populateWallets` / `appendToQueue` idempotency regression (Phase 5 API contract): four cases covering the full dedupe scope specified in the contract. (1) Remaining-set dedupe: seed `remainingWalletIds = [A, B, C]`, `doneWalletIds = []`, `orderRevision = 5`; call `populateWallets(['A', 'B'])`; assert no duplicates, `orderRevision` still 5, loop kicked. (2) Done-set dedupe: seed `remainingWalletIds = [A]`, `doneWalletIds = [B]`, `orderRevision = 5`; call `populateWallets(['B'])`; assert `remainingWalletIds` still `[A]` (B is not re-appended because it's already in `doneWalletIds`), `doneWalletIds` still `[B]`, `orderRevision` still 5. (3) Currently-processing dedupe (regression for "no separate active state"): seed `remainingWalletIds = [A, B, C]`, start populate so the loop is mid-processing A (A has been read off remainingWalletIds[0] but `markDone` hasn't run yet — A is still in `remainingWalletIds`); call `populateWallets(['A'])`; assert no duplicate append, `orderRevision` unchanged, `populateLoopRunning` single-flight prevents a second `runPopulate` kick from doing work (parity with test #15). (4) Genuine new id: seed `remainingWalletIds = [A, B, C]`, `orderRevision = 5`; call `populateWallets(['D'])` with D not in any set; assert D is appended, `orderRevision = 6`, loop kicked. Paired edge case: `populateWallets([])` with an empty set does not duplicate state and does not fire `runPopulate`. Regresses against a naive `appendToQueue` that pushes duplicates against either set or bumps `orderRevision` on idempotent calls.
> - `onWalletsDeleted(...)` snap-only wipe regression: forgets only wallet-scoped `snap:*` MMKV keys for the deleted wallets; shared `rate:v1:*` keys (which are `(coin, quote, interval)`-scoped) are untouched and remain valid for the surviving wallet set. Write a test that seeds `rate:v1:*` keys for assets the deleted wallets held and asserts they are still present after `onWalletsDeleted`.
> - `onWalletsDeleted(...)` reset-window regression: while `performResetSequence` is active (`populateResetInFlight === true`), invoke `onWalletsDeleted({walletIds})`. Assert zero side effects from the trigger (no `cancelPopulate`, no wait, no MMKV writes, no `scheduleRecompute`, no `populateWallets`). The in-flight reset completes its wipe, which removes the deleted wallets' data as part of the full wipe; the next fire-time trigger after reset sees the Redux-authoritative eligible wallet set and recomputes correctly.
> - `onWalletsDeleted(...)` cache-invalid regression: with `portfolioCacheInvalid === true` (durable invalid bit latched), invoke the trigger. Assert no-op. The next `onAppLaunchPostAuth` / repair path wipes and clears the bit, then normal work resumes with the updated wallet set.
> - `onWalletsDeleted(...)` no populate-vs-clear race regression: while an active populate loop is mid-`handleProcessNextPageOnPopulateWorklet` for one of the deleted walletIds, invoke `onWalletsDeleted({walletIds: [thatWalletId]})`. Assert the loop observes cancel and exits before any `snapshotStore.clearWallet(...)` resolves, and no populate-side `snap:*` writes land after the clear.
>
> **Test-suite packaging note (implementation guidance, not plan-breaking):** the `onWalletsDeleted(...)` tests above pin distinct invariants at the plan level (three guards, carve-out, no-unregistered-writer, dedupe, populate-resume) and are intentionally granular so regressions fail with a specific explanatory test name. At implementation time, the three post-await race assertions — GUARD #3, clearWallet carve-out parity, and no-unregistered-writer — may be collapsed into a single `describe('reset-race invariants', ...)` block with multiple `expect(...)` assertions sharing one seeded-race scenario, as long as each asserted invariant is still named and reachable from CI failure output. Do not merge tests that pin different scenarios (e.g., second-guard vs. third-guard) because the race windows they cover are disjoint.
> - Wallet-deletion middleware parity regression: asserting the existing `cleanupPortfolioOnDeleteKeyMiddleware` in `src/store/index.ts` now calls `onWalletsDeleted({walletIds})` instead of dispatching `clearWalletPortfolioDataWithRuntime({walletIds})`, and that every `walletIds` collected from the deleted key reaches the v2 trigger.
> - `onKeyImported(...)` livenet-filter regression: dispatch `WalletActionTypes.SUCCESS_IMPORT` with a key containing three mainnet wallets and two testnet wallets. Assert `populateWallets(...)` is called with only the three mainnet walletIds; the two testnet walletIds never reach `appendToQueue`. Verifies guardrail #29.
> - `onKeyImported(...)` testnet-only key regression: import a key with testnet wallets only. Assert `populateWallets` is NOT called (early return on empty `livenetWalletIds`). No queue mutation, no populate kick.
> - `onKeyImported(...)` show-portfolio-off regression: with `getShowPortfolioEnabledFromStore() === false`, import a mainnet key. Assert the trigger no-ops — no populate kick, no queue write.
> - `onKeyImported(...)` progressive-reveal regression: import a key with five mainnet wallets while Show Portfolio is on and no prior portfolio data exists. Assert rows reveal progressively (same first-populate behavior as cold start): rows appear in canonical order, ready rows show PnL as they finish, unready rows show skeletons.
> - `onWalletsVisibilityChanged(...)` key-hide regression: populate a portfolio with two keys (K1: A, B, C; K2: D, E). Dispatch the action that sets `hideKeyBalance = true` on K1. Assert `onWalletsVisibilityChanged({affectedWalletIds: ['A', 'B', 'C']})` fires. After the scheduler drains, the published state has no `byWallet[A|B|C]` entries, totals equal the sum of D and E only, Home / All Assets / Allocation show only D and E. K1's `snap:*` MMKV keys are still present (hide does not delete).
> - `onWalletsVisibilityChanged(...)` key-unhide regression: after the above, dispatch `hideKeyBalance = false` on K1. Assert the trigger fires with A/B/C; no populate kick (they're already in `queue.doneWalletIds`); full recompute publishes a state where A/B/C reappear in `byWallet` and totals include them. Unhide is instant — no populate-latency window.
> - `onWalletsVisibilityChanged(...)` wallet-hide regression: with populated `[A, B, C]`, set `hideWallet = true` on B. Assert the affected walletIds the middleware passes is exactly `[B]`, the published state drops `byWallet[B]` and any B-only asset groups / order entries, Home / KeyOverview / AccountDetails for B's key stop counting B, and B's `snap:*` data remains on disk.
> - `onWalletsVisibilityChanged(...)` unhide-populated-late regression (edge case per guardrail #30): import key K1 with wallets A, B **during a populate-blocked window** — either `getShowPortfolioEnabledFromStore()` is false, or `populateResetInFlight` is true, or `portfolioCacheInvalid` is latched. A is hidden (`hideWallet = true`), B is visible. The populate-blocked window ends, Show Portfolio is on, and populate runs — but only for the set reached by a subsequent trigger; A remains absent from `queue.doneWalletIds`. Now dispatch unhide on A. Assert the trigger kicks `populateWallets(['A'])` because A is livenet, visible, and not in `doneWalletIds`. Populate completes; A appears in `byWallet` and totals. Paired regression: if A WAS already populated (normal import path: Show Portfolio on, not blocked, `onKeyImported` queued A at import), unhide is instant — no populate kick fires because A is in `doneWalletIds`.
> - `onWalletsVisibilityChanged(...)` EVM-account-hide regression: configure an EVM key with accounts `main` (visible) and `trading` (hidden via `evmAccountsInfo.trading.hideAccount = true`). Assert wallets under `trading` are excluded from `getEligibleStoredWalletsFromStore()` and dropped from `byWallet` post-recompute; flipping to visible re-includes them.
> - Visibility getter isolation regression: `getPopulateEligibleWalletsFromStore()` and `getEligibleStoredWalletsFromStore()` return different sets for a fixture where A is hidden and B is visible (both livenet, both not deleted). Populate set contains both; eligible (recompute) set contains only B. Unit test pins this divergence to regress guardrail #30 against accidental reunification.
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
> - `selectIsAssetGroupReady(...)` controls the right-side content only: ready rows show PnL, unready rows show skeletons/placeholders. If `selectIsAssetGroupInvalidHistoryBlocked(...)` (or the scoped equivalent) is true, the row may show the same skeleton footprint plus an error-ready affordance, but it still does not disappear. Do **not** hide unready rows.
> - Home and All Assets use the same `orderedAssetGroupIdsForAssetList` mid-populate so navigation preserves continuity.
> - Switching Today vs All Time mid-populate changes only which precomputed row payload is displayed; it must not change populate order or row visibility.
> - When "Show Portfolio" is off, this entire asset-list surface is hidden. The setting turning back on restarts from empty and re-reveals rows by the normal progressive populate rules.

## 7b. Home chart + PortfolioBalance
> Under flag: `selectTotalSeries` + `areEqualBySeriesFingerprint`. Chart keys on `series.fingerprint`. First-ever chart gating is based on valid published snapshots, not merely queue metadata. Home uses the numerator-only predicate `selectHasAnyPopulatedWallets(s)`: once at least one valid wallet has published, Home can show portfolio charts from the valid subset. Active-invalid-history wallets are visible to selectors through `invalidHistoryWalletIdsById` / `invalidHistoryAssetGroupIdsById`; they are not counted as populated/ready, and they are not treated as endlessly pending blockers. During later incremental populates Home may show a lightweight refreshing state while values update progressively.
>
> **First-ever chart gate predicate:** use `selectHasAnyPopulatedWallets(s)`. If published populated state is empty, hide charts until ready. If published populated state is non-empty, charts can continue showing current data while incremental refresh progresses. Route-specific blocked/error-ready UI reads invalid-history maps from `sharedPortfolioState`, never from the queue or MMKV during render.
> Quote-currency switches remain immediate because they transform current chart state directly.
> If "Show Portfolio" is off, hide this Home portfolio chart/balance surface entirely, but leave the Home Exchange Rates section visible.

## 7c. Wallet / Account / Key detail
> `WalletDetails`/`AccountDetails`: mount → `scheduleRecompute({ scope: { kind: 'wallet', walletId }, ...base })`. Subscribe `selectWalletSeries` + `areEqualBySeriesFingerprint`. `useFocusEffect` → `touchWallet`. Wallet/account charts stay hidden on first populate until that wallet is ready; on later incremental populates they may show a lightweight refreshing state while values update progressively. Use `selectHasAnyPopulatedWallets(s)` for first-ever chart gating.
> Quote-currency switches still update the current wallet/account chart immediately.
> If "Show Portfolio" is off, hide these portfolio chart surfaces entirely.
>
> `KeyOverview`: resolve key → walletIds from Redux, derive `walletIdsKey = stableWalletIdsKey(walletIds)`, then mount → `scheduleRecompute({ scope: { kind: 'wallets', walletIds }, ...base })`. Subscribe `selectKeySeries(s, walletIdsKey, tf)`, which reads the compute-runtime-published `scopedByWalletSet[walletIdsKey]` entry. The "See All Assets" route passes `keyId` / `walletIdsKey`, and the downstream All Assets / asset-detail screens use the **scoped cache selectors** (`selectScopedAssetGroupRows`, `selectScopedOrderedAssetGroupIds`, scoped detail series) so the key view never falls back to global Home rows and never aggregates rows/series on the JS thread.

## 7d. Asset balance history + exchange rate
> `AssetBalanceHistoryScreen`: default path uses `selectAssetGroupSeries` + `areEqualBySeriesFingerprint`. If the route carries `keyId`, use `selectScopedAssetGroupSeries(s, walletIdsKey, assetGroupId, tf)` for that key's compute-runtime-published scoped cache entry instead of the global Home asset-group slice. Required consistency test: row and detail match byte-for-byte under both global and key-scoped navigation.
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
> `AllAssets`: global route uses `selectOrderedAssetGroupIds`; key-scoped route uses `selectScopedOrderedAssetGroupIds(s, walletIdsKey)` from the compute-runtime-published scoped cache. `Allocation`: `selectAllocationRows`. **Order must match**: Allocation reuses the same canonical asset-group ordering as All Assets / Home rows; do not introduce a second value-ranked sort. Test asserts orders stay identical for the same wallet set. Mid-populate, All Assets shows the same ready-vs-skeleton continuity as Home. When "Show Portfolio" is off, hide both All Assets and Allocation entirely.

## 7f. Balance-chart scrubbing (balance header + PnL row + timestamp)
> Every balance chart in the app — Home `PortfolioBalance`, `WalletDetails`, `AccountDetails`, `KeyOverview`, `AssetBalanceHistoryScreen` — implements scrubbing with the same three-element update rule. This section is the single spec; each chart surface reuses it via a shared hook (e.g., `usePortfolioScrubState(series, interval)`). **Scrubbing is purely local UI state** (a `SharedValue<ScrubState | null>` on the UI runtime). It does not call `ensureFresh`, populate kicks, or `scheduleRecompute` (guardrail #9), does not mutate `sharedPortfolioState`, and does not publish anything cross-runtime. The series passed to the chart/scrub hook is already capped to `MAX_CHART_POINTS = 89`; the scrub hook never receives or iterates a denser balance-chart array.
>
> **Idle state (no scrub in progress):**
> - Big balance above chart: `series.points[last].fiatBalance`, formatted with the app's existing fiat formatter in the current quote currency.
> - PnL row under balance: `series.points[last].pnlChange` (absolute) and `series.points[last].pnlPercent` (signed %), formatted with the existing PnL display util. No timestamp shown in idle.
> - Guardrail #31 pins these values as exact byte-for-byte matches of the series's last point — there is no separate "idle" compute path. Parity test #76 asserts this equality per screen / interval / quote / wallet scope.
>
> **Scrubbing state (user finger/cursor on a point `p` at index `i`):**
> - Big balance updates to `series.points[i].fiatBalance`.
> - PnL row updates to `series.points[i].pnlChange` + `series.points[i].pnlPercent`.
> - PnL row ALSO displays `formatScrubTimestamp(series.points[i].ts, { interval: series.interval, windowStartTs: series.windowStartTs, windowEndTs: series.windowEndTs })` appended after / alongside the PnL values. The timestamp is not shown in idle mode. The formatter reads window metadata from the `Series` itself — UI does not compute window duration separately.
> - At `i === 0` (first point), `pnlChange === 0` exactly by the Phase 3 formula step 6 invariant; UI displays the zero without artificial smoothing.
> - At `i === last`, the displayed numeric values (big balance, PnL change, PnL percent) equal the idle display exactly (guardrail #31). The timestamp is only shown during scrub, so the full rendered row differs in the timestamp segment — compare numeric segments, not whole row strings.
>
> **Timestamp formatting (`formatScrubTimestamp(ts, { interval, windowStartTs, windowEndTs })`):**
> - `interval ∈ {1D, 1W, 1M}` → `"March 29, 2026 at 5:22 PM"` — full date + short time, locale-aware. Use the app's existing date util to format; do not reinvent.
> - `interval ∈ {3M, 1Y, 5Y}` → `"March 29, 2026"` — date only, no time component.
> - `interval === 'ALL'` → duration-based switch: if the resolved ALL-window duration (`windowEndTs - windowStartTs`) is strictly less than ~3 months (90 days), use the `1D/1W/1M` format with hours; otherwise use the `3M/1Y/5Y` format without hours. The 3M cutoff matches the display-derived intervals (`3M`, `1Y`, `5Y` are derived from `ALL` per the canonical-intervals rule) so the ALL scrub timestamp matches how a user would naturally read a 3M+ chart.
>
> **Scrub-end behavior:**
> - Releasing the scrub returns big balance + PnL row to the idle state (last-point values, no timestamp).
> - Scrub state is UI-local; the underlying `series` is not disturbed. If the series updates mid-scrub (e.g., incremental populate publishes a new series), the scrub cursor stays at its current `ts`, resolved against the new series by nearest-timestamp lookup. If the cursor's `ts` falls outside the new series range, scrub ends and falls back to idle.
>
> **Do not:**
> - Trigger any refresh work (guardrail #9). Scrub is read-only.
> - Compute PnL / fiat values on-the-fly in UI code — read from `series.points[i]` directly so the invariants pinned in Phase 3 and guardrail #31 hold automatically.
> - Display a separate "scrub timestamp" component decoupled from the PnL row — the timestamp is part of the PnL row's display and only appears while scrubbing.

## 7g. "Hide Crypto Balances" mask
> The `state.APP.hideAllBalances` flag is read ONLY by portfolio-owned UI components. `reduxAccess.ts`, selectors, triggers, recompute, populate, and `ensureFresh` must not consult it (guardrail #34). Each portfolio-owned surface renders the current value via `useAppSelector(({APP}) => APP.hideAllBalances)` and applies the v1 masking rules below.
>
> **Masking rules per surface (parity with v1):**
> - **Home `PortfolioBalance`:** when `hideAllBalances === true`: (a) replace the big balance string with `maskIfHidden(true, totalBalanceIncludingCoinbase)` → `'****'`; (b) hide the chart entirely — render null in place of the `ChartStage`; (c) hide the `ChartChangeRow` (set `shouldLeftAlignTopSection = hasChartData && !hideAllBalances`). The long-press gesture on the balance dispatches `toggleHideAllBalances()` and remains active regardless of masking state — user long-presses to toggle back off.
> - **`AssetRow` / `AssetRowV2`:** v1 parity is narrow. When `hideAllBalances === true`: (a) **crypto-amount, fiat-amount, and delta-fiat** render via `maskIfHidden(true, ...)` → `'****'`, and their skeleton placeholders ARE bypassed (v1 `AssetRow.tsx:390-420`); (b) the **percent pill** is NOT masked in v1 — it renders `displayItem.deltaPercent` directly and still honors `shouldShowSkeleton` during populate (v1 `AssetRow.tsx:453-469`). V2 must reproduce this exactly for row-level parity. If product decides v2 should mask the percent pill too (for full `'****'` coverage), that is an **explicit product change** beyond v1 parity and must be specified separately — do not silently extend the mask to the percent pill as if it were existing behavior.
> - **`KeyOverview`:** mask the key-level total and per-wallet balance amounts. Hide wallet/key balance charts entirely while masked.
> - **`WalletDetails` / `AccountDetails`:** mask the header balance + PnL subtext; hide the balance chart entirely.
> - **`AssetBalanceHistoryScreen`:** mask the header + PnL subtext; hide the chart. **Exchange Rate detail screen has mixed behavior (v1 parity):** market-rate values and the rate chart itself render unmasked regardless of `hideAllBalances` — those are price data, not user balances. But the Exchange Rate screen also displays the user's wallet / account / holding balances alongside the rate, and those subviews DO consume `hideAllBalances` in v1 (`useExchangeRateSharedModel.ts:115` reads the flag; `ExchangeRateScreenLayout.tsx:450-455` renders `'****'` for `ui.cryptoBalance` / balance fiat when true). V2 must reproduce this split: rate market values stay unmasked; user-balance subviews mask like any other portfolio balance display.
> - **`AllAssets` / `Allocation`:** mask fiat amounts + delta-fiat per row. Row order and visibility are unchanged (users still see which assets they own; only numeric values are masked).
>
> **Scrub interaction:** while `hideAllBalances === true`, charts are not rendered, so scrub is structurally impossible on the affected surfaces. No special scrub-mask coordination is required; the scrub hook simply has no chart to attach to. If the user toggles the flag mid-scrub on a chart that becomes hidden, the scrub state is discarded by the chart unmounting.
>
> **Do not:**
> - Read `state.APP.hideAllBalances` anywhere in `src/portfolio/v2/**` outside the UI render layer. Specifically: no read in `reduxAccess.ts`, no read in any trigger, no read inside `recompute(...)` or scoped-cache builders, no read in selectors or read hooks. A grep of `src/portfolio/v2/**` for `hideAllBalances` after Phase 7 must return zero hits (guardrail #34).
> - Suppress populate, recompute, `ensureFresh`, or shared-state publishes based on the flag. Hide Crypto Balances ON keeps data warm so that toggling off is instant.
> - Use `hideAllBalances` as a substitute for "Show Portfolio off" behavior. The two settings are orthogonal: Hide Crypto Balances masks display without touching cache; Show Portfolio off clears cache and hides surfaces via `performResetSequence()`.
> - Apply the mask to rate / market-price values on the Home **Exchange Rates** section or the **Exchange Rate** detail screen. Rate values are market data, not user balances — they must render unmasked regardless of `hideAllBalances`. The mask applies only to balance / fiat-amount / delta-fiat strings, including those rendered inside the Exchange Rate detail screen's user-balance subviews per the 7g surface rules above. Verify v1 parity by checking that the rate chart line / rate numeric values render the same whether the flag is on or off.

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
   Formula pinning fixtures must cover buys, sells, partial disposals, zero-balance exits, no-transaction windows, same-user wallet transfers, and collapsed multi-chain asset groups. Include a named no-transaction fixture: 10 units held across a full `1D` window with no transactions; assert `pnlPercent === ratePercentChange` within `1e-8`.

   Include a named **same-user transfer fixture** with concrete pinned values so transfer-netting bugs fail on a specific number rather than a vague "not net zero" assertion. (Note: v18's PnL is window-local per Phase 3 — `remainingCostBasisFiat` initializes from window-start holdings × baseline rate. There is no historical / tax-average cost basis carried in from before the window. The fixture below uses window-local values throughout.)
   - **Setup:** wallet A and wallet B are both user-owned. The window is `1D` with baseline timestamp `t0`. The USDC baseline rate at `t0` is `$1.00`. A holds `100 USDC` at `t0`, so A's window-local `remainingCostBasisFiat` initializes to `100 * $1.00 = $100.00`. B holds `0 USDC` at `t0`, so B's `remainingCostBasisFiat` initializes to `$0.00`. The collapsed `assetGroupId = 'usdc'` covers both wallets.
   - **Event:** at the transfer timestamp τ inside the window, the USDC spot rate is `$1.005`. A sends `40 USDC` to B. A's balance delta is `-40 USDC`; B's is `+40 USDC`. Per Phase 3 step 4: A applies pro-rata disposal (`remainingCostBasisFiat *= afterAtomic / beforeAtomic`); B adds basis at the event's spot rate (`remainingCostBasisFiat += deltaUnits * rate(τ)`).
   - **Per-wallet expected end state:**
     - A: `60 USDC`, `remainingCostBasisFiat = $100.00 * (60 / 100) = $60.00` (pro-rata of A's window-local remaining basis; the spot rate at τ is irrelevant for A's disposal step).
     - B: `40 USDC`, `remainingCostBasisFiat = $0.00 + 40 * $1.005 = $40.20` (basis added at the receiving event's spot rate).
   - **Aggregate expected end state (collapsed `usdc` row across A + B):**
     - Total units = `100 USDC` (unchanged — units conserve).
     - Total remaining cost basis = `$60.00 + $40.20 = $100.20` (NOT $100.00).
   - **Load-bearing assertion (the bug-catcher):** `aggregateRemainingCostBasisFiatEnd === 100.20` within `1e-8`. An implementation that nets out the transfer (treats it as a no-op) produces `$100.00` instead and fails this exact value. An implementation that double-counts the disposal/addition produces something else again. Both regressions land on a specific failing number, not a directional check.
   - **Paired endpoint assertions:** A's `pnlPercent` over the window reflects only A's holdings/basis path; B's reflects only B's; the collapsed row reflects `sum(pnlEnd) / sum(remainingCostBasisFiatEnd)` per the Phase 3 formula. None of the three should equal a "transfer-ignored" result.
   - **Cross-chain variant:** rerun the same fixture with A on Ethereum and B on Polygon, both `assetGroupId = 'usdc'`. ETH-side baseline rate at `t0` is `$1.00` so A's `remainingCostBasisFiat` still initializes to `$100.00`. Per-chain spot rates at τ: ETH-side `$1.005`, Polygon-side `$1.0048`. A's disposal is pro-rata of A's window-local basis (no rate input); B's add-basis uses Polygon's `$1.0048`. Aggregate remaining cost basis = `$60.00 + 40 * $1.0048 = $60.00 + $40.192 = $100.192`. This pins the per-chain spot-rate sourcing rule from the Phase 3 transfer/accounting model note — collapsing the two wallets under one `assetGroupId` does not erase the per-chain rate distinction at event time.
   Assert the exact v1 formulas from Phase 3: chart `totalPnlChange = totalUnrealizedPnlFiat - firstTotalUnrealizedPnlFiat`, chart `totalPnlPercent = totalUnrealizedPnlFiat / totalRemainingCostBasisFiat * 100`, asset-summary `pnlChange = pnlEnd - pnlStart`, asset-summary `pnlPercent = pnlEnd / remainingCostBasisFiatEnd * 100`, and collapsed-row `pnlPercent = sum(pnlEnd) / sum(remainingCostBasisFiatEnd) * 100`. Use `1e-8` tolerance for numeric formula parity unless existing v1 output is byte-for-byte stable. Also assert endpoint equivalence: for the same `assetGroupId`, optional `keyId` wallet scope, quote, and interval window, row Today equals Asset Detail `1D` final chart change row and row All Time equals Asset Detail `ALL` final chart change row byte-for-byte.
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
   - `loadQueue` with `schemaVersion: 1` but missing `invalidHistoryWalletIds` → returns a normalized queue with `invalidHistoryWalletIds: []`, no log.
   - `loadQueue` with `schemaVersion: 1` but missing `reason` → returns a normalized queue with `reason: 'manual'`, no log. Telemetry-only field; safe forward-compat default.
   - `loadQueue` with `schemaVersion: 1` and `reason` set to a string outside the `PopulateQueueReason` enum (e.g., `'pullToRefresh'` from a stale enum that included it) → returns a normalized queue with `reason: 'manual'`, no log. Unknown reason values are coerced to the neutral default.
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
51. **Key-scoped asset list parity:** `AllAssets({keyId})` shows only that key's grouped assets, row taps carry `keyId` / `walletIdsKey`, and the asset detail chart/row/**wallet-list** values stay scoped to the key instead of falling back to Home-global data.
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
62. **Quote-switch during populate:** while populate is active, `onQuoteCurrencyChanged(...)` runs `ensureQuoteCurrencyFxBridge(...)` then dispatches `recomputeQuoteBridgeFromExistingData(...)` on the compute runtime, which reprices from existing persisted snapshots/rates using the per-τ bridge formula. Visible screens switch quote when the reprice publishes. Populate continues unaffected (the reprice does not touch the populate queue).
63. **No recursive render / max-depth regression:** rapid timeframe toggles and chart scrubbing on Home / Wallet / Asset Detail / Exchange Rate do not produce "maximum update depth exceeded" errors, recursive scheduler churn, or blank intermediate flashes between valid series.
64. **Post-auth repair path for durable invalid bit:** boot with `PORTFOLIO_CACHE_INVALID_KEY = 1`; `onAppLaunchPostAuth(...)` repairs via `performResetSequence()` before any ordinary v2 populate/recompute work runs, and only a successful repair clears the bit.
65. **Show Portfolio off clears + hides:** toggling the user-facing setting off runs `performResetSequence()`, clears portfolio MMKV/shared state, hides all portfolio-owned charts/list surfaces, and leaves Home Exchange Rates / Exchange Rate detail visible even if those surfaces refetch after a `rate:v1:*` cache miss.
66. **Show Portfolio on repopulates from scratch:** toggling the setting back on after a prior disable starts a fresh populate-from-empty flow (`isFirstPopulate: true`) and re-reveals portfolio-owned surfaces by the normal progressive populate rules.
67. **Rapid Show Portfolio toggle churn:** repeated off/on/off/on toggles serialize cleanly with last-toggle-wins semantics for final visibility; `visibilityWipeRequired` guarantees an OFF-created wipe obligation completes before a later ON can start fresh populate; no overlapping populate loops survive, stale completions no-op, and the final setting determines whether portfolio surfaces are hidden or repopulating.
68. **Joinable reset during Show Portfolio toggle:** toggling portfolio visibility while post-auth repair / debug-clear / sign-out reset is already in flight joins or waits for that reset, re-checks epoch and store state afterward, and never surfaces an "already in flight" error for normal toggle churn.
69. **Key deletion clears portfolio data (triple-guarded + quiesced, no unregistered writers):** dispatching `WalletActionTypes.DELETE_KEY` routes through `cleanupPortfolioOnDeleteKeyMiddleware` → `onWalletsDeleted({walletIds})`. Normal path: the trigger (a) checks `canRunPortfolioV2Work()` as GUARD #1 — literal first executable statement per guardrail #21, before argument normalization, (b) calls `cancelPopulate()` + awaits `waitForPopulateLoopToStop()`, (c) re-checks `canRunPortfolioV2Work()` as GUARD #2, (d) calls the existing `reconcileQueueAgainstEligible(...)` primitive — no new queue-prune implementation — which drops deleted walletIds from `remainingWalletIds` / `doneWalletIds` / `orderedAssetGroupIdsForAssetList` and bumps `orderRevision` iff order changed, (e) `await`s `Promise.all(walletIds.map(id => snapshotStore.clearWallet(id)))` to remove wallet-scoped `snap:*` keys through the kernel's existing async API (same `kvStore.delete` + registry path v1 uses), shared `rate:v1:*` stays intact, (f) re-checks `canRunPortfolioV2Work()` as GUARD #3 (reset/cache-invalid can flip during the `Promise.all` above, same discipline `ensureFresh` uses before `persistRates`), then (g) publishes post-delete state via `scheduleRecompute({scope: 'full'})` — which rebuilds `byWallet` from `inputs.walletsById` and naturally drops deleted walletIds, through the registered scheduler observable by `waitForRecomputeDrainToStop` — and (h) re-kicks the populate loop for survivors via `populateWallets(loadQueue()?.remainingWalletIds ?? [])`, relying on the Phase 5 `populateWallets` / `appendToQueue` idempotency contract (already-queued ids append is a no-op and does not bump `orderRevision`, so this call is semantically "clear cancel flag + runPopulate kick") and parity with test #31. There is NO direct `sharedPortfolioState` writer invoked by `onWalletsDeleted` — all shared-state publishes flow through the registered scheduler. `snapshotStore.clearWallet` is explicitly carved out of the reset wait-set (guardrail #22 exception): delete-only, idempotent under `kvStore.delete` + registry, scoped to walletIds Redux has already removed, and a strict subset of what a concurrent `wipePortfolioMmkvKeys` would delete — so a race with `performResetSequence` produces at worst a redundant delete, never a stale write. Reset-window path: if `performResetSequence` is in flight or `portfolioCacheInvalid` is latched at any of the three guards, the trigger no-ops — the active reset/repair wipe removes the deleted wallets' data, and Redux's `DELETE_KEY` reducer is authoritative for the updated eligible-wallet set observed by the next fire-time trigger. In both paths, Home / All Assets / Allocation stop counting the deleted wallets' balances and PnL at the first publish after the Redux deletion is reflected in `getEligibleStoredWalletsFromStore()`. Additional coverage: (a) delete one wallet mid-populate of three; surviving two resume to completion via `populateWallets(...)`; (b) `kvStore.listKeys()` has no stale deleted-wallet `snap:*` keys post-delete; (c) no-unregistered-writer test — `onWalletsDeleted` run concurrently with `performResetSequence` makes zero `runOnRuntimeAsync(getComputeRuntime(), ...)` calls outside the scheduler; (d) `populateWallets` / `appendToQueue` idempotency regression — passing already-queued ids is a no-op bump-wise, passing a new id advances `orderRevision` by exactly one.
70. **Livenet-only populate across every construction site (guardrail #29):** for fixtures containing a mix of network strings, assert no populate-construction path ever produces a `PopulateQueueV1.remainingWalletIds` containing a non-livenet/mainnet-like walletId. **Required fixture coverage per `isLivenetWallet` normalized predicate:** `'livenet'`, `'mainnet'`, whitespace/case variants (`' Livenet '`, `'MAINNET'`, `'mAiNnEt'`), `'testnet'`, and `'regtest'`. The first three must all be treated as livenet and enter the queue; `'testnet'` / `'regtest'` and any other non-matching string must never enter the queue. Construction-site coverage: (a) cold start `maybeResumePopulateOnLaunch` with mixed eligible set, (b) `onKeyImported` with a mixed key, (c) `onSendCompleted({walletId: testnetId})` no-op, (d) `onPullToRefresh` with mixed `changedWalletIds`, (e) `onWalletsVisibilityChanged` unhide-populated-late path. In every case, non-livenet/mainnet-like wallets never enter the queue and never reach `runPopulate`; every literal-string variant of livenet/mainnet does.
71. **Populate vs recompute eligibility divergence (guardrail #30):** unit test asserting `getPopulateEligibleWalletsFromStore()` returns a strict superset of `getEligibleStoredWalletsFromStore()` exactly when one or more wallets have any hide flag set. Under zero hidden wallets, the two getters return the same walletIds. Under all wallets hidden, populate-eligible is non-empty and recompute-eligible is empty. Pins the two-set model against accidental reunification.
72. **Hide/unhide cycle preserves snapshot data:** run a populate, then hide all wallets (any hide flag), then unhide. Assert: (a) while hidden, `kvStore.listKeys()` still contains every `snap:*` key from before — hide does not touch MMKV; (b) the published state has empty `byWallet` while hidden; (c) on unhide, `byWallet` repopulates from the warm snapshot data in the next scheduler drain with zero populate kicks fired (guardrail #30 "unhide is instant").
73. **Import-during-populate-blocked-window cold populate path:** fixture where a mainnet wallet is imported with `hideWallet = true` AND the system is in a populate-blocked state at import time (any of: `getShowPortfolioEnabledFromStore() === false`, `populateResetInFlight === true`, `portfolioCacheInvalid === true`). `onKeyImported` no-ops on its `canRunPortfolioV2Work()` / Show-Portfolio guards and never calls `populateWallets(...)`, so the new walletId is never appended to the queue. After the block clears, no subsequent trigger kicks populate for this specific walletId before the user unhides it — scenarios include: the user toggles unhide before any other trigger fires, or no send / pull-to-refresh happens while the wallet is still hidden. The walletId is therefore absent from both `queue.remainingWalletIds` and `queue.doneWalletIds`. Crucially, the wallet is NOT "pruned from the populate queue because it's hidden" — guardrail #30 forbids that; hidden livenet wallets remain in the populate queue once added. The walletId is simply never added in the first place. Verify: the wallet is NOT in `byWallet` (hidden by the visibility-respected recompute eligibility), not in `queue.remainingWalletIds`, not in `queue.doneWalletIds`. Dispatch unhide. Assert `populateWallets([walletId])` fires from `onWalletsVisibilityChanged`'s unhide-populated-late branch, populate runs, `doneWalletIds` includes the walletId, and `byWallet` now contains it. Paired test — normal (unblocked) import: Show Portfolio on at import, no reset / cache-invalid, wallet imported with `hideWallet = true`. `onKeyImported` queues the hidden walletId at import time (populate is visibility-ignored), populate runs, `doneWalletIds` includes the hidden walletId even though the wallet remains hidden. Unhide is instant — no populate kick fires because the walletId is already in `doneWalletIds`. Regression for guardrail #30 edge-case path.
74. **`onKeyImported` wiring parity:** dispatching `WalletActionTypes.SUCCESS_IMPORT` routes through the wallet-lifecycle middleware to `onKeyImported({key})`; the key's livenet walletIds reach `populateWallets`; testnet walletIds do not. Progressive UI reveal matches first-populate behavior from cold start.
75. **`onWalletsVisibilityChanged` delta-computation parity:** every Redux action that mutates a hide flag produces an `onWalletsVisibilityChanged({affectedWalletIds})` call with exactly the set of walletIds whose *effective* visibility (union of all applicable hide flags) flipped. Idempotent action (re-set to same value) produces empty delta and trigger no-ops.
76. **Scrubbing endpoint equality + first-point zero (guardrail #31):** for every balance chart (Home total, wallet, account, key-scoped, asset-group detail) and every interval (`1D`, `1W`, `1M`, `3M`, `1Y`, `5Y`, `ALL`), assert: (a) `series.points[0].pnlChange === 0` exactly (1e-12 tolerance); (b) the idle **numeric segments** — balance header string and the pnlChange / pnlPercent substrings in the PnL row — equal the formatted `series.points[last].fiatBalance` / `pnlChange` / `pnlPercent` byte-for-byte; (c) scrubbing to index 0 displays `pnlChange = 0` in the PnL-row numeric segment and the first-point formatted timestamp in the timestamp segment; (d) scrubbing to index `last`: compare **numeric segments only** — big balance, pnlChange, pnlPercent — byte-identical to the idle display. The PnL row's timestamp segment is present during scrub and absent at idle, so the full rendered row is intentionally different there; test extracts the numeric substrings (e.g., via `data-testid` attributes or a shared formatter called from both idle and scrub paths) and asserts those strings match. (e) After scrub release, the display returns to idle state byte-identical to its pre-scrub idle state — full row compare is valid here because no timestamp segment is present in either before or after. Run across all publishable series.
77. **Scrub timestamp formatting parity:** unit test `formatScrubTimestamp(ts, { interval, windowStartTs, windowEndTs })` per the Terminology contract. Cases: (a) `1D/1W/1M` → full date + short time string matching the app's existing locale-aware date formatter (window args unused for these intervals but must be accepted); (b) `3M/1Y/5Y` → date-only string, no time; (c) `ALL` with `windowEndTs - windowStartTs < 90 * 24 * 60 * 60 * 1000` → date + time; (d) `ALL` with `windowEndTs - windowStartTs >= 90 * 24 * 60 * 60 * 1000` → date only. Assert no time component appears in the 3M+ / long-ALL cases and no date component is missing in any case. Callers always pass `series.interval` + `series.windowStartTs` + `series.windowEndTs` from the currently-displayed `Series` — do not reach into UI state or recompute window bounds.
78. **Scrubbing is pure UI-local (no side effects, guardrail #9 reinforcement):** instrumented scrub test records every call to `ensureFresh`, `scheduleRecompute`, `populateWallet`, `populateWallets`, `runOnRuntimeAsync(getComputeRuntime(), ...)`, `runOnRuntimeAsync(getPopulateRuntime(), ...)`, and every MMKV write. Seed dense raw histories/rates, assert each published balance chart series is capped to `<= MAX_CHART_POINTS` (89), then scrub through every emitted point across every interval on every chart surface. Assert total count of all recorded events is zero. `sharedPortfolioState.value` is never written during scrub.
79. **Scrub mid-publish cursor stability:** start scrubbing a chart at point 50 (timestamp `T`). While scrubbing, inject a scheduler publish that replaces `series` with a new series. Assert: (a) if the new series contains a point with `ts === T`, the cursor stays at that point and displayed values update to the new point's values; (b) if no exact-`T` point exists, the cursor snaps to the nearest-timestamp point in the new series; (c) if `T` falls outside the new series range, scrub ends and falls back to idle. In all three cases, no crashes, no recursive render, no "maximum update depth" error.
80. **Scrub across quote-currency switch:** start scrubbing on Home chart at point 50 with quote = USD. While scrubbing, dispatch `onQuoteCurrencyChanged('EUR')`. Assert: (a) `recomputeQuoteBridgeFromExistingData(...)` runs and publishes a new bridged series; (b) scrub cursor stays at point 50's `ts`; (c) displayed values update to EUR-bridged `fiatBalance` / `pnlChange` / `pnlPercent`; (d) timestamp format unchanged (quote switch doesn't change interval). Scrub release returns to the new EUR idle display.
81. **Scoped aggregation stays off the JS thread (guardrail #32):** seed a large fixture with many wallets, asset groups, and dense chart points. Mount `KeyOverview`, key-scoped `AllAssets`, and key-scoped `AssetBalanceHistoryScreen`. Assert the mount path schedules `scheduleRecompute({scope: {kind: 'wallets', walletIds}, ...base})`, the compute-runtime `recompute(...)` publishes `sharedPortfolioState.scopedByWalletSet[walletIdsKey]`, and the scoped selectors only read that cache entry. Instrument selector-side helpers so any attempt to iterate `state.byWallet`, walk `Series.points`, rebuild collapsed groups, or compute PnL in JS fails the test. Timeframe switches and chart scrubbing under the scoped route must cause zero recompute/fetch/populate side effects and zero scoped aggregation work; they only switch/read already-published scoped `Series` entries by fingerprint. A missing scoped cache entry returns `undefined` / skeleton-ready state until the scheduled recompute publishes it. **Visibility-filtered `walletIdsKey` sub-assertion:** mount `KeyOverview` for a key with wallets `[A, B, C]`, let the scoped recompute publish under `walletIdsKey_1 = stableWalletIdsKey([A, B, C])`. Dispatch a visibility action that hides `B`. Assert: (a) the mount site's derived `walletIds` changes to `[A, C]` (visibility filter applied at the caller, not the compute runtime); (b) the new `walletIdsKey_2 = stableWalletIdsKey([A, C])` differs from `walletIdsKey_1`; (c) selectors for `walletIdsKey_2` initially miss the cache and return skeleton-ready state; (d) a fresh `scheduleRecompute({scope: {kind: 'wallets', walletIds: [A, C]}, ...base})` runs and publishes `scopedByWalletSet[walletIdsKey_2]`; (e) the prior `walletIdsKey_1` entry remains in cache (for flip-back) until LRU eviction. The compute runtime must NOT have filtered visibility internally at the scope level — verify by inspecting the published `walletIdsKey_1` entry's `walletIds` pre-hide still contains `B`.

82. **Scoped cache full-recompute refresh:** populate three scoped entries under distinct `walletIdsKey`s by mounting three key-scoped screens in succession; let each publish. Fire a `full` recompute (e.g., `onLiveRatesUpdated`). Assert within the same recompute pass: (a) global state and all three scoped entries are refreshed (their `computedAtMs` advances); (b) **global inputs are reused across the global rebuild and every scoped rebuild within the pass**, not re-fetched per scoped entry — instrument `buildBaseRecomputeInputs` (the JS-side loader that assembles global rates/balances/wallet maps) and assert it is called exactly once per recompute pass regardless of how many scoped entries refresh in that pass; (c) Soft-cap eviction runs after the refresh step, so no entry just rebuilt in this pass is evicted in the same pass; (d) Scoped entries keep their prior `walletIds` / `walletIdsKey`, only values update.

**Per-wallet snapshot dedupe (Phase 3 perf acceptance, not a hard correctness gate):** for any wallet appearing in both the global rebuild set and one-or-more scoped entries, loading its snapshot data once and reusing across the pass is a performance optimization, not a correctness invariant. If the recompute implementation has a natural per-pass snapshot cache (e.g., Phase 3 adds one while building `recompute(...)`), assert no duplicated `snapshotStore.readIndexCached` / chunk-load calls for the same `walletId` within one pass. If the implementation loads per-scope (e.g., the existing kernel structure naturally reads by scope and caches at the chunk-key level), this test relaxes to "reads are bounded above by `N_scopes × N_wallets_per_scope`" — i.e., the implementation is not pathologically re-reading the same chunk multiple times within a single scoped rebuild. Track this as a Phase 3 performance acceptance measured alongside timeframe-switch latency, not a blocker.

83. **Scoped cache intersection refresh on `wallet` / `wallets` scope:** populate two scoped entries, `walletIdsKey_X = stableWalletIdsKey([A, B])` and `walletIdsKey_Y = stableWalletIdsKey([C, D])`. Fire `scheduleRecompute({scope: {kind: 'wallet', walletId: 'A'}, ...base})`. Assert the `walletIdsKey_X` entry is refreshed (its `computedAtMs` advances) and the `walletIdsKey_Y` entry is left untouched (`computedAtMs` unchanged, contents identical by reference). Repeat with `scope: {kind: 'wallets', walletIds: ['A', 'C']}` — assert both are refreshed because both intersect the changed set.

84. **Scoped cache eviction flows through `scheduleRecompute`, not direct trigger mutation:** populate three scoped entries covering wallets `{A, B, C, D, E}` across them. Dispatch `onWalletsDeleted({walletIds: ['B']})`. Assert: (a) the trigger does NOT write directly to `sharedPortfolioState.scopedByWalletSet` — instrument the SharedValue setter and assert the trigger's own stack frame performs zero scoped-cache writes (guardrail #22, no unregistered writers); (b) the trigger's tail `scheduleRecompute({scope: 'full', evictScopedWalletIds: ['B'], ...})` is called with `evictScopedWalletIds` populated; (c) inside the compute-runtime `recompute(...)` drain, entries whose `walletIds` intersect `['B']` are dropped first, then remaining scoped entries are refreshed per rule #82; (d) the published `sharedPortfolioState` revision shows both global drop-of-B and scoped-entry evictions atomically — there is no intermediate state where global state is post-delete but scoped entries still contain B; (e) scoped entries that did not contain `B` are refreshed with updated values but retain their `walletIdsKey` identity.

85. **Singleton rule is route-typed, not count-typed:** (a) Mount `WalletDetails` for a single wallet — assert no `ScopedPortfolioSlice` entry is written; the chart reads from `byWallet[walletId]` directly. (b) Mount `KeyOverview` for a key whose visible wallet set after filtering is exactly one wallet — assert `scopedByWalletSet[walletIdsKey]` IS written with that single-wallet scope, and `KeyOverview`'s chart reads from the scoped cache, not from `byWallet` directly. (c) Mount an EVM `AccountDetails` for an account with exactly one wallet under it — assert the same: scoped-cache write, scoped-cache read. (d) Hide one of two visible wallets under a key so `KeyOverview`'s scope collapses to one wallet; assert the scoped-cache write happens for the new `walletIdsKey`, not a fallback to `byWallet`. This regresses against an implementation that conditionally skips scoped-cache writes whenever the runtime wallet count is 1 — route type decides, not wallet count.

86. **Negative running balance writes invalid-history marker (guardrail #33):** build a corrupted tx-history fixture where an outgoing tx appears without the missing incoming tx that funded it, and same-batch `reorderTxBatchToPreventUnderflow(...)` cannot avoid underflow. Assert the snapshot builder throws `PortfolioInvalidHistoryError` with code `PORTFOLIO_INVALID_HISTORY_NEGATIVE_BALANCE`, `reason: 'negative_balance'`, `txId`, `balanceAtomic`, and source. Assert the marker is persisted at `snap:invalid-history:v1:<walletId>` with `retryAfter` approximately 24h after `detectedAt`.

87. **Invalid-history clear semantics preserve marker during quarantine:** when populate detects negative running balance in `handleProcessNextPageOnPopulateWorklet(...)` or `handleFinishWalletOnPopulateWorklet(...)`, assert `saveWorkletInvalidHistoryMarker(...)` is called before wallet snapshot cleanup, `clearWorkletWalletSnapshots(walletId, {preserveInvalidHistoryMarker: true})` deletes meta/index/chunk/raw snapshot keys but leaves `snap:invalid-history:v1:<walletId>`, and the wallet session is closed/deleted. Full wipe / Show Portfolio off / key deletion still delete the marker with the rest of `snap:*`; successful later finish clears the marker explicitly.

88. **Active invalid-history marker suppresses auto-populate without blocking the queue:** seed queue `[A, B, C]` and an active invalid-history marker for B. Run populate. Assert A completes, B is removed from `remainingWalletIds`, added to `invalidHistoryWalletIds`, not added to `doneWalletIds`, and C still runs to completion. Assert no tx-history fetch, snapshot index read, or snapshot write occurs for B while the marker is active. `populateProgressTick` advances for the skip so UI can stop treating B as endlessly pending.

89. **Invalid-history append retry seam:** seed B in `invalidHistoryWalletIds`. Case 1, active marker: call `populateWallets(['B'])`; assert `appendToQueue` moves B from `invalidHistoryWalletIds` to `remainingWalletIds`, then `runPopulate` loads the active marker, re-skips B without tx-history fetch/snapshot write, and records B back in `invalidHistoryWalletIds`. Case 2, expired marker: call `populateWallets(['B'])`; assert `appendToQueue` moves B to `remainingWalletIds`, `runPopulate` does not suppress the wallet because `isSnapshotInvalidHistoryMarkerActive(...)` is false, and a successful `handleFinishWalletOnPopulateWorklet(...)` clears `snap:invalid-history:v1:B`, removes B from `invalidHistoryWalletIds`, and moves B to `doneWalletIds`.

90. **Invalid-history wallet never publishes clamped negative portfolio math:** seed shared/queue state where B previously failed with negative running balance. Assert recompute publishes `invalidHistoryWalletIdsById[B] === true` and the corresponding invalid-history asset-group map entry, but omits B from `byWallet`, total series, scoped slices, asset-group rows, and allocation math until a successful later populate writes valid snapshots. Assert no displayed `fiatBalance`, `pnlChange`, or `pnlPercent` is derived from a clamped negative running balance. For first-ever populate, `selectHasAnyPopulatedWallets(s)` reveals charts once completed valid wallets publish, while B remains not-ready and error-ready via invalid-history selector state.

91. **Invalid-history queue status reconciliation:** with `remainingWalletIds = [A]`, `doneWalletIds = [B]`, `invalidHistoryWalletIds = [C]`, run `reconcileQueueAgainstEligible(...)` after deleting C or otherwise removing C from the livenet/not-deleted populate-eligible set. Assert C is removed from `invalidHistoryWalletIds`, asset-group order drops C-only groups, and `orderRevision` bumps iff order changed. Visibility-only hides must not prune C because populate eligibility is visibility-ignored. Paired assertion: `markSkippedInvalidHistory(B)` removes B from `doneWalletIds` before recording it as invalid-history skipped, preventing stale readiness if a previously-good wallet later corrupts during incremental populate.

92. **V4 fiat-rates token-vs-coin fetch distinction:** seed `ensureFresh` with a mixed asset set via its `FiatRateAssetRef[]` input shape (i.e., use the `coin` field, not `currencyAbbreviation` — `currencyAbbreviation` is an input to the classifier, not to `ensureFresh`): `coins: ['btc', 'eth', 'sol']` plus `assets: [{coin: 'usdc', chain: 'eth', tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'}, {coin: 'usdc', chain: 'sol', tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}, {coin: 'wbtc'}, {coin: 'matic', chain: 'eth', tokenAddress: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0'}, {coin: 'pol', chain: 'eth', tokenAddress: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0'}]`. (Internally, `normalizeUniqueFiatRateAssets` forwards each `asset.coin` as the classifier's `currencyAbbreviation` parameter, so `coin: 'matic'` still exercises the alias normalization.) Instrument `loadSeriesWorkletWithContext` to record each call's `args` object. Assert:
>    - (a) The classifier collapses `wbtc → btc`, and **both** legacy ETH-side MATIC inputs (`coin: 'matic'` and `coin: 'pol'`, each paired with the legacy `0x7d1afa7b...` token address on `chain: 'eth'` — forwarded as classifier `currencyAbbreviation` by `normalizeUniqueFiatRateAssets`) to native `pol`. The `matic` alias first normalizes to `pol` via `normalizeFiatRateSeriesCoin`, then the legacy-MATIC special case strips `chain`/`tokenAddress`. After `normalizeUniqueFiatRateAssets` deduplicates by `(coin, chain, tokenAddress)` tuple, the two legacy MATIC entries collapse into a single native `pol` entry, and the native-coin set (compared as a `Set<string>`, order-insensitive) equals `{'btc', 'eth', 'sol', 'pol'}`.
>    - (b) Exactly **one** native-coin batched fetch fires with no `asset` param — the URL produced by `getFiatRateSeriesUrl` has no `chain`/`tokenAddress` query params. Assert the batched `loadSeries({coins})` receives the same `Set<string>`-equality set `{'btc', 'eth', 'sol', 'pol'}`. Do NOT assert a specific array order: v1's batched path at `portfolioWorkletRates.ts:524` sorts alphabetically via `localeCompare`, which puts `pol` before `sol`; v2 may or may not preserve that particular sort. If order is asserted, use the `localeCompare`-sorted order `['btc', 'eth', 'pol', 'sol']` matching v1.
>    - (c) Exactly **two** token-specific fetches fire — one per token `(coin, chain, tokenAddress)` tuple: ETH USDC and SOL USDC. Each token fetch has the correct `chain` + `tokenAddress` query params on its URL.
>    - (d) The SOL USDC tokenAddress is transmitted **case-preserved** (`EPjFWdd5...`), not lowercased. The ETH USDC tokenAddress is lowercased (`0xa0b86991...`).
>    - (e) MMKV persist writes land at distinct keys: `rate:v1:USD:btc:1D`, `rate:v1:USD:eth:1D`, `rate:v1:USD:sol:1D`, `rate:v1:USD:pol:1D` (natives, no token suffix), and `rate:v1:USD:usdc:1D:eth:0xa0b86991...`, `rate:v1:USD:usdc:1D:sol:EPjFWdd5...` (tokens with `:chain:tokenAddress` suffix).
>    - (f) `extractSeriesFromFiatRatePayload` handles the token response shape including the single-key fallback: seed a token payload like `{USDCET: {...}}` (key does not match requested `usdc` symbol) and assert the series is still extracted via `Object.values(record)[0]`.
>    - (g) A native-coin fetch failure with every missing default having a fallback (stale cached series) is swallowed; a native-coin fetch failure with any coin lacking a fallback rethrows.
>    - (h) A token-specific fetch failure does not abort the remaining token fetches — subsequent tokens in the loop still run.
>    - (i) Timeframe `3M`/`1Y`/`5Y` never produces a **separate `3M`/`1Y`/`5Y` URL or MMKV key**: the interval is resolved to `ALL` via `resolveStoredFiatRateInterval(...)` before the freshness gate. `ensureFresh` never emits a URL with `days=90`, `days=365`, or `days=1825`. The resolved `ALL` request itself may or may not fire depending on whether the `ALL` series is cached and fresh — if `ALL` is missing/stale/forced, a single `ALL` fetch runs; if `ALL` is fresh, no network call fires. Persist writes always land at the `ALL` MMKV key, never under `3M`/`1Y`/`5Y` keys.
>    - (j) **Direct classifier sub-assertion** (pins the `currencyAbbreviation`-input API independent of `ensureFresh`'s `FiatRateAssetRef` shape): call `getFiatRateAssetRef({currencyAbbreviation: 'matic', chain: 'eth', tokenAddress: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0'})` and assert the returned ref is `{coin: 'pol', chain: undefined, tokenAddress: undefined}`. Repeat with `currencyAbbreviation: 'pol'` and assert the same result. Also assert `getFiatRateAssetRef({currencyAbbreviation: 'wbtc'})` → `{coin: 'btc', chain: undefined, tokenAddress: undefined}` and `getFiatRateAssetRef({currencyAbbreviation: 'weth'})` → `{coin: 'eth', chain: undefined, tokenAddress: undefined}`. Regresses against a future refactor that only preserves aliases for the `coin`-field input path and breaks the `currencyAbbreviation`-input path used by consumers that classify from wallet summaries.

93. **`hideAllBalances` is orthogonal to portfolio v2 data paths (guardrail #34):** instrument `runOnRuntimeAsync` (both populate and compute runtimes), every v2 MMKV write through `getPortfolioMmkvStorageOnRN()`, every trigger function in `src/portfolio/v2/triggers.ts`, and every write to `sharedPortfolioState.value` (i.e., the publish wrapper that sets the SharedValue). Seed a populated portfolio state. Dispatch `toggleHideAllBalances()` 20 times in rapid succession (both on and off states). Assert: (a) zero `runOnRuntimeAsync` calls fire from the toggle path; (b) zero MMKV writes; (c) zero trigger function invocations; (d) zero writes to `sharedPortfolioState.value`; (e) React re-renders DO fire on portfolio-owned components that subscribe to `APP.hideAllBalances` via `useAppSelector`. Grep `src/portfolio/v2/**` for `hideAllBalances` and `APP.hideAllBalances` in the same test — both must return zero matches.

94. **Masking rules per surface (v1 parity, narrow):** for each portfolio-owned surface, render with `hideAllBalances === true` and assert v1-accurate masking:
>    - (a) Home `PortfolioBalance`: big balance string equals `maskIfHidden(true, ...)` → `'****'`; `ChartStage` is not rendered; `ChartChangeRow` is not rendered.
>    - (b) `AssetRowV2`: crypto-amount, fiat-amount, and delta-fiat strings render as `'****'` with skeletons bypassed for those fields; **the percent pill is NOT masked** — `displayItem.deltaPercent` renders directly and `shouldShowSkeleton` still controls the percent-pill skeleton during populate. Assert both explicitly.
>    - (c) `KeyOverview`: key-level total + per-wallet balance amounts mask to `'****'`; key balance charts do not render.
>    - (d) `WalletDetails` / `AccountDetails`: header balance + PnL subtext mask; chart does not render.
>    - (e) `AssetBalanceHistoryScreen`: header + PnL subtext mask; chart does not render.
>    - (f) `AllAssets` / `Allocation`: fiat-amount + delta-fiat mask per row; row order and visibility unchanged.
>    - (g) Home **Exchange Rates** section rate values + Exchange Rate detail screen rate chart + rate numeric values render **unmasked** regardless of the flag. The Exchange Rate detail screen's user-balance subviews (`ExchangeRateScreenLayout.tsx:450-455`) DO mask to `'****'` because they display user balances, not market data.
>
>    Render with `hideAllBalances === false` and assert the opposite: numeric values displayed, charts visible, skeletons visible during populate.

95. **Hide toggle reveals data instantly (no populate/fetch latency):** populate a portfolio fully. Toggle `hideAllBalances` ON, wait 10 seconds, then toggle OFF. Assert the OFF transition produces zero populate kicks, zero `ensureFresh` calls, zero recompute drains — only React re-renders. The numeric values that reappear are byte-identical to what was displayed before the ON toggle (same `series.points[last].fiatBalance`, same PnL strings). Paired assertion: while the flag is ON, the underlying `sharedPortfolioState.value` continues to update normally on incremental populates / rate updates / send triggers — the UI just renders `'****'` instead of the new values. When the user toggles OFF, the post-update values are shown immediately.

96. **Hide is orthogonal to Show Portfolio off:** set `hideAllBalances = true` AND `showPortfolioValue = true` (Show Portfolio ON, Hide Crypto Balances ON). Assert portfolio data is populated and cached normally; UI shows `'****'`. Toggle Hide Crypto Balances OFF — numeric values appear instantly. Now toggle Show Portfolio OFF — `performResetSequence()` runs, cache clears, portfolio surfaces hide entirely. Toggle Show Portfolio back ON — fresh populate runs; while it runs, `hideAllBalances` is irrelevant because the surfaces are hidden by Show Portfolio gating. Populate completes, surfaces reappear with numeric values. Re-enable Hide Crypto Balances — values mask to `'****'` again. Verifies the two settings are truly independent and neither implies the other.

97. **Hide mask survives mid-scrub chart unmount gracefully:** start scrubbing a Home chart. Mid-scrub, dispatch `toggleHideAllBalances()` to set ON. Assert: (a) the chart unmounts cleanly — no crash, no `maximum update depth exceeded`; (b) the scrub state is discarded (no orphaned `SharedValue<ScrubState>` leaks); (c) subsequent re-renders are driven only by the hideAllBalances flag flip, not by any portfolio v2 side effect; (d) toggling OFF re-mounts the chart in its idle state (last-point values), NOT in a scrubbed state. The scrub gesture must be restarted by the user after toggling back.

98. **Chart point cap parity (`MAX_CHART_POINTS = 89`, guardrails #35-36):** seed dense inputs that would naturally produce more than 89 points for every interval and scope. Assert every published portfolio balance `Series.points` array has `length <= 89` for Home total, wallet, account, key-scoped, asset-group detail, and every cached `scopedByWalletSet` entry. For windows with more than 89 raw samples, assert `resolveChartSampleGrid(...)` returns the capped grid before portfolio PnL math runs; instrument the compute formula loop and verify it iterates no more than 89 chart timestamps per interval/scope, not the dense raw grid. Assert the capped series preserves the first resolved window endpoint and final resolved window endpoint; `series.points[0].pnlChange === 0` and the final point still matches idle header/PnL output per test #76. For Exchange Rate screens, seed a dense raw `rate:v1:*` series and assert the raw cached series may remain dense, but `formatExchangeRateChartData(...)` / the rendered graph payload has `data.length <= 89`, reuses the existing `downsampleSeries(...)` / `downsampleTimestamps(...)` primitive path (and the extracted `downsampleExchangeRateSeriesPreservingExtrema(...)` wrapper if needed), and uses the same first/final displayed window endpoints for percent-change calculation. No chart component should receive a points/data array longer than 89.

99. **Quote-switch in-window-tx parity (load-bearing for guardrail #4 / Phase 3 bridge formula):** seed a fixture with at least one wallet that has in-window balance changes (a buy plus a partial disposal) on every interval. Populate fully in `fromQuote = USD`. Compare two outputs: (a) `recomputeQuoteBridgeFromExistingData(...)` invoked from `onQuoteCurrencyChanged('EUR')` using the existing snapshots/rates plus the BTC bridge for EUR; (b) a from-scratch full recompute against the same snapshots with `quoteCurrency = EUR` configured ab initio (rates for EUR resolved through the same per-τ bridge formula). Assert byte-equal `Series.points` (every `ts`, `fiatBalance`, `pnlChange`, `pnlPercent`) within `1e-8` for every interval and scope. Specifically regresses against an implementation that bridges only chart points (correct `fiatBalance`, wrong `pnlChange` / `pnlPercent` because cost basis was scalar-bridged from `oldCostBasis(t) * bridge(t)` instead of recomputed from per-tx events with `bridge(τ)`). Paired no-tx fixture: same comparison on a window with zero in-window txs must also match within `1e-8` — both implementations should agree there since the scalar shortcut is mathematically correct in the no-tx case.

100. **Post-auth no-network publish (load-bearing for "completed PnL appears immediately on resume"):** seed MMKV with persisted snapshots for wallets `[A, B, C]` (all populated) and persisted canonical-quote rate series for the relevant assets. Boot the app and reach post-auth. Mock the network layer to track every fetch initiated by `ensureFresh(...)` / `ensureQuoteCurrencyFxBridge(...)`. Instrument `runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ...)` to capture every populate kick. Assert: (a) the first published `sharedPortfolioState` revision after `onAppLaunchPostAuth(...)` returns contains all three wallets in `populatedWalletIdsById`, with non-empty `byWallet` / `byAssetGroup` / `total` series and finite `pnlChange` / `pnlPercent` values; (b) this first publish lands **without awaiting any network call** — instrument the timeline and assert the publish timestamp precedes any mocked fetch resolution; (c) **publish-before-populate ordering (load-bearing):** the warm publish revision lands strictly before the first `runOnRuntimeAsync(getPopulateRuntime(), runPopulate, ...)` call. Specifically the `await waitForRecomputeDrainToStop()` between scheduleRecompute and maybeResumePopulateOnLaunch must observe the drain go from running → not-running before populate kicks. Without this await, populate's `populateProgressTick` could trigger a second recompute that races and lands first; (d) full ordering: schedule warm recompute → await drain → publish lands → populate kicks → `runBackgroundFreshenAndRefresh(...)` starts but stays unresolved; (e) when the mocked `ensureFresh` later resolves, a second publish lands with the refreshed rate values and a higher `revision`; (f) if the mocked `ensureFresh` rejects with a network error, the warm-publish revision remains the latest published state — no rollback, no error UI, only `logPortfolioRuntimeError(err, {tag: 'postAuthBackgroundFreshen'})`. Paired guard regression: while the background freshen await is in flight, invoke `performResetSequence()`. Assert `waitForEnsureFreshToStop` blocks the wipe until the freshen settles (the second `canRunPortfolioV2Work()` check inside the helper prevents the follow-up `scheduleRecompute`). Paired drain-failure regression: stub `waitForRecomputeDrainToStop()` to throw after timeout; assert `onAppLaunchPostAuth` propagates the error and does NOT kick populate or background freshen — the drain failure is a hard signal something is wrong.

101. **Multi-hop quote-switch parity (canonical-rate-quote correctness):** seed a fixture with the canonical rate quote pinned to `'USD'`: persisted asset rate series under `rate:v1:USD:*`, populated wallet snapshots, and an in-window-tx fixture for at least one wallet (a buy + a partial disposal mid-window) on every interval. Compare three outputs for byte-equality within `1e-8`:
   - **(P1) USD-from-scratch:** full recompute with `quoteCurrency = 'USD'` — the baseline.
   - **(P2) USD → EUR single hop:** dispatch `onQuoteCurrencyChanged('EUR')`. Assert `ensureQuoteCurrencyFxBridge` is called with `canonicalRateQuoteCurrency: 'USD'`, `targetQuoteCurrency: 'EUR'` (NOT `fromQuoteCurrency: 'USD'`). The reprice must read `rate:v1:USD:*` series + the freshly-fetched `rate:v1:EUR:btc:*` series and apply the per-τ formula. Compare the resulting EUR series to (P3) below.
   - **(P3) EUR-from-scratch reference:** a separate recompute path (test-only) that builds EUR series from-scratch using the same per-τ bridge formula on the same persisted USD asset rates. (P2) must equal (P3) byte-for-byte within `1e-8`.
   - **(P4) USD → EUR → GBP two hops:** with the canonical quote still `'USD'`, dispatch `onQuoteCurrencyChanged('GBP')` after the EUR hop. Assert `ensureQuoteCurrencyFxBridge` is called with `canonicalRateQuoteCurrency: 'USD'` (not `'EUR'`!) and `targetQuoteCurrency: 'GBP'`. The bridge factor used is `btcRate(τ, GBP) / btcRate(τ, USD)` — sourced from the original USD canonical asset rates, not composed through the EUR hop. Compare the resulting GBP series to a from-scratch GBP recompute (built with the same per-τ formula, USD canonical → GBP). They must equal byte-for-byte within `1e-8`.
   - **(P5) Anti-regression:** run an instrumented variant that intentionally passes `fromQuoteCurrency: 'EUR'` to `ensureQuoteCurrencyFxBridge` for the second hop (simulating the bug where `getQuoteCurrencyFromStore()` was used instead of canonical). Assert this produces *different* GBP series than (P4) on the in-window-tx fixture, proving the test would catch the regression. The wrong-source path either crashes (no `rate:v1:EUR:*` asset series exists for non-BTC assets) or composes a chain that diverges from canonical-direct. Either failure mode is acceptable for the regression — the point is that the test *catches* it.
   - Paired no-tx fixture: same comparisons on a window with zero in-window txs must also match (P1)/(P3)/(P4) byte-for-byte — the canonical-vs-display distinction still matters even without txs because `btcRate(τ, EUR) / btcRate(τ, USD)` differs from `btcRate(τ, EUR) / btcRate(τ, EUR) === 1` at the second hop's source.

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
- **Precomputed row payloads** make the global row selectors O(1); key/account scoped selectors read bounded compute-runtime-published `scopedByWalletSet` entries and do not aggregate wallets or chart points on the JS thread.
- **Scheduler accumulates, never subsumes.**
- **One unified order-update rule:** heavy scopes may advance order + revision when incoming is newer; touch scopes never do.
- **Touch scopes** never change `computedAtMs`, readiness, invalid-history maps, series, rows, total, order, or `orderRevision`.
- **Readiness O(1)** via `populated*IdsById`.
- **Chart-boundary equality** keys on `Series.fingerprint`.
- **Only four fiat-rate intervals are fetched/persisted:** `1D`, `1W`, `1M`, and `ALL`. Displayed `3M`, `1Y`, and `5Y` derive from `ALL` on the compute runtime.
- **Quote-currency switching uses a BTC FX bridge.** Quote changes fetch only BTC bridge data for the target quote and reprice portfolio/chart/list values on the compute runtime via `recomputeQuoteBridgeFromExistingData(...)` — a targeted reprice from existing persisted snapshots/rates using the per-τ bridge formula at baseline `t0`, every chart sample `ti`, and every in-window balance-change timestamp τ. No per-asset new-quote fetches.
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
- **Key-scoped All Assets and asset detail stay scoped.** `AllAssets({keyId})` and row taps from `KeyOverview` use compute-runtime-published scoped cache selectors instead of Home-global rows or JS-side aggregation, including any constituent wallet list rendered inside asset detail.
- **Rate fetching and snapshot refresh happen only at explicit triggers**, not in the scheduler and not on timeframe switches or chart scrubbing.
- **The user-facing "Show Portfolio" toggle is a first-class trigger.** Off clears cached portfolio data and hides portfolio-owned surfaces immediately; on repopulates from scratch after the wipe obligation is discharged. Home Exchange Rates and the Exchange Rate detail screen stay visible regardless of the setting and refetch on demand if the shared `rate:v1:*` cache was cleared.
- **Mid-populate UI behavior is explicit.** Asset-list rows stay visible immediately in canonical order with skeletons for unready right-side content; charts stay hidden during first populate until their relevant data is ready. Later incremental populates may update charts/rows progressively while a lightweight refreshing state is shown.
- **`runOnRuntimeAsync` non-curried**; fire-and-forget attaches `.catch(log)`.
- **Rapid timeframe/scrub interaction has an explicit no-recursive-render bar.** The plan now requires a dedicated regression for no maximum-update-depth errors, no recursive scheduler churn, and no blank flashes during timeframe toggles or chart scrubbing.
- **No data migration.** `SnapshotIndexV2.revision` required, starts at 1.
- **Every phase ships green.** Flag gates v1 vs v2 until Phase 8.
- **LOC estimate ~20.6k inside `src/portfolio/`**, 18–22k range pending Phase 0 inventory.
