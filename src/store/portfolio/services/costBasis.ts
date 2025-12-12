import {
  CostBasisMethod,
  CryptoLot,
  CostBasisState,
  BreakevenResult,
  CryptoCheckpoint,
} from '../portfolio.types';
import {getHistoricQuoteRate, QuoteRateRequest} from '../rate-cache';

/**
 * Removes crypto from lots according to the specified method.
 * Mutates the lots array in place.
 * 
 * @param lots - Array of crypto lots (will be mutated)
 * @param amountToRemove - Amount of crypto to remove (satoshis)
 * @param method - Cost basis method (FIFO, LIFO, or AVG)
 */
const removeCrypto = (
  lots: CryptoLot[],
  amountToRemove: number,
  method: CostBasisMethod,
): void => {
  if (amountToRemove <= 0 || lots.length === 0) {
    return;
  }

  if (method === 'AVG') {
    // Average: reduce all lots proportionally
    const totalAmount = lots.reduce((sum, lot) => sum + lot.amount, 0);
    if (totalAmount <= 0) {
      return;
    }
    
    // If removing more than we have, remove everything
    const fraction = Math.min(amountToRemove / totalAmount, 1);
    for (const lot of lots) {
      lot.amount *= (1 - fraction);
      lot.costBasis *= (1 - fraction);
    }
    return;
  }

  // FIFO or LIFO: consume lots in order
  let remaining = amountToRemove;
  
  // FIFO: oldest first (natural order), LIFO: newest first (reverse)
  const indices = method === 'LIFO' 
    ? [...Array(lots.length).keys()].reverse() 
    : [...Array(lots.length).keys()];

  for (const i of indices) {
    if (remaining <= 0) {
      break;
    }
    
    const lot = lots[i];
    if (lot.amount <= 0) {
      continue;
    }
    
    const take = Math.min(remaining, lot.amount);
    const fraction = take / lot.amount;
    lot.amount -= take;
    lot.costBasis *= (1 - fraction);
    remaining -= take;
  }
};

/**
 * Removes empty lots from the array.
 * Returns a new array with only lots that have positive amounts.
 */
const pruneEmptyLots = (lots: CryptoLot[]): CryptoLot[] => {
  return lots.filter(lot => lot.amount > 0.01); // Small epsilon to handle floating point
};

export interface BuildCostBasisOptions {
  transactions: any[];
  method: CostBasisMethod;
  quoteCurrency: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
}

/**
 * Builds cost basis state from transaction history.
 * 
 * For each transaction:
 * - received: Add a new lot with the fiat value at time of receipt
 * - sent: Remove crypto from lots per the selected method
 * - moved: Only the fee reduces holdings
 * 
 * @returns CostBasisState with lots and totals
 */
export const buildCostBasis = async ({
  transactions,
  method,
  quoteCurrency,
  currencyAbbreviation,
  chain,
  tokenAddress,
}: BuildCostBasisOptions): Promise<CostBasisState> => {
  const lots: CryptoLot[] = [];

  for (const tx of transactions) {
    const timestampMs = (tx?.time ?? tx?.createdOn ?? 0) * 1000;
    if (!timestampMs) {
      continue;
    }

    const amount = typeof tx?.amount === 'number' ? tx.amount : 0;
    const fee = typeof tx?.fees === 'number' ? tx.fees : (typeof tx?.fee === 'number' ? tx.fee : 0);
    const action = tx?.action as 'sent' | 'received' | 'moved' | undefined;

    // Get historic rate for this transaction
    const rateRequest: QuoteRateRequest = {
      quoteCurrency,
      currencyAbbreviation,
      chain,
      tokenAddress,
      timestampMs,
    };

    switch (action) {
      case 'received': {
        // Add new lot - need to fetch rate for cost basis
        const rate = await getHistoricQuoteRate(rateRequest);
        if (rate > 0 && amount > 0) {
          // Convert satoshis to units for fiat calculation
          // Note: rate is per unit (e.g., USD per BTC), amount is in satoshis
          // We store costBasis as the total fiat value of this lot
          lots.push({
            timestamp: timestampMs,
            amount,
            costBasis: 0, // Will be calculated after we know the unit conversion
            quoteRate: rate,
          });
        }
        break;
      }

      case 'sent': {
        // Remove crypto from lots (amount + fee are both spent)
        const totalSpent = amount + fee;
        removeCrypto(lots, totalSpent, method);
        break;
      }

      case 'moved': {
        // Only fee is "spent" (amount comes back to self)
        if (fee > 0) {
          removeCrypto(lots, fee, method);
        }
        break;
      }
    }
  }

  // Prune empty lots
  const prunedLots = pruneEmptyLots(lots);

  return {
    lots: prunedLots,
    totalCostBasis: prunedLots.reduce((sum, lot) => sum + lot.costBasis, 0),
    totalAmount: prunedLots.reduce((sum, lot) => sum + lot.amount, 0),
    method,
  };
};

