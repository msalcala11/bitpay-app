# Portfolio Analytics (PnL + Charts) Agent Plan

This document is a detailed, auditable implementation plan for portfolio analytics in this app. It is designed to be executed by an agent and verified by a human via debug screens at each phase.

## High-level goals

- Wallet/account/key/portfolio **fiat value charts** over:
  - day, week, month, 3 months, 1 year, 5 years, all time
- **Breakeven line** on charts:
  - **current remaining cost basis (now)** converted to selected `altCurrency` via FX
- **Interval PnL** for the same 7 intervals:
  - `UnrealizedPnLUSD(t) = ValueUSD(t) - CostBasisRemainingUSD(t)`
  - `IntervalPnLUSD = UnrealizedPnLUSD(end) - UnrealizedPnLUSD(start)`
- Asset list:
  - aggregate crypto units, value in selected `altCurrency`, allocation %, interval PnL

## Core accounting decisions

- **Canonical accounting currency**: USD.
  - All cost basis and PnL are computed in USD.
  - UI denominates via **USD→ALT FX layer** (cached).
- **Cost basis method**: average cost.
- **Fees**:
  - Treated as part of crypto disposed on send/move.
  - For EVM, gas fee is a spend of the gas-asset wallet (e.g. ETH) even when the primary wallet is a token.
- **Transfers/moves**:
  - Stored as `category: moved` with direction inferred from `cryptoDelta` sign.
  - v1 fallback: for moved-in events (cryptoDelta > 0), assign basis using tx-time USD price if basis transfer cannot be determined.
- **Internal transfers excluded?**: not in v1.

## Data model (persisted)

### 1) `PortfolioTxEvent` (per wallet)

Persisted as the canonical ledger.

- `walletId`
- `txid`
- `time` (unix seconds)
- `assetId` (coin or token)
- `category`: `receive | spend | moved`
- `cryptoDelta` (signed)
- `feeCrypto` (if applicable)
- `confirmed/status`
- `usdPriceUsed?` (asset→USD price at tx time; required for events that create cost basis)
- `basisUSDOverride?` (future support)
- `counterpartyWalletId?` (optional; for future internal transfer basis linking)

### 2) Cursor-first v1: `WalletIntervalCursor`

Persisted per wallet per interval. This is the v1 mechanism that avoids periodic checkpoints.

- `walletId`
- `interval`: `day | week | month | 3months | year | 5years | all`
- `points` (length 45, on standardized grid)
  - `time`
  - `cryptoBalance`
  - `costBasisRemainingUSD`
  - `valueUSD`
- `lastEndTime`
- `lastTxIndex`

### 3) Optional future optimization: `WalletPositionCheckpoint`

Not required for v1; architecture should allow adding later.

- `walletId`
- `time`
- `txIndex`
- `cryptoBalance`
- `costBasisRemainingUSD`
- `avgCostUSDPerUnit`

### 4) Rate caches

- **Crypto→USD rate cache**
  - keyed by `assetId`, interval, and standardized timestamps (45 per interval)
- **USD→ALT FX cache**
  - keyed by `altCurrency` and standardized timestamps (same grid timestamps)

## Standardized timestamps / grid

- Each interval uses a standardized grid of 45 points.
- Define an `endTime` snapped to the grid step (per interval):
  - `end = floor(now / stepSeconds) * stepSeconds`
- Timestamps are `end - k*stepSeconds` for `k = 0..44`.
- Refresh should typically be:
  - drop oldest point
  - shift left
  - append newest point (once endTime advances)

## Implementation phases (auditable)

### Phase 0 — Discovery + baseline instrumentation

**Goal**: Identify the existing code paths for tx history, historical rates, persistence, and add minimal logging hooks for auditing.

- **[Find existing APIs]**
  - Locate where wallet tx history is fetched (`getTxHistory` call sites).
  - Locate existing historical rate fetch (used by PriceCharts).
  - Locate store persistence (redux-persist/MMKV) and storage usage tracking UI.
- **[Define asset identity]**
  - Decide the canonical `assetId` string format (coin symbol vs token address).

**Audit (manual)**
- Confirm which modules provide tx history and historical pricing.

### Phase 1 — Add Portfolio Redux slice + persistence

