import type {AnyAction} from 'redux';
import {DEFAULT_WATCHLIST, buildCoinCatalog} from './coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import type {WatchlistState} from './watchlist.models';

const initialCatalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
export const initialWatchlistState: WatchlistState = {
  items: DEFAULT_WATCHLIST.map(
    symbol => initialCatalog.byId.get(`coin:${symbol}`)!,
  ),
  contexts: {},
  order: 0,
  priceAlertsEnabled: true,
  permissionPromptShown: false,
  permissionAllowed: undefined,
};

export const watchlistReducer = (
  state = initialWatchlistState,
  action: AnyAction,
): WatchlistState =>
  action.type === 'WATCHLIST/UPDATE' ? action.payload : state;

export const updateWatchlist = (payload: WatchlistState) => ({
  type: 'WATCHLIST/UPDATE' as const,
  payload,
});
