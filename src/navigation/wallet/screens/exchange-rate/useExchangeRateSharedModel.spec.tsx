import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import useExchangeRateSharedModel from './useExchangeRateSharedModel';
import {priceAlertsContextKey} from '../../../../store/watchlist/watchlist.effects';
import {getCoinCatalog} from '../../../../store/watchlist/coin-registry';
import {resolveExchangeRateLink} from '../../../watchlist/exchangeRateLink';
import {tokenManager} from '../../../../managers/TokenManager';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let latestSharedModel:
  | ReturnType<typeof useExchangeRateSharedModel>
  | undefined;
let mockRouteParams: any;
let mockState: any;
const mockDispatch = jest.fn();
const mockSetOptions = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    setOptions: mockSetOptions,
  }),
  useRoute: () => ({
    params: mockRouteParams,
  }),
}));

jest.mock('../../../../contexts', () => ({
  useTheme: () => ({
    dark: false,
  }),
}));

jest.mock('../../../../components/back/HeaderBackButton', () => () => null);
jest.mock('../../../../components/styled/Text', () => ({
  HeaderTitle: 'HeaderTitle',
}));

jest.mock('../../../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    btc: {
      name: 'Bitcoin',
      img: 'btc-image',
      theme: {},
    },
    eth: {
      name: 'Ethereum',
      img: 'eth-image',
      theme: {},
    },
  },
}));

jest.mock('../../../../store/market-stats', () => ({
  fetchMarketStats: jest.fn((args: unknown) => ({
    type: 'FETCH_MARKET_STATS',
    payload: args,
  })),
  getMarketStatsCacheKey: jest.fn(() => 'market-stats-key'),
}));

jest.mock('../../../../store/wallet/utils/wallet', () => ({
  buildUIFormattedWallet: jest.fn(() => ({
    fiatBalance: 0,
    fiatBalanceFormat: '$0.00',
  })),
}));

jest.mock('../../../../utils/helper-methods', () => ({
  formatCurrencyAbbreviation: jest.fn((value: string) =>
    String(value || '').toUpperCase(),
  ),
  formatFiat: jest.fn(() => '$0.00'),
  formatFiatAmount: jest.fn((value: number) => String(value)),
  getRateByCurrencyName: jest.fn(
    (
      rates: Record<string, Array<{code: string; rate: number}>>,
      currencyAbbreviation: string,
    ) => rates[currencyAbbreviation] || [],
  ),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: any) => any) => selector(mockState),
}));

jest.mock('../../../../utils/portfolio/assetTheme', () => ({
  getAssetTheme: jest.fn(() => undefined),
}));

jest.mock('../../../../portfolio/ui/common', () => ({
  resolveCurrentRatesAsOfMs: jest.fn(() => 1234),
}));

jest.mock(
  '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence',
  () =>
    jest.fn(() => ({
      checked: true,
      hasAllSnapshots: false,
      hasAnySnapshots: false,
      hasSnapshotsByWalletId: {},
      loading: false,
    })),
);

jest.mock('../../../../utils/portfolio/assets', () => ({
  findSupportedCurrencyOptionForAsset: jest.fn(() => undefined),
  getWalletLiveFiatBalance: jest.fn(() => 0),
  getWalletsMatchingExchangeRateAsset: jest.fn(() => []),
  getVisibleWalletsForKey: jest.fn(() => []),
  getVisibleWalletsFromKeys: jest.fn(() => []),
}));

jest.mock('../../../../utils/portfolio/core/pnl/rates', () => ({
  normalizeFiatRateSeriesCoin: jest.fn((value: string) =>
    String(value || '').toLowerCase(),
  ),
}));

jest.mock('../../../../store/wallet/utils/currency', () => ({
  IsSVMChain: jest.fn(() => false),
}));

jest.mock('../ExchangeRate.utils', () => ({
  formatCompactCurrency: jest.fn(() => '--'),
  formatSupply: jest.fn(() => '--'),
  POLYGON_ABOUT_FALLBACK: '',
}));

// Reassigning the module-level capture variable directly inside the
// component trips React Compiler's `globals` rule; route it through a helper.
const captureSharedModel = (model: typeof latestSharedModel) => {
  latestSharedModel = model;
};

const HookHarness = () => {
  captureSharedModel(useExchangeRateSharedModel());
  return null;
};

