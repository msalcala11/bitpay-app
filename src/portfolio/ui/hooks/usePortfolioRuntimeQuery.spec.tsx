import React from 'react';
import {act, render, waitFor} from '../../../../test/render';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  buildCommittedPortfolioRevisionToken,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCommittedPortfolioQuoteCurrency,
} from '../common';

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../common', () => ({
  buildCommittedPortfolioRevisionToken: jest.fn(() => 'committed-revision'),
  getStoredWalletRequestSignature: jest.fn(() => 'wallet-sig'),
  mapWalletsToStoredWallets: jest.fn(() => ({
    eligibleWallets: [],
    storedWallets: [],
  })),
  resolveCommittedPortfolioQuoteCurrency: jest.fn(() => 'USD'),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;
const mockBuildCommittedPortfolioRevisionToken =
  buildCommittedPortfolioRevisionToken as jest.Mock;
const mockGetStoredWalletRequestSignature =
  getStoredWalletRequestSignature as jest.Mock;
const mockMapWalletsToStoredWallets = mapWalletsToStoredWallets as jest.Mock;
const mockResolveCommittedPortfolioQuoteCurrency =
  resolveCommittedPortfolioQuoteCurrency as jest.Mock;

const mockWallet = {id: 'wallet-1'} as any;
const mockStoredWallet = {
  walletId: 'wallet-1',
  addedAt: 0,
  credentials: {},
  summary: {
    walletId: 'wallet-1',
    walletName: 'Bitcoin',
    chain: 'btc',
    network: 'livenet',
    currencyAbbreviation: 'btc',
    balanceAtomic: '100000000',
    balanceFormatted: '1',
  },
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

let latestResult: ReturnType<typeof usePortfolioRuntimeQuery<any>> | undefined;
const executeSpy = jest.fn();

const HookHarness = ({
  timeframe = '1D',
  refreshToken = 'refresh-1',
  clearDataOnRefreshToken = true,
}: {
  timeframe?: any;
  refreshToken?: string;
  clearDataOnRefreshToken?: boolean;
}) => {
  latestResult = usePortfolioRuntimeQuery<any>({
    wallets: [mockWallet],
    timeframe,
    refreshToken,
    clearDataOnRefreshToken,
    execute: executeSpy,
  });
  return null;
};

describe('usePortfolioRuntimeQuery', () => {
  let mockState: any;

  beforeEach(() => {
    latestResult = undefined;
    executeSpy.mockReset();
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockState = {
      APP: {
        defaultAltCurrency: {isoCode: 'USD'},
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
        lastPopulatedAt: 10,
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockBuildCommittedPortfolioRevisionToken.mockReset();
    mockBuildCommittedPortfolioRevisionToken.mockReturnValue(
      'committed-revision',
    );
    mockResolveCommittedPortfolioQuoteCurrency.mockReset();
    mockResolveCommittedPortfolioQuoteCurrency.mockReturnValue('USD');
    mockGetStoredWalletRequestSignature.mockReset();
    mockGetStoredWalletRequestSignature.mockReturnValue('wallet-sig');
    mockMapWalletsToStoredWallets.mockReset();
    mockMapWalletsToStoredWallets.mockReturnValue({
      eligibleWallets: [mockWallet],
      storedWallets: [mockStoredWallet],
    });
  });

  it('does not expose stale data when the timeframe changes', async () => {
    const oneDay = createDeferred<any>();
    const allTime = createDeferred<any>();

    executeSpy.mockImplementation(({timeframe}) => {
      return timeframe === 'ALL' ? allTime.promise : oneDay.promise;
    });

    const view = render(<HookHarness timeframe="1D" />);

    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.data).toBeUndefined();

    await act(async () => {
      oneDay.resolve({label: 'one-day'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'one-day'});
      expect(latestResult?.requestKey).toBe('USD|1D||wallet-sig');
    });

    view.rerender(<HookHarness timeframe="ALL" />);

    expect(latestResult?.requestKey).toBe('USD|ALL||wallet-sig');
    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.data).toBeUndefined();

    await act(async () => {
      allTime.resolve({label: 'all-time'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'all-time'});
    });
  });

  it('clears visible data for a new refresh token before the replacement result returns', async () => {
    const refreshOne = createDeferred<any>();
    const refreshTwo = createDeferred<any>();

    executeSpy
      .mockImplementationOnce(() => refreshOne.promise)
      .mockImplementationOnce(() => refreshTwo.promise);

    const view = render(
      <HookHarness timeframe="1D" refreshToken="refresh-1" />,
    );

    await act(async () => {
      refreshOne.resolve({label: 'refresh-one'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'refresh-one'});
    });

    view.rerender(<HookHarness timeframe="1D" refreshToken="refresh-2" />);

    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.data).toBeUndefined();

    await act(async () => {
      refreshTwo.resolve({label: 'refresh-two'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'refresh-two'});
    });
  });

  it('keeps visible data during a refresh-token reload when clearDataOnRefreshToken is false', async () => {
    const refreshOne = createDeferred<any>();
    const refreshTwo = createDeferred<any>();

    executeSpy
      .mockImplementationOnce(() => refreshOne.promise)
      .mockImplementationOnce(() => refreshTwo.promise);

    const view = render(
      <HookHarness
        timeframe="1D"
        refreshToken="refresh-1"
        clearDataOnRefreshToken={false}
      />,
    );

    await act(async () => {
      refreshOne.resolve({label: 'refresh-one'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'refresh-one'});
    });

    view.rerender(
      <HookHarness
        timeframe="1D"
        refreshToken="refresh-2"
        clearDataOnRefreshToken={false}
      />,
    );

    expect(latestResult?.loading).toBe(true);
    expect(latestResult?.data).toEqual({label: 'refresh-one'});

    await act(async () => {
      refreshTwo.resolve({label: 'refresh-two'});
    });

    await waitFor(() => {
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.data).toEqual({label: 'refresh-two'});
    });
  });
});
