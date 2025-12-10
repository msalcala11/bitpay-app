# Portfolio Analytics – Phase 2 Worklog

## Goals

1. Build the historical balance pipeline (transaction fetch, timeline builder, quote conversion, caching, selectors/thunks).
2. Layer in gain/loss calculations.
3. Compute allocation breakdowns.
4. Expose hooks/selectors for components (without wiring UI).

## Task Breakdown

### 1. Historical Balance Pipeline
- [x] `src/store/portfolio/services/history.ts`
  - [x] `fetchFullHistory(wallet)` helper using `GetTransactionHistory` loop.
  - [x] `buildCryptoTimeline(transactions)` – pure function returning `CryptoCheckpoint[]` (timestamp + satoshi amount) at transaction times. No fiat, no async.
  - [x] `buildQuoteSeries(options)` – async function that:
    - Filters crypto timeline by timeframe
    - Dynamically calculates sampling interval to produce exactly 45 data points (for chart performance)
    - Fetches historic rates and converts to `BalancePoint[]`
    - Includes `quoteRate` and `cryptoAmount` fields
- [x] `src/store/portfolio/rate-cache.ts` – memoize `(coin, quoteCurrency, hour)` lookups using BWS `/v1/fiatrates`.
- [x] `src/store/portfolio/selectors.ts`
  - [x] `selectBalanceSeries(state, scope, timeframe)`.
- [x] `src/store/portfolio/thunks.ts`
  - [x] `loadBalanceSeries` thunk orchestrating: fetch → buildCryptoTimeline → buildQuoteSeries → reducer updates.
- [x] Update reducer/actions for storing per-scope series + load statuses.
- [x] Simplified types for single-asset wallets: `CryptoCheckpoint` and `BalancePoint` no longer use Record/breakdown structures.

### 2. Gain/Loss Service
- [ ] `src/store/portfolio/services/gainLoss.ts`
  - [ ] Compute net inflows/outflows excluding transfers.
  - [ ] `computeGainLossForScope(scope, timeframe)`.
- [ ] Thunk/selector wiring similar to balance series.

> **Note:** This service computes timeframe-based performance metrics (e.g., "How did I do this month?"). For lot-based cost basis tracking and unrealized gain calculations (e.g., "Am I in profit on my current holdings?"), see **Phase 3: Breakeven/Cost Basis** in `portfolio_phase3_breakeven.md`. The Gain/Loss Service can optionally consume Cost Basis data to provide more accurate unrealized gain figures:
> ```ts
> unrealizedGain = currentFiatValue - costBasis;
> ```

### 3. Allocation Service
- [ ] `src/store/portfolio/services/allocations.ts`
  - [ ] Use current wallet balances to compute per-asset `quoteValue` + `%`.
- [ ] Selector + refresh thunk.

### 4. Hooks
- [x] `src/store/portfolio/hooks.ts`
  - [x] `useBalanceSeries`
  - [ ] `useGainLoss`
  - [ ] `useAllocations`
  - [x] Each dispatches corresponding load thunk when data missing/stale.

### 5. Incremental Refresh (Left-Shift Strategy)
- [ ] Add `BalanceSeriesMeta` to track refresh state per scope
  ```ts
  interface BalanceSeriesMeta {
    lastUpdated: number;        // Timestamp of last refresh
    lastCryptoAmount: number;   // Final crypto balance for timeline continuity
    lastTxCount: number;        // Transaction count for delta fetching
  }
  ```
- [ ] Store meta alongside series in Redux: `seriesMeta: Record<string, BalanceSeriesMeta>`
- [ ] Implement `incrementalRefresh` in thunks:
  - [ ] Left-shift: filter out points before new window start
  - [ ] Delta fetch: get only new transactions since `lastTxCount`
  - [ ] Partial build: construct checkpoints/rates for new period only
  - [ ] Merge: combine valid old points with new points
- [ ] Add `forceFullReload` option to `loadBalanceSeries` for manual full refresh
- [ ] Detect when incremental is possible vs full reload required:
  - First load → full
  - Cache exists + same timeframe → incremental
  - Quote currency changed → full (different cache key handles this)

**Implementation Notes:**
- Each timeframe has its own cache key, so switching timeframes doesn't invalidate other caches
- Rate cache already memoizes by hour bucket, so overlapping periods won't re-fetch
- For ALL timeframe: only append new transactions, no left-shift needed
- Consider adding a staleness threshold (e.g., refresh if > 5 min old)

## Status Log
- _2025-11-21_: Phase 2 outline created.
- _2025-12-02_: Implemented `sampleAtIntervals` to generate synthetic checkpoints at regular intervals (hourly for 1D/1W, daily for longer timeframes). This allows charts to reflect price changes even when the crypto balance hasn't changed. Updated `loadBalanceSeries` thunk to include this step in the pipeline. Added `quoteRate` field to `BalancePoint` for displaying the historic rate used per checkpoint.
- _2025-12-02_: Refactored for cleaner separation of concerns:
  - Renamed `buildBalanceTimeline` → `buildCryptoTimeline` (pure, sync, no wallet dependency)
  - Merged `sampleAtIntervals` + `convertToQuoteSeries` into single `buildQuoteSeries` (handles filtering, sampling, rate fetching)
  - Simplified types for single-asset wallets: `CryptoCheckpoint` is now `{timestamp, amount}`, `BalancePoint` uses `cryptoAmount` instead of `cryptoBreakdown` Record
  - Updated `WalletBalanceSeries.tsx` to use new simplified types
- _2025-12-02_: Optimized sampling to produce exactly 45 data points per timeframe (TARGET_DATA_POINTS constant). Replaced fixed hourly/daily intervals with dynamic interval calculation based on time range. This improves chart animation performance and reduces rate-fetching overhead.
- _2025-12-10_: Added left-shift incremental refresh strategy to plan. Instead of full reloads, will filter stale points, fetch only new transactions/rates, and merge with existing data. Each timeframe maintains its own cache key so switching timeframes uses separate cached data.
