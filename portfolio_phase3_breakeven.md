# Portfolio Analytics – Phase 3: Breakeven / Cost Basis

## Overview

Display a dotted horizontal line on wallet/key/portfolio quote series charts representing the **breakeven fiat value** – the price at which there is zero capital gain from price movement. This is equivalent to the **cost basis** of the current holdings.

## Definition

**Breakeven Value** = Total fiat cost to acquire the current crypto balance

- Every incoming transaction ("received") is treated as a purchase at the fiat rate at time of receipt
- Outgoing transactions ("sent") reduce the cost basis according to a configurable method
- Internal transfers ("moved") only affect cost basis by the fee burned

## Requirements

### Functional Requirements

1. **Cost Basis Calculation**
   - Track cost basis per wallet, aggregatable to key and portfolio levels
   - Support configurable cost basis methods: **FIFO**, **LIFO**, **Average Cost**
   - Default to Average Cost (simplest, most common)

2. **Transaction Handling**
   - **Received**: Add `fiatRate * cryptoAmount` to cost basis, add crypto to lot pool
   - **Sent**: Remove crypto from lot pool per selected method, reduce cost basis proportionally
   - **Moved**: Only the fee reduces holdings; cost basis reduced by fee's proportional cost

3. **Breakeven Line Display**
   - Render as a horizontal dotted line on fiat balance charts
   - Line represents: "If current holdings were worth this fiat amount, gain = 0"
   - Show on wallet, key, and portfolio charts

4. **Aggregation**
   - Wallet breakeven: sum of cost basis for that wallet's current holdings
   - Key breakeven: sum of all wallet breakevens under that key
   - Portfolio breakeven: sum of all key breakevens

### Non-Functional Requirements

- Efficient: compute alongside existing balance series pipeline
- Cached: store computed cost basis in Redux, invalidate on new transactions
- Configurable: cost basis method stored in APP settings

## Data Model

### New Types

```ts
type CostBasisMethod = 'FIFO' | 'LIFO' | 'AVG';

interface CryptoLot {
  timestamp: number;
  amount: number;        // satoshis acquired
  costBasis: number;     // fiat paid for this lot
  quoteRate: number;     // fiat rate at acquisition
}

interface CostBasisState {
  lots: CryptoLot[];           // ordered by timestamp (oldest first)
  totalCostBasis: number;      // sum of remaining lots' cost basis
  totalAmount: number;         // sum of remaining lots' amounts
  method: CostBasisMethod;
}

interface BreakevenResult {
  costBasis: number;           // total fiat cost of current holdings
  currentAmount: number;       // current crypto balance (satoshis)
  breakeven: number;           // costBasis (the line value)
  method: CostBasisMethod;
  lastUpdated: number;
}
```

### Redux State Additions

```ts
interface PortfolioAnalyticsState {
  // ... existing fields ...
  breakeven: Record<string, BreakevenResult>;  // keyed by scope
  costBasisMethod: CostBasisMethod;            // user preference
}
```

## Algorithm

### Cost Basis Calculation

```ts
function buildCostBasis(
  transactions: Transaction[],
  method: CostBasisMethod,
  getHistoricRate: (timestamp: number) => Promise<number>,
): Promise<CostBasisState> {
  const lots: CryptoLot[] = [];
  
  for (const tx of transactions) {  // sorted ascending by time
    const rate = await getHistoricRate(tx.timestamp);
    const amount = tx.amount;  // satoshis
    
    switch (tx.action) {
      case 'received':
        // Add new lot
        lots.push({
          timestamp: tx.timestamp,
          amount,
          costBasis: amount * rate,
          quoteRate: rate,
        });
        break;
        
      case 'sent':
        // Remove crypto from lots per method
        removeCrypto(lots, amount + tx.fee, method);
        break;
        
      case 'moved':
        // Only fee is "spent"
        if (tx.fee > 0) {
          removeCrypto(lots, tx.fee, method);
        }
        break;
    }
  }
  
  return {
    lots,
    totalCostBasis: lots.reduce((sum, l) => sum + l.costBasis, 0),
    totalAmount: lots.reduce((sum, l) => sum + l.amount, 0),
    method,
  };
}

function removeCrypto(
  lots: CryptoLot[],
  amountToRemove: number,
  method: CostBasisMethod,
): void {
  let remaining = amountToRemove;
  
  // Select lots based on method
  const orderedLots = method === 'LIFO' ? [...lots].reverse() : lots;
  
  for (const lot of orderedLots) {
    if (remaining <= 0) break;
    
    if (method === 'AVG') {
      // Average: reduce all lots proportionally
      const totalAmount = lots.reduce((s, l) => s + l.amount, 0);
      const fraction = amountToRemove / totalAmount;
      for (const l of lots) {
        l.amount *= (1 - fraction);
        l.costBasis *= (1 - fraction);
      }
      return;
    }
    
    // FIFO/LIFO: consume lots in order
    const take = Math.min(remaining, lot.amount);
    const fraction = take / lot.amount;
    lot.amount -= take;
    lot.costBasis *= (1 - fraction);
    remaining -= take;
  }
  
  // Remove empty lots
  lots = lots.filter(l => l.amount > 0);
}
```

