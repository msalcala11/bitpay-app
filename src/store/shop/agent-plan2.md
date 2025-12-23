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

### Numeric precision strategy (must-have)

- Portfolio accounting must be deterministic and must not lose on-chain precision.
- Treat all on-chain crypto amounts as **base units** end-to-end:
  - use `bigint` in memory for normalization + accounting
  - persist integers as **decimal strings** (JSON/redux-persist cannot serialize `bigint`)
- Avoid JS `number` for base-unit amounts (can exceed `2^53 - 1`, e.g. `1e18` token base units).
- Treat USD accounting values as fixed-point integers:
  - `usdMicro = round(usd * 1e6)`
  - store and update basis/value/PnL using `usdMicro` as `bigint`
- Only convert to `number` / decimal strings at the **UI boundary** (selectors/formatters/graphs).

### Cost basis method

- **Average cost** (remaining-units basis):
  - Tracked state is integer-based:
    - `cryptoBalanceBase` (base units)
    - `costBasisRemainingMicroUSD` (micro-USD)
  - spend-like events reduce basis proportionally (no floats):
    - `costBasisUsedMicroUSD = (costBasisRemainingMicroUSD * unitsDisposedBase) / cryptoBalanceBase`

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
- `cryptoDeltaBase` (signed, **base units**, persisted as decimal string)
- `feeCryptoBase` (base units; optional; persisted as decimal string)
- `confirmed` / `status`

Pricing + basis fields:
- `usdPriceUsedMicro?: string`
  - micro-USD per 1 crypto unit (persisted as decimal string)
  - **required** for all basis-creating receives (incoming)
- `basisUSDOverrideMicro?: string` (optional, future)

Extensibility fields (do not compute in v1 UI, but design for it):
- `usdPriceAtSpendTimeMicro?: string` (optional, future realized PnL)
- `costBasisUsedMicroUSD?: string` (optional, can be computed during replay)
- `counterpartyWalletId?: string` (optional; future internal transfer linking)

Determinism fields (recommended):
- `eventId: string`
  - stable unique id used for sorting/dedup (e.g. `${walletId}:${txid}:${time}:${cryptoDeltaBase}`)

### Cursor model: `WalletIntervalCursor`

Persisted per wallet per interval.

- `walletId`
- `interval`
- `points[45]`:
  - `time`
  - `cryptoBalanceBase` (decimal string)
  - `costBasisRemainingMicroUSD` (decimal string)
  - `valueMicroUSD` (nullable if missing rate; decimal string)
- `grid` metadata:
  - `startTime`
  - `endTime`
  - `stepSeconds`
- incremental metadata:
  - `eventsRevision` (see invalidation)
  - `lastEventId` or `lastTxIndex`

### Rate + FX caches

Use explicit schemas. For cursor/FX valuation caching, use a single bucket strategy (hourly):

- `rateCacheUsdByAssetId: Record<assetId, Record<bucketTimeSec, string>>`
  - micro-USD per 1 crypto unit (decimal string)
  - used for cursor `valueMicroUSD` computations
- `fxCacheByAlt: Record<altCurrency, Record<bucketTimeSec, string>>`
  - micro-ALT per 1 USD (decimal string)

Bucket rule (for caches):
- `bucketTimeSec = floor(timeSec / 3600) * 3600` (hourly)

Reasons (for caches):
- aligns with `endTime` snapping
- dedupes requests
- works for all intervals (including variable “all time”)

Note:
- Basis pricing for incoming events uses **exact timestamps** and is persisted on events as `usdPriceUsedMicro` (see Phase 3).

### Meta/sync state

Make meta **per wallet** to improve diagnostics:

- `metaByWalletId[walletId]`:
  - `included: boolean` (eligible for portfolio analytics: mainnet + has tx events)
  - `excludedReason?: string`
  - `lastTxSyncAt?: number`
  - `lastCursorBuildAt?: number`
  - `lastRatesSyncAt?: number`
  - `lastError?: string`
  - `lastErrorAt?: number`
  - `lastErrorStage?: 'tx_history' | 'normalize' | 'basis_pricing' | 'cursor_rates' | 'fx' | 'aggregate' | 'persist'`
  - `lastErrorIsRetryable?: boolean`
  - `lastRequestCounts?: {txHistory?: number; prices?: number; fx?: number}`
  - `lastRequestErrors?: {txHistory?: number; prices?: number; fx?: number}`