export interface ComputeBreakevenOptions {
  transactions: any[];
  method: CostBasisMethod;
  quoteCurrency: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
  unitToSatoshi: number;
}

/**
 * Computes the breakeven result for a wallet.
 * 
 * The breakeven value is the total cost basis of current holdings -
 * the fiat value at which there would be zero capital gain.
 * 
 * @returns BreakevenResult with cost basis and breakeven value
 */
export const computeBreakeven = async ({
  transactions,
  method,
  quoteCurrency,
  currencyAbbreviation,
  chain,
  tokenAddress,
  unitToSatoshi,
}: ComputeBreakevenOptions): Promise<BreakevenResult> => {
  const lots: CryptoLot[] = [];

  for (const tx of transactions) {
    const timestampMs = (tx?.time ?? tx?.createdOn ?? 0) * 1000;
    if (!timestampMs) {
      continue;
    }

    const amount = typeof tx?.amount === 'number' ? tx.amount : 0;
    const fee = typeof tx?.fees === 'number' ? tx.fees : (typeof tx?.fee === 'number' ? tx.fee : 0);
    const action = tx?.action as 'sent' | 'received' | 'moved' | undefined;

    switch (action) {
      case 'received': {
        // Get historic rate for this transaction
        const rate = await getHistoricQuoteRate({
          quoteCurrency,
          currencyAbbreviation,
          chain,
          tokenAddress,
          timestampMs,
        });
        
        if (rate > 0 && amount > 0) {
          // Convert satoshis to units for fiat calculation
          const units = amount / unitToSatoshi;
          const costBasis = units * rate;
          
          lots.push({
            timestamp: timestampMs,
            amount,
            costBasis,
            quoteRate: rate,
          });
        }
        break;
      }

      case 'sent': {
        // Remove crypto from lots (amount + fee are both spent)
        const totalSpent = amount + fee;
        removeCrypto(lots, totalSpent, method);
        break;
      }

      case 'moved': {
        // Only fee is "spent" (amount comes back to self)
        if (fee > 0) {
          removeCrypto(lots, fee, method);
        }
        break;
      }
    }
  }

  // Prune empty lots
  const prunedLots = pruneEmptyLots(lots);
  
  const totalCostBasis = prunedLots.reduce((sum, lot) => sum + lot.costBasis, 0);
  const totalAmount = prunedLots.reduce((sum, lot) => sum + lot.amount, 0);

  return {
    costBasis: totalCostBasis,
    currentAmount: totalAmount,
    breakeven: totalCostBasis, // Breakeven = total cost basis
    method,
    lastUpdated: Date.now(),
  };
};

/**
 * Aggregates multiple breakeven results into a single result.
 * Used for key and portfolio scope aggregation.
 * 
 * @param results - Array of breakeven results from individual wallets
 * @param method - Cost basis method to use for the aggregate
 * @returns Aggregated BreakevenResult
 */
export const aggregateBreakeven = (
  results: BreakevenResult[],
  method: CostBasisMethod,
): BreakevenResult => {
  const totalCostBasis = results.reduce((sum, r) => sum + r.costBasis, 0);
  const totalAmount = results.reduce((sum, r) => sum + r.currentAmount, 0);

  return {
    costBasis: totalCostBasis,
    currentAmount: totalAmount,
    breakeven: totalCostBasis,
    method,
    lastUpdated: Date.now(),
  };
};

export interface EnrichTimelineOptions {
  timeline: CryptoCheckpoint[];
  quoteCurrency: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
}

/**
 * Enriches a crypto timeline with fiat rates for each checkpoint.
 * Uses the rate cache, so rates fetched during breakeven calculation will be reused.
 * 
 * @returns New array of CryptoCheckpoint with quoteRate populated
 */
export const enrichTimelineWithRates = async ({
  timeline,
  quoteCurrency,
  currencyAbbreviation,
  chain,
  tokenAddress,
}: EnrichTimelineOptions): Promise<CryptoCheckpoint[]> => {
  const enriched: CryptoCheckpoint[] = [];

  for (const checkpoint of timeline) {
    const rate = await getHistoricQuoteRate({
      quoteCurrency,
      currencyAbbreviation,
      chain,
      tokenAddress,
      timestampMs: checkpoint.timestamp,
    });

    enriched.push({
      ...checkpoint,
      quoteRate: rate > 0 ? rate : undefined,
    });
  }

  return enriched;
};