**Goal**: Create a new portfolio state container without yet computing basis.

- **[Create slice]**
  - Add `PORTFOLIO` store slice with:
    - `txEventsByWalletId: Record<walletId, PortfolioTxEvent[]>`
    - `walletIntervalCursors: Record<walletId, Record<interval, WalletIntervalCursor>>`
    - `rateCacheUsd: ...`
    - `fxCache: ...`
    - `meta: lastSyncTime, syncStatus, errors`
- **[Persistence]**
  - Persist the slice (ensure encryption rules if needed by app policy).
  - Add size accounting entry for “Portfolio” in Storage Usage UI.

**Debug screen (Phase 1)**
- Add **Portfolio Storage Debug** screen:
  - shows counts:
    - wallets with txEvents
    - total txEvents
    - cursor count
    - rate cache sizes
  - shows approximate serialized byte sizes if available

**Exit criteria**
- App boots/re-hydrates cleanly.
- Portfolio slice persists and is visible in the debug screen.

### Phase 2 — Tx history ingestion + normalization

**Goal**: For each wallet, fetch full tx history and normalize to `PortfolioTxEvent`.

- **[Implement `fetchFullTransactionHistory(walletId)`]**
  - Page via `getTxHistory(limit=1000)` until empty.
  - Normalize each tx to a `PortfolioTxEvent`:
    - Determine `category` using tx metadata (sent/received/moved) + sign.
    - Compute `cryptoDelta` precisely.
    - Identify `feeCrypto` where available.
    - Assign `assetId`.
  - Deduplicate by `(txid, walletId)`.
  - Store sorted ascending by `time`.

**Debug screen (Phase 2)**
- Add **Transaction History Debug** entry in wallet settings:
  - list raw txs (as returned)
  - list normalized PortfolioTxEvents
  - export CSV of normalized events

**Exit criteria**
- For several wallets (including an EVM token wallet), normalized events match expected direction and delta.

### Phase 3 — USD tx-time pricing for basis-creating events

**Goal**: Persist `usdPriceUsed` where needed to make basis deterministic.

- **[Define “basis-creating” rule]**
  - For v1 average cost, price is required for:
    - `receive` events that add holdings
    - `moved` with `cryptoDelta > 0` when basis transfer cannot be determined
  - (Optional) also store for other categories for debugging consistency.

- **[Fetch `usdPriceUsed`]**
  - Use existing historical pricing API.
  - De-dupe requests by `(assetId, timestampBucket)`.
  - Persist into the event (`usdPriceUsed`).

**Debug screen (Phase 3)**
- Extend Transaction History Debug:
  - show which events have missing `usdPriceUsed`
  - show pricing fetch status + errors

**Exit criteria**
- For major assets, all basis-creating events have `usdPriceUsed`.

### Phase 4 — Average cost engine (per wallet)

**Goal**: From `PortfolioTxEvent[]`, compute running position state and allow querying state at any timestamp needed by cursor construction.

- **[Compute functions]**
  - Implement pure functions (no UI) to:
    - applyEventToState(state, event) => newState
    - state contains:
      - `cryptoBalance`
      - `costBasisRemainingUSD`
      - `avgCostUSDPerUnit`
  - Rules:
    - receive: increase balance; increase basis by `basisUSDOverride ?? (cryptoDelta * usdPriceUsed)`
    - spend: decrease balance; decrease basis by `avgCostUSDPerUnit * abs(cryptoDelta)`
    - moved (out): treat like spend for remaining basis
    - moved (in): if basis transfer known use it; else basis = `cryptoDelta * usdPriceUsed`
    - fees: subtract from balance and basis using avg cost rules (or treat as part of spend/move event depending on tx representation)

**Debug screen (Phase 4)**
- Extend Transaction History Debug:
  - show running `cryptoBalance`, `costBasisRemainingUSD`, `avgCostUSDPerUnit` after each event
  - export CSV including derived columns

**Exit criteria**
- Sanity checks on known scenarios (buy then partial sell; move out then move in) look reasonable.

### Phase 5 — Cursor construction (45-point series) for each interval

**Goal**: Build `WalletIntervalCursor` for each wallet and interval using standardized timestamps and the cost basis engine.

