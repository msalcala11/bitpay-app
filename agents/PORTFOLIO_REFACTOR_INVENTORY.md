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

**Wipe contract:** enumerate via `getPortfolioMmkvStorageOnRN().getAllKeys()` (real source of truth, not `kvStore.listKeys()`), filter by `PORTFOLIO_WIPE_PREFIXES`, delete via `kvStore.delete(key)` so the registry stays consistent.

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

**Phase 0 conclusion:** Option (A) from spec decision #25's quote-safety contract. No new accessor required. Document this invariant in Phase 1 `reduxAccess.ts` so a future implementer doesn't try to add `getLiveRatesQuoteCurrencyFromStore()` thinking it's missing.

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

For the Phase 5 + Phase 2 Nitro boundary tests (test #100 in the spec).

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
3. **Spy on `runOnRuntimeAsync`** (or whatever the Reanimated dispatch wrapper is named in Phase 1). Assert `ensureFresh(...)` dispatches `RnBwsFiatRateProvider.loadSeries(...)` to the rate-fetch runtime, not the populate runtime, not JS.
4. **Anti-regression variant:** stub `ensureFresh` to call a hand-written JS-thread BWS fetch helper (e.g., a direct `axios.get(...)` to `/v4/fiatrates/`) and assert the test fails. This proves the boundary test catches regressions that bypass the worklet path.

The intent matches the txhistory boundary test, but the assertion shape differs because the BWS module has no JS surface to spy on — instead the test asserts on transport-level invariants (no JS HTTP, dispatch goes to rate-fetch runtime).

### Spy-target summary (for test #100 instrumentation)

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
