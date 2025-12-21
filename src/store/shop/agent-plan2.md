# Portfolio Analytics (PnL + Charts) — Agent Plan v2 (auditable)

This document is a detailed, **phase-gated** implementation plan for portfolio analytics in this app. It is designed for **GPT-5.2 Codex Max High** to execute with minimal ambiguity, and for a human to audit correctness via dedicated debug UI at every phase.

Do not edit `plan.md` / `agent-plan.md` while executing this plan. Implement changes in small PRs/commits per phase.

---

## Execution rules (for Codex)

- Only implement **one phase at a time**.
- At the end of each phase, ensure:
  - debug UI for that phase is functional
  - exit criteria are met
  - no type errors / lint failures / crashes on boot
- Prefer **pure functions + unit tests** for core logic (normalization, grid generation, cursor replay, aggregation).
- Use existing code paths and conventions where possible:
  - tx history fetch uses existing wallet transaction history effects
  - token identity/rates are keyed using existing `getCurrencyAbbreviation` / `addTokenChainSuffix`
  - persistence uses existing `redux-persist` / MMKV conventions

---

## Scope + hard decisions (v1)

- **Network scope**: v1 portfolio analytics runs only for **mainnet wallets** (`Network.mainnet === 'livenet'`).
  - Non-mainnet wallets are excluded from ingestion, cursors, and aggregation.
  - Debug UI must clearly show what is excluded.

- **“All time” interval**: means the **life of the wallet**.
  - For a wallet: `startTime = walletFirstEventTime` (see definition below)
  - For a key/portfolio aggregate: `startTime = min(walletFirstEventTime)` across included wallets

- **Basis-creating receives**:
  - Basis-creating events are simply **incoming transactions**.
  - Cost basis uses the **USD spot price at the time of receipt**.

- **PnL scope**:
  - v1 supports **unrealized PnL only** (no realized PnL UI).
  - We still design data structures to keep **future extensibility** cheap (see “Extensibility hooks”).

---

## Definitions

### Wallet first event time

- `walletFirstEventTime` should be:
  - the earliest `PortfolioTxEvent.time` after normalization
  - if a wallet has no events, it is excluded from portfolio analytics

### Canonical accounting currency

- **USD is canonical**:
  - cost basis is stored/updated in USD
  - unrealized pnl in USD
  - UI converts USD→ALT using a cached FX layer

### Cost basis method

- **Average cost** (remaining-units basis):
  - `avgCostUSDPerUnit = costBasisRemainingUSD / cryptoBalance`
  - spend-like events reduce basis by `avgCostUSDPerUnit * unitsDisposed`

### Fees

- Fees reduce holdings and basis using the same average-cost disposal rule.
- For EVM:
  - gas fee is a spend of the **gas asset wallet** (e.g. ETH) even if the primary wallet is a token wallet.

### Transfers / moves

- v1 does **not exclude** internal transfers at the wallet level.
- For moved-in events where basis transfer cannot be determined:
  - v1 fallback assigns basis using tx-time USD price (same as receives).

---

## Asset identity (critical)

### Required `assetId` format

Use a canonical `assetId` that is consistent, future-proof, and avoids collisions:

- **Native**: `{network}:{chain}:{coin}`
- **Token**: `{network}:{chain}:{coin}:{tokenAddress}`

Where:
- `network` is one of `livenet|testnet|regtest` (v1 will always use `livenet`, but keep this prefix to avoid future migrations)
- `chain` and `coin` are lowercase
- `tokenAddress` casing:
  - EVM: lowercase
  - Solana: preserve case (Solana mint addresses are case-sensitive)

### Rates key mapping (do not invent a new convention)

The app’s existing rates storage uses:
- Coins: `coin.toLowerCase()` (with special handling such as POL/MATIC mapping)
- Tokens: `addTokenChainSuffix(tokenAddress, chain)` → `{tokenAddressLower}_{suffix}` for EVM, `{tokenAddress}_sol` preserving case

For portfolio analytics, keep `assetId` as above, and derive a `ratesKey` when needed using existing helpers:
- `ratesKey = getCurrencyAbbreviation(tokenAddress ?? coin, chain)`

