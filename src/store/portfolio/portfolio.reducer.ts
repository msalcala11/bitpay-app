import {
  PortfolioActionType,
  PortfolioActionTypes,
  PortfolioAnalyticsState,
} from './portfolio.types';

const initialState: PortfolioAnalyticsState = {
  series: {},
  seriesRefreshState: {},
  cryptoTimelines: {},
  gainLoss: {},
  allocations: {},
  breakeven: {},
  meta: {
    lastUpdated: null,
    warmingScopes: {},
  },
  status: {},
};

export const portfolioReduxPersistBlackList: (keyof PortfolioAnalyticsState)[] = [];

export const portfolioReducer = (
  state: PortfolioAnalyticsState = initialState,
  action: PortfolioActionType,
): PortfolioAnalyticsState => {
  switch (action.type) {
    case PortfolioActionTypes.RESET:
      return initialState;

    case PortfolioActionTypes.CLEAR_SCOPE: {
      const {scope} = action.payload;
      const {[scope]: _series, ...seriesRest} = state.series;
      const {[scope]: _refreshState, ...refreshStateRest} = state.seriesRefreshState;
      const {[scope]: _cryptoTimeline, ...cryptoTimelinesRest} = state.cryptoTimelines;
      const {[scope]: _gainLoss, ...gainLossRest} = state.gainLoss;
      const {[scope]: _allocations, ...allocationsRest} = state.allocations;
      const {[scope]: _breakeven, ...breakevenRest} = state.breakeven;
      const {[scope]: _status, ...statusRest} = state.status;

      return {
        ...state,
        series: seriesRest,
        seriesRefreshState: refreshStateRest,
        cryptoTimelines: cryptoTimelinesRest,
        gainLoss: gainLossRest,
        allocations: allocationsRest,
        breakeven: breakevenRest,
        status: statusRest,
      };
    }

    case PortfolioActionTypes.UPSERT_STATUS: {
      const {scope, status} = action.payload;
      return {
        ...state,
        status: {
          ...state.status,
          [scope]: status,
        },
      };
    }

    case PortfolioActionTypes.UPSERT_SERIES: {
      const {scope, points} = action.payload;
      return {
        ...state,
        series: {
          ...state.series,
          [scope]: points,
        },
      };
    }

    case PortfolioActionTypes.UPSERT_SERIES_REFRESH_STATE: {
      const {scope, refreshState} = action.payload;
      return {
        ...state,
        seriesRefreshState: {
          ...state.seriesRefreshState,
          [scope]: refreshState,
        },
      };
    }

    case PortfolioActionTypes.UPSERT_CRYPTO_TIMELINE: {
      const {scope, checkpoints} = action.payload;
      return {
        ...state,
        cryptoTimelines: {
          ...state.cryptoTimelines,
          [scope]: checkpoints,
        },
      };
    }

    case PortfolioActionTypes.UPSERT_BREAKEVEN: {
      const {scope, breakeven} = action.payload;
      return {
        ...state,
        breakeven: {
          ...state.breakeven,
          [scope]: breakeven,
        },
      };
    }

    default:
      return state;
  }
};
