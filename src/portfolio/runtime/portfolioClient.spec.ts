import {PortfolioRuntimeClient, type PortfolioClientTransport} from './portfolioClient';
import type {WorkerRequest, WorkerResponse} from '../core/engine/workerProtocol';

function createImmediateTransport(
  responder: (request: WorkerRequest) => WorkerResponse | Error,
): PortfolioClientTransport {
  return {
    dispatch: async (
      request: WorkerRequest,
      onResponse: (response: WorkerResponse) => void,
      onFatalError: (error: Error) => void,
    ): Promise<void> => {
      const result = responder(request);
      if (result instanceof Error) {
        onFatalError(result);
        return;
      }

      onResponse(result);
    },
  };
}

describe('PortfolioRuntimeClient', () => {
  it('resolves successful responses by request id', async () => {
    const client = new PortfolioRuntimeClient(
      createImmediateTransport(request => {
        return {
          id: request.id,
          ok: true,
          result: null,
        } as WorkerResponse;
      }),
    );

    await expect(client.getSnapshotIndex({walletId: 'w1'})).resolves.toBeNull();
  });

  it('treats worker method failures as per-request errors without poisoning the client', async () => {
    let callCount = 0;
    const client = new PortfolioRuntimeClient(
      createImmediateTransport(request => {
        callCount += 1;
        if (callCount === 1) {
          return {
            id: request.id,
            ok: false,
            error: 'boom',
          } as WorkerResponse;
        }

        return {
          id: request.id,
          ok: true,
          result: undefined,
        } as WorkerResponse;
      }),
    );

    await expect(client.clearWallet({walletId: 'w1'})).rejects.toThrow('boom');
    await expect(client.clearAllStorage()).resolves.toBeUndefined();
  });

  it('dispatches computeAssetRows through the analysis.computeAssetRows RPC method', async () => {
    let dispatchedRequest: WorkerRequest | null = null;
    const client = new PortfolioRuntimeClient(
      createImmediateTransport(request => {
        dispatchedRequest = request;
        return {
          id: request.id,
          ok: true,
          result: {
            timeframe: '1D',
            quoteCurrency: 'USD',
            startTs: 0,
            endTs: 0,
            generatedAt: 0,
            rows: [],
          },
        } as WorkerResponse;
      }),
    );

    await expect(
      client.computeAssetRows({
        cfg: {baseUrl: 'https://example.com'},
        wallets: [],
        quoteCurrency: 'USD',
        timeframe: '1D',
      }),
    ).resolves.toEqual({
      timeframe: '1D',
      quoteCurrency: 'USD',
      startTs: 0,
      endTs: 0,
      generatedAt: 0,
      rows: [],
    });

    expect(dispatchedRequest?.method).toBe('analysis.computeAssetRows');
  });

  it('marks transport failures as fatal for all future requests', async () => {
    const client = new PortfolioRuntimeClient(
      createImmediateTransport(() => new Error('transport failed')),
    );

    await expect(client.getSnapshotIndex({walletId: 'w1'})).rejects.toThrow(
      'transport failed',
    );
    await expect(client.kvStats()).rejects.toThrow('transport failed');
  });
});