---

## Data model (persisted)

### `PortfolioTxEvent` (canonical ledger)

Persisted per wallet and treated as authoritative.

Minimum required fields:
- `walletId`
- `txid`
- `time` (unix seconds)
- `assetId`
- `category`: `receive | spend | moved`
- `cryptoDelta` (signed, in **crypto units**, not fiat)
- `feeCrypto` (crypto units; optional)
- `confirmed` / `status`

Pricing + basis fields:
- `usdPriceUsed?: number`
  - **required** for all basis-creating receives (incoming)
- `basisUSDOverride?: number` (optional, future)

Extensibility fields (do not compute in v1 UI, but design for it):
- `usdPriceAtSpendTime?: number` (optional, future realized PnL)
- `costBasisUsedUSD?: number` (optional, can be computed during replay)
- `counterpartyWalletId?: string` (optional; future internal transfer linking)

Determinism fields (recommended):
- `eventId: string`
  - stable unique id used for sorting/dedup (e.g. `${walletId}:${txid}:${time}:${cryptoDelta}`)

### Cursor model: `WalletIntervalCursor`

Persisted per wallet per interval.

- `walletId`
- `interval`
- `points[45]`:
  - `time`
  - `cryptoBalance`
  - `costBasisRemainingUSD`
  - `valueUSD` (nullable if missing rate)
- `grid` metadata:
  - `startTime`
  - `endTime`
  - `stepSeconds`
- incremental metadata:
  - `eventsRevision` (see invalidation)
  - `lastEventId` or `lastTxIndex`

### Rate + FX caches

Use explicit schemas and a single bucket strategy:

- `rateCacheUsdByAssetId: Record<assetId, Record<bucketTimeSec, number>>`
- `fxCacheByAlt: Record<altCurrency, Record<bucketTimeSec, number>>`

Bucket rule:
- `bucketTimeSec = floor(timeSec / 3600) * 3600` (hourly)

Reasons:
- aligns with `endTime` snapping
- dedupes requests
- works for all intervals (including variable “all time”)

### Meta/sync state

Make meta **per wallet** to improve diagnostics:

- `metaByWalletId[walletId]`:
  - `included: boolean` (mainnet-only gating)
  - `excludedReason?: string`
  - `lastTxSyncAt?: number`
  - `lastCursorBuildAt?: number`
  - `lastRatesSyncAt?: number`
  - `lastError?: string`
  - `lastRequestCounts?: {txHistory?: number; prices?: number; fx?: number}`

---

## Grid definition (45 points)

For all intervals, define a grid with 45 timestamps.

Common rule:
- `endTime = floor(nowSec / 3600) * 3600` (snap to hour)
- `times[i] = startTime + i * stepSeconds` for `i=0..44`

Fixed-window intervals:
- day: `duration = 1 * 86400`
- week: `7 * 86400`
- month: `30 * 86400`
- 3months: `90 * 86400`
- year: `365 * 86400`
- 5years: `5 * 365 * 86400`

For these intervals:
- `startTime = endTime - duration`
- `stepSeconds = round(duration / (45 - 1))`

“All time” (wallet lifetime):
- `startTime = walletFirstEventTime` (or group min for aggregates)
- `duration = endTime - startTime`
- `stepSeconds = max(1, round(duration / (45 - 1)))`

Important consequence:
- All-time grids are **not globally standardized** across wallets.
- Aggregated all-time charts must use a **group grid** and query each wallet at group timestamps.

---

## Invalidation + determinism (must-have)

### Event list determinism

- Normalize txs into `PortfolioTxEvent[]` sorted by:
  1) `time` ascending
  2) `txid` ascending
  3) `eventId` ascending

### `eventsRevision`

Maintain `eventsRevisionByWalletId[walletId]`:
- increment whenever the wallet’s normalized event list changes in any way
  - append
  - dedup removal
  - reordering
  - backfill of missing `usdPriceUsed`

Persist cursor with `eventsRevision` used to build it.

Cursor invalidation rule:
- if `cursor.eventsRevision !== currentRevision`, rebuild cursor from scratch