### Breakeven Computation

```ts
function computeBreakeven(costBasisState: CostBasisState): number {
  // Breakeven = total cost basis of current holdings
  // This is the fiat value at which gain = 0
  return costBasisState.totalCostBasis;
}
```

## Implementation Plan

### Task Breakdown

#### 1. Cost Basis Service
- [x] `src/store/portfolio/services/costBasis.ts`
  - [x] `buildCostBasis(transactions, method, getRate)` – compute lot-based cost basis
  - [x] `removeCrypto(lots, amount, method)` – FIFO/LIFO/AVG lot reduction
  - [x] `computeBreakeven(costBasisState)` – extract breakeven value
  - [x] `aggregateBreakeven(results, method)` – aggregate multiple wallet breakevens

#### 2. Redux Integration
- [x] Add `breakeven` to `PortfolioAnalyticsState`
- [x] Add actions: `UPSERT_BREAKEVEN`
- [x] Add selectors: `selectBreakevenByKey(state, scope)`
- [ ] Add `costBasisMethod` to APP settings (currently hardcoded to 'AVG')

#### 3. Thunk Integration
- [x] Extend `loadBalanceSeries` to compute breakeven for wallet scope
- [ ] Add breakeven aggregation for key/portfolio scopes

#### 4. Hook
- [x] `useBreakeven({entity, quoteCurrency})` – returns `BreakevenResult | undefined`

#### 5. Chart Integration
- [ ] Add optional `breakevenLine` prop to chart components
- [ ] Render as horizontal dotted line at the breakeven fiat value
- [ ] Style: dotted, muted color, with optional label

#### 6. Settings UI
- [ ] Add cost basis method selector to settings (FIFO/LIFO/Average)
- [ ] Store in APP slice, default to 'AVG'

### File Changes

| File | Changes |
|------|---------|
| `src/store/portfolio/services/costBasis.ts` | New file – cost basis calculation |
| `src/store/portfolio/portfolio.types.ts` | Add `CostBasisMethod`, `CryptoLot`, `BreakevenResult` |
| `src/store/portfolio/portfolio.reducer.ts` | Add `breakeven`, `costBasisMethod` state |
| `src/store/portfolio/portfolio.actions.ts` | Add breakeven actions |
| `src/store/portfolio/selectors.ts` | Add breakeven selectors |
| `src/store/portfolio/thunks.ts` | Integrate breakeven computation |
| `src/store/portfolio/hooks.ts` | Add `useBreakeven` hook |
| `src/navigation/wallet/screens/WalletBalanceSeries.tsx` | Render breakeven line on chart |
| `src/store/app/app.reducer.ts` | Add `costBasisMethod` setting |

## Edge Cases

1. **No transactions**: Breakeven = 0 (no cost basis)
2. **All crypto sold**: Breakeven = 0 (no holdings)
3. **Negative cost basis**: Not possible with this model (can't go below 0)
4. **Missing historic rates**: Fall back to nearest available rate or current rate

## Chart Rendering

```tsx
// In chart component
{breakeven != null && breakeven > 0 && (
  <ReferenceLine
    y={breakeven}
    stroke={theme.colors.muted}
    strokeDasharray="5 5"
    label={{
      value: `Breakeven: ${formatFiat(breakeven)}`,
      position: 'right',
    }}
  />
)}
```

For `react-native-graph`, this may require a custom overlay since it doesn't natively support reference lines. Options:
1. Overlay an absolute-positioned `View` at the calculated Y position
2. Switch to a chart library with reference line support
3. Draw the line manually using SVG

## Status Log

- _2025-12-09_: Phase 3 spec created. Defined cost basis model with FIFO/LIFO/AVG support, breakeven calculation, and integration plan.
- _2025-12-11_: Implemented core cost basis calculation:
  - Created `costBasis.ts` service with `computeBreakeven`, `removeCrypto`, `aggregateBreakeven`
  - Added types: `CostBasisMethod`, `CryptoLot`, `CostBasisState`, `BreakevenResult`
  - Added Redux: `breakeven` state, `UPSERT_BREAKEVEN` action, `selectBreakevenByKey` selector
  - Integrated into `loadBalanceSeries` thunk (wallet scope only)
  - Added `useBreakeven` hook for component consumption
  - Remaining: Chart integration, settings UI, key/portfolio scope aggregation
