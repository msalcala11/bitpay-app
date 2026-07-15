const mockRuntime = {name: 'shared-portfolio-runtime'};
const mockCreateWorkletRuntime = jest.fn((_config?: unknown) => mockRuntime);
const mockCreateWorkletPortfolioTransport = jest.fn((config: unknown) => ({
  config,
  dispatch: jest.fn(),
  destroy: jest.fn(),
}));
const mockTerminate = jest.fn();
const mockClientConstructor = jest.fn();

jest.mock('react-native-worklets', () => ({
  createWorkletRuntime: (config: unknown) => mockCreateWorkletRuntime(config),
}));

jest.mock('../adapters/rn/workletMmkvBridge', () => ({
  getPortfolioMmkvNativeStorageOnRN: jest.fn(() => ({kind: 'mmkv'})),
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY: 'registry-key',
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID: 'storage-id',
}));

jest.mock('../adapters/rn/workletRuntimeShared', () => ({
  initializePortfolioRuntimeGlobals: jest.fn(),
  PORTFOLIO_WORKLET_RUNTIME_NAME: 'portfolio-runtime',
}));

jest.mock('./portfolioClient', () => ({
  PortfolioRuntimeClient: class MockPortfolioRuntimeClient {
    terminate = mockTerminate;

    constructor(transport: unknown) {
      mockClientConstructor(transport);
    }
  },
}));

jest.mock('./portfolioWorkletTransport', () => ({
  createWorkletPortfolioTransport: (config: unknown) =>
    mockCreateWorkletPortfolioTransport(config),
}));

type PortfolioRuntimeModule = typeof import('./portfolioRuntime');

const loadPortfolioRuntime = (): PortfolioRuntimeModule =>
  require('./portfolioRuntime') as PortfolioRuntimeModule;

describe('portfolioRuntime shared Worklet Runtime', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns the same runtime object from all production runtime getters', () => {
    const {
      getPortfolioAnalysisWorkletRuntime,
      getPortfolioRateWorkletRuntime,
      getPortfolioWorkletRuntime,
    } = loadPortfolioRuntime();

    const base = getPortfolioWorkletRuntime();
    const rates = getPortfolioRateWorkletRuntime();
    const analysis = getPortfolioAnalysisWorkletRuntime();

    expect(base).toBe(mockRuntime);
    expect(rates).toBe(base);
    expect(analysis).toBe(base);
    expect(mockCreateWorkletRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkletRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'portfolio-runtime',
        enableEventLoop: true,
        initializer: expect.any(Function),
      }),
    );
  });

  it('creates all three clients on one runtime and never creates another runtime', () => {
    const {
      getPortfolioAnalysisRuntimeClient,
      getPortfolioRateRuntimeClient,
      getPortfolioRuntimeClient,
    } = loadPortfolioRuntime();

    const baseClient = getPortfolioRuntimeClient();
    const ratesClient = getPortfolioRateRuntimeClient();
    const analysisClient = getPortfolioAnalysisRuntimeClient();

    expect(baseClient).not.toBe(ratesClient);
    expect(ratesClient).not.toBe(analysisClient);
    expect(mockCreateWorkletRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkletPortfolioTransport).toHaveBeenCalledTimes(3);

    for (const [transportConfig] of mockCreateWorkletPortfolioTransport.mock
      .calls) {
      expect(transportConfig).toEqual(
        expect.objectContaining({runtime: mockRuntime}),
      );
    }

    expect(getPortfolioRuntimeClient()).toBe(baseClient);
    expect(getPortfolioRateRuntimeClient()).toBe(ratesClient);
    expect(getPortfolioAnalysisRuntimeClient()).toBe(analysisClient);
    expect(mockCreateWorkletRuntime).toHaveBeenCalledTimes(1);
  });

  it('terminates each client without replacing the shared runtime', () => {
    const {
      getPortfolioAnalysisRuntimeClient,
      getPortfolioRateRuntimeClient,
      getPortfolioRuntimeClient,
      resetPortfolioRuntimeClient,
    } = loadPortfolioRuntime();

    getPortfolioRuntimeClient();
    getPortfolioRateRuntimeClient();
    getPortfolioAnalysisRuntimeClient();

    resetPortfolioRuntimeClient();

    expect(mockTerminate).toHaveBeenCalledTimes(3);
    getPortfolioRuntimeClient();
    getPortfolioRateRuntimeClient();
    getPortfolioAnalysisRuntimeClient();
    expect(mockCreateWorkletRuntime).toHaveBeenCalledTimes(1);
  });
});
