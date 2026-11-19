import {Analytics} from '../../store/analytics/analytics.effects';
import {savePriceAlert} from '../../store/watchlist/watchlist.effects';
import {
  saveAlertFromUi,
  removeCoinFromUi,
  reorderFromUi,
  skipPriceAlert,
  canAddWatchlistCoin,
} from './watchlistUi.effects';
import type {WatchlistCoin} from '../../store/watchlist/watchlist.models';
const coin = {
  id: 'coin:btc',
  name: 'Bitcoin',
  symbol: 'BTC',
  selector: {coin: 'btc'},
} as unknown as WatchlistCoin;
const existing = {coin: 'btc', thresholdPct: 10, code: 'USD'};
jest.mock('../../store/analytics/analytics.effects', () => ({
  Analytics: {
    track: jest.fn((event, properties) => ({
      type: 'ANALYTICS',
      event,
      properties,
    })),
  },
}));
jest.mock('../../store/app/app.actions', () => ({
  showBottomNotificationModal: (payload: unknown) => ({type: 'SHEET', payload}),
}));
jest.mock('../../store/watchlist/watchlist.selectors', () => ({
  selectAlertContext: (state: any) => state.context,
  selectAlertsAvailable: () => true,
}));
jest.mock('../../store/watchlist/watchlist.effects', () => ({
  savePriceAlert: jest.fn(),
  removeWatchlistCoin: () => () => ({coin: 'btc', thresholdPct: 10}),
  reorderWatchlist: () => () => ({
    coin: 'btc',
    from_position: 8,
    to_position: 2,
    moved_into_top_5: true,
  }),
}));
const create = () => {
  const state = {
    WATCHLIST: {items: [coin], alertSheet: {open: true}},
    context: {alerts: {'coin:btc': {alert: existing}}},
  };
  const dispatch = (action: any): any =>
    typeof action === 'function'
      ? action(dispatch, () => state, undefined)
      : action;
  return {state, dispatch};
};
beforeEach(() => jest.clearAllMocks());
it('waits for the alert sheet to finish dismissing before opening another native picker', () => {
  const state: any = {WATCHLIST: {items: [], alertSheet: {open: false}}};
  const dispatch = jest.fn();
  const canOpen = () => (canAddWatchlistCoin() as any)(dispatch, () => state);
  expect(canOpen()).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  state.WATCHLIST.alertSheet = undefined;
  expect(canOpen()).toBe(true);
});
it('emits exact edit properties only after a confirmed save, and nothing on failure', async () => {
  const h = create();
  let resolve!: (value: any) => void;
  (savePriceAlert as jest.Mock).mockReturnValue(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const saving = h.dispatch(saveAlertFromUi(coin, 20, 'PriceChart'));
  expect(Analytics.track).not.toHaveBeenCalled();
  resolve({...existing, thresholdPct: 20});
  await saving;
  expect(Analytics.track).toHaveBeenCalledWith('Price Alert Saved', {
    coin: 'btc',
    threshold_pct: 20,
    is_edit: true,
    previous_threshold_pct: 10,
    context: 'PriceChart',
  });
  jest.clearAllMocks();
  (savePriceAlert as jest.Mock).mockReturnValue(() =>
    Promise.reject(new Error('offline')),
  );
  await expect(
    h.dispatch(saveAlertFromUi(coin, 20, 'PriceChart')),
  ).rejects.toThrow();
  expect(Analytics.track).not.toHaveBeenCalled();
});
it('records removal with its alert and one-based reorder positions', () => {
  const h = create();
  h.dispatch(removeCoinFromUi(coin, 'HomeRoot'));
  expect(Analytics.track).toHaveBeenCalledWith('Watchlist Asset Removed', {
    coin: 'btc',
    context: 'HomeRoot',
    had_alert: true,
  });
  expect(Analytics.track).toHaveBeenCalledWith('Price Alert Turned Off', {
    coin: 'btc',
    threshold_pct: 10,
    method: 'removed_from_watchlist',
    context: 'HomeRoot',
  });
  h.dispatch(reorderFromUi('btc', 1));
  expect(Analytics.track).toHaveBeenCalledWith('Watchlist Reordered', {
    coin: 'btc',
    from_position: 8,
    to_position: 2,
    moved_into_top_5: true,
  });
  h.dispatch(skipPriceAlert(coin));
  expect(Analytics.track).toHaveBeenCalledWith('Price Alert Skipped', {
    coin: 'btc',
  });
});
