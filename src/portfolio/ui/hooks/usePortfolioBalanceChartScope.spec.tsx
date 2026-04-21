import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {usePortfolioBalanceChartScope} from './usePortfolioBalanceChartScope';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../../../utils/portfolio/chartCache', () => ({
  buildBalanceChartScopeId: jest.fn(
    ({
      walletIds,
      quoteCurrency,
      balanceOffset,
    }: {
      walletIds: string[];
      quoteCurrency: string;
      balanceOffset?: number;
    }) =>
      [
        quoteCurrency,
        typeof balanceOffset === 'number' ? String(balanceOffset) : '0',
        walletIds.join(','),
      ].join('|'),
  ),
  getSortedUniqueWalletIds: jest.fn((walletIds: string[]) =>
    Array.from(new Set(walletIds.filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    ),
  ),
}));

jest.mock('../../../utils/portfolio/balanceChartData', () => ({
  buildCurrentSpotRatesByRateKey: jest.fn(() => ({
    'btc:btc': 100,
  })),
  getCurrentSpotRatesByRateKeySignature: jest.fn(
    (rates: Record<string, number>) =>
      Object.keys(rates)
        .sort()
        .map(rateKey => `${rateKey}:${String(rates[rateKey])}`)
        .join('|'),
  ),
}));

jest.mock('../common', () => ({
  buildCommittedPortfolioRevisionToken: jest.fn(
    ({lastPopulatedAt}: {lastPopulatedAt?: number}) =>
      typeof lastPopulatedAt === 'number' ? String(lastPopulatedAt) : 'uncommitted',
  ),
  buildCurrentRatesByAssetId: jest.fn(() => ({
    'btc:btc': 100,
  })),
  getCurrentRatesByAssetIdSignature: jest.fn(
    (rates: Record<string, number>) =>
      Object.keys(rates)
        .sort()
        .map(rateKey => `${rateKey}:${String(rates[rateKey])}`)
        .join('|'),
  ),
  getStoredWalletRequestSignature: jest.fn(
    (
      storedWallets: Array<{
        summary?: {
          walletId?: string;
          chain?: string;
          currencyAbbreviation?: string;
          tokenAddress?: string;
        };
      }>,
    ) =>
      storedWallets
        .map(wallet => {
          const summary = wallet.summary || {};
          return [
            String(summary.walletId || ''),
            String(summary.chain || ''),
            String(summary.currencyAbbreviation || ''),
            String(summary.tokenAddress || ''),
          ].join(':');
        })
        .sort()
        .join('|'),
  ),
  mapWalletsToStoredWallets: jest.fn(
    ({wallets}: {wallets: Array<{id: string; chain: string; currencyAbbreviation: string}>}) => ({
      eligibleWallets: wallets,
      storedWallets: wallets.map(wallet => ({
        summary: {
          walletId: wallet.id,
          walletName: wallet.id,
          chain: wallet.chain,
          currencyAbbreviation: wallet.currencyAbbreviation,
          tokenAddress: undefined,
        },
      })),
    }),
  ),
  resolveActivePortfolioDisplayQuoteCurrency: jest.fn(
    ({
      quoteCurrency,
      defaultAltCurrencyIsoCode,
    }: {
      quoteCurrency?: string;
      defaultAltCurrencyIsoCode?: string;
    }) => quoteCurrency || defaultAltCurrencyIsoCode || 'USD',
  ),
  resolveCurrentRatesAsOfMs: jest.fn(
    ({ratesUpdatedAt}: {ratesUpdatedAt?: number}) => ratesUpdatedAt,
  ),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;

let mockState: any;
let latestResult:
  | ReturnType<typeof usePortfolioBalanceChartScope>
  | undefined;

const walletFactory = () =>
  ({
    id: 'wallet-1',
    chain: 'btc',
    currencyAbbreviation: 'btc',
  }) as any;

const HookHarness = ({wallets}: {wallets: any[]}) => {
  latestResult = usePortfolioBalanceChartScope({
    wallets,
  });
  return null;
};

describe('usePortfolioBalanceChartScope', () => {
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
        lastPopulatedAt: 111,
      },
      PORTFOLIO_CHARTS: {
        cacheByScopeId: {},
      },
      RATE: {
        rates: {
          btc: [{code: 'USD', rate: 100}],
        },
        ratesUpdatedAt: 1234,
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
  });

  it('keeps the historical chart revision stable when only the shared rate asOfMs changes', async () => {
    let view: TestRenderer.ReactTestRenderer;

    await act(async () => {
      view = TestRenderer.create(<HookHarness wallets={[walletFactory()]} />);
    });

    expect(latestResult?.chartDataRevisionSig).toBe('111');
    expect(latestResult?.asOfMs).toBe(1234);

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

    expect(latestResult?.chartDataRevisionSig).toBe('111');
    expect(latestResult?.asOfMs).toBe(5678);
  });
});
