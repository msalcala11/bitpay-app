export type PriceAlertThreshold = 5 | 10 | 15 | 20;
export type PriceAlertSelector =
  | {coin: string}
  | {chain: string; tokenAddress: string};

export interface PriceAlertPreferences {
  externalUserId: string;
  priceAlertsEnabled: boolean;
  pushEnabled: boolean;
}

export type PriceAlertRegistration =
  | {registered: false}
  | ({registered: true} & PriceAlertPreferences);

export type PriceAlert = PriceAlertSelector & {
  assetKey: string;
  thresholdPct: PriceAlertThreshold;
  code: string;
  name?: string;
  symbol?: string;
};

export interface PriceAlertsResponse {
  registration: PriceAlertRegistration;
  alerts: PriceAlert[];
}