Persist a minimal global “initial sync” progress state so long-running first-time syncs can resume after an app restart:

- `initialPortfolioSync?:`
  - `status: 'idle' | 'running' | 'complete' | 'failed'`
  - `startedAt?: number`
  - `lastUpdatedAt?: number`
  - `lastError?: string`
  - `lastErrorAt?: number`
  - `backoffUntil?: number`
  - `currentWalletId?: string`
  - `completedWalletCount?: number`
  - `totalWalletCount?: number`

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
  - backfill of missing `usdPriceUsedMicro`

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
- If a wallet’s normalized event list is empty (`0` events), it must be treated as excluded (`excludedReason = 'no_tx_history'`) and the wallet-scope pipeline must short-circuit:
  - do not build cursors
  - do not fetch crypto→USD rates for that wallet
  - do not fetch USD→ALT FX solely because of that wallet
- Key/portfolio scopes delegate to wallet scope for each included wallet (with throttling and guards against overlapping runs).

### Initial background sync + resume (required)

Power users may have many wallets and initial sync may take a long time. The app must be able to start syncing **in the background** on first launch and resume after an app restart.

Requirements:
- **Auto-start**: after store rehydration, kick off an “initial portfolio sync” if any eligible wallet is missing required wallet-level artifacts (tx events, basis pricing, cursors).
- **Non-blocking**: run with low priority and yield to the JS event loop to avoid freezing the UI (use existing throttling patterns; yield periodically while iterating wallets/intervals).
- **Resumable**: persist progress/checkpoints so that if the user kills the app mid-sync, the next launch resumes without redoing completed work.
  - Treat persisted wallet-level artifacts (`txEventsByWalletId`, rate/fx caches, cursors, and `metaByWalletId` timestamps) as the primary resume checkpoints.
  - Use `initialPortfolioSync` for a lightweight global progress indicator (and to avoid restarting from wallet 0 purely for UX).
- **Idempotent**: wallet-scope steps must be safe to re-run for a wallet that was mid-flight when the app exited.

### Aggregate auto-update rule

- Any aggregation that includes a wallet must update automatically when that wallet’s portfolio data changes.
- Prefer deriving aggregates from wallet-level artifacts (tx events + cursors) so no explicit “rebuild aggregates” job is required in v1.
- If persisted aggregate caches are introduced later, they must be invalidated via wallet-level revision(s) and rebuilt automatically.

## Debug UI: Audit Hub (required)

Create/maintain a single entry point screen:

- **Settings → About → Portfolio Analytics (Debug)**

This screen links to phase-specific audit screens below and must exist before Phase 2.

It must also expose **hierarchical sync triggers** (wallet/key/portfolio) and make it easy to verify that aggregates update after a wallet-only sync.

### Debug-triggered run telemetry (required)

All debug screens must display a lightweight “sync telemetry” view for any **debug UI triggered** data fetch/aggregation runs.

Telemetry must include:
- run start/end timestamps and total duration
- current elapsed time while running
- **API request counts**, broken down by:
  - request type (tx history vs rates)
  - wallet(s) the request is attributable to
  - optional: sub-type (tx history page requests vs crypto→USD basis timestamp requests vs crypto→USD cursor bucket requests vs USD→ALT FX bucket requests)
- **API error counts**, broken down by:
  - request type + wallet
  - retry attempts
  - last error (message + best-effort HTTP status)

UI update constraints:
- Update counters “real-time-ish”, but throttle/batch updates (for example, flush at 250–500ms) to avoid re-render storms.
- Prefer computing elapsed time from a stored `startedAt` in the UI rather than writing an “elapsed” value on every tick.
- Keep telemetry non-persisted to disk (do not persist via redux-persist) and cap retained history (example: last 20 runs).
- Telemetry must be stored outside screen-local component state (for example, in a Redux slice or singleton) so that:
  - leaving and returning to a debug screen shows the latest in-progress run status (request counts, duration)
  - telemetry continues updating “behind the scenes” even while debug screens are unmounted
  - multiple debug screens can observe the same run consistently

### API request error handling (required)

