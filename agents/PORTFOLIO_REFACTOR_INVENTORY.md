# Portfolio Refactor — Phase 0 Inventory

**Status:** Phase 0 deliverable. Pinned facts about the current codebase that downstream phases (1–9) depend on. All file paths and line numbers verified against the working tree at this commit.

---

## 1. Portfolio UI consumers

UI surfaces that read portfolio data and will migrate in Phase 7.

### Home root

| Component | Path | Reads | Hook/client |
|---|---|---|---|
| `PortfolioBalance` | `src/navigation/tabs/home/components/PortfolioBalance.tsx` | total balance, balance-history chart with timeframe selector, change row | manual Redux + `BalanceHistoryChart` |
| `AssetsSection` | `src/navigation/tabs/home/components/AssetsSection.tsx` | top-N assets preview, gain/loss mode | `usePortfolioAssetRows()` |
| `AllocationSection` | `src/navigation/tabs/home/components/AllocationSection.tsx` | allocation donut/legend | pure data transform — no portfolio hook |

### Full-screen portfolio screens

| Screen | Path | Hook |
|---|---|---|
| `AllAssets` | `src/navigation/tabs/home/screens/AllAssets.tsx` | `usePortfolioAssetRows({gainLossMode, keyId, externalRefreshToken})` |
| `Allocation` | `src/navigation/tabs/home/screens/Allocation.tsx` | `buildAllocationDataFromWalletRows` (no v1 hook) |

### Per-wallet/account/key portfolio surfaces

| Screen | Path | Reads |
|---|---|---|
| `WalletDetails` | `src/navigation/wallet/screens/WalletDetails.tsx` | `BalanceHistoryChart`, `usePortfolioWalletSnapshotPresence()` |
| `AccountDetails` | `src/navigation/wallet/screens/AccountDetails.tsx` | `BalanceHistoryChart` (account scope) |
| `KeyOverview` | `src/navigation/wallet/screens/KeyOverview.tsx` | `BalanceHistoryChart` (key scope) |

### Asset detail / Exchange Rate screens

| Screen | Path | Hook |
|---|---|---|
| `AssetBalanceHistoryScreen` | `src/navigation/wallet/screens/exchange-rate/AssetBalanceHistoryScreen.tsx` | `usePortfolioAnalysis({wallets, quoteCurrency})` |
| `ExchangeRateScreen` (market detail) | `src/navigation/wallet/screens/exchange-rate/ExchangeRateScreen.tsx` | `useRuntimeFiatRateSeriesCache(...)` |
| `ExchangeRatesList` (Home section) | `src/navigation/tabs/home/components/exchange-rates/ExchangeRatesList.tsx` | Redux `RATE` slice |

### Debug

| Screen | Path | Client method |
|---|---|---|
| `PortfolioDebug` | `src/navigation/tabs/settings/about/screens/PortfolioDebug.tsx` | `getPortfolioRuntimeClient()` (wallet index, snapshot inspect, clear, populate) |
| `PortfolioWalletDebug` | `src/navigation/tabs/settings/about/screens/PortfolioWalletDebug.tsx` | `getPortfolioRuntimeClient()` (per-wallet tx history, balance diagnostic) |
| `StorageUsage` | `src/navigation/tabs/settings/about/screens/StorageUsage.tsx` | `getPortfolioRuntimeClient()` (storage stats) |

**Total UI surfaces migrating in Phase 7:** 12 screens + 3 components.

---

## 2. Redux state paths

### `state.PORTFOLIO` — `src/store/portfolio/`

Files (1,204 LOC total):

- `portfolio.types.ts` (88) — action enums + discriminated union
- `portfolio.models.ts` (38) — `PortfolioState`, `PortfolioPopulateStatus`, `SnapshotBalanceMismatch`
- `portfolio.reducer.ts` (263) — 8 action types
- `portfolio.actions.ts` (65) — action creators
- `portfolio.runtime.effects.ts` (733) — populate orchestration
- `portfolio.utils.ts` (17)

State shape:

```ts
state.PORTFOLIO = {
  lastPopulatedAt?: number,
  quoteCurrency?: string,
  populateDisabled: boolean,
  populateStatus: {
    inProgress: boolean,
    startedAt?: number, finishedAt?: number, elapsedMs?: number,
    stopReason?: string,
    currentWalletId?: string,
    walletsTotal: number, walletsCompleted: number,
    txRequestsMade: number, txsProcessed: number,
    errors: Array<{walletId, message}>,
    walletStatusById?: Record<string, 'in_progress' | 'done' | 'error'>
  },
  snapshotBalanceMismatchesByWalletId?: Record<string, SnapshotBalanceMismatch>
};
```

Action types: `CLEAR_PORTFOLIO`, `CANCEL_POPULATE_PORTFOLIO`, `START_POPULATE_PORTFOLIO`, `UPDATE_POPULATE_PROGRESS`, `CLEAR_WALLET_PORTFOLIO_STATE`, `FINISH_POPULATE_PORTFOLIO`, `FAIL_POPULATE_PORTFOLIO`, `SET_SNAPSHOT_BALANCE_MISMATCHES_BY_WALLET_ID_UPDATES`.

### `state.PORTFOLIO_CHARTS` — `src/store/portfolio-charts/` (509 LOC)

Persists chart cache with LRU eviction (max 40 scopes). **Stores large `ts[]`, `totalFiatBalance[]`, `totalPnlChange[]` arrays in Redux** — slated for deletion in Phase 8b.

### `state.RATE` — `src/store/rate/` (271 LOC)

```ts
state.RATE = {
  rates: Record<string, Rate[]>,           // live rates, keys like "BTC_USD"
  lastDayRates: Record<string, Rate[]>,
  ratesCacheKey: Record<number, number>,
  ratesUpdatedAt?: number
};
```

**No explicit `quoteCurrency` field.** Quote is encoded in the rate-key suffix (`"_USD"`). The new architecture's quote-metadata-safety rule requires either:

- (A) verifying the live-rate slice is always maintained in the current display quote (Phase 0 finding: see §11 below), or
- (B) adding `getLiveRatesQuoteCurrencyFromStore()` to `reduxAccess.ts` and making passive live-rate touches no-op on quote mismatch.

Action types: `SUCCESS_GET_RATES`, `FAILED_GET_RATES`, `UPDATE_CACHE_KEY`, `CLEAR_RATE_STATE`.

### `state.APP` (portfolio-relevant fields)

| Field | Path | Default |
|---|---|---|
| `hideAllBalances` | `state.APP.hideAllBalances` | `false` |
| `showPortfolioValue` | `state.APP.showPortfolioValue` | `true` |
| `defaultAltCurrency` | `state.APP.defaultAltCurrency` (`{isoCode, name}`) | `{isoCode: 'USD', name: 'US Dollar'}` |
| `pinLockActive` | `state.APP.pinLockActive` | `false` |
| `biometricLockActive` | `state.APP.biometricLockActive` | `false` |
| `lockAuthorizedUntil` | `state.APP.lockAuthorizedUntil` | `undefined` |

