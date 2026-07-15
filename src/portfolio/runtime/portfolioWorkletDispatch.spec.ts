jest.mock('react-native-worklets', () => ({
  scheduleOnRN: jest.fn(
    (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
  ),
}));

jest.mock('../adapters/rn/txHistorySigning', () => ({
  disposePortfolioTxHistorySigningDispatchContext: jest.fn(),
}));

jest.mock('../adapters/rn/workletRuntimeShared', () => ({
  getRuntimeErrorDetails: jest.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })),
}));

jest.mock('./worklet/portfolioRequestWorklet', () => ({
  canHandlePortfolioRequestOnRuntime: jest.fn(() => true),
  handlePortfolioRequestOnRuntime: jest.fn(),
}));

jest.mock('./worklet/portfolioPopulateJobWorklet', () => ({
  handleGetPopulateJobStatusOnWorklet: jest.fn(),
}));

import {disposePortfolioTxHistorySigningDispatchContext} from '../adapters/rn/txHistorySigning';
import {
  dispatchPortfolioPopulateStartAndWaitOnRuntime,
  dispatchPortfolioRequestOnRuntime,
} from './portfolioWorkletDispatch';
import {
  canHandlePortfolioRequestOnRuntime,
  handlePortfolioRequestOnRuntime,
} from './worklet/portfolioRequestWorklet';
import {handleGetPopulateJobStatusOnWorklet} from './worklet/portfolioPopulateJobWorklet';

const flushDispatch = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

