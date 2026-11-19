import type {AnyAction} from 'redux';
import {createTransform} from 'redux-persist';
import {DEFAULT_WATCHLIST, buildCoinCatalog, watchlistCoin} from './coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import type {WatchlistState} from './watchlist.models';

const initialCatalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
export const initialWatchlistState: WatchlistState = {
  items: DEFAULT_WATCHLIST.map(symbol =>
    watchlistCoin(initialCatalog.byId.get(`coin:${symbol}`)!),
  ),
  contexts: {},
  order: 0,
  priceAlertsEnabled: true,
  permissionPromptShown: false,
  permissionAllowed: undefined,
};

// Prototype state has no migration: an old ID anywhere resets this slice.
// Backend-held alerts will be restored by the ordinary launch list request.
export const resetLegacyWatchlistState = (
  state: WatchlistState,
): WatchlistState => {
  if (!state) return state;
  const ids = [
    ...state.items.map(item => item.id),
    ...Object.values(state.contexts).flatMap(context => [
      ...Object.keys(context.alerts),
      ...Object.keys(context.intents),
      ...Object.values(context.pendingRemovals).map(removal => removal.itemId),
    ]),
  ];
  if (ids.every(id => id.startsWith('coin:'))) return state;
  return {
    ...initialWatchlistState,
    items: initialWatchlistState.items.map(watchlistCoin),
    contexts: {},
    priceAlertsEnabled: state.priceAlertsEnabled,
    permissionPromptShown: state.permissionPromptShown,
  };
};

export const watchlistPersistTransform = createTransform<
  WatchlistState,
  WatchlistState
>(state => state, resetLegacyWatchlistState, {whitelist: ['WATCHLIST']});

export const watchlistReducer = (
  state = initialWatchlistState,
  action: AnyAction,
): WatchlistState =>
  action.type === 'WATCHLIST/UPDATE' ? action.payload : state;

export const updateWatchlist = (payload: WatchlistState) => ({
  type: 'WATCHLIST/UPDATE' as const,
  payload,
});
