# Portfolio Analytics Implementation Plan

## Goals

1. Plot fiat balance line graphs for every wallet, key, and the entire portfolio across standard timeframes: **1D, 1W, 1M, 3M, 1Y, 5Y, ALL**.
2. Compute fiat gain/loss over the same intervals for every wallet/key/portfolio while excluding user transfers.
3. Calculate the current fiat value and percentage allocation of every asset within each key and the overall portfolio.
4. React instantly to fiat currency changes by recalculating all metrics using the newly selected alternative currency without redundant network usage.

## Data Sources

| Data | Source | Notes |
| --- | --- | --- |
| Wallet transaction history | `GetTransactionHistory` / `wallet.getTxHistory` | Already paginates; set `limit = BWS_TX_HISTORY_LIMIT` for bulk pulls. |
| Historic fiat rates | `getHistoricFiatRate` (`/v1/fiatrates`) | Accepts arbitrary timestamps; cache results per `(fiat, coin, hour)` bucket. |
| Batched historical rates | `fetchHistoricalRates` (`/v2/fiatrates`) | Used for small chart windows (1D/1W/1M/3M); returns all coins for a fiat ISO code. |
| Current balances | `startFormatBalanceAllWalletsForKey` outputs | Provides live fiat totals used to seed series end-points. |

## Architecture Overview

```
PortfolioAnalyticsModule
├── HistoricalBalanceService
│   ├── buildWalletSeries(walletId, timeframe, fiat)
│   ├── buildKeySeries(keyId, timeframe, fiat)
│   └── buildPortfolioSeries(timeframe, fiat)
├── GainLossService
│   └── computeGainLoss(entityId, entityType, timeframe, fiat)
├── AllocationService
│   └── computeAllocations(scope, fiat)
└── FiatRateCache
    ├── getRate(coin, fiat, timestamp)
    └── primeRange(coin, fiat, timeframe)
```

All services live under `src/store/portfolio` with Redux-managed state so UI components consume memoized selectors.

## Processing Pipeline

### 1. Historical Balance Series

1. **Load transactions:**
   ```ts
   fetchFullHistory(walletId: string): Promise<Transaction[]>;
   ```
   - Wraps repeated `GetTransactionHistory` calls until `loadMore` is false.

2. **Normalize chronologically:** sort ascending, map to `{timestamp, deltaCrypto, feeCrypto, action}`.

3. **Detect transfers:**
   ```ts
   classifyTransfer(tx: Transaction): 'external' | 'internal';
   ```
   - Use `action === 'moved'` or matching txids/addresses between own wallets to tag internal flows.

4. **Build crypto timeline (pure, sync):**
   ```ts
   buildCryptoTimeline(transactions): CryptoCheckpoint[];
   interface CryptoCheckpoint {
     timestamp: number;
     amount: number;  // satoshis
   }
   ```
   - Pure function, no fiat conversion.
   - Returns one checkpoint per transaction with running balance.

5. **Convert to quote series (async, handles sampling + rates):**
   ```ts
   buildQuoteSeries(options): Effect<Promise<BalancePoint[]>>;
   interface BuildQuoteSeriesOptions {
     wallet: Wallet;
     cryptoTimeline: CryptoCheckpoint[];
     quoteCurrency: string;
     timeframe: Timeframe;
   }
   interface BalancePoint {
     timestamp: number;
     quoteValue: number;
     quoteCurrency: string;
     quoteRate?: number;
     cryptoAmount: number;  // satoshis
   }
   ```
   - Filters checkpoints by timeframe.
   - Dynamically calculates sampling interval to produce exactly 45 data points (`TARGET_DATA_POINTS`), optimized for chart animation performance.
   - Fetches historic rates and converts to quote currency.
   - Stores the historic rate used in `quoteRate` for display purposes.

6. **Aggregate scopes:**
   - Wallet series feed into `buildKeySeries` (sum by timestamp) and then `buildPortfolioSeries` (sum across keys).

### 2. Gain/Loss Calculations

1. **Inputs:** Balance series plus transfer classification.
2. **Compute net inflows/outflows per interval:** sum fiat value of external `received` (inflows) and `sent` (outflows) transactions inside the window.
3. **Gain/Loss formula:**
   ```ts
   interface GainLossResult {
     timeframe: Timeframe;
     absolute: number;
     percentage: number;
     inflows: number;
     outflows: number;
   }
   absolute = endingFiat - startingFiat - inflows + outflows;
   percentage = startingFiat === 0 ? null : absolute / (startingFiat + inflows - outflows);
   ```
4. **Expose methods:**
   ```ts
   computeGainLoss(entity: EntityRef, timeframe: Timeframe, fiat: string): GainLossResult;
   ```

### 3. Asset Allocations

1. Use latest wallet balances (already in store) to generate per-asset fiat values via `toFiat`.
2. Scope options:
   ```ts
   computeAllocations({scope: 'wallet'|'key'|'portfolio', id?: string, quoteCurrency}: AllocationRequest): AllocationResult[];
   interface AllocationResult { assetId: string; quoteValue: number; percentage: number; }
   ```
3. Percent = `quoteValue / totalScopeValue`.

### 4. Alt-Currency Support

- Centralize fiat ISO selection in APP slice (already exists as `defaultAltCurrency`).
- Introduce `usePortfolioAnalytics(fiatIsoCode)` hook or selectors that take `fiat` param.
- When fiat changes:
  1. Invalidate FiatRateCache keys for previous fiat.
  2. Reuse stored crypto timelines; only redo fiat conversions + gain/loss math.
  3. Memoize rates per `(fiat, coin, hour)` to avoid duplicate HTTP calls while recomputing multiple series.