describe('portfolioWorkletDispatch explicit request contexts', () => {
  const mockedDispose =
    disposePortfolioTxHistorySigningDispatchContext as jest.MockedFunction<
      typeof disposePortfolioTxHistorySigningDispatchContext
    >;
  const mockedCanHandle =
    canHandlePortfolioRequestOnRuntime as jest.MockedFunction<
      typeof canHandlePortfolioRequestOnRuntime
    >;
  const mockedHandleRequest =
    handlePortfolioRequestOnRuntime as jest.MockedFunction<
      typeof handlePortfolioRequestOnRuntime
    >;
  const mockedGetPopulateJobStatus =
    handleGetPopulateJobStatusOnWorklet as jest.MockedFunction<
      typeof handleGetPopulateJobStatusOnWorklet
    >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCanHandle.mockReturnValue(true);
  });

  it('passes the request-owned signing context explicitly and disposes it after response', async () => {
    const requestContext = {kind: 'request-a'} as any;
    const response = {id: 1, ok: true, result: undefined} as any;
    mockedHandleRequest.mockResolvedValue(response);

    const resolveOnRN = jest.fn();
    const rejectOnRN = jest.fn();
    const dispatchContext = {
      singleRequestSigningContext: requestContext,
    };

    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 1, method: 'rates.ensure', params: {}} as any,
      dispatchContext,
      resolveOnRN,
      rejectOnRN,
    );
    await flushDispatch();

    expect(mockedHandleRequest).toHaveBeenCalledWith(
      {},
      expect.objectContaining({id: 1, method: 'rates.ensure'}),
      requestContext,
      undefined,
    );
    expect(mockedDispose).toHaveBeenCalledTimes(1);
    expect(mockedDispose).toHaveBeenCalledWith(requestContext);
    expect(dispatchContext.singleRequestSigningContext).toBeUndefined();
    expect(resolveOnRN).toHaveBeenCalledWith(response);
    expect(rejectOnRN).not.toHaveBeenCalled();
  });

  it('keeps overlapping dispatches bound to their own explicit contexts', async () => {
    const firstGate = deferred<any>();
    const secondGate = deferred<any>();
    const seenContexts: unknown[] = [];

    mockedHandleRequest.mockImplementation(
      async (_config: any, request: any, requestContext: any) => {
        seenContexts.push(requestContext);
        return request.id === 1 ? firstGate.promise : secondGate.promise;
      },
    );

    const contextA = {kind: 'context-a'} as any;
    const contextB = {kind: 'context-b'} as any;
    const resolveA = jest.fn();
    const resolveB = jest.fn();

    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 1, method: 'rates.ensure', params: {}} as any,
      {singleRequestSigningContext: contextA},
      resolveA,
      jest.fn(),
    );
    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 2, method: 'rates.ensure', params: {}} as any,
      {singleRequestSigningContext: contextB},
      resolveB,
      jest.fn(),
    );
    await flushDispatch();

    expect(seenContexts).toEqual([contextA, contextB]);

    secondGate.resolve({id: 2, ok: true, result: 'b'} as any);
    await flushDispatch();
    expect(resolveB).toHaveBeenCalledWith({id: 2, ok: true, result: 'b'});
    expect(resolveA).not.toHaveBeenCalled();

    firstGate.resolve({id: 1, ok: true, result: 'a'} as any);
    await flushDispatch();
    expect(resolveA).toHaveBeenCalledWith({id: 1, ok: true, result: 'a'});
    expect(mockedDispose).toHaveBeenCalledWith(contextA);
    expect(mockedDispose).toHaveBeenCalledWith(contextB);
  });

  it('uses each request Nitro client after both shared-runtime dispatches have yielded', async () => {
    const resume = deferred<void>();
    const clientA = {
      requestSync: jest.fn(() => 'response-a'),
    };
    const clientB = {
      requestSync: jest.fn(() => 'response-b'),
    };

    mockedHandleRequest.mockImplementation(
      async (_config: any, request: any, requestContext: any) => {
        await resume.promise;
        return {
          id: request.id,
          ok: true,
          result: requestContext.nitroFetchClient.requestSync({
            requestId: request.id,
          }),
        } as any;
      },
    );

    const resolveA = jest.fn();
    const resolveB = jest.fn();
    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 11, method: 'rates.ensure', params: {}} as any,
      {singleRequestSigningContext: {nitroFetchClient: clientA} as any},
      resolveA,
      jest.fn(),
    );
    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 12, method: 'analysis.computeChart', params: {}} as any,
      {singleRequestSigningContext: {nitroFetchClient: clientB} as any},
      resolveB,
      jest.fn(),
    );
    await flushDispatch();

    expect(clientA.requestSync).not.toHaveBeenCalled();
    expect(clientB.requestSync).not.toHaveBeenCalled();

    resume.resolve();
    await flushDispatch();

    expect(clientA.requestSync).toHaveBeenCalledWith({requestId: 11});
    expect(clientB.requestSync).toHaveBeenCalledWith({requestId: 12});
    expect(resolveA).toHaveBeenCalledWith({
      id: 11,
      ok: true,
      result: 'response-a',
    });
    expect(resolveB).toHaveBeenCalledWith({
      id: 12,
      ok: true,
      result: 'response-b',
    });
  });

  it('passes populate wallet contexts explicitly and releases the source map after handoff', async () => {
    const requestContext = {kind: 'start-request'} as any;
    const walletContext = {kind: 'wallet-1'} as any;
    const sourceMap = {'wallet-1': walletContext};
    let receivedWalletContext: unknown;

    mockedHandleRequest.mockImplementation(
      async (
        _config: any,
        _request: any,
        receivedRequestContext: any,
        receivedMap: any,
      ) => {
        expect(receivedRequestContext).toBe(requestContext);
        receivedWalletContext = receivedMap?.['wallet-1'];
        return {
          id: 3,
          ok: true,
          result: {
            jobId: 'job-1',
            status: {jobId: 'job-1', state: 'running', inProgress: true},
          },
        } as any;
      },
    );

    const dispatchContext = {
      singleRequestSigningContext: requestContext,
      populateJobSigningContextsByWalletId: sourceMap,
    };
    const resolveOnRN = jest.fn();

    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {
        id: 3,
        method: 'populate.startJob',
        params: {wallets: [], awaitTerminal: false},
      } as any,
      dispatchContext,
      resolveOnRN,
      jest.fn(),
    );
    await flushDispatch();

    expect(receivedWalletContext).toBe(walletContext);
    expect(mockedDispose).toHaveBeenCalledWith(requestContext);
    expect(mockedDispose).toHaveBeenCalledWith(walletContext);
    expect(sourceMap).toEqual({});
    expect(dispatchContext.singleRequestSigningContext).toBeUndefined();
    expect(
      dispatchContext.populateJobSigningContextsByWalletId,
    ).toBeUndefined();
    expect(resolveOnRN).toHaveBeenCalledWith(
      expect.objectContaining({id: 3, ok: true}),
    );
  });

  it('disposes request context and reports a handler error', async () => {
    const requestContext = {kind: 'failing-request'} as any;
    mockedHandleRequest.mockRejectedValue(new Error('runtime failed'));
    const resolveOnRN = jest.fn();
    const rejectOnRN = jest.fn();

    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 4, method: 'analysis.compute', params: {}} as any,
      {singleRequestSigningContext: requestContext},
      resolveOnRN,
      rejectOnRN,
    );
    await flushDispatch();

    expect(mockedDispose).toHaveBeenCalledWith(requestContext);
    expect(resolveOnRN).not.toHaveBeenCalled();
    expect(rejectOnRN).toHaveBeenCalledWith(
      'runtime failed',
      expect.any(String),
    );
  });

  it('rejects an unsupported request without invoking the handler', async () => {
    mockedCanHandle.mockReturnValue(false);
    const requestContext = {kind: 'unsupported'} as any;
    const rejectOnRN = jest.fn();

    dispatchPortfolioRequestOnRuntime(
      {} as any,
      {id: 5, method: 'rates.ensure', params: {}} as any,
      {singleRequestSigningContext: requestContext},
      jest.fn(),
      rejectOnRN,
    );
    await flushDispatch();

    expect(mockedHandleRequest).not.toHaveBeenCalled();
    expect(mockedDispose).toHaveBeenCalledWith(requestContext);
    expect(rejectOnRN).toHaveBeenCalledWith(
      expect.stringContaining('does not support rates.ensure'),
      expect.any(String),
    );
  });

  it('polls an awaited populate job until terminal after explicit context handoff', async () => {
    jest.useFakeTimers();

    try {
      const runtimeConfig = {kind: 'runtime-config'} as any;
      const requestContext = {kind: 'await-request'} as any;
      const walletContext = {kind: 'wallet-context'} as any;
      const sourceMap = {'wallet-1': walletContext};
      mockedHandleRequest.mockResolvedValue({
        id: 6,
        ok: true,
        result: {
          jobId: 'job-1',
          status: {jobId: 'job-1', state: 'running', inProgress: true},
        },
      } as any);
      const terminalStatus = {
        jobId: 'job-1',
        state: 'completed',
        inProgress: false,
      } as any;
      mockedGetPopulateJobStatus.mockResolvedValue(terminalStatus);

      const resolveOnRN = jest.fn();
      const rejectOnRN = jest.fn();
      dispatchPortfolioPopulateStartAndWaitOnRuntime(
        runtimeConfig,
        {
          id: 6,
          method: 'populate.startJob',
          params: {wallets: [], awaitTerminal: true},
        } as any,
        {
          singleRequestSigningContext: requestContext,
          populateJobSigningContextsByWalletId: sourceMap,
        },
        resolveOnRN,
        rejectOnRN,
      );
      await flushDispatch();

      expect(mockedHandleRequest).toHaveBeenCalledWith(
        runtimeConfig,
        expect.objectContaining({method: 'populate.startJob'}),
        requestContext,
        sourceMap,
      );
      expect(sourceMap).toEqual({});
      expect(resolveOnRN).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();
      await flushDispatch();

      expect(mockedGetPopulateJobStatus).toHaveBeenCalledWith(
        runtimeConfig,
        'job-1',
      );
      expect(resolveOnRN).toHaveBeenCalledWith({
        id: 6,
        ok: true,
        result: {jobId: 'job-1', status: terminalStatus},
      });
      expect(rejectOnRN).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