- **[Grid generation]**
  - Define `getIntervalGrid(interval, now) => { stepSeconds, endTime, times[45] }`.
- **[Cursor build / rebuild]**
  - For wallet+interval, build `points` by replaying events once and emitting state at each `time`.
  - Compute `valueUSD` per point using crypto→USD rate cache at that point time.
  - Store `lastEndTime` and `lastTxIndex` (event index at endTime).

- **[Incremental refresh]**
  - If `newEndTime == lastEndTime`:
    - do not shift timestamps
    - if tx history changed (new txs) or rates/FX changed, recompute the latest point (the last item in `points`) in place
    - otherwise no-op
  - If advanced:
    - shift points left
    - compute new last point by replaying events from `lastTxIndex` forward to `newEndTime`
    - update `lastEndTime/lastTxIndex`

**Debug screen (Phase 5)**
- Add **Cursor Debug** (per wallet):
  - choose interval
  - show the 45 points (time, balance, basis, value)
  - show lastEndTime / lastTxIndex

**Exit criteria**
- After refresh, cursors update by adding only newest point when grid advances.

### Phase 6 — Aggregations (wallet → account/key/portfolio + assets)

**Goal**: Aggregate outputs across wallets.

- **[Define groupings]**
  - wallet → account (EVM account aggregations)
  - wallets → key
  - keys → portfolio
  - wallets → assets list

- **[Aggregate series]**
  - For a given interval, sum `valueUSD` across wallets at each point index.
  - Cost basis breakeven line for aggregates:
    - sum current `costBasisRemainingUSD(now)` across included wallets and convert to ALT via FX.

- **[Aggregate interval PnL]**
  - For each wallet interval:
    - `pnlUSD = (valueUSD_end - basis_end) - (valueUSD_start - basis_start)`
  - Sum pnlUSD across wallets.

**Debug screens (Phase 6)**
- Add **Aggregate Debug**:
  - pick grouping (wallet/account/key/portfolio)
  - show:
    - summed series valueUSD
    - interval PnL breakdown by wallet
    - breakeven USD (now)

**Exit criteria**
- Aggregated values match the sum of components.

### Phase 7 — UI integration (charts + asset list)

**Goal**: Use computed caches to render the portfolio features.

- **[Charts]**
  - Wallet chart uses wallet cursor points.
  - Key/portfolio charts use aggregated series.
  - Breakeven line:
    - `breakevenALT = costBasisRemainingUSD(now) * fx(now)`
- **[PriceCharts intervals]**
  - Extend intervals to: 3 months, 1 year, 5 years, all.
  - Add breakeven line for PriceCharts based on selected asset total holdings cost basis.
- **[Asset list]**
  - Aggregate current crypto units and current fiat value.
  - Interval selector uses interval PnL computed from cursors.

**Audit**
- Compare displayed values with debug screens.

### Phase 8 — Storage, invalidation, and reliability

**Goal**: Make refresh safe and predictable.

- **[Invalidation]**
  - When new txs arrive for a wallet:
    - append events
    - refresh cursors (incremental)
  - When rate cache updates:
    - recompute `valueUSD` for affected points (no need to recompute balance/basis)
  - When FX cache updates:
    - UI conversion updates

- **[Resilience]**
  - Handle missing rates by leaving `valueUSD` null and skipping that asset/wallet in v1.

**Debug screen (Phase 8)**
- Add **Sync Status Debug**:
  - last sync times per wallet
  - outstanding rate/FX fetch counts
  - last error

### Phase 9 — Optional future performance: periodic checkpoints

**Goal**: Add checkpoints later if needed without migration.

- Keep `PortfolioTxEvent` canonical.
- Add optional generation of `WalletPositionCheckpoint` every N tx.
- Update replay functions to:
  - use nearest checkpoint when present
  - otherwise use cursor / genesis

## Acceptance checklist

- Wallet tx normalization is correct for:
  - receive
  - spend
  - moved
  - EVM gas fees
- Cursor points are stable on the standardized grid and update by shifting + appending.
- Interval PnL computed from `points[0]` and `points[44]` matches debug-derived values.
- Aggregations across wallets match sums.
- Switching altCurrency is fast (USD→ALT FX cache).
- Storage usage shows “Portfolio” contribution.
