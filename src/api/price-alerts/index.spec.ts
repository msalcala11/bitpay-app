import axios from 'axios';
import BitAuth from 'bitauth';
import {Buffer} from 'buffer';
import {createHash} from 'crypto';
import {
  PriceAlertsApi,
  priceAlertPath,
  priceAlertsError,
  signedPriceAlertRequest,
} from './index';

jest.mock('axios');

const priv = createHash('sha256')
  .update('bws-price-alerts-test-vector-1 (throwaway)')
  .digest('hex');
const pub =
  '02fb4b3a1b3f7adbd3c322c41d07452f0fedd0ded9c427dcf155f2924e3e30691a';
const identity = {priv, pub};
const tokenAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const vectors = [
  {
    method: 'GET' as const,
    path: '/v1/pricealerts/',
    body: undefined,
    signature:
      '304402204e6a1219fbae4f6e7e700aa776267960b28f1fa78e12e5baccab767f10b395530220014a58bea805ff71a4fff443d9cd09a1e656065b03005e241b8b9c0706950110',
  },
  {
    method: 'DELETE' as const,
    path: '/v1/pricealerts/?coin=btc',
    body: undefined,
    signature:
      '30440220538d6d6136735a408cdf51e2134f43613c649c6920d6f9a2057fc41d0586355f02201c52da27c4f2b171deb425e3e73cc1aa6cd79f804fc27a5256286f3bba8a3ebf',
  },
  {
    method: 'PUT' as const,
    path: `/v1/pricealerts/?chain=eth&tokenAddress=${tokenAddress}`,
    body: {thresholdPct: 10, code: 'USD'},
    signature:
      '304402202f1b3d7d28ef794bba7889e3d68b0b81bb25446b4b878343148741ddb5fd5c7b022038f2e99d9be894109cc96da8ae021372d53fe59797c3284be11b7c88eba965db',
  },
];

describe('price alert signing vectors', () => {
  it.each(vectors)('$method $path', ({method, path, body, signature}) => {
    const request = signedPriceAlertRequest(identity, method, path, body);
    const message = `${method.toLowerCase()}|${path}|${JSON.stringify(
      body || {},
    )}`;
    expect(BitAuth.getPublicKeyFromPrivateKey(priv)).toBe(pub);
    expect(request.headers['x-signature']).toBe(signature);
    expect(BitAuth.verifySignature(message, pub, signature)).toBe(true);
    expect(request.data).toBe(body ? JSON.stringify(body) : undefined);
  });

  it('accepts byte identities as well as hex strings', () => {
    expect(
      signedPriceAlertRequest(
        {priv: Buffer.from(priv, 'hex'), pub: Buffer.from(pub, 'hex')},
        'GET',
        '/v1/pricealerts/',
      ),
    ).toEqual(signedPriceAlertRequest(identity, 'GET', '/v1/pricealerts/'));
  });
});

describe('price alerts transport', () => {
  const request = axios.request as jest.Mock;
  const api = new PriceAlertsApi('http://localhost:3232/bws/api/', identity);

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({status: 200, data: {ok: true}});
  });

  it('builds canonical selectors, with case-sensitive Solana addresses', () => {
    expect(priceAlertPath({coin: 'BTC'})).toBe('/v1/pricealerts/?coin=btc');
    expect(priceAlertPath({chain: 'ETH', tokenAddress: '0xAbC'})).toBe(
      '/v1/pricealerts/?chain=eth&tokenAddress=0xabc',
    );
    expect(priceAlertPath({chain: 'sol', tokenAddress: 'AbC123'})).toBe(
      '/v1/pricealerts/?chain=sol&tokenAddress=AbC123',
    );
  });

  it('signs the exact wire path and body of all four calls', async () => {
    await api.list();
    await api.register({
      externalUserId: 'test',
      priceAlertsEnabled: true,
      pushEnabled: false,
    });
    await api.save({chain: 'eth', tokenAddress}, 10, 'USD');
    await api.remove({coin: 'btc'});
    expect(request.mock.calls.map(([config]) => config.url)).toEqual([
      'http://localhost:3232/bws/api/v1/pricealerts/',
      'http://localhost:3232/bws/api/v1/pricealerts/registration/',
      `http://localhost:3232/bws/api/v1/pricealerts/?chain=eth&tokenAddress=${tokenAddress}`,
      'http://localhost:3232/bws/api/v1/pricealerts/?coin=btc',
    ]);
    for (const [config] of request.mock.calls) {
      const path = config.url.replace('http://localhost:3232/bws/api', '');
      expect(
        BitAuth.verifySignature(
          `${config.method.toLowerCase()}|${path}|${config.data || '{}'}`,
          config.headers['x-identity'],
          config.headers['x-signature'],
        ),
      ).toBe(true);
      if (config.method === 'PUT') {
        expect(config.headers['Content-Type']).toBe('application/json');
        expect(typeof config.data).toBe('string');
      } else {
        expect(config.data).toBeUndefined();
      }
    }
  });

  it.each([
    [
      400,
      {code: 'PRICE_ALERTS_DISABLED', message: 'private'},
      'PRICE_ALERTS_DISABLED',
    ],
    [401, {code: 'NOT_AUTHORIZED', message: 'private'}, 'NOT_AUTHORIZED'],
    [
      400,
      {code: 'VALIDATION_ERROR', message: 'private'},
      'PRICE_ALERTS_REQUEST_FAILED',
    ],
    [429, {error: 'coinGecko rate limit'}, 'PRICE_ALERTS_REQUEST_FAILED'],
    [403, {error: 'private'}, 'PRICE_ALERTS_REQUEST_FAILED'],
    [503, {error: 'private'}, 'PRICE_ALERTS_REQUEST_FAILED'],
  ])(
    'maps HTTP %s without exposing backend text',
    async (status, data, code) => {
      request.mockRejectedValue({response: {status, data}});
      await expect(api.list()).rejects.toMatchObject({
        code,
        status,
        message: 'Unable to update price alerts. Please try again.',
      });
    },
  );

  it('marks a lost response as unknown', () => {
    expect(priceAlertsError(new Error('Network Error')).outcomeUnknown).toBe(
      true,
    );
  });
});
