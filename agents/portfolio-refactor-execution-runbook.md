# Portfolio refactor execution runbook

**Source of truth:** `agents/portfolio-refactor-implementation-plan-standalone-updated.md`.

This runbook is an execution checklist, not a second architecture spec. If a contract detail conflicts with the implementation plan, the implementation plan wins and this file should be patched.

Goal: land the portfolio v2 refactor as a strangler migration. Every PR before default-on must be safe with `PORTFOLIO_V2` off. Do not delete v1 orchestration until the Phase 8a soak passes.

---

## Global Rules

- Keep PRs small enough to review. Prefer 1-3 implementation areas plus their tests.
- Do not migrate React screens before the v2 runtime output is proven by fixture tests.
- Do not duplicate product formulas in UI. UI reads runtime-published slices only.
- Do not store chart arrays, snapshot arrays, generated rows, or PnL payloads in persisted Redux.
- Do not read Redux at module top level. Use fire-time accessors from `src/portfolio/v2/reduxAccess.ts`.
- Do not let v1 and v2 react to the same portfolio trigger at the same time during soak.
- Do not delete v1 code until Phase 8b.
- Each PR must state: flag behavior, affected files, tests run, and rollback behavior.

## Standard PR Checklist

- `PORTFOLIO_V2=false` behavior is unchanged unless the PR is Phase 8a or later.
- New v2 code lives under `src/portfolio/v2/**` unless intentionally adapting preserved kernels.
- Tests cover the phase-local acceptance criteria from the implementation plan.
- No banned UI imports are introduced.
- `git diff --check` passes.
- Typecheck/lint/test scope is listed in the PR.

---

## PR 0: Inventory And Flag

Purpose: create the safe switch and document existing integration points.

Files to add/edit:

- `agents/portfolio-v2-inventory.md`
- feature flag definition for `PORTFOLIO_V2`
- flag accessors usable from JS and worklet paths

Do not touch:

- portfolio UI behavior
- v1 runtime request/session APIs
- persisted Redux shape

Required checks:

- Inventory lists portfolio consumers, Redux paths, MMKV prefixes, reset paths, visibility actions, post-auth signal, send/pull/quote triggers, and invalid-history behavior.
- `PORTFOLIO_V2=false` produces no behavior change.
- Flag is readable from trigger code and worklet-bound code.

Merge gate:

- Inventory checked in.
- No production behavior change.

Rollback:

- Disable or remove the flag wiring. No data migration should exist yet.

---

## PR 1: V2 Scaffolding

Purpose: add the v2 module skeleton and shared model contracts.

Files to add:

- `src/portfolio/v2/model.ts`
- `src/portfolio/v2/constants.ts`
- `src/portfolio/v2/runtimes.ts`
- `src/portfolio/v2/sharedState.ts`
- `src/portfolio/v2/reduxAccess.ts`
- `src/portfolio/v2/kvStore.ts`
- `src/portfolio/v2/logPortfolioRuntimeError.ts`
- `src/portfolio/v2/manifest.ts`
- `src/portfolio/v2/ordering.ts`
- `src/portfolio/v2/routes/routeScope.ts`
- `src/portfolio/v2/routes/exchangeRateRoute.ts`
- `src/portfolio/v2/populate/queue.ts`
- `src/portfolio/v2/populate/reconciliation.ts`
- `src/portfolio/v2/populate/resetState.ts`
- `src/portfolio/v2/populate/performResetSequence.ts`
- `src/portfolio/v2/__tests__/fixtures/`

Do not touch:

- production screens
- v1 hooks/selectors
- v1 runtime transport/client files

Required checks:

- Model includes `Point.remainingUnrealizedPnlFiat`, `AssetGroupRowShell`, discriminated `WeightedGroupRateSeries`, `PortfolioManifestV1`, `PopulateQueueV1`, `PopulateCheckpoint`, and `ScopeReadiness`.
- Manifest and queue load/save schema validation tests pass.
- Empty state and `resetSharedPortfolioStateForDebugClear` tests pass.
- `logPortfolioRuntimeError` contract test passes.

Merge gate:

- Typecheck green for added modules.
- No behavior change with flag off.

Rollback:

- Safe to revert this PR. It should not be referenced by production UI yet.

---

## PR 2: Rate And Snapshot Readers

Purpose: create v2 read/fetch infrastructure without changing UI.

Files to add/edit:

