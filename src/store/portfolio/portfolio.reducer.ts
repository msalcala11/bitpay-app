import {
  PortfolioActionType,
  PortfolioActionTypes,
  PortfolioState,
} from './portfolio.types';

export const portfolioReduxPersistBlackList: (keyof PortfolioState)[] = [];

const initialState: PortfolioState = {
  global: {
    status: 'idle',
    walletsTotal: 0,
    walletsDone: 0,
  },
  wallets: {},
};

export const portfolioReducer = (
  state: PortfolioState = initialState,
  action: PortfolioActionType,
): PortfolioState => {
  switch (action.type) {
    case PortfolioActionTypes.SET_GLOBAL_SYNC: {
      return {
        ...state,
        global: {
          ...state.global,
          ...action.payload,
        },
      };
    }

    case PortfolioActionTypes.UPDATE_WALLET_SYNC: {
      const {walletId, keyId, ...rest} = action.payload;
      const existing = state.wallets[walletId];
      return {
        ...state,
        wallets: {
          ...state.wallets,
          [walletId]: {
            ...existing,
            status: existing?.status ?? 'idle',
            keyId,
            walletId,
            txCount: existing?.txCount ?? 0,
            chunkCount: existing?.chunkCount ?? 0,
            txRequestCount: existing?.txRequestCount ?? 0,
            rateRequestCount: existing?.rateRequestCount ?? 0,
            rateDaysTotal: existing?.rateDaysTotal ?? 0,
            rateDaysDone: existing?.rateDaysDone ?? 0,
            ...rest,
          },
        },
      };
    }

    case PortfolioActionTypes.RESET: {
      return initialState;
    }

    default:
      return state;
  }
};