Portfolio sync is network-dependent and long-running. **All API requests must fail safely** and must never crash the app or corrupt persisted state.

Definitions:
- **Retryable** errors (retry with backoff): connection errors, timeouts, `429`, and `5xx`.
- **Non-retryable** errors (do not retry): most `4xx` (except `429`), invalid request parameters, unsupported assets, and parse/schema errors.

Retry policy (recommended defaults):
- Tx history page requests:
  - up to 2 retries for retryable errors
  - exponential backoff with jitter (example: 2s, then 5s)
- USD price fetch requests (basis timestamp):
  - up to 2 retries for retryable errors
  - exponential backoff with jitter (example: 0.5s, then 2s)
- FX fetch requests:
  - up to 2 retries for retryable errors
  - exponential backoff with jitter (example: 0.5s, then 2s)

Failure behavior (wallet/key/portfolio scope):
- **Wallet scope**:
  - If tx history ingestion fails: stop the wallet pipeline (do not proceed to pricing/cursors), record `metaByWalletId[walletId].lastError*`, and keep the last good persisted artifacts.
  - If pricing fails for some events: leave those events missing `usdPriceUsedMicro`, record error counts, and treat the wallet as **not ready** for cursor build until resolved.
  - If cursor valuation rates are missing: set `valueMicroUSD = null` for those points and record missing-rate meta (do not crash).
- **Key/portfolio scope**:
  - Continue syncing other wallets even if one wallet fails.
  - The overall run result must surface “partial success” and list failed wallets + stage.

Persistence safety:
- Never write partially-corrupted wallet artifacts.
- Only bump `eventsRevision` if the persisted event list actually changed.
- On errors, persist the latest error fields in `metaByWalletId` (stage/message/time/retryable) so the next run can resume and debug UI can explain what happened.

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

Redux effects (no new effects required in this phase; identify and instrument existing):
- `GetTransactionHistory(args: {wallet: Wallet; transactionsHistory: any[]; limit: number; refresh?: boolean; contactList?: any[]; isAccountDetailsView?: boolean; isExportHistoryView?: boolean;}): Effect<Promise<{transactions: any[]; loadMore: boolean; hasConfirmingTxs: boolean}>>`
- `fetchFullTransactionHistoryForWallet(wallet: Wallet): Effect<Promise<{transactions: any[]; requestCount: number}>>`
- `syncPortfolioTxEventsForWallet(wallet: Wallet): Effect<Promise<{events: PortfolioTxEvent[]; requestCount: number}>>`
- `startGetRates(args: {context?: UpdateAllKeyAndWalletStatusContext; force?: boolean}): Effect<Promise<Rates>>`
- `fetchHistoricalRates(dateRange?: DateRanges, currencyAbbreviation?: string, fiatIsoCode?: string): Effect<Promise<Array<Rate>>>`

Instrumentation:
- Add `logManager` info/error logs for:
  - portfolio sync start/end per wallet (include duration)
  - tx history request counts per wallet
  - rates request counts per wallet
  - request failures + retry attempts (include stage + best-effort HTTP status)
  - debug-triggered run summary (scope, wallets, total duration, request totals)
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

Redux effects (add/extend):
- `clearPortfolioCache(): Effect<void>`

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
  - latest debug-triggered run telemetry summary (duration + per-wallet request counts by type)
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

Redux effects (add/extend):
- `fetchFullTransactionHistoryForWallet(wallet: Wallet): Effect<Promise<{transactions: any[]; requestCount: number}>>`
- `normalizeTxHistoryToPortfolioTxEvents(wallet: Wallet, transactions: any[]): Effect<PortfolioTxEvent[]>`
- `syncPortfolioTxEventsForWallet(wallet: Wallet): Effect<Promise<{events: PortfolioTxEvent[]; requestCount: number}>>`
- `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>`
- `syncPortfolioKeyScope(args: {keyId: string}): Effect<Promise<void>>`
- `syncPortfolioPortfolioScope(): Effect<Promise<void>>`

Work:
- Enforce gating:
  - if `wallet.network !== Network.mainnet`, mark excluded in `metaByWalletId` and skip
- Paging:
  - use existing paging limit (BWS limit) until `loadMore` false
  - record request count in meta