This avoids subtle bugs when “new history appears in the past”.

---

## Sync orchestration (required)

Portfolio analytics must support both **targeted** execution (single wallet) and **top-down** execution (key/portfolio), and all aggregations that include an updated wallet must update automatically.

### Trigger scopes

- **Wallet**: sync a single wallet by `walletId`.
- **Key**: sync all wallets within a key by `keyId`.
- **Portfolio**: sync all included wallets.

### Required behavior

- Wallet scope runs the full pipeline **for that wallet only** (tx ingest/normalize → price backfill → cursor build → ensure required rates/FX buckets).
- Key/portfolio scopes delegate to wallet scope for each included wallet (with throttling and guards against overlapping runs).

### Aggregate auto-update rule

- Any aggregation that includes a wallet must update automatically when that wallet’s portfolio data changes.
- Prefer deriving aggregates from wallet-level artifacts (tx events + cursors) so no explicit “rebuild aggregates” job is required in v1.
- If persisted aggregate caches are introduced later, they must be invalidated via wallet-level revision(s) and rebuilt automatically.

## Debug UI: Audit Hub (required)

Create/maintain a single entry point screen:

- **Settings → About → Portfolio Analytics (Debug)**

This screen links to phase-specific audit screens below and must exist before Phase 2.

It must also expose **hierarchical sync triggers** (wallet/key/portfolio) and make it easy to verify that aggregates update after a wallet-only sync.

Each phase below includes:
- required debug UI work
- manual audit steps
- exit criteria

---

# Implementation phases (auditable)

## Phase 0 — Discovery + baseline instrumentation

**Goal**: Map existing tx history + rate APIs and establish logging conventions.

Deliverables:
- Identify and document (in code comments or commit message) the specific effects used for:
  - full tx history paging
  - historical crypto→USD rates (PriceCharts path)
  - USD→ALT FX rates

Instrumentation:
- Add `logManager` info/error logs for:
  - portfolio sync start/end per wallet
  - tx history request counts
  - price/fx request counts
  - rehydrate/persist failures related to PORTFOLIO slice

Audit (manual):
- Verify logs appear for a single wallet sync.

Exit criteria:
- No functional changes yet; logging is present and safe.

---

## Phase 1 — Portfolio slice hardening (schema + persistence + clear-cache)

**Goal**: Ensure persisted portfolio state is well-defined, debuggable, and recoverable.

Work:
- Confirm the PORTFOLIO reducer state uses the schemas above.
- Add:
  - `eventsRevisionByWalletId`
  - `metaByWalletId`
  - `rateCacheUsdByAssetId` and `fxCacheByAlt` keyed by hourly buckets

User-facing ops:
- Implement **Clear Portfolio Cache** action (debug-only initially):
  - clears tx events, cursors, rate/fx caches, meta