## Redux State Additions

```ts
interface PortfolioAnalyticsState {
  series: {
    [scope: string]: {
      [timeframe in Timeframe]?: BalancePoint[];
    };
  };
  gainLoss: {
    [scope: string]: {
      [timeframe in Timeframe]?: GainLossResult;
    };
  };
  allocations: {
    [scope: string]: AllocationResult[];
  };
  meta: {
    fiatIsoCode: string;
    lastUpdated: number;
  };
}
```

- `scope` can be `wallet:${walletId}`, `key:${keyId}`, or `portfolio`.
- Reducers update slices when async thunks finish building data for a timeframe.

## Public API (Selectors / Hooks)

Expose via `src/store/portfolio`:

```ts
export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';
export interface EntityRef { type: 'wallet' | 'key' | 'portfolio'; id?: string; }

// Historical balances
export const selectBalanceSeries = (
  state: RootState,
  entity: EntityRef,
  timeframe: Timeframe,
): BalancePoint[] | undefined;

export const loadBalanceSeries = createAsyncThunk(
  'portfolio/loadBalanceSeries',
  async ({entity, timeframe, fiat}: {entity: EntityRef; timeframe: Timeframe; fiat: string}) => { ... }
);

// Gain/Loss
export const selectGainLoss = (
  state: RootState,
  entity: EntityRef,
  timeframe: Timeframe,
): GainLossResult | undefined;

export const loadGainLoss = createAsyncThunk(...);

// Allocations
export const selectAllocations = (
  state: RootState,
  entity: EntityRef,
): AllocationResult[] | undefined;

export const refreshAllocations = createAsyncThunk(...);
```

Components (graphs, summary cards) consume selectors; if data missing or stale they dispatch corresponding `load*` thunk.

## Performance & Caching

1. **FiatRateCache:**
   ```ts
   class FiatRateCache {
     getRate(coin: string, fiat: string, hourTs: number): Promise<number>;
     seedRange(coin: string, fiat: string, timeframe: Timeframe): Promise<void>;
   }
   ```
   - Stores rates in-memory + persisted Redux `RATE` slice.

2. **Transaction cache:** Keep fetched histories in `wallet.transactionHistory` to avoid refetching; only pull deltas when new txs arrive.

3. **Incremental recompute:**
   - For rolling timeframes (1D/1W/1M/3M) reuse existing series by appending newest checkpoints rather than rebuilding from scratch.
   - For 1Y/5Y/ALL recompute only when new tx enters range or fiat changes.

4. **Background warm-up:** when app launches or fiat changes, kick off a background job to warm most-used scopes/timeframes so UI reads instantly.

## Implementation Phases

1. **Foundations:** set up `portfolio` slice, `Timeframe` enum, FiatRateCache abstraction, and history fetching helpers.
2. **Wallet series + gain/loss:** implement wallet-level analytics, ensure transfer exclusion is correct, add memoized selectors.
3. **Key & portfolio aggregation:** build reducers/selectors that derive from wallet data; add background warm-up.
4. **Allocations + fiat switching:** compute per-asset allocation, wire to existing alt currency setting, add cache invalidation.
5. **UI integration:** expose hooks (`useBalanceSeries`, `useGainLoss`, `useAllocations`) and connect to charts/cards.

## Example Hook Consumption

### Wallet Balance Chart

```tsx
import {Timeframe, useBalanceSeries} from 'store/portfolio/hooks';

const WalletBalanceChart = ({walletId}: {walletId: string}) => {
  const timeframe: Timeframe = '1M';
  const {data, isLoading, reload} = useBalanceSeries({
    entity: {type: 'wallet', id: walletId},
    timeframe,
  });

  if (isLoading || !data?.length) {
    return <LoadingSpinner />;
  }

  return (
    <PortfolioLineChart
      points={data.map(point => ({
        x: point.timestamp,
        y: point.quoteValue,
      }))}
      timeframe={timeframe}
      onRefresh={reload}
    />
  );
};
```

### Key Gain/Loss Summary Card

```tsx
import {Timeframe, useGainLoss} from 'store/portfolio/hooks';

const KeyGainLossCard = ({keyId}: {keyId: string}) => {
  const timeframe: Timeframe = '3M';
  const {result, isLoading} = useGainLoss({
    entity: {type: 'key', id: keyId},
    timeframe,
  });

  if (isLoading || !result) {
    return <SummarySkeleton />;
  }

  return (
    <GainLossCard
      title="3M Performance"
      absolute={result.absolute}
      percentage={result.percentage}
      inflows={result.inflows}
      outflows={result.outflows}
    />
  );
};
```

### Portfolio Allocation Breakdown

```tsx
import {useAllocations} from 'store/portfolio/hooks';

const PortfolioAllocationDonut = () => {
  const {allocations, isLoading} = useAllocations({
    entity: {type: 'portfolio'},
  });

  if (isLoading || !allocations?.length) {
    return <ChartSkeleton />;
  }

  return (
    <DonutChart
      data={allocations.map(({assetId, quoteValue, percentage}) => ({
        label: assetId,
        value: quoteValue,
        percentage,
      }))}
    />
  );
};
```

Following this plan keeps responsibilities isolated (history parsing vs. fiat conversion vs. presentation), maximizes cache reuse, and provides clean public interfaces for components to render portfolio analytics consistently across wallets, keys, and the entire account.