- `src/portfolio/v2/workletData/snapshotsKv.ts`
- `src/portfolio/v2/workletData/ratesKv.ts`
- `src/portfolio/v2/workletData/ratesFetch.ts`
- adapters around existing `snapshotStore`, `fiatRateStore`, and rate fetch helpers

Do not touch:

- asset-list UI
- chart UI
- populate loop behavior

Required checks:

- `resolveStoredRateInterval` maps `3M`, `1Y`, `5Y`, and `ALL` to `ALL`.
- `ensureFresh` separates freshness check, fetch, and persist, with a second guard before persist.
- `buildEnsureFreshArgsForPopulateEligibleAssetGroups(...)` is visibility-ignored and includes hidden livenet wallets.
- `buildEnsureFreshArgsForVisibleAssetGroups(...)` is visibility-respecting for display refreshes.
- Both helpers always union canonical `BTC/USD` for `1D`, `1W`, `1M`, and `ALL`.
- `ensureQuoteCurrencyFxBridge` fetches only target BTC rates, with no target fetch when target is canonical `USD`.
- Hidden-only populated asset rate coverage test passes.

Merge gate:

- Rate fetch context lifecycle tests pass.
- No UI behavior change.

Rollback:

- Revert PR. No production screens should depend on these helpers yet.

---

## PR 3: Recompute Engine And Product Fixtures

Purpose: prove the runtime render model before React migration.

Files to add/edit:

- `src/portfolio/v2/recompute.ts`
- `src/portfolio/v2/selectors.ts`
- `src/portfolio/v2/scheduler.ts` only if needed for isolated recompute tests
- shared fixture files under `src/portfolio/v2/__tests__/fixtures/`

Do not touch:

- production screen hooks
- v1 asset rows/chart caches

Required checks:

- Shared interval-window helper is used by portfolio and Exchange Rate tests.
- Chart output is capped to `MAX_CHART_POINTS = 89` while all in-window events are still processed.
- Full-point series fingerprints hash all emitted points.
- Row shells publish for visible asset groups before PnL is ready.
- `currentFiatValue` behavior is pinned: no visible members means no shell, all-zero visible members publish `0`, missing nonzero rate publishes `undefined`.
- PnL fixture suite passes: buys, sells, partial disposals, zero-balance exits, no-transaction windows, same-user transfer `$100.20`, cross-chain transfer `$100.192`.
- Weighted group fixture passes: `180.392 -> 180.592 -> 0.1108696616%`.
- Weighted `missingConstituentRate` publishes `availability: 'unavailable'`, reason, and `points: []`.
- Quote-bridge reprice matches from-scratch bridged recompute.

Merge gate:

- Product-oracle fixtures pass.
- Row/detail equality passes globally and key-scoped.
- No React UI migration yet.

Rollback:

- Revert PR. v1 remains live.

---

## PR 4: Scheduler, Hooks, And Import Guards

Purpose: make React able to subscribe to v2 slices without migrating screens yet.

Files to add/edit:

- `src/portfolio/v2/hooks/usePortfolioSlice.ts`
- `src/portfolio/v2/hooks/usePortfolioChart.ts`
- `src/portfolio/v2/hooks/usePortfolioAssetRows.ts`
- `src/portfolio/v2/hooks/usePortfolioStatus.ts`
- `src/portfolio/v2/scheduler.ts`
- eslint/import-check configuration or test

Do not touch:

- production screen rendering paths, except optional debug-only mounts behind the flag

Required checks:

- `usePortfolioSlice` evaluates selector on UI runtime and sends only selected slice to React.
- Initial hook state is `undefined`/skeleton; do not materialize full `sharedPortfolioState` on JS.
- Named comparator kinds only. No arbitrary comparator closures from screens.
- Timeframe switch causes zero fetch/populate/snapshot/recompute side effects.
- Scoped selector cache misses return skeleton state, not JS aggregation.
- Full-point fingerprint change causes relevant consumer update; unchanged fingerprint does not.
- Import restrictions prevent UI from calling generic v1 compute/query/request APIs.

Merge gate:

- Hook tests pass.
- Import restriction test passes.

Rollback:

- Revert PR. No production UI should require these hooks yet.

---

## PR 5: Populate Runtime

Purpose: implement durable, resumable, priority-aware populate v2.

Files to add/edit:

- `src/portfolio/v2/populate/api.ts`
- `src/portfolio/v2/populate/populateLoop.ts`
- `src/portfolio/v2/populate/resume.ts`
- existing populate kernels only as narrow adapters

Do not touch:

- UI surfaces
- trigger wiring outside isolated tests