Debug UI:
- **Portfolio Analytics (Debug) Hub** exists.
- **Portfolio Storage Debug** shows:
  - wallets included/excluded counts
  - total txEvents
  - cursor counts per interval
  - cache sizes (#assets, #buckets)
  - serialized size estimate (best-effort)
  - Clear Cache button

Audit (manual):
- Clear cache → confirm slice resets and app continues working.

Exit criteria:
- App boots/re-hydrates cleanly.
- Storage Debug reflects state accurately.

---

## Phase 2 — Tx ingestion + normalization (mainnet-only)

**Goal**: For each **livenet** wallet, fetch full tx history and normalize into deterministic `PortfolioTxEvent[]`.

Work:
- Enforce gating:
  - if `wallet.network !== Network.mainnet`, mark excluded in `metaByWalletId` and skip
- Paging:
  - use existing paging limit (BWS limit) until `loadMore` false
  - record request count in meta
- Normalization:
  - category mapping: `receive | spend | moved`
  - compute `cryptoDelta` and `feeCrypto`
  - set `assetId` using the format defined above
  - dedupe + stable sort
- Update `eventsRevisionByWalletId`.

Debug UI:
- **Wallet Transaction Debug** screen:
  - select wallet
  - show raw tx count + request count
  - show normalized events list
  - highlight events missing required fields
  - export CSV (events)
  - button: **Sync this wallet** (runs wallet-scope sync; later phases extend what this sync does)

Audit (manual):
- Pick 3 wallets:
  - UTXO coin
  - EVM coin (gas asset)
  - EVM token wallet
- Confirm direction/deltas look correct.

Exit criteria:
- Normalized events are deterministic and match expectations.

---

## Phase 3 — Pricing for basis (USD spot at receipt)

**Goal**: Ensure all basis-creating receives have `usdPriceUsed` stored.

Work:
- Basis-creating rule:
  - any event with `cryptoDelta > 0` (incoming)
  - includes `receive` and moved-in
- For each basis event missing `usdPriceUsed`:
  - fetch crypto→USD at `bucketTimeSec` (hourly bucket)
  - write into the event, then bump `eventsRevision`

Caching:
- Use `rateCacheUsdByAssetId[assetId][bucketTimeSec]` as the canonical store.
- `usdPriceUsed` on events should reference a value from the cache.

Debug UI:
- Extend Wallet Transaction Debug:
  - count of missing `usdPriceUsed`
  - last N price fetches (assetId, bucketTimeSec)
  - last error

Audit (manual):
- For a wallet with incoming txs, confirm all incoming events have a USD price.

Exit criteria:
- No missing `usdPriceUsed` for incoming events in sampled wallets.

---

## Phase 4 — Average cost engine (precision + extensibility)

**Goal**: Implement and test the average-cost replay engine used by cursors.

Work:
- Implement pure replay functions:
  - `applyEventToState(state, event) => state`
  - state includes:
    - `cryptoBalance`
    - `costBasisRemainingUSD`
    - `avgCostUSDPerUnit`
- Rules:
  - incoming: add balance; add basis by `basisUSDOverride ?? (cryptoDelta * usdPriceUsed)`
  - spend-like (outgoing delta or fee): subtract balance; subtract basis by `avgCostUSDPerUnit * unitsDisposed`
- Extensibility hook:
  - have the engine optionally return `costBasisUsedUSD` per spend-like application

Precision strategy (v1 pragmatic):
- Keep values as `number` but:
  - clamp non-negative balances/basis
  - avoid compounding float error where possible
- Document a future upgrade path:
  - store crypto in base units (integer)
  - store USD basis in micro-USD (integer)

Tests:
- Unit tests for:
  - buy/receive then partial spend
  - move-out (treated spend-like)
  - moved-in fallback basis assignment
  - fee-only disposal

Debug UI:
- Extend Wallet Transaction Debug:
  - show running state after each event
  - export CSV including derived columns (balance/basis/avg cost)

Audit (manual):
- Compare computed remaining balance/basis to intuitive expectations.

Exit criteria:
- Tests pass; derived state looks sane.

---

## Phase 5 — Wallet interval cursors (45-point series)

**Goal**: Build `WalletIntervalCursor` for each wallet and interval.

Work:
- Grid generation:
  - implement fixed-window grids for 1D/1W/1M/3M/1Y/5Y
  - implement all-time grid using wallet lifetime
- Cursor build:
  - for each grid point time, compute wallet state at that time
  - compute `valueUSD = cryptoBalance * rateUsd(assetId, bucketTimeSec)`
  - if rate missing, set `valueUSD = null` and record missing-rate meta
- Persist cursor with `eventsRevision`.

Incremental refresh:
- If `eventsRevision` unchanged and `endTime` unchanged: no-op.
- If only rates/fx changed: recompute only `valueUSD` fields.
- If `endTime` advanced: shift points and compute new last point.
- If `eventsRevision` changed: rebuild.

Debug UI:
- **Wallet Cursor Debug**:
  - select wallet + interval
  - show grid (start/end/step)
  - show points table
  - show cursor revision vs wallet revision

Audit (manual):
- Advance device time or wait for `endTime` tick; confirm shift behavior.

Exit criteria:
- Wallet cursors update predictably and rebuild when needed.

---

## Phase 6 — FX cache (USD→ALT) and value conversion

**Goal**: Make UI denomination fast and consistent.

Work:
- Implement `fxCacheByAlt[altCurrency][bucketTimeSec]`.
- Fetch FX at the same bucket times needed by charts.
- Breakeven line uses **current remaining basis (now)**:
  - `breakevenALT = costBasisRemainingUSD(now) * fx(nowBucket)`

Debug UI:
- **Rates + FX Debug**:
  - show cache hit/miss counts
  - show buckets stored
  - clear FX only

Exit criteria:
- Switching `altCurrency` updates chart values without recomputing portfolio state.

---

## Phase 7 — Aggregations (wallet → account/key/portfolio) + internal transfer neutralization

**Goal**: Aggregate results across wallets for charts and asset list.

Work:
- Aggregation for fixed-window intervals:
  - grids are standardized → sum by point index where times align
- Aggregation for all-time:
  - define a **group grid** using group lifetime
  - for each grid time, query each wallet’s state at that time (do not assume aligned indices)

Internal transfer neutralization (recommended v1 enhancement):
- At wallet level: keep transfers included.
- At key/portfolio aggregation:
  - attempt to match moved-out with moved-in within the same key/portfolio (heuristic: same `txid` + same `assetId` + close time)
  - neutralize the matched pair’s effect on aggregate PnL (but keep fees reducing holdings/basis)
- If matching is uncertain, fall back to “no neutralization” and expose a debug flag.

Debug UI:
- **Aggregate Debug**:
  - choose scope: wallet/account/key/portfolio
  - show series valueUSD, basisUSD, unrealizedPnLUSD
  - show interval PnL breakdown by wallet
  - show transfer matches (and unmatched candidates)

Exit criteria:
- Aggregate Debug totals match the sum of components.

---

## Phase 8 — Product UI integration (charts + asset list)

**Goal**: Wire computed data into the user-facing UI.

Work:
- Extend existing PriceCharts intervals:
  - add 3M/1Y/5Y/ALL
- Add portfolio value charts for:
  - wallet
  - account (EVM account grouping)
  - key
  - portfolio
- Add asset list:
  - current units, current value in ALT
  - allocation %
  - interval PnL (unrealized change)

UX:
- Show loading/sync state clearly.
- If some wallets are excluded (non-mainnet) or missing rates:
  - show a non-blocking banner/tooltip

Audit (manual):
- Compare UI values against debug screens.

Exit criteria:
- UI renders without relying on debug screens.

---

## Phase 9 — Reliability, persistence safety, and performance

**Goal**: Make long-lived persisted state safe and diagnosable.

Work:
- Persist/rehydrate resilience:
  - log rehydrate errors and fall back to clearing PORTFOLIO slice if corrupted
- Throttling:
  - limit concurrent network requests (tx history, price, fx)
  - add cancellation/guards to prevent overlapping full syncs
- Storage controls:
  - optional: cap rate/fx cache buckets per asset/alt

Debug UI:
- **Sync Status Debug**:
  - per wallet: last sync, last cursor build, last errors, request counts
  - buttons:
    - **Sync Portfolio** (top-down)
    - **Sync Key** (top-down)
    - **Sync Wallet** (targeted)
    - clear wallet cache
    - clear all

Exit criteria:
- No crashes on rehydrate.
- Sync can be rerun safely.

---

## Phase 10 — Optional optimization: checkpoints

**Goal**: Speed up state queries for large histories without changing correctness.

Work:
- Add optional `WalletPositionCheckpoint` every N events.
- Cursor/state queries should:
  - start from nearest checkpoint prior to query time
  - replay forward

Exit criteria:
- Performance improves for very large wallets; results unchanged.

---

## Global acceptance checklist

- All v1 portfolio computations run only for `Network.mainnet` wallets.
- All incoming events have `usdPriceUsed`.
- Wallet cursors:
  - are deterministic
  - rebuild correctly on history backfills
  - update incrementally when `endTime` advances
- “All time” reflects wallet lifetime (and aggregates reflect group lifetime).
- Aggregations match sums and are auditable.
- Clear Portfolio Cache is available and safe.
- Debug hub provides complete audit coverage for every phase.
- Sync can be triggered at wallet/key/portfolio scope, and wallet-only sync updates all containing aggregates automatically.
