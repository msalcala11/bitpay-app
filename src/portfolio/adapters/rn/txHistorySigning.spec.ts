const mockNitroFetchClient = {
  request: jest.fn(),
  requestSync: jest.fn(),
};
const mockCreateClient = jest.fn(() => mockNitroFetchClient);
const mockNitroFetchSingleton = {
  createClient: mockCreateClient,
};
const mockNitroModulesBox = jest.fn((obj: unknown) => ({
  unbox: () => obj,
}));
let mockKeyObjectInitResult = true;
const mockCreateHybridObject = jest.fn((name: string) => {
  switch (name) {
    case 'Hash':
      return {
        createHash: jest.fn(),
        update: jest.fn(),
        digest: jest.fn(() => new ArrayBuffer(32)),
      };
    case 'KeyObjectHandle':
      return {
        init: jest.fn(() => mockKeyObjectInitResult),
      };
    case 'SignHandle':
      return {
        init: jest.fn(),
        update: jest.fn(),
        sign: jest.fn(
          () =>
            new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])
              .buffer,
        ),
      };
    default:
      throw new Error(`Unexpected hybrid object request: ${name}`);
  }
});

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: (name: string) => mockCreateHybridObject(name),
    box: (obj: unknown) => mockNitroModulesBox(obj),
  },
}));

jest.mock('react-native-nitro-fetch', () => ({
  NitroFetch: mockNitroFetchSingleton,
}));

import {
  createPortfolioTxHistorySigningDispatchContextOnRN,
  derivePortfolioTxHistorySigningAuthorityOnRN,
  disposePortfolioTxHistorySigningDispatchContext,
  getPortfolioNitroFetchClientOnRuntime,
  portfolioTxHistorySigningDispatchContextHasSigningAuthority,
  takeNextPortfolioTransferredSignHandleOnRuntime,
  type PortfolioTxHistorySigningDispatchContext,
} from './txHistorySigning';
import {
  PORTFOLIO_BWS_CLIENT_VERSION_HEADER,
  fetchPortfolioTxHistoryPageByRequest,
} from './txHistoryRequest';

