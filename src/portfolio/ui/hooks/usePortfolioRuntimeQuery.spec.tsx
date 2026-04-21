import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {
  type PortfolioRuntimeQueryState,
  usePortfolioRuntimeQuery,
} from './usePortfolioRuntimeQuery';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../common', () => ({
  buildCurrentRatesByAssetId: jest.fn(() => ({
    'btc:btc': 100,
  })),
  buildCommittedPortfolioRevisionToken: jest.fn(() => 'revision-1'),
  getCurrentRatesByAssetIdSignature: jest.fn(() => 'btc:btc:100'),
  getStoredWalletRequestSignature: jest.fn(
    (storedWallets: Array<{summary?: {walletId?: string}}>) =>
      storedWallets
        .map(wallet => String(wallet.summary?.walletId || ''))
        .sort()
        .join('|'),
  ),
  mapWalletsToStoredWallets: jest.fn(
    ({wallets}: {wallets: Array<{id: string; chain: string; currencyAbbreviation: string}>}) => ({
      eligibleWallets: wallets,
      storedWallets: wallets.map(wallet => ({
        walletId: wallet.id,
        addedAt: 0,
        summary: {
          walletId: wallet.id,
          walletName: wallet.id,
          chain: wallet.chain,
          network: 'livenet',
          currencyAbbreviation: wallet.currencyAbbreviation,
          balanceAtomic: '0',
          balanceFormatted: '0',
        },
        credentials: {},
      })),
    }),
  ),
  resolveCurrentRatesAsOfMs: jest.fn(
    ({ratesUpdatedAt}: {ratesUpdatedAt?: number}) => ratesUpdatedAt ?? 0,
  ),
  resolveActivePortfolioDisplayQuoteCurrency: jest.fn(() => 'USD'),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;

const execute = jest.fn(() => new Promise<never>(() => undefined));
let consoleErrorSpy: jest.SpyInstance;
let mockState: any;
let latestResult: PortfolioRuntimeQueryState<any> | undefined;

const walletFactory = () =>
  ({
    id: 'wallet-1',
    chain: 'btc',
    currencyAbbreviation: 'btc',
  }) as any;

const HookHarness = ({wallets}: {wallets: any[]}) => {
  latestResult = usePortfolioRuntimeQuery({
    wallets,
    timeframe: '1D',
    execute,
  });
  return null;
};

describe('usePortfolioRuntimeQuery', () => {
  beforeEach(() => {
    execute.mockClear();
    latestResult = undefined;
    (
      jest.requireMock('../common') as {
        resolveActivePortfolioDisplayQuoteCurrency: jest.Mock;
      }
    ).resolveActivePortfolioDisplayQuoteCurrency.mockReturnValue('USD');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockState = {
      APP: {
        defaultAltCurrency: {isoCode: 'USD'},
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
        lastPopulatedAt: 1,
      },
      RATE: {
        rates: {
          btc: [{code: 'USD', rate: 100}],
        },
        ratesUpdatedAt: 1234,
      },
    };
    mockUseAppSelector.mockImplementation(selector =>
      selector(mockState),
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('does not re-run the runtime query for semantically identical rerenders', async () => {
    const firstWallet = walletFactory();
    let view: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(<HookHarness wallets={[firstWallet]} />);
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        asOfMs: 1234,
      }),
    );

    const rerenderedWallet = walletFactory();
    await act(async () => {
      view!.update(<HookHarness wallets={[rerenderedWallet]} />);
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('re-runs the runtime query when the shared rates snapshot timestamp changes', async () => {
    let view: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        asOfMs: 1234,
      }),
    );

    mockState = {
      ...mockState,
      RATE: {
        ...mockState.RATE,
        ratesUpdatedAt: 5678,
      },
    };

    await act(async () => {
      view!.update(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        asOfMs: 5678,
      }),
    );
  });

  it('resolves the active display quote from APP.defaultAltCurrency instead of stale PORTFOLIO.quoteCurrency', async () => {
    const common = jest.requireMock('../common') as {
      resolveActivePortfolioDisplayQuoteCurrency: jest.Mock;
    };
    common.resolveActivePortfolioDisplayQuoteCurrency.mockReturnValue('EUR');
    mockState = {
      ...mockState,
      APP: {
        defaultAltCurrency: {isoCode: 'EUR'},
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
        lastPopulatedAt: 1,
      },
    };

    await act(async () => {
      TestRenderer.create(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quoteCurrency: 'EUR',
      }),
    );
  });

  it('clears query data immediately when the active display quote changes', async () => {
    const common = jest.requireMock('../common') as {
      resolveActivePortfolioDisplayQuoteCurrency: jest.Mock;
    };
    execute.mockImplementation(
      ({quoteCurrency}: {quoteCurrency: string}) =>
        quoteCurrency === 'USD'
          ? Promise.resolve({quoteCurrency})
          : new Promise<never>(() => undefined),
    );

    let view: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(latestResult?.data).toEqual({quoteCurrency: 'USD'});
    expect(latestResult?.quoteCurrency).toBe('USD');

    common.resolveActivePortfolioDisplayQuoteCurrency.mockReturnValue('EUR');
    mockState = {
      ...mockState,
      APP: {
        defaultAltCurrency: {isoCode: 'EUR'},
      },
    };

    await act(async () => {
      view!.update(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(latestResult?.quoteCurrency).toBe('EUR');
    expect(latestResult?.data).toBeUndefined();
    expect(latestResult?.loading).toBe(true);
  });
});