const mockPortfolioAssets = jest.requireMock(
  '../../../../utils/portfolio/assets',
);
const mockGetWalletsMatchingExchangeRateAsset =
  mockPortfolioAssets.getWalletsMatchingExchangeRateAsset as jest.Mock;
const mockGetVisibleWalletsForKey =
  mockPortfolioAssets.getVisibleWalletsForKey as jest.Mock;
const mockGetVisibleWalletsFromKeys =
  mockPortfolioAssets.getVisibleWalletsFromKeys as jest.Mock;
const mockUsePortfolioWalletSnapshotPresence = jest.requireMock(
  '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence',
) as jest.Mock;
const mockBuildUIFormattedWallet = jest.requireMock(
  '../../../../store/wallet/utils/wallet',
).buildUIFormattedWallet as jest.Mock;

describe('useExchangeRateSharedModel', () => {
  beforeEach(() => {
    latestSharedModel = undefined;
    mockDispatch.mockReset();
    mockSetOptions.mockReset();
    mockBuildUIFormattedWallet.mockReset();
    mockBuildUIFormattedWallet.mockImplementation((wallet: any) => ({
      id: wallet?.id,
      walletName: wallet?.walletName || wallet?.id,
      cryptoBalance: wallet?.balance?.crypto ?? '0.00',
      fiatBalance: 0,
      fiatBalanceFormat: '$0.00',
    }));
    mockGetWalletsMatchingExchangeRateAsset.mockReset();
    mockGetWalletsMatchingExchangeRateAsset.mockImplementation(
      ({wallets}: {wallets?: unknown[]}) => wallets || [],
    );
    mockGetVisibleWalletsForKey.mockReset();
    mockGetVisibleWalletsForKey.mockImplementation(
      (key: {wallets?: unknown[]} | undefined) => key?.wallets || [],
    );
    mockGetVisibleWalletsFromKeys.mockReset();
    mockGetVisibleWalletsFromKeys.mockReturnValue([]);
    mockUsePortfolioWalletSnapshotPresence.mockReset();
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      checked: true,
      hasAllSnapshots: false,
      hasAnySnapshots: false,
      hasSnapshotsByWalletId: {},
      loading: false,
    });
    mockRouteParams = {
      currencyAbbreviation: 'eth',
      chain: 'eth',
      currencyName: 'Ethereum',
    };
    mockState = {
      APP: {
        defaultAltCurrency: {isoCode: 'EUR'},
        identity: {},
        network: 'livenet',
        hideAllBalances: false,
        homeCarouselConfig: undefined,
        showPortfolioValue: true,
      },
      MARKET_STATS: {
        itemsByKey: {},
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
      },
      RATE: {
        rates: {
          eth: [
            {code: 'USD', rate: 2000},
            {code: 'EUR', rate: 999999},
          ],
          btc: [
            {code: 'USD', rate: 40000},
            {code: 'EUR', rate: 36000},
          ],
        },
        ratesUpdatedAt: 1234,
      },
      WALLET: {
        keys: {},
      },
      WATCHLIST: {items: [], contexts: {}},
    };
  });

  it('derives the live display-quote spot rate from canonical USD plus the BTC bridge', async () => {
    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(latestSharedModel?.resolvedQuoteCurrency).toBe('EUR');
    expect(latestSharedModel?.currentFiatRate).toBeCloseTo(1800, 8);
  });

  it('scopes asset wallets to the route key when opening asset details from key All Assets', async () => {
    const keyWallet = {
      id: 'wallet-in-key',
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };
    const otherKeyWallet = {
      id: 'wallet-outside-key',
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };

    mockRouteParams = {
      ...mockRouteParams,
      chartType: 'assetBalanceHistory',
      keyId: 'key-a',
    };
    mockState.WALLET.keys = {
      'key-a': {
        id: 'key-a',
        wallets: [keyWallet],
      },
      'key-b': {
        id: 'key-b',
        wallets: [otherKeyWallet],
      },
    };
    mockGetVisibleWalletsFromKeys.mockReturnValue([keyWallet, otherKeyWallet]);

    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(mockGetVisibleWalletsForKey).toHaveBeenCalledWith(
      mockState.WALLET.keys['key-a'],
    );
    expect(mockGetVisibleWalletsFromKeys).not.toHaveBeenCalled();
    expect(latestSharedModel?.assetWallets).toEqual([keyWallet]);
    expect(
      latestSharedModel?.walletsForAsset.map(({wallet}) => wallet),
    ).toEqual([keyWallet]);
  });

  it('includes zero-balance asset wallets with snapshots in asset balance details', async () => {
    const liveWallet = {
      id: 'wallet-live',
      balance: {crypto: '1.234567', sat: 1},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };
    const zeroHistoricalWallet = {
      id: 'wallet-zero-history',
      balance: {crypto: '0.00', sat: 0},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };
    const zeroEmptyWallet = {
      id: 'wallet-zero-empty',
      balance: {sat: 0},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };

    mockRouteParams = {
      ...mockRouteParams,
      chartType: 'assetBalanceHistory',
    };
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      liveWallet,
      zeroHistoricalWallet,
      zeroEmptyWallet,
    ]);
    mockGetWalletsMatchingExchangeRateAsset.mockImplementation(
      ({
        includeZeroBalance,
        wallets,
      }: {
        includeZeroBalance?: boolean;
        wallets?: Array<{balance?: {sat?: number}}>;
      }) => {
        return (wallets || []).filter(wallet => {
          return includeZeroBalance || Number(wallet.balance?.sat || 0) > 0;
        });
      },
    );
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      checked: true,
      hasAllSnapshots: false,
      hasAnySnapshots: true,
      hasSnapshotsByWalletId: {
        'wallet-zero-history': true,
        'wallet-zero-empty': false,
      },
      loading: false,
    });

    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(latestSharedModel?.assetWallets).toEqual([
      liveWallet,
      zeroHistoricalWallet,
      zeroEmptyWallet,
    ]);
    expect(mockUsePortfolioWalletSnapshotPresence).toHaveBeenCalledWith({
      wallets: [liveWallet, zeroHistoricalWallet, zeroEmptyWallet],
      enabled: true,
    });
    expect(
      latestSharedModel?.walletsForAsset.map(({wallet}) => wallet),
    ).toEqual([liveWallet, zeroHistoricalWallet]);
    expect(
      latestSharedModel?.walletsForAsset.map(({ui}) => ui.cryptoBalance),
    ).toEqual(['1.234567', '0.000000']);
  });

  it('includes zero-balance asset wallets with snapshots in exchange rate details', async () => {
    const liveWallet = {
      id: 'exchange-wallet-live',
      balance: {crypto: '2.345678', sat: 1},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };
    const zeroHistoricalWallet = {
      id: 'exchange-wallet-zero-history',
      balance: {crypto: '0.00', sat: 0},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };
    const zeroEmptyWallet = {
      id: 'exchange-wallet-zero-empty',
      balance: {sat: 0},
      currencyAbbreviation: 'eth',
      chain: 'eth',
    };

    mockGetVisibleWalletsFromKeys.mockReturnValue([
      liveWallet,
      zeroHistoricalWallet,
      zeroEmptyWallet,
    ]);
    mockGetWalletsMatchingExchangeRateAsset.mockImplementation(
      ({
        includeZeroBalance,
        wallets,
      }: {
        includeZeroBalance?: boolean;
        wallets?: Array<{balance?: {sat?: number}}>;
      }) => {
        return (wallets || []).filter(wallet => {
          return includeZeroBalance || Number(wallet.balance?.sat || 0) > 0;
        });
      },
    );
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      checked: true,
      hasAllSnapshots: false,
      hasAnySnapshots: true,
      hasSnapshotsByWalletId: {
        'exchange-wallet-zero-history': true,
        'exchange-wallet-zero-empty': false,
      },
      loading: false,
    });

    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(latestSharedModel?.assetWallets).toEqual([liveWallet]);
    expect(mockUsePortfolioWalletSnapshotPresence).toHaveBeenCalledWith({
      wallets: [liveWallet, zeroHistoricalWallet, zeroEmptyWallet],
      enabled: true,
    });
    expect(
      latestSharedModel?.walletsForAsset.map(({wallet}) => wallet),
    ).toEqual([liveWallet, zeroHistoricalWallet]);
    expect(
      latestSharedModel?.walletsForAsset.map(({ui}) => ui.cryptoBalance),
    ).toEqual(['2.345678', '0.000000']);
  });
  it('uses the grouped listed token’s own name, symbol and image without a wallet', async () => {
    tokenManager.setTokenOptions({
      tokenDataByAddress: {},
      tokenOptionsByAddress: {
        '0xabc_e': {
          name: 'Listed Token',
          symbol: 'LIST',
          address: '0xabc',
          decimals: 18,
          logoURI: 'https://example.test/list.png',
        },
      },
    });
    mockRouteParams = {
      currencyAbbreviation: 'list',
      chain: 'eth',
      tokenAddress: '0xabc',
    };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness />);
    });
    expect(latestSharedModel?.currencyName).toBe('Listed Token');
    expect(latestSharedModel?.currencyAbbreviation).toBe('LIST');
    expect(latestSharedModel?.currencyImageSource).toBe(
      'https://example.test/list.png',
    );
    expect(latestSharedModel?.currentFiatRate).toBeUndefined();
    await act(async () => {
      renderer!.unmount();
      tokenManager.clear();
    });
  });
  it('opens token B’s exact page and chart while its filled star and bell act on token A’s row', async () => {
    tokenManager.setTokenOptions({
      tokenDataByAddress: {},
      tokenOptionsByAddress: {
        '0xa_e': {
          name: 'Token A',
          symbol: 'SAME',
          address: '0xa',
          decimals: 18,
          logoURI: 'a.png',
        },
        '0xb_m': {
          name: 'Token B',
          symbol: 'SAME',
          address: '0xb',
          decimals: 18,
          logoURI: 'b.png',
        },
      },
    });
    const catalog = getCoinCatalog();
    const row = catalog.fromSelector({chain: 'eth', tokenAddress: '0xa'})!;
    mockState.WATCHLIST.items = [row];
    mockState.APP.identity.livenet = {pub: 'test-identity'};
    mockState.WATCHLIST.contexts[priceAlertsContextKey('test-identity')] = {
      alerts: {
        [row.id]: {
          alert: {
            chain: 'eth',
            tokenAddress: '0xa',
            thresholdPct: 10,
            code: 'USD',
          },
        },
      },
    };
    const resolved = resolveExchangeRateLink(
      {currencyAbbreviation: 'same', chain: 'matic', tokenAddress: '0xb'},
      catalog,
      true,
    );
    if (resolved.status !== 'resolved') throw new Error('link did not resolve');
    mockRouteParams = {...resolved.asset, currencyName: resolved.coin.name};
    let renderer: TestRenderer.ReactTestRenderer,
      header: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness />);
    });
    expect(latestSharedModel).toMatchObject({
      currencyName: 'Token B',
      currencyAbbreviation: 'SAME',
      currencyImageSource: 'b.png',
      historicalRateIdentity: {chain: 'matic', tokenAddress: '0xb'},
    });
    await act(async () => {
      header = TestRenderer.create(
        mockSetOptions.mock.calls.at(-1)![0].headerRight(),
      );
    });
    const buttons = [
      ...new Map(
        header!.root
          .findAll(
            node =>
              node.props.accessibilityRole === 'button' &&
              typeof node.props.onPress === 'function',
          )
          .map(node => [node.props.accessibilityLabel, node]),
      ).values(),
    ];
    expect(buttons[0].props.accessibilityState.selected).toBe(true);
    expect(buttons[1].props.accessibilityState.selected).toBe(true);
    mockDispatch.mockImplementation(action =>
      typeof action === 'function'
        ? action(mockDispatch, () => mockState)
        : action,
    );
    await act(async () => {
      buttons[1].props.onPress();
    });
    const opened = mockDispatch.mock.calls.find(
      ([action]) => action?.type === 'WATCHLIST/UPDATE',
    )![0];
    expect(opened.payload.alertSheet.coin).toEqual(row);
    await act(async () => {
      header!.unmount();
      renderer!.unmount();
      tokenManager.clear();
    });
  });
  it('keeps the built-in USDC.e page name and abbreviation instead of its USDC row label', async () => {
    mockRouteParams = {
      currencyName: 'USDC.e',
      currencyAbbreviation: 'usdc.e',
      chain: 'matic',
      tokenAddress: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness />);
    });
    expect(latestSharedModel?.currencyName).toBe('USDC.e');
    expect(latestSharedModel?.currencyAbbreviation).toBe('USDC.E');
    await act(async () => renderer!.unmount());
  });
});
