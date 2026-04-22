import {runOnRuntimeAsync} from 'react-native-worklets';
import {createPortfolioTxHistorySigningDispatchContextOnRN} from '../adapters/rn/txHistorySigning';
import {createWorkletPortfolioTransport} from './portfolioWorkletTransport';

jest.mock('react-native-worklets', () => ({
  runOnRuntimeAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../adapters/rn/txHistorySigning', () => ({
  createPortfolioTxHistorySigningDispatchContextOnRN: jest.fn(
    (args: Record<string, unknown>) => ({
      kind: 'dispatch-context',
      ...args,
    }),
  ),
}));

describe('createWorkletPortfolioTransport', () => {
  const mockedRunOnRuntimeAsync = runOnRuntimeAsync as jest.MockedFunction<
    typeof runOnRuntimeAsync
  >;
  const mockedCreateSigningContext =
    createPortfolioTxHistorySigningDispatchContextOnRN as jest.MockedFunction<
      typeof createPortfolioTxHistorySigningDispatchContextOnRN
    >;

  beforeEach(() => {
    mockedRunOnRuntimeAsync.mockClear();
    mockedCreateSigningContext.mockClear();
  });

  it('provides a default Nitro-capable request context for analysis queries', async () => {
    const transport = createWorkletPortfolioTransport({
      runtime: {} as any,
      host: {} as any,
    });

    await transport.dispatch(
      {
        id: 1,
        method: 'analysis.compute',
        params: {
          wallets: [],
          quoteCurrency: 'USD',
          timeframe: '1D',
        },
      } as any,
      jest.fn(),
      jest.fn(),
    );

    expect(mockedCreateSigningContext).toHaveBeenCalledWith({
      requestPrivKey: undefined,
      requestPubKey: undefined,
      requestCount: 1,
    });

    const dispatchContext = mockedRunOnRuntimeAsync.mock.calls[0]?.[4] as any;
    expect(dispatchContext?.singleRequestSigningContext).toMatchObject({
      kind: 'dispatch-context',
      requestCount: 1,
    });
  });

  it('preserves wallet signing metadata for txhistory page requests', async () => {
    const transport = createWorkletPortfolioTransport({
      runtime: {} as any,
      host: {} as any,
    });

    await transport.dispatch(
      {
        id: 1,
        method: 'snapshots.prepareWallet',
        params: {
          wallet: {walletId: 'wallet-1'},
          credentials: {
            requestPrivKey: 'priv-key',
            requestPubKey: 'pub-key',
          },
        },
      } as any,
      jest.fn(),
      jest.fn(),
    );

    mockedRunOnRuntimeAsync.mockClear();
    mockedCreateSigningContext.mockClear();

    await transport.dispatch(
      {
        id: 2,
        method: 'snapshots.processNextPage',
        params: {
          walletId: 'wallet-1',
        },
      } as any,
      jest.fn(),
      jest.fn(),
    );

    expect(mockedCreateSigningContext).toHaveBeenCalledWith({
      requestPrivKey: 'priv-key',
      requestPubKey: 'pub-key',
      requestCount: 4,
    });

    const dispatchContext = mockedRunOnRuntimeAsync.mock.calls[0]?.[4] as any;
    expect(dispatchContext?.singleRequestSigningContext).toMatchObject({
      kind: 'dispatch-context',
      requestPrivKey: 'priv-key',
      requestPubKey: 'pub-key',
      requestCount: 4,
    });
  });

  it('passes lightweight per-wallet populate signing metadata without eagerly hydrating Nitro hybrids', async () => {
    const transport = createWorkletPortfolioTransport({
      runtime: {} as any,
      host: {} as any,
    });

    await transport.dispatch(
      {
        id: 3,
        method: 'populate.startJob',
        params: {
          wallets: [
            {
              walletId: 'wallet-1',
              credentials: {
                requestPrivKey: 'priv-key-1',
                requestPubKey: 'pub-key-1',
              },
              summary: {
                walletId: 'wallet-1',
              },
            },
            {
              walletId: 'wallet-2',
              credentials: {
                requestPrivKey: 'priv-key-2',
              },
              summary: {
                walletId: 'wallet-2',
              },
            },
          ],
        },
      } as any,
      jest.fn(),
      jest.fn(),
    );

    expect(mockedCreateSigningContext).toHaveBeenCalledTimes(3);
    expect(mockedCreateSigningContext).toHaveBeenNthCalledWith(1, {
      requestPrivKey: undefined,
      requestPubKey: undefined,
      requestCount: 1,
    });
    expect(mockedCreateSigningContext).toHaveBeenNthCalledWith(2, {
      requestPrivKey: 'priv-key-1',
      requestPubKey: 'pub-key-1',
      requestCount: 4,
    }, expect.any(Object));
    expect(mockedCreateSigningContext).toHaveBeenNthCalledWith(3, {
      requestPrivKey: 'priv-key-2',
      requestPubKey: undefined,
      requestCount: 4,
    }, expect.any(Object));

    const dispatchContext = mockedRunOnRuntimeAsync.mock.calls[0]?.[4] as any;
    expect(dispatchContext?.populateJobSigningContextsByWalletId).toEqual({
      'wallet-1': {
        kind: 'dispatch-context',
        requestPrivKey: 'priv-key-1',
        requestPubKey: 'pub-key-1',
        requestCount: 4,
      },
      'wallet-2': {
        kind: 'dispatch-context',
        requestPrivKey: 'priv-key-2',
        requestPubKey: undefined,
        requestCount: 4,
      },
    });
  });
});
