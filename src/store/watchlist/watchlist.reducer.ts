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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Prototype state has no migration: an old ID anywhere resets this slice.
// Backend-held alerts will be restored by the ordinary launch list request.
export const resetLegacyWatchlistState = (state: unknown): WatchlistState => {
  const saved = isRecord(state) ? state : {};
  const fresh = (): WatchlistState => ({
    ...initialWatchlistState,
    items: initialWatchlistState.items.map(watchlistCoin),
    contexts: {},
    priceAlertsEnabled:
      typeof saved.priceAlertsEnabled === 'boolean'
        ? saved.priceAlertsEnabled
        : initialWatchlistState.priceAlertsEnabled,
    permissionPromptShown:
      typeof saved.permissionPromptShown === 'boolean'
        ? saved.permissionPromptShown
        : initialWatchlistState.permissionPromptShown,
  });
  if (!Array.isArray(saved.items) || !isRecord(saved.contexts)) return fresh();
  const ids: unknown[] = [];
  for (const item of saved.items) {
    if (!isRecord(item)) return fresh();
    ids.push(item.id);
  }
  for (const context of Object.values(saved.contexts)) {
    if (
      !isRecord(context) ||
      !isRecord(context.alerts) ||
      !isRecord(context.intents) ||
      !isRecord(context.pendingRemovals)
    )
      return fresh();
    for (const id of Object.keys(context.alerts)) ids.push(id);
    for (const id of Object.keys(context.intents)) ids.push(id);
    for (const removal of Object.values(context.pendingRemovals)) {
      if (!isRecord(removal)) return fresh();
      ids.push(removal.itemId);
    }
  }
  return ids.every(id => typeof id === 'string' && id.startsWith('coin:'))
    ? (saved as unknown as WatchlistState)
    : fresh();
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