### `state.WALLET` (visibility fields)

| Field | Path | Action |
|---|---|---|
| `hideKeyBalance` | `state.WALLET.keys[keyId].hideKeyBalance` | (no dedicated action — set in-place) |
| `hideAccount` | `state.WALLET.keys[keyId].evmAccountsInfo[accountAddress].hideAccount` | `WalletActionTypes.TOGGLE_HIDE_ACCOUNT` |
| `hideWallet` | `state.WALLET.keys[keyId].wallets[*].hideWallet` | `WalletActionTypes.TOGGLE_HIDE_WALLET` |
| `hideWalletByAccount` | `state.WALLET.keys[keyId].wallets[*].hideWalletByAccount` | (cascaded by `TOGGLE_HIDE_ACCOUNT`) |
| `hideBalance` | `state.WALLET.keys[keyId].wallets[*].hideBalance` | (legacy) |
| `network` | `state.WALLET.keys[keyId].wallets[*].network` | wallet creation/import |

### Store + access

- `getStore()` — `src/store/index.ts` (default export, returns `Promise<{store, persistor}>`)
- `RootState` — `ReturnType<typeof rootReducer>` exported from `src/store/index.ts`
- Existing fire-time access pattern: thunk closures (`(dispatch, getState) => { const state = getState(); ... }`)
- **Direct fire-time `store.getState()` reads from non-React code are NOT yet established.** The new `src/portfolio/v2/reduxAccess.ts` (Phase 1) wires this via `getStore().then(...)` callback in `index.js`.

---

## 3. MMKV key prefixes

All prefixes verified at construction sites:

| Prefix | Key format | Construction site |
|---|---|---|
| `snap:meta:v2:*` | `snap:meta:v2:${walletId}` | `src/portfolio/core/pnl/snapshotStore.ts:146` |
| `snap:index:v2:*` | `snap:index:v2:${walletId}` | `src/portfolio/core/pnl/snapshotStore.ts:150` |
| `snap:chunk:v2:*` | `snap:chunk:v2:${walletId}:${chunkId}` | `src/portfolio/core/pnl/snapshotStore.ts:154` |
| `snap:invalid-history:v1:*` | `snap:invalid-history:v1:${walletId}` | `src/portfolio/core/pnl/snapshotStore.ts:158` |
| `snap:*:*:*` (legacy hydrated points) | `snap:${walletId}:${ts}:${rowIndex}` | `src/portfolio/core/pnl/snapshotStore.ts:162` |
| `rate:v1:*` | `rate:v1:${quote}:${coin}:${interval}[:${chain}:${tokenAddress}]` | `src/portfolio/core/pnl/fiatRateStore.ts` (rateKey ~line 30) + `src/portfolio/runtime/worklet/portfolioWorkletRates.ts:50` |

Mirror implementations in worklet runtime: `src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts` (lines 27, 32, 40, 45, 233).

**Phase 0 conclusion:** the complete set of portfolio-adjacent prefixes in MMKV is `['snap:', 'rate:v1:', 'portfolio:v2:']`. The actual default wipe set per the spec's Phase 7.5 — and per §5 below — is `['portfolio:v2:', 'snap:']` only; `rate:v1:*` is intentionally excluded because Exchange Rate screens share that cache. The list above is "candidate prefixes," not the wipe target.

---

## 4. Portfolio MMKV instance + registry

| Item | Value | Location |
|---|---|---|
| Instance ID | `'bitpay.portfolio.engine'` | `src/portfolio/adapters/rn/workletMmkvBridge.ts:8` |
| JS accessor | `getPortfolioMmkvStorageOnRN()` | `src/portfolio/adapters/rn/workletMmkvBridge.ts:20-26` |
| Worklet bridge accessor | `getPortfolioMmkvNativeStorageOnRN()` | `src/portfolio/adapters/rn/workletMmkvBridge.ts:53-58` |
| Registry key | `'__bitpay.portfolio.engine.registry.v1__'` | `src/portfolio/adapters/rn/mmkvKvStore.ts:10-11` |
| KvStore class | `MmkvKvStore` | `src/portfolio/adapters/rn/mmkvKvStore.ts:160` |
| `kvStore.delete(key)` untracks from registry | ✅ verified | `src/portfolio/adapters/rn/mmkvKvStore.ts:193-196` |

**Current MMKV instance/registry facts:** the registry-aware delete path (`kvStore.delete(key)`) untracks each key from the registry, so the v1 wipe convention has been "enumerate via `getPortfolioMmkvStorageOnRN().getAllKeys()` as the real source of truth (not `kvStore.listKeys()`), filter by `PORTFOLIO_WIPE_PREFIXES`, delete via `kvStore.delete(key)` so the registry stays consistent." V2 wipe behavior is superseded by the plan's helper-family contract: `clearPortfolioMmkvKeysForReset(...)` enumerates the **union** of real keys plus registry-tracked keys, filters by portfolio-owned prefixes, and routes every removal through `deletePortfolioMmkvKey(...)`. See the implementation plan's "MMKV registry discipline" and helper-family sections for the v2 contract.

---

## 5. `rate:v1:*` sharing with Exchange Rate screens — **YES**

Exchange Rate detail (`ExchangeRateScreen.tsx`) uses `useRuntimeFiatRateSeriesCache(...)` → `loadRuntimeFiatRateSeriesCache(...)` → `getPortfolioRuntimeClient().getRateSeriesCache(...)`, which calls `FiatRateStore.ensureRates(...)` and persists results to the same `rate:v1:*` MMKV cache.

**Implication for Phase 7.5 wipe:** default `PORTFOLIO_WIPE_PREFIXES = ['portfolio:v2:', 'snap:']` — does NOT include `rate:v1:*`. Wiping shared market-rate cache on Show Portfolio off would force Exchange Rate screens to refetch on every navigation.

**Implication for Phase 13 trigger architecture:** Exchange Rate screen navigation **does** persist new historical `rate:v1:*` data. This satisfies the Phase 0 condition for adding `onHistoricalRatesPersisted(...)`. See §13 below.

---

## 6. `SnapshotIndexV2.revision` field — **does NOT exist**

Type at `src/portfolio/core/pnl/snapshotStore.ts:108-116`:

```ts
export type SnapshotIndexV2 = {
  v: 2;
  walletId: string;
  compressionEnabled: boolean;
  chunkRows: number;
  chunks: SnapshotChunkMetaV2[];
  checkpoint: SnapshotPopulateCheckpointV1;
  updatedAt: number;
  // NO revision field
};
```

**Phase 2 must add `revision: number`.** First persisted value is `1`; `0` is the "no index" sentinel. `saveIndex` increments on every save. Update fixtures in `snapshotStore.spec.ts` and `portfolioWorkletSnapshots.ts` (worklet mirror).