- Error handling:
  - if tx history fetch fails for a wallet, record `lastErrorStage = 'tx_history'` and continue syncing other wallets (do not mark `no_tx_history`)
  - only set `excludedReason = 'no_tx_history'` when tx history + normalization succeeded and the normalized events length is `0`
- Normalization:
  - category mapping: `receive | spend | moved`
  - compute `cryptoDeltaBase` and `feeCryptoBase` (base units)
  - set `assetId` using the format defined above
  - dedupe + stable sort
- Update `eventsRevisionByWalletId`.
- Empty-history rule:
  - if normalized events length is `0`, mark excluded (`excludedReason = 'no_tx_history'`) and skip all later pipeline steps for this wallet (rates/FX/cursors/aggregation).

Debug UI:
- **Wallet Transaction Debug** screen:
  - select wallet
  - show raw tx count
  - show request counts (tx history + rates) for the selected wallet (live while running, and for the most recent run)
  - show last run duration (and live elapsed while running)
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

## Phase 3 — Pricing for basis (USD spot at receipt; exact timestamp)

**Goal**: Ensure all basis-creating receives have `usdPriceUsedMicro` stored.

Redux effects (add/extend):
- `getOrFetchUsdRateByAssetIdAtTime(args: {assetId: string; timeSec: number}): Effect<Promise<string>>`
- `backfillUsdPriceUsedForWallet(walletId: string): Effect<Promise<{pricesFetched: number; pricesFailed: number; requestCount: number}>>`
- Extend `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>` to include basis price backfill.

Work:
- Basis-creating rule:
  - any event with `BigInt(cryptoDeltaBase) > 0n` (incoming)
  - includes `receive` and moved-in
- For each basis event missing `usdPriceUsedMicro`:
  - fetch crypto→USD at the **exact event timestamp**
    - `timeSec = event.time`
    - request timestamp should be `tsMs = timeSec * 1000` (BWS expects ms)
  - convert to micro-USD (`usdPriceUsedMicro`) and write into the event, then bump `eventsRevision`

Caching + dedupe:
- Deduplicate in-flight requests by exact `(assetId, timeSec)` while a backfill run is executing.
- Do **not** persist per-event exact timestamp USD rates in `rateCacheUsdByAssetId` (canonical persisted value is `PortfolioTxEvent.usdPriceUsedMicro`).

Error handling:
- If a USD price request fails after retries:
  - leave the event missing `usdPriceUsedMicro`
  - increment `metaByWalletId[walletId].lastRequestErrors.prices`
  - set `metaByWalletId[walletId].lastErrorStage = 'basis_pricing'`
  - do not proceed to cursor build for that wallet until missing prices are resolved

Debug UI:
- Extend Wallet Transaction Debug:
  - count of missing `usdPriceUsedMicro`
  - last N price fetches (assetId, timeSec)
  - last error

Audit (manual):
- For a wallet with incoming txs, confirm all incoming events have a USD price.

Exit criteria:
- No missing `usdPriceUsedMicro` for incoming events in sampled wallets.

---

## Phase 4 — Average cost engine (precision + extensibility)

**Goal**: Implement and test the average-cost replay engine used by cursors.

Redux effects:
- No new Redux effects required in this phase (pure functions used by cursor-building effects).

Work:
- Implement pure replay functions:
  - `applyEventToState(state, event) => state`
  - state includes:
    - `cryptoBalanceBase` (`bigint`)
    - `costBasisRemainingMicroUSD` (`bigint`)
- Rules:
  - incoming:
    - add balance using base units
    - add basis using micro-USD:
      - `basisAddedMicroUSD = basisUSDOverrideMicro ?? (abs(cryptoDeltaBase) * usdPriceUsedMicro) / unitToSatoshi`
  - spend-like (outgoing delta or fee):
    - `unitsDisposedBase = abs(cryptoDeltaBase) + feeCryptoBase`
    - reduce basis using average-cost ratio (do not compute floats):
      - `costBasisUsedMicroUSD = (costBasisRemainingMicroUSD * unitsDisposedBase) / cryptoBalanceBase`
- Extensibility hook:
  - have the engine optionally return `costBasisUsedMicroUSD` per spend-like application

