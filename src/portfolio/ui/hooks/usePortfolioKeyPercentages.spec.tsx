import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {usePortfolioKeyPercentages} from './usePortfolioKeyPercentages';
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
  buildCommittedPortfolioRevisionToken: jest.fn(
    ({lastPopulatedAt}: {lastPopulatedAt?: number}) =>
      typeof lastPopulatedAt === 'number' ? String(lastPopulatedAt) : 'uncommitted',
  ),
  getCurrentRatesByAssetIdSignature: jest.fn(() => 'btc:btc:100'),
  getLastFiniteNumber: jest.fn((values: Array<number | null | undefined>) =>
    Array.isArray(values) ? values.find(value => typeof value === 'number') : undefined,
  ),
  getStoredWalletRequestSignature: jest.fn(() => 'wallet-1'),
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
  resolveActivePortfolioDisplayQuoteCurrency: jest.fn(
    ({defaultAltCurrencyIsoCode}: {defaultAltCurrencyIsoCode?: string}) =>
      defaultAltCurrencyIsoCode || 'USD',
  ),
  resolveCurrentRatesAsOfMs: jest.fn(
    ({ratesUpdatedAt}: {ratesUpdatedAt?: number}) => ratesUpdatedAt ?? 0,
  ),
  runPortfolioChartQuery: jest.fn(() => new Promise<never>(() => undefined)),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;

let latestResult: Record<string, number | null> | undefined;
let mockState: any;

const keyFactory = () =>
  ({
    id: 'key-1',
    totalBalance: 123,
    wallets: [
      {
        id: 'wallet-1',
        chain: 'btc',
        currencyAbbreviation: 'btc',
        hideWallet: false,
        hideWalletByAccount: false,
      },
    ],
  }) as any;

const HookHarness = ({keys}: {keys: any[]}) => {
  latestResult = usePortfolioKeyPercentages({keys});
  return null;
};

describe('usePortfolioKeyPercentages', () => {
  beforeEach(() => {
    latestResult = undefined;
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockState = {
      APP: {
        defaultAltCurrency: {isoCode: 'USD'},
      },
      PORTFOLIO: {
        lastPopulatedAt: 1,
      },
      RATE: {
        rates: {},
        ratesUpdatedAt: 1234,
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
  });

  it('keeps the empty loading map reference stable across a fiat switch while percentages are still loading', async () => {
    let view: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(<HookHarness keys={[keyFactory()]} />);
    });

    const firstResult = latestResult;
    expect(firstResult).toEqual({});

    mockState = {
      ...mockState,
      APP: {
        defaultAltCurrency: {isoCode: 'EUR'},
      },
    };

    await act(async () => {
      view!.update(<HookHarness keys={[keyFactory()]} />);
    });

    expect(latestResult).toBe(firstResult);
  });
});