---

## 7. Reset paths

| Path | Location | Trigger | Clears | Coordinated |
|---|---|---|---|---|
| BitPayID disconnect | `src/store/bitpay-id/bitpay-id.effects.ts:613-692` (`startDisconnectBitPayId`) | User logout | NO portfolio data | N/A |
| Debug "Clear All" | `src/navigation/tabs/settings/about/screens/PortfolioDebug.tsx:580-596` → `clearPortfolioWithRuntime({populateDisabled: false})` | Button | Runtime KV (snap, rate) + `state.PORTFOLIO` + `state.PORTFOLIO_CHARTS` | ✅ full |
| Reset All Settings | `src/store/app/app.effects.ts:1036-1060` (`resetAllSettings`) | Button | Same as Debug Clear All + app settings | ✅ full |
| Debug "Clear Rates" | `PortfolioDebug.tsx:598-606` → `client.clearRateStorage()` | Button | Runtime rate KV only | ✅ |
| Debug "Clear Charts" | `PortfolioDebug.tsx:608-617` → `clearPortfolioCharts()` | Button | `state.PORTFOLIO_CHARTS` only | partial |
| Show Portfolio off | `src/navigation/tabs/settings/components/General.tsx:103-129` | User toggle | `state.PORTFOLIO` + `state.PORTFOLIO_CHARTS` (Redux only); **does NOT clear runtime KV** | ❌ incomplete |
| Key delete | `src/store/index.ts:379-405` (`cleanupPortfolioOnDeleteKeyMiddleware`) → `clearWalletPortfolioDataWithRuntime({walletIds})` | `WalletActionTypes.DELETE_KEY` | Per-wallet runtime snapshots + Redux per-wallet state | ✅ full |
| `persistor.purge()` | `src/store/index.ts:554-556` | (commented out) | (n/a) | n/a |

**Phase 6 / 7.5 implication:** the new `performResetSequence(...)` replaces all of the above runtime-coordinated paths. Show Portfolio off (currently incomplete) becomes the toggle-driven `performResetSequence` path. Key delete becomes `onWalletsDeleted({walletIds})` with the triple-guard contract.

---

## 8. Visibility actions

| Action constant | Type string | File | Payload |
|---|---|---|---|
| `WalletActionTypes.TOGGLE_HIDE_WALLET` | `'WALLET/TOGGLE_HIDE_WALLET'` | `src/store/wallet/wallet.types.ts:47` | `{wallet: Wallet}` (carries `keyId` + `id`) |
| `WalletActionTypes.TOGGLE_HIDE_ACCOUNT` | `'WALLET/TOGGLE_HIDE_ACCOUNT'` | `src/store/wallet/wallet.types.ts:48` | `{accountAddress: string; keyId: string; accountToggleSelected?: boolean}` |
| `AppActionTypes.TOGGLE_HIDE_ALL_BALANCES` | `'APP/TOGGLE_HIDE_ALL_BALANCES'` | `src/store/app/app.types.ts:66` | optional `boolean` |

UI dispatch sites:

- `TOGGLE_HIDE_WALLET`: `src/navigation/wallet/screens/WalletSettings.tsx`
- `TOGGLE_HIDE_ACCOUNT`: `WalletSettings.tsx`, `AccountSettings.tsx`
- `TOGGLE_HIDE_ALL_BALANCES`: `PortfolioBalance.tsx`, `AccountDetails.tsx`, `WalletDetails.tsx`, `KeyOverview.tsx`, `General.tsx`

**Cascading rule:** `TOGGLE_HIDE_ACCOUNT` cascades to `wallet.hideWalletByAccount` for all wallets under that account.

**`hideKeyBalance`** has no dedicated action — set in-place inside wallet/account toggle reducers. (Wire-up note for Phase 6: the visibility middleware must observe both flags + the cascaded `hideWalletByAccount` to compute `affectedWalletIds`.)

**Key import:** `WalletActionTypes.SUCCESS_IMPORT` carries the imported `Key` (with wallet array). `onKeyImported({key})` filters by `isLivenetWallet(...)` before queuing.

---

## 9. Post-auth signal — `AppActionTypes.LOCK_AUTHORIZED_UNTIL`

| Item | Value |
|---|---|
| Action constant | `AppActionTypes.LOCK_AUTHORIZED_UNTIL` (`'APP/LOCK_AUTHORIZED_UNTIL'`) |
| Defined | `src/store/app/app.types.ts:73` |
| Dispatched from | `src/components/modal/pin/PinModal.tsx:146-148`, `src/components/modal/biometric/BiometricModal.tsx` |
| Payload | `authorizedUntil: number` (timestamp) |
| Observer | `src/Root.tsx:300-559` |
| Persisted state | `state.APP.lockAuthorizedUntil: number \| undefined` |
| `state.APP.pinLockActive` | gate flag |
| `state.APP.biometricLockActive` | gate flag |

Fires on:
1. First launch after PIN setup (during onboarding)
2. Each subsequent app foreground after re-auth

**`onAppLaunchPostAuth(...)` wiring (Phase 6):** subscribe to `state.APP.lockAuthorizedUntil` becoming defined (transitioning from `undefined` to a valid timestamp). Alternative: middleware on the `LOCK_AUTHORIZED_UNTIL` action.

---

## 10. Trigger sites

### Send completion

`src/store/wallet/effects/send/send.ts:1274` (`publishAndSign`). After broadcast at line 1471, dispatches:

- `waitForTargetAmountAndUpdateWallet({key, wallet, targetAmount, recipient})` — line 1483 (after 3s `setTimeout`)
- `startUpdateWalletStatus({key, wallet, force: true})` — line 1492 (single-copayer path)

**No portfolio populate trigger today.** `src/store/wallet/effects/send/send.ts` does not import portfolio code. **Phase 6 must add `onSendCompleted({walletId})` wiring at line ~1471 (post-broadcast) or via a new middleware on a successful-send action.**

### Pull-to-refresh

| Screen | Path:line | Refreshes |
|---|---|---|
| `WalletDetails` | `src/navigation/wallet/screens/WalletDetails.tsx:543` | `startGetRates({})`, `startUpdateWalletStatus({force: true})`, `debouncedLoadHistory(true)`, `updatePortfolioBalance()` |
| `AccountDetails` | `src/navigation/wallet/screens/AccountDetails.tsx:1319` | `startGetRates({})` + status updates |
| `KeyOverview` | `src/navigation/wallet/screens/KeyOverview.tsx:1049` | rate + status updates |
| Home | (no per-screen `RefreshControl`; pull-to-refresh wired through inner sections) | — |

**`changedWalletIds` derivation:** the existing handlers do not produce a `changedWalletIds` list. Phase 6's `onPullToRefresh({changedWalletIds})` requires the trigger caller to derive this set — either by snapshotting wallet balances pre-refresh and diffing post-refresh, or by inspecting the `startUpdateWalletStatus` outcome.