Precision strategy (v1 required):
- The replay engine must use **only integer math** (`bigint`) for crypto + USD accounting.
- Rounding policy must be explicit and deterministic (recommended: integer division rounds down).
- After a full disposal, ensure remaining basis and balance resolve to exactly `0` (no tiny negative/positive drift).

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

Redux effects (add/extend):
- `buildCursorForWalletInterval(walletId: string, interval: PortfolioInterval): Effect<Promise<void>>`
- `buildCursorsForWallet(args: {walletId: string; intervals?: PortfolioInterval[]}): Effect<Promise<{built: number}>>`
- Extend `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>` to include cursor builds.

Work:
- Skip cursor builds entirely for wallets excluded from portfolio analytics (non-mainnet or `no_tx_history`).
- Grid generation:
  - implement fixed-window grids for 1D/1W/1M/3M/1Y/5Y
  - implement all-time grid using wallet lifetime
- Cursor build:
  - for each grid point time, compute wallet state at that time
  - compute `valueMicroUSD = (cryptoBalanceBase * rateMicroUsd(assetId, bucketTimeSec)) / unitToSatoshi`
  - if rate missing, set `valueMicroUSD = null` and record missing-rate meta
- Persist cursor with `eventsRevision`.

Incremental refresh:
- If `eventsRevision` unchanged and `endTime` unchanged: no-op.
- If only rates/fx changed: recompute only `valueMicroUSD` fields.
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

Redux effects (add/extend):
- `getOrFetchFxRateUsdToAltByBucket(args: {altCurrency: string; bucketTimeSec: number}): Effect<Promise<string>>`
- `ensureFxRatesForAltCurrency(args: {altCurrency: string; bucketTimeSecs: number[]}): Effect<Promise<{fetched: number; failed: number; requestCount: number}>>`
- Extend `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>` to ensure required FX buckets.

Work:
- Implement `fxCacheByAlt[altCurrency][bucketTimeSec]`.
- Fetch FX at the same bucket times needed by charts.
- Breakeven line uses **current remaining basis (now)**:
  - `breakevenAltMicro = (costBasisRemainingMicroUSD(now) * fxMicro(nowBucket)) / 1_000_000`

Error handling:
- If FX fetch fails after retries:
  - keep existing FX cache values
  - record `lastErrorStage = 'fx'` and increment `lastRequestErrors.fx`
  - UI may fall back to USD until FX is available (do not block basis or cursor builds)

Debug UI:
- **Rates + FX Debug**:
  - show cache hit/miss counts
  - show buckets stored
  - show request counts (rates + FX) per wallet (live while running, and for the most recent run)
  - show last run duration (and live elapsed while running)
  - clear FX only

Exit criteria:
- Switching `altCurrency` updates chart values without recomputing portfolio state.

---

## Phase 7 — Aggregations (wallet → account/key/portfolio) + internal transfer neutralization

**Goal**: Aggregate results across wallets for charts and asset list.

Redux effects:
- No new Redux effects required in this phase (prefer selectors/pure functions; do not persist aggregate caches in v1).

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
  - show series `valueMicroUSD`, `costBasisRemainingMicroUSD`, `unrealizedPnlMicroUSD` (and formatted USD/ALT)
  - show interval PnL breakdown by wallet
  - show transfer matches (and unmatched candidates)
  - show last aggregation compute duration (best-effort) and last run duration

Exit criteria:
- Aggregate Debug totals match the sum of components.

---

## Phase 8 — Product UI integration (charts + asset list)

**Goal**: Wire computed data into the user-facing UI.

Redux effects (reuse):
- Reuse `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>` for “ensure data is ready” on wallet screens.
- Reuse `syncPortfolioKeyScope(args: {keyId: string}): Effect<Promise<void>>` / `syncPortfolioPortfolioScope(): Effect<Promise<void>>` where appropriate.

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

Redux effects (add/extend):
- `startInitialPortfolioSync(): Effect<Promise<void>>`
- `resumeInitialPortfolioSyncIfNeeded(): Effect<Promise<void>>`
- Extend `syncPortfolioWalletScope(args: {walletId: string}): Effect<Promise<void>>` with cancellation/guards and low-priority yielding.

Work:
- Persist/rehydrate resilience:
  - log rehydrate errors and fall back to clearing PORTFOLIO slice if corrupted
