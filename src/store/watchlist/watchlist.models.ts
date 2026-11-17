import type {
  PriceAlert,
  PriceAlertRegistration,
  PriceAlertSelector,
} from '../../api/price-alerts/price-alerts.types';

export interface WatchlistAsset {
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
  network?: string;
}

export interface WatchlistCoin {
  id: string;
  name: string;
  symbol: string;
  image: {builtin: string} | {uri: string};
  assets: WatchlistAsset[];
  selector: PriceAlertSelector;
}

export interface PendingRemoval {
  itemId: string;
  selector: PriceAlertSelector;
  order: number;
}

export interface AlertContextState {
  attemptedSave: boolean;
  registration?: PriceAlertRegistration;
  registrationUnknown?: boolean;
  alerts: Record<string, {alert: PriceAlert; unknown?: boolean}>;
  pendingRemovals: Record<string, PendingRemoval>;
  intents: Record<string, {order: number; kind: 'save' | 'off' | 'remove'}>;
  unresolved: PriceAlert[];
  unresolvedOrder?: number;
  unknownSelectors: Record<string, boolean>;
  lastSync?: number;
  disabled: boolean;
}

export interface WatchlistState {
  items: WatchlistCoin[];
  contexts: Record<string, AlertContextState>;
  order: number;
  priceAlertsEnabled: boolean;
  permissionPromptShown: boolean;
  // Runtime fields are excluded from persistence.
  activeContext?: string;
  permissionAllowed: boolean;
  alertSheet?: {
    coin: WatchlistCoin;
    context: 'Watchlist' | 'PriceChart' | 'WalletDetails';
    afterAdd: boolean;
    open: boolean;
    saved?: boolean;
    nonce: number;
  };
  lastAdded?: {id: string; nonce: number};
  pendingNotificationPrompt?: 'Watchlist' | 'PriceChart' | 'WalletDetails';
}

export const emptyAlertContext = (): AlertContextState => ({
  attemptedSave: false,
  alerts: {},
  pendingRemovals: {},
  intents: {},
  unresolved: [],
  unknownSelectors: {},
  disabled: false,
});
