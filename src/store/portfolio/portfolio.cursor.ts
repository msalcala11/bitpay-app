import {getPortfolioIntervalGrid} from './portfolio.grid';
import {
  PortfolioInterval,
  PortfolioTxEvent,
  WalletIntervalCursor,
  WalletIntervalCursorPoint,
} from './portfolio.types';

export interface PortfolioPositionState {
  cryptoBalance: number;
  costBasisRemainingUSD: number;
  avgCostUSDPerUnit: number;
}


const updateAvgCost = (state: PortfolioPositionState): PortfolioPositionState => {
  const {cryptoBalance, costBasisRemainingUSD} = state;
  const avgCostUSDPerUnit =
    cryptoBalance > 0 ? costBasisRemainingUSD / cryptoBalance : 0;
  return {...state, avgCostUSDPerUnit};
};

export const applyEventToState = (
  prev: PortfolioPositionState,
  event: PortfolioTxEvent,
): PortfolioPositionState => {
  let next = {...prev};

  const feeCrypto = event.feeCrypto || 0;
  const delta = event.cryptoDelta || 0;
  const absDelta = Math.abs(delta);

  const applySpendLike = (amountCrypto: number) => {
    if (amountCrypto <= 0) {
      return;
    }
    const costUsed = next.avgCostUSDPerUnit * amountCrypto;
    next.cryptoBalance = next.cryptoBalance - amountCrypto;
    next.costBasisRemainingUSD = next.costBasisRemainingUSD - costUsed;
    next = updateAvgCost(next);
  };

  const applyReceiveLike = (amountCrypto: number) => {
    if (amountCrypto <= 0) {
      return;
    }
    const basisUsd =
      event.basisUSDOverride != null
        ? event.basisUSDOverride
        : event.usdPriceUsed != null
        ? amountCrypto * event.usdPriceUsed
        : 0;
    next.cryptoBalance = next.cryptoBalance + amountCrypto;
    next.costBasisRemainingUSD = next.costBasisRemainingUSD + basisUsd;
    next = updateAvgCost(next);
  };

  switch (event.category) {
    case 'receive':
      applyReceiveLike(delta);
      break;
    case 'spend':
      applySpendLike(absDelta);
      break;
    case 'moved':
      if (delta < 0) {
        applySpendLike(absDelta);
      } else if (delta > 0) {
        applyReceiveLike(delta);
      }
      break;
    default:
      break;
  }

  if (feeCrypto > 0) {
    applySpendLike(feeCrypto);
  }

  next.costBasisRemainingUSD = next.costBasisRemainingUSD;
  next.cryptoBalance = next.cryptoBalance;
  next = updateAvgCost(next);

  return next;
};

export const buildWalletIntervalCursor = (
  walletId: string,
  interval: PortfolioInterval,
  events: PortfolioTxEvent[],
): WalletIntervalCursor => {
  const grid = getPortfolioIntervalGrid(interval);
  const sortedEvents = [...events].sort((a, b) => a.time - b.time);
  let state: PortfolioPositionState = {
    cryptoBalance: 0,
    costBasisRemainingUSD: 0,
    avgCostUSDPerUnit: 0,
  };

  let eventIdx = 0;
  const points: WalletIntervalCursorPoint[] = grid.times.map(time => {
    while (eventIdx < sortedEvents.length && sortedEvents[eventIdx].time <= time) {
      state = applyEventToState(state, sortedEvents[eventIdx]);
      eventIdx++;
    }
    return {
      time,
      cryptoBalance: state.cryptoBalance,
      costBasisRemainingUSD: state.costBasisRemainingUSD,
      valueUSD: null,
    };
  });

  return {
    walletId,
    interval,
    points,
    lastEndTime: grid.endTime,
    lastTxIndex: Math.max(-1, eventIdx - 1),
  };
};