Required checks:

- Queue dedupes only same-run `itemId`s. It never dedupes against `manifest.populatedWalletIds`.
- Urgent send/pull items insert after active work and ahead of background work.
- Urgent same-wallet items supersede older unstarted normal/background same-wallet items.
- Active item is not preempted mid-page.
- Active item resumes after app kill; invalid checkpoints clear only wallet staging and restart safely.
- Persisted checkpoint cursor is JSON-serializable/schema-validated.
- `failed`, `closed`, `corrupt`, and `invalidHistoryBlocked` are non-optional booleans.
- Hidden livenet wallets remain populate-eligible.
- Testnet/regtest wallets never enter queue.
- Invalid-history quarantine behavior is preserved.

Merge gate:

- Queue, resume, checkpoint, and invalid-history tests pass.
- No production triggers wired yet, except test harnesses.

Rollback:

- Revert PR. v1 populate remains live.

---

## PR 6: Triggers, Reset, And Delete Safety

Purpose: wire v2 runtime entrypoints behind `PORTFOLIO_V2`.

Files to add/edit:

- `src/portfolio/v2/triggers.ts`
- post-auth hook/site
- send completion trigger site
- pull-to-refresh trigger sites
- quote currency change trigger site
- live-rate update trigger site
- key import and wallet/key/account visibility trigger sites
- wallet/key deletion trigger sites
- Show Portfolio toggle path

Do not touch:

- v1 code path behavior when `PORTFOLIO_V2=false`
- production screen rendering yet, except hidden flag gates if required

Required checks:

- Every ordinary v2 trigger checks `canRunPortfolioV2Work()` before side effects.
- Post-auth ordering is warm publish -> await drain -> resume populate -> background freshen.
- Pull/live freshness triggers are ensureFresh-first.
- Send requeues already-populated wallet with urgent priority.
- Quote switch fetches only BTC bridge rates, except canonical `USD` target performs no target fetch.
- Delete path uses triple guard and resumes existing queue with `kickPopulateLoopIfIdle()`.
- Show Portfolio rapid toggle serializes and discharges OFF-created wipe obligation before ON populate.
- Invalid-history unhide ownership test passes.
- Flag-off dual-path safety test passes: v2 observers/triggers do not run when flag is off.
- In-flight v2 work on flag-off cannot publish or kick follow-up work.

Merge gate:

- Trigger ordering table tests pass.
- Reset/MMKV registry tests pass.
- `PORTFOLIO_V2=false` still routes through v1 only.

Rollback:

- Turn flag off. If needed, revert trigger wiring PR.

---

## PR 7: UI Migration Behind Flag

Purpose: move user-visible portfolio surfaces to v2, one route group at a time.

Suggested order:

1. Home portfolio balance/chart and Home asset list.
2. All Assets and Allocation.
3. WalletDetails.
4. AccountDetails.
5. KeyOverview and key-scoped All Assets.
6. AssetBalanceHistoryScreen and scoped asset detail.
7. Portfolio-entered Exchange Rate routing.

Files to edit:

- screen/hooks under `src/navigation/**`
- portfolio chart/list components only as needed to accept v2 render models
- `src/components/charts/BalanceHistoryChart.tsx` only to remove data-loading responsibility behind flag

Do not touch:

- v1 path removal
- v1 Redux chart-cache deletion

Required checks:

- First-populate chart gates are scope-specific.
- Rows render immediately from shells and progressively reveal right-side PnL.
- UI never aggregates row amounts/PnL through `memberWalletIds`.
- Scrub first/final point invariants pass.
- Portfolio-entered Exchange Rate uses `ExchangeRateRoute.kind`.
- Weighted unavailable intervals render interval-local empty state and do not fallback to market route.
- Hide Crypto Balances causes zero v2 runtime side effects.
- No max update depth errors on rapid timeframe/scrub interactions.

Merge gate:

- Flag-on UI acceptance suite passes.
- Flag-off path still uses v1 during soak.

Rollback:

- Turn flag off to return surfaces to retained v1 path.

---

## PR 8: Debug And Reset Tooling

Purpose: make support/debug flows use v2-safe operations.

Files to edit:

- `src/navigation/tabs/settings/about/screens/PortfolioDebug.tsx`
- `src/navigation/tabs/settings/about/screens/PortfolioWalletDebug.tsx`
- related debug helpers

Do not touch:

- v1 deletion targets

Required checks:

- Debug clear calls `performResetSequence`.
- Wipe uses portfolio MMKV instance and registry-aware deletes.
- Wipe excludes shared `rate:v1:*` by default.
- Cache-invalid bit survives failed reset and repair clears it.
- Exchange Rate cached rates remain available when shared rate cache is retained.

Merge gate:

- Debug/reset tests pass.
- Manual debug clear smoke test passes.

Rollback:

- Turn flag off for production surfaces; debug path can be reverted independently.

---

## PR 9: Default V2 On, Soak With V1 Retained

Purpose: make v2 the default while preserving real rollback.

Files to edit:

- feature flag default/config
- QA docs or release notes for rollback drill

Do not delete:

- `src/store/portfolio-charts/**`
- `src/store/portfolio/**`
- `src/portfolio/runtime/**` v1 request/client/session orchestration
- v1 UI hooks/selectors

Required checks:

- Flag-on path uses v2.
- Flag-off path still works through retained v1.
- No persisted Redux arrays are written by v2 while flag is on.
- Rollback drill passes on a populated development device.
- Turning flag off while v2 work is in flight does not publish stale v2 state or kick follow-up v2 work.

Merge gate:

- Soak criteria defined before merge.
- QA has documented meaning of the kill switch during soak: rollback to v1.

Rollback:

- Turn flag off. v1 remains present.

---

## PR 10: Delete V1 Orchestration After Soak

Purpose: remove old orchestration only after v2 is proven.

Delete targets:

- `src/store/portfolio-charts/**`
- `src/store/portfolio/**` v1 slice/effects, except tiny retained summary fields if still needed
- `src/portfolio/runtime/portfolioClient.ts`
- `src/portfolio/runtime/portfolioHost.ts`
- `src/portfolio/runtime/portfolioRequestRouting.ts`
- `src/portfolio/runtime/portfolioWorkletTransport.ts`
- `src/portfolio/runtime/portfolioWorkletDispatch.ts`
- `src/portfolio/runtime/serialQueue.ts`
- `src/portfolio/runtime/worklet/portfolioRequestWorklet.ts`
- `src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts`
- `src/portfolio/core/engine/portfolioEngine.ts` session/query APIs
- `src/portfolio/service/portfolioPopulateService.ts`
- `src/portfolio/ui/hooks/**` v1 orchestration hooks
- `src/portfolio/ui/selectors/**` v1 row/analysis selectors

Keep/adapt:

- `src/portfolio/core/pnl/analysisStreaming.ts`
- `src/portfolio/core/pnl/snapshotStream.ts`
- `src/portfolio/core/pnl/snapshotStore.ts`
- `src/portfolio/core/pnl/fiatRateStore.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts`
- `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletRates.ts`
- `src/portfolio/adapters/rn/**`

Required checks:

- No UI imports banned v1 APIs.
- No persisted Redux arrays for portfolio charts/snapshots/rates.
- Root reducer/persist config no longer includes deleted v1 portfolio chart caches.
- Kill-switch docs now say post-deletion behavior is v2-disable/hide, not v1 rollback.

Merge gate:

- Soak sign-off complete.
- Full test suite, typecheck, and lint green.

Rollback:

- After this PR, rollback to v1 is no longer available. The remaining switch disables/hides portfolio-owned v2 surfaces and ordinary v2 work.

---

## PR 11: Polish And Benchmark

Purpose: measure the new system and clean up only after correctness is locked.

Tasks:

- Benchmark post-auth warm publish.
- Benchmark first-populate reveal.
- Benchmark timeframe switch.
- Benchmark scrub.
- Benchmark quote switch.
- Benchmark pull-to-refresh.
- Delete spikes and unused helpers.
- Add persisted derived render-state hydration only if measured cold-start latency requires it.

Merge gate:

- Benchmarks are recorded.
- No speculative derived-state persistence is added without measured need.

Rollback:

- Revert individual optimizations if they regress correctness or complexity.

---

## Final Pre-Deletion Gate

Before PR 10, verify:

- Product-oracle PnL fixtures pass.
- Weighted group route/bridge/unavailable tests pass.
- Queue/resume/checkpoint tests pass.
- Reset/delete/MMKV registry tests pass.
- Hide Crypto Balances orthogonality test passes.
- Dual-path soak safety tests pass.
- Flag-off v1 rollback drill passes.
- No v2 persisted Redux arrays exist.
- No UI-side aggregation through `memberWalletIds` exists.
- Exchange Rate surfaces remain available when Show Portfolio is off.

If any item fails, do not delete v1 orchestration yet.
