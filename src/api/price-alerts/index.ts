import axios from 'axios';
import BitAuth from 'bitauth';
import {Buffer} from 'buffer';
import type {AppIdentity} from '../../store/app/app.models';
import {
  PriceAlert,
  PriceAlertPreferences,
  PriceAlertRegistration,
  PriceAlertSelector,
  PriceAlertsResponse,
  PriceAlertThreshold,
} from './price-alerts.types';

export const PRICE_ALERTS_PATH = '/v1/pricealerts/';

export const identityHex = (key: string | Uint8Array): string =>
  typeof key === 'string' ? key : Buffer.from(key).toString('hex');

export const normalizeSelector = (
  selector: PriceAlertSelector,
): PriceAlertSelector =>
  'coin' in selector
    ? {coin: selector.coin.toLowerCase()}
    : {
        chain: selector.chain.toLowerCase(),
        tokenAddress:
          selector.chain.toLowerCase() === 'sol'
            ? selector.tokenAddress
            : selector.tokenAddress.toLowerCase(),
      };

export const priceAlertPath = (input: PriceAlertSelector): string => {
  const selector = normalizeSelector(input);
  return (
    PRICE_ALERTS_PATH +
    ('coin' in selector
      ? `?coin=${encodeURIComponent(selector.coin)}`
      : `?chain=${encodeURIComponent(
          selector.chain,
        )}&tokenAddress=${encodeURIComponent(selector.tokenAddress)}`)
  );
};

// The returned string is also the wire body. Never serialize a second object
// after signing: path order, trailing slash and JSON bytes are authenticated.
export const signedPriceAlertRequest = (
  identity: Pick<AppIdentity, 'priv' | 'pub'>,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: object,
) => {
  const json = JSON.stringify(method === 'PUT' ? body || {} : {});
  const message = `${method.toLowerCase()}|${path}|${json}`;
  const signature = BitAuth.sign(message, identityHex(identity.priv));
  return {
    method,
    headers: {
      'x-identity': identityHex(identity.pub),
      'x-signature': identityHex(signature),
      ...(method === 'PUT' ? {'Content-Type': 'application/json'} : {}),
    },
    data: method === 'PUT' ? json : undefined,
  };
};

export class PriceAlertsError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly outcomeUnknown = false,
  ) {
    // Backend/provider messages must never escape into UI error sheets or logs.
    super('Unable to update price alerts. Please try again.');
    this.name = 'PriceAlertsError';
  }
}

export const priceAlertsError = (error: unknown): PriceAlertsError => {
  if (error instanceof PriceAlertsError) {
    return error;
  }
  const response = (
    error as {response?: {status: number; data?: {code?: string}}}
  )?.response;
  const knownCodes = [
    'PRICE_ALERTS_DISABLED',
    'PRICE_ALERTS_UNREGISTERED',
    'PRICE_ALERTS_LIMIT',
    'NOT_AUTHORIZED',
  ];
  const code = response?.data?.code;
  return new PriceAlertsError(
    code && knownCodes.includes(code) ? code : 'PRICE_ALERTS_REQUEST_FAILED',
    response?.status,
    !response || response.status >= 500,
  );
};

export class PriceAlertsApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly identity: Pick<AppIdentity, 'priv' | 'pub'>,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    body?: object,
  ): Promise<T> {
    try {
      const response = await axios.request<T>({
        ...signedPriceAlertRequest(this.identity, method, path, body),
        url: this.baseUrl + path,
        timeout: 30000,
      });
      if (response.status !== 200) {
        throw {response};
      }
      return response.data;
    } catch (error) {
      throw priceAlertsError(error);
    }
  }

  list(): Promise<PriceAlertsResponse> {
    return this.request('GET', PRICE_ALERTS_PATH);
  }

  register(
    preferences: Partial<PriceAlertPreferences>,
  ): Promise<PriceAlertRegistration> {
    return this.request(
      'PUT',
      `${PRICE_ALERTS_PATH}registration/`,
      preferences,
    );
  }

  save(
    selector: PriceAlertSelector,
    thresholdPct: PriceAlertThreshold,
    code: string,
  ): Promise<PriceAlert> {
    return this.request('PUT', priceAlertPath(selector), {thresholdPct, code});
  }

  remove(selector: PriceAlertSelector): Promise<{disabled: true}> {
    return this.request('DELETE', priceAlertPath(selector));
  }
}