describe('txHistorySigning explicit request context', () => {
  beforeEach(() => {
    mockKeyObjectInitResult = true;
    delete (globalThis as any).NitroModulesProxy;
    jest.clearAllMocks();
  });

  it('hydrates only the explicit signing context on demand', () => {
    const signingAuthority = derivePortfolioTxHistorySigningAuthorityOnRN({
      requestPrivKey:
        '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c',
    });
    const context = createPortfolioTxHistorySigningDispatchContextOnRN({
      signingAuthority,
      requestCount: 2,
    });

    expect(JSON.stringify(context)).not.toContain('requestPrivKey');
    expect(context.signingAuthority?.sec1DerHex).toBeTruthy();
    expect(context.boxedNitroModulesProxy).toBeDefined();
    expect(context.boxedNitroFetch).toBeDefined();
    expect(mockCreateHybridObject).not.toHaveBeenCalled();

    const nitroFetchClient = getPortfolioNitroFetchClientOnRuntime(context);
    expect(nitroFetchClient).toBe(mockNitroFetchClient);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateHybridObject).not.toHaveBeenCalled();

    const firstHandle =
      takeNextPortfolioTransferredSignHandleOnRuntime(context);
    const secondHandle =
      takeNextPortfolioTransferredSignHandleOnRuntime(context);

    expect(firstHandle).not.toBeNull();
    expect(secondHandle).not.toBeNull();
    expect(context.signingAuthority).toBeUndefined();
    expect(context.signHandleHybrids).toHaveLength(2);
    expect(context.nextSignHandleIndex).toBe(2);
    expect(mockCreateHybridObject).toHaveBeenCalledTimes(4);
  });

  it('signs a txhistory request with the context passed to that request', async () => {
    mockNitroFetchClient.requestSync.mockReturnValueOnce({
      ok: true,
      status: 200,
      bodyString: '[]',
    });

    const context = createPortfolioTxHistorySigningDispatchContextOnRN({
      signingAuthority: derivePortfolioTxHistorySigningAuthorityOnRN({
        requestPrivKey:
          '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c',
      }),
      requestCount: 1,
    });

    await fetchPortfolioTxHistoryPageByRequest(
      {
        credentials: {
          walletId: 'wallet-1',
          copayerId: 'copayer-1',
          chain: 'btc',
          coin: 'btc',
        },
        cfg: {baseUrl: 'https://bws.example'},
        skip: 0,
        limit: 1000,
        reverse: true,
      },
      context,
    );

    const request = mockNitroFetchClient.requestSync.mock.calls[0]?.[0] as any;
    expect(request.url).toMatch(
      /^https:\/\/bws\.example\/v1\/txhistory\/\?limit=1000&reverse=1&r=\d+$/,
    );
    expect(request.headers).toEqual(
      expect.arrayContaining([
        {
          key: 'x-client-version',
          value: PORTFOLIO_BWS_CLIENT_VERSION_HEADER,
        },
        {key: 'x-identity', value: 'copayer-1'},
        {key: 'x-signature', value: '3006020101020101'},
      ]),
    );
    expect(request.followRedirects).toBe(false);
    expect(context.signingAuthority).toBeUndefined();
    expect(context.privateKeyHandle).toBeDefined();
    expect(context.signHandleHybrids).toHaveLength(1);
  });

  it('keeps Nitro clients isolated across overlapping request contexts', () => {
    const clientA = {request: jest.fn(), requestSync: jest.fn()};
    const clientB = {request: jest.fn(), requestSync: jest.fn()};
    const contextA = {nitroFetchClient: clientA};
    const contextB = {nitroFetchClient: clientB};

    expect(getPortfolioNitroFetchClientOnRuntime(contextA)).toBe(clientA);
    expect(getPortfolioNitroFetchClientOnRuntime(contextB)).toBe(clientB);
    expect(getPortfolioNitroFetchClientOnRuntime(contextA)).toBe(clientA);
  });

  it('maintains an independent sign-handle cursor for each request context', () => {
    const firstHashHybrid = {} as any;
    const privateKeyHandle = {} as any;
    const a0 = {} as any;
    const a1 = {} as any;
    const b0 = {} as any;
    const contextA: PortfolioTxHistorySigningDispatchContext = {
      firstHashHybrid,
      privateKeyHandle,
      signHandleHybrids: [a0, a1],
      nextSignHandleIndex: 0,
    };
    const contextB: PortfolioTxHistorySigningDispatchContext = {
      firstHashHybrid,
      privateKeyHandle,
      signHandleHybrids: [b0],
      nextSignHandleIndex: 0,
    };

    expect(
      takeNextPortfolioTransferredSignHandleOnRuntime(contextA)
        ?.signHandleHybrid,
    ).toBe(a0);
    expect(
      takeNextPortfolioTransferredSignHandleOnRuntime(contextA)
        ?.signHandleHybrid,
    ).toBe(a1);
    expect(
      takeNextPortfolioTransferredSignHandleOnRuntime(contextB)
        ?.signHandleHybrid,
    ).toBe(b0);
    expect(contextA.nextSignHandleIndex).toBe(2);
    expect(contextB.nextSignHandleIndex).toBe(1);
  });

  it('rejects a missing or fetch-only context for signing', () => {
    expect(() => getPortfolioNitroFetchClientOnRuntime(undefined)).toThrow(
      'Portfolio runtime request context is unavailable.',
    );
    expect(() =>
      takeNextPortfolioTransferredSignHandleOnRuntime(undefined),
    ).toThrow('Portfolio runtime request context is unavailable.');
    expect(() =>
      takeNextPortfolioTransferredSignHandleOnRuntime({
        nitroFetchClient: mockNitroFetchClient,
      }),
    ).toThrow(
      'No SEC1 DER-encoded request private key is available on the portfolio runtime for Nitro signing hydration.',
    );
  });

  it('deletes DER authority and hydrated handle refs when hydration fails', () => {
    mockKeyObjectInitResult = false;
    const context = createPortfolioTxHistorySigningDispatchContextOnRN({
      signingAuthority: derivePortfolioTxHistorySigningAuthorityOnRN({
        requestPrivKey:
          '3da1b53f027ed856bb1922dde7438f91309a59fa1a3aaf7f64dd7f46a258c73c',
      }),
      requestCount: 1,
    });

    expect(() =>
      takeNextPortfolioTransferredSignHandleOnRuntime(context),
    ).toThrow('KeyObjectHandle.init() returned false');
    expect(context.signingAuthority).toBeUndefined();
    expect(context.privateKeyHandle).toBeUndefined();
    expect(context.signHandleHybrids).toBeUndefined();
    expect(context.firstHashHybrid).toBeUndefined();
  });

  it('disposes one context idempotently without mutating another context', () => {
    const contextA: PortfolioTxHistorySigningDispatchContext = {
      signingAuthority: {kind: 'sec1DerHex', sec1DerHex: 'der-a'},
      nitroFetchClient: {request: jest.fn(), requestSync: jest.fn()},
      nextSignHandleIndex: 2,
    };
    const contextB: PortfolioTxHistorySigningDispatchContext = {
      signingAuthority: {kind: 'sec1DerHex', sec1DerHex: 'der-b'},
      nitroFetchClient: {request: jest.fn(), requestSync: jest.fn()},
      nextSignHandleIndex: 3,
    };

    disposePortfolioTxHistorySigningDispatchContext(contextA);
    disposePortfolioTxHistorySigningDispatchContext(contextA);

    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority(contextA),
    ).toBe(false);
    expect(contextA.nitroFetchClient).toBeUndefined();
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority(contextB),
    ).toBe(true);
    expect(contextB.nextSignHandleIndex).toBe(3);
    expect(contextB.nitroFetchClient).toBeDefined();
  });

  it('recognizes only complete hydrated handles or DER authority as signing-capable', () => {
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority(undefined),
    ).toBe(false);
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority({
        privateKeyHandle: {} as any,
      }),
    ).toBe(false);
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority({
        firstHashHybrid: {} as any,
        privateKeyHandle: {} as any,
        signHandleHybrids: [],
      }),
    ).toBe(false);
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority({
        signingAuthority: {kind: 'sec1DerHex', sec1DerHex: 'der-fixture'},
      }),
    ).toBe(true);
    expect(
      portfolioTxHistorySigningDispatchContextHasSigningAuthority({
        firstHashHybrid: {} as any,
        privateKeyHandle: {} as any,
        signHandleHybrids: [{} as any],
      }),
    ).toBe(true);
  });
});
