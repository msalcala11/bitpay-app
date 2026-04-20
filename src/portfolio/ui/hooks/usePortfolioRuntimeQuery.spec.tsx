import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';
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
  resolveCommittedPortfolioQuoteCurrency: jest.fn(() => 'USD'),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;

const execute = jest.fn(() => new Promise<never>(() => undefined));
let consoleErrorSpy: jest.SpyInstance;

const walletFactory = () =>
  ({
    id: 'wallet-1',
    chain: 'btc',
    currencyAbbreviation: 'btc',
  }) as any;

const HookHarness = ({wallets}: {wallets: any[]}) => {
  usePortfolioRuntimeQuery({
    wallets,
    timeframe: '1D',
    execute,
  });
  return null;
};

describe('usePortfolioRuntimeQuery', () => {
  beforeEach(() => {
    execute.mockClear();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockUseAppSelector.mockImplementation(selector =>
      selector({
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
        },
      }),
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

    const rerenderedWallet = walletFactory();
    await act(async () => {
      view!.update(<HookHarness wallets={[rerenderedWallet]} />);
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