### Quote currency change

`AppActionTypes.SET_DEFAULT_ALT_CURRENCY` mutates `state.APP.defaultAltCurrency`. Dispatch sites in settings flow.

**No portfolio populate trigger today.** Phase 6 adds `onQuoteCurrencyChanged({newQuote})` wiring on this action.

### Live rates updated

`src/store/wallet/effects/rates/rates.ts:35` (`startGetRates`). Calls `BASE_BWS_URL/v3/fiatrates/` and dispatches `successGetRates({rates, lastDayRates})`. **`v3` endpoint is the live-rate path.** Historical `rate:v1:*` cache uses the `v4` endpoint via `FiatRateStore.ensureRates(...)`.

**Frequency:** on-demand from pull-to-refresh and explicit calls. Cache validated via `RATES_CACHE_DURATION` (`isCacheKeyStale(...)`).

**Live-rate quote currency:** rates are fetched in **all alt currencies at once** (BWS `v3/fiatrates/` returns the full alt-currency table). Lookup at consumer sites uses `state.APP.defaultAltCurrency.isoCode` to pick the row. **Conclusion: live rates are NOT exclusively in the current display quote — they cover all currencies, and the consumer projects.** This means the new architecture's "passive live-rate quote-metadata safety" check is satisfied by construction: any current-quote read against `state.RATE.rates` is intrinsically quote-tagged via the rate-key suffix. **`getLiveRatesQuoteCurrencyFromStore()` is not needed**; passive `liveRateTouch` recompute reads the current-quote rates from the existing slice and the data is valid by construction.

---

## 11. Live-rate Redux slice quote invariant — **resolved by construction**

See §10 above. `state.RATE.rates` is keyed `${COIN}_${QUOTE}` and contains entries for **all** alt currencies the user can switch to. Recompute reads the rows matching `state.APP.defaultAltCurrency.isoCode`. There is no quote-mismatch state because every quote's data is present simultaneously.

**Phase 0 conclusion:** Option (A) from the plan's passive live-rate quote-metadata-safety section. No new accessor required because the live-rate slice is keyed by `${COIN}_${QUOTE}` and contains all alt currencies simultaneously, so any current-quote read is intrinsically quote-tagged. Document this invariant in Phase 1 `reduxAccess.ts` so a future implementer doesn't try to add `getLiveRatesQuoteCurrencyFromStore()` thinking it's missing.

---

## 12. Exchange Rate screen historical-rate persistence — **YES, persists**

`ExchangeRateScreen.tsx:118` uses `useRuntimeFiatRateSeriesCache(...)` →
`src/portfolio/ui/fiatRateSeries.ts:87` (`loadRuntimeFiatRateSeriesCache`) →
`getPortfolioRuntimeClient().getRateSeriesCache(...)` →
`src/portfolio/core/engine/portfolioEngine.ts:316` (`this.rateStore.ensureRates(...)`).

`ensureRates(...)` fetches and persists to `rate:v1:*` MMKV when entries are stale or missing.

**Phase 0 decision (per the "Historical rates persisted notification" Phase-0-conditional in §13 "Trigger behavior" of the implementation plan):** add `onHistoricalRatesPersisted(...)`. The trigger is needed because Exchange Rate screen navigation can persist new historical rate data outside v2-owned trigger paths.

Signature (per spec):

```ts
export function onHistoricalRatesPersisted(args: {
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  source: 'exchangeRateScreen' | 'manualRefresh' | 'externalEffect';
}): void;
```

The Exchange Rate screen's `useRuntimeFiatRateSeriesCache(...)` hook is the natural insertion point: after a successful `getRateSeriesCache(...)` resolves with newly persisted data, fire `onHistoricalRatesPersisted({source: 'exchangeRateScreen', ...})`.

---

## 13. Invalid-history behavior

| Item | Location |
|---|---|
| Constants & types | `src/portfolio/core/pnl/invalidHistory.ts` |
| Marker version | `SNAPSHOT_INVALID_HISTORY_VERSION = 1` |
| Retry cooldown | `SNAPSHOT_INVALID_HISTORY_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000` (24h) |
| Error name | `'PortfolioInvalidHistoryError'` |
| Error code | `'PORTFOLIO_INVALID_HISTORY_NEGATIVE_BALANCE'` |
| `createNegativeBalanceInvalidHistoryError(...)` | `invalidHistory.ts:32-52` (worklet-tagged) |
| `isSnapshotInvalidHistoryError(...)` | `invalidHistory.ts:54-69` (worklet) |
| `toSnapshotInvalidHistoryMarker(...)` | `invalidHistory.ts:71-107` (worklet) |
| `isSnapshotInvalidHistoryMarkerActive(...)` | `invalidHistory.ts:109-120` (worklet) |
| Marker save (worklet) | `src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts:530` (`saveWorkletInvalidHistoryMarker`) |
| Marker save (JS) | `src/portfolio/core/pnl/snapshotStore.ts:566` (`saveInvalidHistoryMarker`) |
| Marker clear (JS) | `src/portfolio/core/pnl/snapshotStore.ts:588` (`clearInvalidHistoryMarker`) |
| `clearWallet({preserveInvalidHistoryMarker: true})` | `snapshotStore.ts:511-521` (JS) and `portfolioWorkletSnapshots.ts:422-434` (worklet) |
| Populate-decision suppression | `src/portfolio/service/portfolioStaleness.ts:53-60` (`getPortfolioPopulateDecisionForWallet`) — checks `isSnapshotInvalidHistoryMarkerActive(invalidHistory)` |
| Populate-loop save site | `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts:1137` |

**Phase 5 must preserve verbatim:** marker shape (`{v, walletId, reason, detectedAt, retryAfter, message, source?, txId?, balanceAtomic?}`), 24h cooldown default, `preserveInvalidHistoryMarker: true` flag, `getPortfolioPopulateDecisionForWallet` suppression, `markManifestPopulated` clears the marker on success.

---

## 14. JS-thread helper module surface (Nitro spy targets)

