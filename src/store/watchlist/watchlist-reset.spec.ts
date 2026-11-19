import {combineReducers, createStore} from 'redux';
import {persistReducer, persistStore} from 'redux-persist';
import {
  initialWatchlistState,
  resetLegacyWatchlistState,
  watchlistPersistTransform,
  watchlistReducer,
  updateWatchlist,
} from './watchlist.reducer';
import {emptyAlertContext, type WatchlistState} from './watchlist.models';
import {PriceAlertQueue} from './price-alerts.queue';
import {buildCoinCatalog, selectorKey} from './coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';

const btc = initialWatchlistState.items[0];
const old = () => ({
  ...initialWatchlistState,
  items: [{...btc}],
  contexts: {identity: emptyAlertContext()},
  order: 24,
  priceAlertsEnabled: false,
  permissionPromptShown: true,
});

it.each(['row', 'alert', 'intent', 'removal'] as const)(
  'resets saved state when an old-form ID is present in a %s, preserving only the two settings',
  place => {
    const state: WatchlistState = old();
    if (place === 'row') state.items[0].id = 'listed:old';
    if (place === 'alert')
      state.contexts.identity.alerts['listed:old'] = {
        alert: {
          coin: 'btc',
          assetKey: 'native:btc',
          thresholdPct: 10,
          code: 'USD',
        },
      };
    if (place === 'intent')
      state.contexts.identity.intents['listed:old'] = {
        kind: 'remove',
        order: 2,
      };
    if (place === 'removal')
      state.contexts.identity.pendingRemovals['native:btc'] = {
        itemId: 'listed:old',
        selector: {coin: 'btc'},
        order: 3,
        scope: 'coin',
      };
    const snapshot = JSON.parse(JSON.stringify(state));
    const restored = resetLegacyWatchlistState(state);
    expect(restored).toEqual({
      ...initialWatchlistState,
      priceAlertsEnabled: false,
      permissionPromptShown: true,
    });
    expect(state).toEqual(snapshot);
    expect(restored.items.every(row => row.id.startsWith('coin:'))).toBe(true);
  },
);

it('leaves current ticker state untouched, including ignored legacy assets fields', () => {
  const state = old();
  Object.assign(state.items[0], {
    assets: [{chain: 'btc', currencyAbbreviation: 'btc'}],
  });
  state.contexts.identity.intents['coin:btc'] = {kind: 'save', order: 1};
  expect(resetLegacyWatchlistState(state)).toBe(state);
});

it('rehydrates before requests, then restores backend-held alerts and registration under the same signing identity after the accepted loss of an unsent removal', async () => {
  const selector = {chain: 'eth', tokenAddress: '0xrestored'};
  const alert = {
    ...selector,
    assetKey: selectorKey(selector),
    thresholdPct: 10 as const,
    code: 'USD',
  };
  const saved: WatchlistState = {
    ...old(),
    priceAlertsEnabled: true,
    items: [{...btc, id: 'listed:old'}],
  };
  saved.contexts.identity.pendingRemovals[selectorKey(selector)] = {
    itemId: 'listed:old',
    selector,
    order: 17,
    scope: 'coin',
  };
  const identity = {
    pub: 'same-signing-public-key',
    priv: 'test-only-signing-key',
  };
  const storage = {
    getItem: jest.fn(async () =>
      JSON.stringify({
        WATCHLIST: JSON.stringify(saved),
        APP: JSON.stringify({identity}),
      }),
    ),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  };
  const reducer = persistReducer(
    {key: 'root', storage, transforms: [watchlistPersistTransform], timeout: 0},
    combineReducers({
      WATCHLIST: watchlistReducer,
      APP: (state = {identity}) => state,
    }),
  );
  const store = createStore(reducer);
  let persistor: ReturnType<typeof persistStore>;
  await new Promise<void>(resolve => {
    persistor = persistStore(store, undefined, resolve);
  });
  expect(store.getState().WATCHLIST).toEqual({
    ...initialWatchlistState,
    permissionPromptShown: true,
  });
  expect(store.getState().APP.identity).toEqual(identity);
  const registration = {
    registered: true as const,
    externalUserId: 'same-braze',
    pushEnabled: true,
    priceAlertsEnabled: true,
  };
  const api = {
    list: jest.fn(async () => ({registration, alerts: [alert]})),
    register: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
  };
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xrestored_e': {
        name: 'Restored Token',
        symbol: 'REST',
        address: '0xrestored',
        decimals: 18,
      },
    },
  });
  const queue = new PriceAlertQueue({
    read: () => store.getState().WATCHLIST,
    write: state => {
      store.dispatch(updateWatchlist(state));
    },
    catalog: () => catalog,
    environment: () => ({
      context: store.getState().APP.identity.pub,
      externalUserId: 'same-braze',
      pushEnabled: true,
      currency: 'USD',
    }),
    api: () => api,
  });
  await queue.sync();
  const current = store.getState().WATCHLIST;
  expect(api.list).toHaveBeenCalledTimes(1);
  expect(api.remove).not.toHaveBeenCalled();
  expect(api.register).not.toHaveBeenCalled();
  expect(current.items.at(-1)).toMatchObject({
    id: 'coin:rest',
    selector,
    name: 'Restored Token',
  });
  expect(current.contexts[identity.pub].alerts['coin:rest'].alert).toEqual(
    alert,
  );
  expect(current.contexts[identity.pub].registration).toEqual(registration);
  expect(store.getState().APP.identity).toEqual(identity);
  persistor!.pause();
  await persistor!.flush();
});