- Throttling:
  - limit concurrent network requests (tx history, price, fx)
  - add cancellation/guards to prevent overlapping full syncs
- Retries + backoff:
  - implement the retry policy described in “API request error handling”
  - avoid tight retry loops during background initial sync (respect `initialPortfolioSync.backoffUntil` when set)
- Background initial sync + resume:
  - on app launch (post rehydrate), automatically run initial portfolio sync in the background until complete
  - update persisted checkpoints frequently enough that killing the app does not force a full restart
  - on next launch, resume from persisted checkpoints and skip already-completed wallets/intervals
- Storage controls:
  - optional: cap rate/fx cache buckets per asset/alt

Debug UI:
- **Sync Status Debug**:
  - per wallet: last sync start/end + duration, last cursor build, last errors, request counts (tx history vs rates)
  - while a run is active: show live request counts and elapsed time
  - show `initialPortfolioSync` status + progress (completed/total + current wallet)
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

## Phase 10 — Optional optimization: batch historical fiat rates (multi-timestamp; CDN-friendly)

**Goal**: Reduce network overhead for cursor-rate prefetching (and optionally basis pricing) by fetching many timestamps in a single request, and make those requests cacheable at the CDN layer.

BWS (server) work:
- Add a batch endpoint for historical rates:
  - input: `fiatCode`, `coin`, and a list of `tsMs[]`
  - output: a stable sorted list of `HistoricRate[]` (or a map keyed by `ts`)
- CDN cache friendliness requirements:
  - use `GET` and keep the URL deterministic
  - require clients to sort `tsMs` ascending before requesting
  - cap batch size (example: 50–100 timestamps) and require clients to chunk deterministically
  - allow partial results (do not fail the whole batch because 1 timestamp is missing)

Client (app) integration:
- Cursor valuation rates:
  - collect missing `bucketTimeSec` values per `(assetId, fiatCode)`
  - request `tsMs = bucketTimeSec * 1000` in deterministic, sorted batches
  - write successful results into `rateCacheUsdByAssetId[assetId][bucketTimeSec]`
- Basis pricing (optional; large backfills only):
  - batch exact `event.time * 1000` lookups per `(assetId, fiatCode)`
  - still persist canonical per-event prices to `PortfolioTxEvent.usdPriceUsedMicro`

Error handling + telemetry:
- Treat a batch request as one network request but track:
  - timestamps requested vs returned vs failed
- Partial success is allowed:
  - store returned rates immediately
  - retry only missing timestamps (respect the global retry/backoff policy)
- Debug UI must surface batch effectiveness:
  - total rate network requests
  - total timestamps requested/resolved
  - optional estimate: cache hit ratio (`resolvedFromCache / requestedTotal`)

Exit criteria:
- Fixed-window interval cursor builds require significantly fewer HTTP requests for rates, with unchanged computed values.

---

## Phase 11 — Optional optimization: checkpoints

**Goal**: Speed up state queries for large histories without changing correctness.

Redux effects (add/extend):
- `buildWalletPositionCheckpoints(args: {walletId: string; checkpointEveryNEvents?: number}): Effect<Promise<void>>`

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
- All incoming events have `usdPriceUsedMicro`.
- All portfolio accounting uses base-unit crypto + micro-USD fixed-point integers (`bigint` in memory, decimal strings in persisted state).
- Wallet cursors:
  - are deterministic
  - rebuild correctly on history backfills
  - update incrementally when `endTime` advances
- “All time” reflects wallet lifetime (and aggregates reflect group lifetime).
- Aggregations match sums and are auditable.
- Clear Portfolio Cache is available and safe.
- Debug hub provides complete audit coverage for every phase.
- Sync can be triggered at wallet/key/portfolio scope, and wallet-only sync updates all containing aggregates automatically.
- Debug UI shows per-wallet request counts (tx history vs rates) and run durations for debug-triggered syncs with smooth, throttled updates.
- Transient API failures do not crash the app; errors are recorded per wallet/stage and surfaced in debug UI (with retries/backoff and no persisted state corruption).
- Wallets with no tx history are excluded (`excludedReason = 'no_tx_history'`) and do not trigger cursor builds or rate/FX fetches.
- Initial portfolio sync can run in the background on first launch and resumes on next launch after an app kill, without redoing completed work.