For the Phase 5 + Phase 2 Nitro boundary tests (currently test #120 in the plan's lock-blocker test list).

### `src/portfolio/adapters/rn/txHistorySigning.ts` (1112 LOC)

**JS-tagged exports — spy targets (assert never called from worklet):**

| Export | Lines | Reason |
|---|---|---|
| `createPortfolioTxHistorySigningDispatchContextOnRN` | 716-786 | Builds dispatch context using JS-only deps (bitcore, Nitro require) |
| `signBwsGetRequestWithBitcore` | 996-1013 | Pure JS bitcore ECDSA signing |

**Worklet-tagged exports — NOT spy targets:**

| Export | Lines |
|---|---|
| `ensurePortfolioRuntimeSigningGlobals` | 354 |
| `createTransferredNitroBwsSigningBatchOnRN` | 596-636 |
| `signBwsGetRequestWithTransferredNitro` | 968-994 |
| `setPortfolioTxHistorySigningDispatchContextOnRuntime` | 1015-1024 |
| `clearPortfolioTxHistorySigningDispatchContextOnRuntime` | 1026-1032 |
| `getPortfolioTxHistorySigningDispatchContextOnRuntime` | 1034-1042 |
| `requirePortfolioTxHistorySigningDispatchContextOnRuntime` | 1044-1058 |
| `getPortfolioNitroFetchClientOnRuntime` | 1060-1078 |
| `takeNextPortfolioTransferredSignHandleOnRuntime` | 1080-1112 |

**Hybrid:** `probeQuickCryptoRequestPubKeyDerivationOnRN` (638-714) — `'worklet'`-tagged but designed to run from JS for probes. Boundary test should not spy on this; it's a debug-only probe.

### `src/portfolio/adapters/rn/txHistoryRequest.ts` (223 LOC)

All exports worklet-tagged:

| Export | Lines |
|---|---|
| `buildPortfolioTxHistoryRequestPath` | 48-81 |
| `appendPortfolioTxHistoryCacheBustParam` | 83-102 |
| `fetchPortfolioTxHistoryPageByRequest` | 161-223 |

No JS-tagged exports — nothing to spy on for this module. Boundary tests assert these are reached only from worklet code.

### `src/portfolio/adapters/rn/bwsFiatRateProvider.ts` (61 LOC)

| Export | Lines | Tag |
|---|---|---|
| `RnBwsFiatRateProvider` (class with `loadSeries(...)` method) | 13-60 | worklet-tagged |

**No JS-tagged BWS rate-fetch exports exist** — that's the desired state. The provider is worklet-only by construction.

**Rate-fetch boundary test instrumentation surface:** because there are no JS-tagged BWS helpers to spy on directly, the Phase 2 rate-fetch Nitro boundary test asserts the invariant by instrumenting the *outside* of the runtime boundary instead of the inside:

1. **Spy on `createPortfolioTxHistorySigningDispatchContextOnRN`** (already in the txhistory spy list — same JS-tagged context creator is used by both populate and ensureFresh). Assert it is called once per `ensureFresh(...)` invocation to build the lightweight (non-signing) dispatch context, then never re-called inside the rate-fetch loop.
2. **Spy on the global `fetch` / `axios.get` / Node-side HTTP transports.** Assert zero calls during `ensureFresh(...)`. All HTTP must go through the Nitro fetch client inside the worklet runtime — any JS-thread HTTP call is a regression. Existing live-rate `axios.get(...)` calls in `src/store/wallet/effects/rates/rates.ts` are NOT a regression (they belong to the live-rate path, not historical-rate `ensureFresh`).
3. **Spy on `runOnRuntimeAsync`** (or whatever the `react-native-worklets` dispatch adapter is named in Phase 1). Assert `ensureFresh(...)` dispatches `RnBwsFiatRateProvider.loadSeries(...)` to the rate-fetch runtime, not the populate runtime, not JS.
4. **Anti-regression variant:** stub `ensureFresh` to call a hand-written JS-thread BWS fetch helper (e.g., a direct `axios.get(...)` to `/v4/fiatrates/`) and assert the test fails. This proves the boundary test catches regressions that bypass the worklet path.

The intent matches the txhistory boundary test, but the assertion shape differs because the BWS module has no JS surface to spy on — instead the test asserts on transport-level invariants (no JS HTTP, dispatch goes to rate-fetch runtime).

### Spy-target summary (for Nitro boundary tests instrumentation, currently test #120)

```ts
// JS-thread spy targets — assert spies have zero calls during populate / ensureFresh:
import * as txHistorySigning from 'src/portfolio/adapters/rn/txHistorySigning';
jest.spyOn(txHistorySigning, 'createPortfolioTxHistorySigningDispatchContextOnRN');
jest.spyOn(txHistorySigning, 'signBwsGetRequestWithBitcore');

// Note: createPortfolioTxHistorySigningDispatchContextOnRN IS called by JS at populate kick time
// (to build the context that is passed into the worklet runtime). The spy assertion is:
// "during the populate loop iteration itself (between kick and completion), this is not called."
// Phase 5 implementation must build the context once before kick, not per-page or per-wallet
// inside the loop.
```

---

## 15. PORTFOLIO_V2 feature flag — implemented

Files added in this phase:

- `src/portfolio/v2/constants.ts` — pinned constants per spec (`PORTFOLIO_V2_FLAG_KEY`, `PORTFOLIO_CACHE_INVALID_KEY`, `MANIFEST_KEY`, `POPULATE_QUEUE_KEY`, `CANONICAL_RATE_QUOTE = 'USD'`, `MAX_SCOPED_CACHE_ENTRIES = 8`, `MAX_CHART_POINTS = 89`, `PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS = 150`).
- `src/portfolio/v2/featureFlag.ts` — `isPortfolioV2EnabledOnJS()` + `isPortfolioV2EnabledOnWorklet(bridge)` + `setPortfolioV2EnabledForTesting(enabled)`. Default: false (absent key reads as false).
- `src/portfolio/v2/featureFlag.spec.ts` — 4 tests: absent-key, value `'1'`, deletion, key string verification. All pass.

**Persistence:** `portfolio:v2:flag` key, value `'1'` for enabled, anything else (or absent) for disabled. Stored in the dedicated portfolio MMKV instance.

**No external imports yet.** Verified via grep: `src/portfolio/v2/` has no callers from outside the v2 directory. Phase 0 acceptance ("no behavior change with flag off") satisfied — the flag module is dormant.

---

## 16. Phase 0 acceptance check

| Acceptance criterion | Status |
|---|---|
| Inventory document checked in | ✅ this file |
| Feature flag readable on JS path | ✅ `isPortfolioV2EnabledOnJS()` |
| Feature flag readable on worklet path | ✅ `isPortfolioV2EnabledOnWorklet(bridge)` |
| No behavior change with flag off | ✅ no v2 imports outside `src/portfolio/v2/`; flag default false |

---

## 17. Phase 1 prerequisites surfaced by Phase 0

These are facts/decisions the implementer reading Phase 1 needs:

1. **`getStore()` is async** (returns `Promise<{store, persistor}>`). `reduxAccess.ts` initialization must run inside the existing `getStore().then(({store, persistor}) => {...})` callback in `index.js` before `<Provider>` mounts.
2. **`RootState`** is exported from `src/store/index.ts` as `ReturnType<typeof rootReducer>`.
3. **Live rates cover all alt currencies simultaneously** — quote-mismatch safety check is satisfied by construction; no `getLiveRatesQuoteCurrencyFromStore()` accessor needed.
4. **Exchange Rate screen DOES persist `rate:v1:*` data** — `onHistoricalRatesPersisted(...)` trigger is required (the YES branch of the Phase-0-conditional in the implementation plan's "Historical rates persisted notification" section under §13).
5. **`SnapshotIndexV2` does NOT have a `revision` field** — Phase 2 must add it.
6. **Portfolio MMKV instance + registry already exist** — `getPortfolioMmkvStorageOnRN()`, `MmkvKvStore`, `DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY` are all production-ready. Phase 1 `kvStore.ts` wraps `MmkvKvStore` against the dedicated portfolio storage.
7. **No existing populate-on-send / populate-on-pull / populate-on-quote-change wiring** — Phase 6 introduces all three trigger hooks at the integration sites identified in §10.
8. **Visibility middleware new** — Phase 6 adds a middleware that observes `TOGGLE_HIDE_WALLET`, `TOGGLE_HIDE_ACCOUNT`, and `hideKeyBalance` reducer paths, derives `affectedWalletIds`, and dispatches `onWalletsVisibilityChanged({affectedWalletIds})`.
9. **`BWS v3` is the live-rate endpoint; `BWS v4` is the historical-rate endpoint.** The v4 path is what the new architecture's `ensureFresh(...)` routes through.
10. **`changedWalletIds` for pull-to-refresh** is not currently produced — Phase 6 must add the diffing logic (pre/post-refresh balance snapshot) at each refresh handler.
11. **TypeScript baseline is not clean.** `yarn validate` currently surfaces pre-existing errors in `HomeRoot.tsx` and wallet-status files unrelated to portfolio v2. Phase 1's "typecheck green" gate must either fix or document an exception around these. The new `src/portfolio/v2/` files do typecheck cleanly in isolation; the failures are inherited from the existing baseline.
12. **Daily snapshot compression checkpoint state already survives resume.** [snapshotStream.ts:355-461](src/portfolio/core/pnl/snapshotStream.ts#L355-L461) declares `SnapshotStreamCheckpoint.daily` (`dayIdx`, `lastTimestamp`, `lastMarkRate`, `balanceAtomic`, `remainingCostBasisFiat`, `txIds`), `BalanceSnapshotStreamBuilder` rehydrates it through its constructor, and `getCheckpoint()` re-emits the in-progress UTC bucket. [snapshotStore.ts:74-111](src/portfolio/core/pnl/snapshotStore.ts#L74-L111) persists the same `daily?` field plus `compressionEnabled` on `SnapshotPopulateCheckpointV1`/wallet meta. App-kill resume picks up the partial UTC day without duplicating or dropping a daily snapshot. **Caveat:** `COMPRESSION_AGE_MS = 90 * DAY_MS` is hardcoded inline at [snapshotStream.ts:11](src/portfolio/core/pnl/snapshotStream.ts#L11) and `compressionEnabled` is currently a constructor arg with no v2-constants default. Per the new daily-compression contract, v2 must thread `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS` and `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED` through the builder so the constants module is the single source of truth — this is the reason the kernel below is reclassified from `reuse unchanged` to `adapt before v2 use`.

---

## 18. Retained-kernel classification

Phase 0/8b acceptance requires that each kernel module the implementation plan keeps in v2 carry an explicit per-module classification, not a directory-wide keep decision. Labels:

- `reuse unchanged` — v2 imports as-is; tests cover behavior under the new contracts without modification.
- `adapt before v2 use` — module needs targeted edits (new field, tighter typing, or removal of a forbidden helper) before v2 phases can depend on it; the changes are surgical, not a rewrite.
- `test fixture only` — kept solely as a reference/fixture for v2 test parity; not imported by v2 production code paths.
- `delete after soak` — retained only to keep v1 working during rollout; deleted once the v2 flag is fully on and the legacy paths are unreferenced.

| Module | Classification | Rationale |
|---|---|---|
| [src/portfolio/core/pnl/analysisStreaming.ts](src/portfolio/core/pnl/analysisStreaming.ts) | adapt before v2 use | Holds `clampWalletAnalysisState(...)`, which decision #34 forbids inside the per-step PnL kernel. v2 must remove or relocate this helper out of the streaming-analysis hot path before reuse. |
| [src/portfolio/core/pnl/snapshotStream.ts](src/portfolio/core/pnl/snapshotStream.ts) | adapt before v2 use | Checkpoint state for in-progress UTC-day compression is already fully persisted and rehydrated (see §17 prereq #12), so app-kill resume is correct as-is. The adapt is narrow: `COMPRESSION_AGE_MS` is hardcoded as `90 * DAY_MS` inside the file and `compressionEnabled` has no v2-constants default. v2 must thread `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS` and `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED` from `src/portfolio/v2/constants.ts` through the builder constructor so the constants module is the single source of truth. The existing 90-day numeric default may stay as the v1 fallback for legacy callers; only v2 callers are required to pass the constants. No logic rewrite. |
| [src/portfolio/core/pnl/snapshotStore.ts](src/portfolio/core/pnl/snapshotStore.ts) | adapt before v2 use | `SnapshotIndexV2` has no `revision` field today (see §17 prereq #5). Phase 2 must add the revision field and the matching invalidation/migration so v2 manifest/queue logic can rely on it. The chunk-write path (currently parameterized only by `chunkRows`) must also enforce the new byte-fallback split rule from the MMKV sharding contract: when a row-budget-sized chunk would exceed `PORTFOLIO_MMKV_VALUE_WARN_BYTES`, split further by byte size before emitting. Plan storage acceptance #7 requires a chunk test proving byte-size splitting takes precedence over the row-budget target. |
| [src/portfolio/core/pnl/fiatRateStore.ts](src/portfolio/core/pnl/fiatRateStore.ts) | adapt before v2 use | Must enforce the `StoredRateInterval` set (1D/1W/1M/ALL only) at the type and runtime boundary; today the `FiatRateProvider` and `FiatRateStore` accept the full `FiatRateInterval` union including 3M/1Y/5Y, which v2 forbids persisting. |
| [src/portfolio/core/txHistoryPaging.ts](src/portfolio/core/txHistoryPaging.ts) | reuse unchanged | Load-bearing helper for the txhistory duplicate-row contract. `getTxHistoryEntryId(...)` prefers on-chain hash fields (`txid`, `txHash`, `txhash`, `hash`) and intentionally refuses to use BWS internal `id`; `dedupeTxHistoryPage(...)` collapses duplicate economic rows before snapshot/PnL processing; `getTxHistoryLogicalPageSize(...)` advances paging by logical unique transaction count rather than raw fetched row count. Existing tests cover duplicate txids, composite fallback identity, and internal-ID-only duplicates. |
| [src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts](src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts) | adapt before v2 use | Builder contract over `Tx` + rate-lookup is intact and v2 just swaps the rate-lookup source — checkpoint resume already covers in-progress daily compression state. The same constants-source-of-truth caveat as [snapshotStream.ts](src/portfolio/core/pnl/snapshotStream.ts) applies: this module also hardcodes `COMPRESSION_AGE_MS = 90 * DAY_MS` at [portfolioWorkletSnapshotBuilder.ts:32](src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts#L32) and accepts `compressionEnabled` as a constructor arg with no v2-constants default. v2 must thread `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS` and `PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED` through both the worklet builder and the JS-thread builder so the constants module is the single source of truth. No logic rewrite. |
| [src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts](src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts) | adapt before v2 use | Existing worker-protocol entry point handles populate sessions but predates the work-epoch + Nitro-boundary contracts (decisions #28, #34, #36). v2 must thread `workEpoch` through every prepare/process/finish call and ensure no JS-trampoline helpers are reachable from inside the loop body. |
| [src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts](src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts) | adapt before v2 use | Snapshot key/index helpers must move under the dedicated portfolio MMKV instance + registry, and read/write through the v2 KV adapter rather than free-standing `workletKv*` calls so the registry tracker sees every key (per the implementation plan's "MMKV registry discipline" and helper-family sections governing reset/wipe). The worklet-side chunk emitter (currently parameterized only by `chunkRows`) must enforce the same byte-fallback split rule as the JS-thread chunk writer in [snapshotStore.ts](src/portfolio/core/pnl/snapshotStore.ts): when a row-budget-sized chunk would exceed `PORTFOLIO_MMKV_VALUE_WARN_BYTES`, split further by byte size before calling the worklet-side `writePortfolioMmkvString` wrapper. |
| [src/portfolio/runtime/worklet/portfolioWorkletRates.ts](src/portfolio/runtime/worklet/portfolioWorkletRates.ts) | adapt before v2 use | Rate-fetch worklet must run on the dedicated rate-fetch runtime, route signing/request/response processing through the Nitro boundary (decision #36), enforce `StoredRateInterval`, and persist canonical market-rate series through the v2 rate store. It must **not** build `WeightedGroupRateSeries`; weighted group series are render-derived in compute/recompute from persisted constituent market rates plus scoped baseline holdings. |

> Note: `src/portfolio/v2/` is not subject to this classification — it is the new kernel, not a retained one. RN adapter modules are classified separately in §19.

---

## 19. RN adapter classification

Phase 0/8b acceptance also requires that each module in `src/portfolio/adapters/rn/` carry an explicit classification. The implementation plan forbids a directory-wide keep/delete decision because v2-dependent Nitro/MMKV/rate/signing adapters must remain reachable until equivalent v2 adapter modules exist. Labels:

- `v2 adapter, keep in place` — module already implements a v2-shaped contract at its current path; v2 imports it as-is.
- `v2 adapter, relocate to src/portfolio/v2/adapters/rn/**` — module's contract belongs in v2, but the file should move under the v2 namespace before the legacy path is unreferenced.
- `v1-only adapter, delete after soak` — module exists only to wire the v1 engine and has no v2 equivalent; deleted once v2 is fully on.
- `shared low-level adapter, keep and document owner` — module is consumed by both v1 and v2 (or sits below the v2 line entirely); keep at current path and record the owning subsystem.

| Module | Classification | Rationale / Owner |
|---|---|---|
| [src/portfolio/adapters/rn/bwsFiatRateProvider.ts](src/portfolio/adapters/rn/bwsFiatRateProvider.ts) | v2 adapter, relocate to `src/portfolio/v2/adapters/rn/**` | Implements the rate-fetch Nitro boundary (decision #36). Belongs under v2 once `FiatRateStore`'s `StoredRateInterval` tightening (§18) lands so its `loadSeries` signature matches v2 directly. |
| [src/portfolio/adapters/rn/mmkvKvStore.ts](src/portfolio/adapters/rn/mmkvKvStore.ts) | shared low-level adapter, keep and document owner | Generic `KvStore`-over-MMKV with the registry tracker — consumed by both v1 and v2 against the same dedicated `bitpay.portfolio.engine` instance. Owner: portfolio-storage. |
| [src/portfolio/adapters/rn/portfolioEngineOptions.ts](src/portfolio/adapters/rn/portfolioEngineOptions.ts) | v1-only adapter, delete after soak | Constructs the v1 `PortfolioEngineOptions`. v2 wires its own runtimes/clients directly and does not consume `PortfolioEngineOptions`. |
| [src/portfolio/adapters/rn/txHistoryPageFetcher.ts](src/portfolio/adapters/rn/txHistoryPageFetcher.ts) | v1-only adapter, delete after soak | Thin wrapper that adapts `fetchPortfolioTxHistoryPageByRequest` to the v1 `TxHistoryPageFetcher` signature. v2's populate runtime calls the request module directly through the Nitro boundary, so this adapter has no v2 caller. |
| [src/portfolio/adapters/rn/txHistoryRequest.ts](src/portfolio/adapters/rn/txHistoryRequest.ts) | v2 adapter, keep in place | Encodes the BWS tx-history request (URL, headers, signing handle plumbing) and routes token wallet pages through [src/portfolio/core/tokenTxHistory.ts](src/portfolio/core/tokenTxHistory.ts) for token-effect normalization. Already routed through `getPortfolioNitroFetchClientOnRuntime()`; v2 populate's loop body imports this directly per decision #36. |
| [src/portfolio/adapters/rn/txHistorySigning.ts](src/portfolio/adapters/rn/txHistorySigning.ts) | v2 adapter, keep in place | Owns the worklet-runtime signing globals, transferred-handle pool, and Nitro fetch client. Required at its current path because both v1 and v2 import the same global-installation helpers; the JS-side context creator named in the Nitro spy-target inventory lives here. |
| [src/portfolio/adapters/rn/walletEligibility.ts](src/portfolio/adapters/rn/walletEligibility.ts) | shared low-level adapter, keep and document owner | Pure-function wallet eligibility (livenet/credentials/TSS) used by both v1 and v2 trigger sites. Owner: wallet-eligibility. |
| [src/portfolio/adapters/rn/walletMappers.ts](src/portfolio/adapters/rn/walletMappers.ts) | shared low-level adapter, keep and document owner | Maps Redux `Wallet` shape into `WalletCredentials`/`WalletSummary`/`StoredWallet`. Consumed by every trigger site. Owner: wallet-mapping. |
| [src/portfolio/adapters/rn/workletMmkvBridge.ts](src/portfolio/adapters/rn/workletMmkvBridge.ts) | shared low-level adapter, keep and document owner | Lazy-singleton over the dedicated `bitpay.portfolio.engine` MMKV. Both v1 engine and v2 KV adapter resolve through this bridge. Owner: portfolio-storage. |
| [src/portfolio/adapters/rn/workletRuntimeShared.ts](src/portfolio/adapters/rn/workletRuntimeShared.ts) | adapt before v2 use | Currently exposes a single runtime name + signing-globals installer. v2 needs three distinct runtime names (compute / populate / rate-fetch) and per-runtime install + teardown; the helper must be widened before v2 phases consume it. |

---

## 20. MMKV mutation spy-target inventory

Phase 0 acceptance requires that the MMKV mutation spy-target surface be checked in so the Phase 5/6 zero-write tests for timeframe switches, chart scrubbing, and passive live-rate touches have a stable set of exports to intercept (decision #37). The v2 mutation helpers do not exist yet — they are Phase 1 deliverables. This inventory records the future helper family plus every current low-level mutation export the spy tests must intercept, so that:

- Phase 1 implements the v2 mutation helper family as the single legal v2 entry points and routes every v2 caller through them.
- Phase 5/6 zero-write tests can spy both the future helpers (positive assertion: helpers are never called from read-only UI paths) and every low-level mutation export (negative assertion: no v2 caller bypasses the helpers to hit the underlying MMKV).

### Future v2 helper family (Phase 1 deliverable)

`writePortfolioMmkvString(...)` only covers string writes. Deletes and reset-time clears need their own helpers so the spy surface stays type-clean and metrics carry the right reason for each mutation kind:

```ts
// src/portfolio/v2/storage/writePortfolioMmkvString.ts (Phase 1)
export function writePortfolioMmkvString(args: {
  key: string;
  value: string;
  reason: PortfolioMmkvWriteReason;
  allowOversize?: boolean;
}): void;

// src/portfolio/v2/storage/deletePortfolioMmkvKey.ts (Phase 1)
export function deletePortfolioMmkvKey(args: {
  key: string;
  reason: PortfolioMmkvWriteReason;
}): void;

// src/portfolio/v2/storage/clearPortfolioMmkvKeysForReset.ts (Phase 1)
// Real-key-enumeration + registry-aware delete loop; NOT a `clearAll` proxy.
export function clearPortfolioMmkvKeysForReset(args: {
  reason: Extract<PortfolioMmkvWriteReason, 'reset' | 'wipe'>;
}): void;
```

All v2 mutations — manifest, queue, snap meta/index/chunk, invalid-history markers, rate cache, work epoch, cache-invalid bit, feature flag, reset/wipe sentinel writes, and any future generated-render-cache keys — must route through one of these three helpers. `generatedRenderCache` is reserved for the optional Phase 9 measured-cold-start cache path and must not be used in Phase 1-8 unless that optional cache is explicitly added by benchmark decision. Tests assert per-`reason` call counts via the redacted `PortfolioV2Metric` union without inspecting logger strings or exposing raw MMKV keys.

### Current low-level mutation exports the spy tests must intercept

The helper family above delegates to a subset of these low-level mutations depending on caller context (JS thread vs worklet runtime). Phase 1 must lock down the export surface so spy tests can assert no v2 caller reaches these directly. **Note**: only the string-write helper *wraps* the underlying writer; deletes/clears are wrapped only by their own helpers, and `clearAll` is intentionally **not** wrapped (see the row note).

| Export | Path | Wrapped by | Notes |
|---|---|---|---|
| `MmkvKvStore.setString(key, value)` | [src/portfolio/adapters/rn/mmkvKvStore.ts:182](src/portfolio/adapters/rn/mmkvKvStore.ts#L182) | `writePortfolioMmkvString` | JS-thread write through the registry-aware portfolio store. v2 reset/wipe and JS-thread metadata writes flow through this. |
| `MmkvKvStore.delete(key)` | [src/portfolio/adapters/rn/mmkvKvStore.ts:193](src/portfolio/adapters/rn/mmkvKvStore.ts#L193) | `deletePortfolioMmkvKey` | JS-thread delete with registry update. Spied independently of the string-write helper because deletes carry their own metric reason. |
| `workletKvSetString(config, key, value)` | [src/portfolio/runtime/worklet/portfolioWorkletKv.ts:94](src/portfolio/runtime/worklet/portfolioWorkletKv.ts#L94) | `writePortfolioMmkvString` (worklet-side wrapper, Phase 1) | Worklet-runtime string write. Used by populate/rate-fetch runtime code and by the snapshot worklet helpers. The Phase 1 worklet wrapper emits the same `PortfolioV2Metric { kind: 'mmkvWrite' }` record as the JS-thread wrapper. |
| `workletKvDelete(config, key)` | [src/portfolio/runtime/worklet/portfolioWorkletKv.ts:133](src/portfolio/runtime/worklet/portfolioWorkletKv.ts#L133) | `deletePortfolioMmkvKey` (worklet-side wrapper, Phase 1) | Worklet-runtime delete; same metric/spy treatment as the JS-thread delete. |
| `workletKvClearAll(config)` | [src/portfolio/runtime/worklet/portfolioWorkletKv.ts:165](src/portfolio/runtime/worklet/portfolioWorkletKv.ts#L165) | **not wrapped** — spy/forbid for v2 reset | Low-level registry-only clear. The plan's safer wipe contract is real-key enumeration plus registry-aware deletes (`clearPortfolioMmkvKeysForReset`), not a registry-only clear-all sweep. v2 reset/wipe must **not** call `workletKvClearAll` unless it is rewritten to satisfy the real-key-enumeration contract; spy tests forbid v2 callers from reaching it. |
| `MMKV.set` / `MMKV.delete` (raw) | `react-native-mmkv` | **not wrapped** — forbidden | Forbidden in v2 outside the registry initialization in [workletMmkvBridge.ts](src/portfolio/adapters/rn/workletMmkvBridge.ts) and the low-level adapters above. Spy tests assert no v2 caller reaches the raw module. |

### Read-only path coverage required by decision #37

Zero-write spy tests must cover, at minimum:

- timeframe selector changes (1D/1W/1M/3M/1Y/5Y/ALL) on Home, KeyOverview, AccountDetails, WalletDetails, AssetDetails, and Exchange Rate screens;
- chart scrub gestures across all of the above;
- passive live-rate updates that fire `onLiveRatesUpdated` while no user-initiated trigger is active.

Each path must produce zero calls to `writePortfolioMmkvString(...)`, `deletePortfolioMmkvKey(...)`, `clearPortfolioMmkvKeysForReset(...)`, and zero calls to every low-level mutation listed above (with the exception of the registry-init write performed once at app boot, which Phase 1 must explicitly exclude from the spy assertion or perform before the spies attach). Anti-regression variants stub a read-only path to call `writePortfolioMmkvString({reason: 'rate'})`, `deletePortfolioMmkvKey({reason: 'rate'})`, or any forbidden low-level mutation; the spy tests must fail.

### Migration tracking belongs to Phase 1

This inventory does **not** enumerate every current call site of `kvStore.setString(...)` / `kvStore.delete(...)` / `workletKvSetString(...)` / `workletKvDelete(...)` that v2 must migrate to the helper family. That migration list is Phase 1 implementation work, not a Phase 0 deliverable. Phase 0's contract is satisfied by naming the helper family, the wrapped low-level exports, the explicitly **un**wrapped exports (clear-all, raw MMKV) that v2 must avoid, and the read-only paths the spy tests must cover.
