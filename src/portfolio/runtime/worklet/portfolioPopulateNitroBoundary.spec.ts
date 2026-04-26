import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  getPortfolioTxHistorySigningDispatchContextOnRuntime,
} from '../../adapters/rn/txHistorySigning';
import * as txHistoryPageFetcher from '../../adapters/rn/txHistoryPageFetcher';
import * as txHistorySigning from '../../adapters/rn/txHistorySigning';
import {
  handleGetPopulateJobStatusOnWorklet,
  handleStartPopulateJobOnWorklet,
  resetPortfolioPopulateJobWorkletState,
} from './portfolioPopulateJobWorklet';

type FakeStorage = {
  contains: (key: string) => boolean;
  delete: (key: string) => void;
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
};

type FakeNitroRequest = {
  url: string;
  method?: string;
  headers?: Array<{key: string; value: string}>;
  timeoutMs?: number;
  followRedirects?: boolean;
};

type FakeNitroResponse = {
  ok: boolean;
  status: number;
  bodyString?: string;
};

const createStorage = (): FakeStorage => {
  const map = new Map<string, string>();
  return {
    contains: key => map.has(key),
    delete: key => {
      map.delete(key);
    },
    getString: key => map.get(key),
    set: (key, value) => {
      map.set(key, String(value));
    },
  };
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function createSigningContext(
  handler: (request: FakeNitroRequest) => FakeNitroResponse,
) {
  const requestSync = jest.fn((request: FakeNitroRequest) => handler(request));
  const request = jest.fn(async (requestArgs: FakeNitroRequest) =>
    handler(requestArgs),
  );
  const signatureDer = Uint8Array.from([
    0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01,
  ]);

  return {
    context: {
      nitroFetchClient: {
        request,
        requestSync,
      },
      firstHashHybrid: {
        createHash: jest.fn(),
        update: jest.fn(),
        digest: jest.fn(() => toArrayBuffer(new Uint8Array(32))),
      },
      signHandleHybrids: [
        {
          init: jest.fn(),
          update: jest.fn(),
          sign: jest.fn(() => toArrayBuffer(signatureDer)),
        },
      ],
      privateKeyHandle: {},
      nextSignHandleIndex: 0,
    },
    requestSync,
  };
}

async function waitForTerminalStatus(
  config: {
    storageId?: string;
    registryKey?: string;
  },
  jobId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await handleGetPopulateJobStatusOnWorklet(config, jobId);
    if (status && !status.inProgress) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  throw new Error(`Populate job ${jobId} did not reach a terminal state.`);
}

describe('populate worklet Nitro boundary', () => {
  afterEach(() => {
    clearPortfolioTxHistorySigningDispatchContextOnRuntime();
    jest.restoreAllMocks();
  });

  it('fetches rates and txhistory through Nitro inside the populate loop without JS trampolines', async () => {
    const mutableGlobal = globalThis as unknown as {fetch?: unknown};
    const originalFetch = mutableGlobal.fetch;
    const fetchSpy = jest.fn();
    const bitcoreSigningSpy = jest.spyOn(
      txHistorySigning,
      'signBwsGetRequestWithBitcore',
    );
    const jsTxHistoryFetcherSpy = jest.spyOn(
      txHistoryPageFetcher,
      'fetchPortfolioTxHistoryPage',
    );
    const storage = createStorage();
    const config = {
      storage,
      storageId: 'populate-nitro-boundary',
      registryKey: '__populate_nitro_boundary_registry__',
    };
    const requestLog: FakeNitroRequest[] = [];
    const {context, requestSync} = createSigningContext(request => {
      requestLog.push(request);
      const url = String(request.url || '');
      if (url.includes('/v4/fiatrates/USD')) {
        return {
          ok: true,
          status: 200,
          bodyString: JSON.stringify({
            btc: [
              {ts: 1700000000000, rate: 10000},
              {ts: 1700086400000, rate: 11000},
            ],
          }),
        };
      }
      if (url.includes('/v1/txhistory/')) {
        return {
          ok: true,
          status: 200,
          bodyString: JSON.stringify([]),
        };
      }
      return {
        ok: false,
        status: 404,
        bodyString: `Unexpected URL: ${url}`,
      };
    });

    mutableGlobal.fetch = fetchSpy;
    resetPortfolioPopulateJobWorkletState(config);

    try {
      const started = await handleStartPopulateJobOnWorklet(
        config,
        {
          jobId: 'populate-nitro-boundary-job',
          cfg: {
            baseUrl: 'https://bws.example/bws/api',
            timeoutMs: 30000,
          },
          wallets: [
            {
              walletId: 'btc-wallet',
              credentials: {
                walletId: 'btc-wallet',
                chain: 'btc',
                network: 'livenet',
                coin: 'btc',
                copayerId: 'copayer-1',
              },
              summary: {
                walletId: 'btc-wallet',
                walletName: 'BTC Wallet',
                chain: 'btc',
                network: 'livenet',
                currencyAbbreviation: 'btc',
                balanceAtomic: '100000000',
                balanceFormatted: '1',
              },
            },
          ],
          ingest: {
            quoteCurrency: 'USD',
            compressionEnabled: true,
            chunkRows: 128,
            snapshotDebugMode: 'none',
          },
          pageSize: 1000,
        } as any,
        {
          'btc-wallet': context as any,
        },
      );
      const status = await waitForTerminalStatus(config, started.jobId);

      expect(status?.state).toBe('completed');
      expect(status?.txRequestsMade).toBe(1);
      expect(status?.walletStatusById).toEqual({'btc-wallet': 'done'});
      expect(requestSync).toHaveBeenCalled();
      expect(
        requestLog.some(request =>
          String(request.url).includes('/v4/fiatrates/USD?days=1'),
        ),
      ).toBe(true);
      expect(
        requestLog.filter(request =>
          String(request.url).includes('/v1/txhistory/'),
        ),
      ).toHaveLength(1);
      expect(
        requestLog.some(request =>
          request.headers?.some(header => header.key === 'x-signature'),
        ),
      ).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(bitcoreSigningSpy).not.toHaveBeenCalled();
      expect(jsTxHistoryFetcherSpy).not.toHaveBeenCalled();
      expect(
        getPortfolioTxHistorySigningDispatchContextOnRuntime(),
      ).toBeUndefined();
    } finally {
      if (typeof originalFetch === 'undefined') {
        delete mutableGlobal.fetch;
      } else {
        mutableGlobal.fetch = originalFetch;
      }
    }
  });
});
