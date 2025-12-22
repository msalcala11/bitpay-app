import {
  PortfolioActionType,
  PortfolioActionTypes,
  PortfolioState,
  PortfolioTxEvent,
} from './portfolio.types';

type PortfolioReduxPersistBlackList = string[];
export const portfolioReduxPersistBlackList: PortfolioReduxPersistBlackList = [];

export const initialPortfolioState: PortfolioState = {
  txEventsByWalletId: {},
  walletIntervalCursorsByWalletId: {},
  rateCacheUsd: {},
  fxCache: {},
  meta: {
    syncStatus: 'idle',
  }
};

const mergeRateCacheUsd = (
  existing: PortfolioState['rateCacheUsd'],
  incoming: PortfolioState['rateCacheUsd'],
): PortfolioState['rateCacheUsd'] => {
  const merged = {...existing};
  Object.entries(incoming || {}).forEach(([assetId, buckets]) => {
    merged[assetId] = {...(merged[assetId] || {}), ...(buckets || {})};
  });
  return merged;
};

const mergeTxEvents = (
  existing: PortfolioTxEvent[],
  incoming: PortfolioTxEvent[],
): PortfolioTxEvent[] => {
  if (!incoming?.length) {
    return existing;
  }
  if (!existing?.length) {
    return incoming;
  }

  const byKey = new Map<string, PortfolioTxEvent>();
  existing.forEach(e => byKey.set(`${e.txid}-${e.time}-${e.cryptoDelta}`, e));
  incoming.forEach(e => byKey.set(`${e.txid}-${e.time}-${e.cryptoDelta}`, e));

  return Array.from(byKey.values()).sort((a, b) => a.time - b.time);
};

export const portfolioReducer = (
  state: PortfolioState = initialPortfolioState,
  action: PortfolioActionType,
): PortfolioState => {
  switch (action.type) {
    case PortfolioActionTypes.RESET:
      return initialPortfolioState;

    case PortfolioActionTypes.SET_TX_EVENTS_FOR_WALLET: {
      const {walletId, txEvents} = action.payload;
      return {
        ...state,
        txEventsByWalletId: {
          ...state.txEventsByWalletId,
          [walletId]: txEvents,
        },
      };
    }

    case PortfolioActionTypes.UPSERT_TX_EVENTS_FOR_WALLET: {
      const {walletId, txEvents} = action.payload;
      const existing = state.txEventsByWalletId[walletId] || [];
      return {
        ...state,
        txEventsByWalletId: {
          ...state.txEventsByWalletId,
          [walletId]: mergeTxEvents(existing, txEvents),
        },
      };
    }

    case PortfolioActionTypes.SET_WALLET_INTERVAL_CURSOR: {
      const {walletId, interval, cursor} = action.payload;
      return {
        ...state,
        walletIntervalCursorsByWalletId: {
          ...state.walletIntervalCursorsByWalletId,
          [walletId]: {
            ...(state.walletIntervalCursorsByWalletId[walletId] || {}),
            [interval]: cursor,
          },
        },
      };
    }

    case PortfolioActionTypes.SET_RATE_CACHE_USD: {
      return {
        ...state,
        rateCacheUsd: mergeRateCacheUsd(state.rateCacheUsd, action.payload.rateCacheUsd),
      };
    }

    case PortfolioActionTypes.CLEAR_RATE_CACHE_USD: {
      return {
        ...state,
        rateCacheUsd: {},
      };
    }

    case PortfolioActionTypes.SET_FX_CACHE: {
      return {
        ...state,
        fxCache: action.payload.fxCache,
      };
    }

    case PortfolioActionTypes.SET_META: {
      return {
        ...state,
        meta: {
          ...state.meta,
          ...action.payload,
        },
      };
    }

    default:
      return state;
  }
};
