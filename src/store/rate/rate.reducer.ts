import type {Rates, RatesCacheKey} from './rate.models';
import {RateActionType, RateActionTypes} from './rate.types';
import {DEFAULT_DATE_RANGE} from '../../constants/rate';

type RateReduxPersistBlackList = string[];
export const rateReduxPersistBlackList: RateReduxPersistBlackList = [];

export interface RateState {
  lastDayRates: Rates;
  rates: Rates;
  ratesCacheKey: RatesCacheKey;
}

const initialState: RateState = {
  rates: {},
  lastDayRates: {},
  ratesCacheKey: {},
};

export const rateReducer = (
  state: RateState = initialState,
  action: RateActionType,
): RateState => {
  switch (action.type) {
    case RateActionTypes.CLEAR_RATE_STATE: {
      return initialState;
    }

    case RateActionTypes.SUCCESS_GET_RATES: {
      const {rates, lastDayRates} = action.payload;
      return {
        ...state,
        rates: {...initialState.rates, ...rates},
        ratesCacheKey: {
          ...state.ratesCacheKey,
          [DEFAULT_DATE_RANGE]: Date.now(),
        },
        lastDayRates: {...initialState.lastDayRates, ...lastDayRates},
      };
    }

    case RateActionTypes.UPDATE_CACHE_KEY: {
      const {dateRange = DEFAULT_DATE_RANGE} = action.payload;
      return {
        ...state,
        ratesCacheKey: {
          ...state.ratesCacheKey,
          [dateRange]: Date.now(),
        },
      };
    }

    default:
      return state;
  }
};
