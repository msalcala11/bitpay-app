import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import {ThemeProvider} from 'styled-components/native';
import PortfolioBalance from './PortfolioBalance';

const mockDispatch = jest.fn();
const mockState = {
  APP: {
    defaultAltCurrency: {isoCode: 'USD'},
    hideAllBalances: false,
    homeCarouselConfig: [],
  },
  COINBASE: {
    balance: {
      production: 0,
    },
  },
  PORTFOLIO: {
    snapshotsByWalletId: {
      'wallet-1': [
        {
          id: 'snapshot-1',
          walletId: 'wallet-1',
          timestamp: 1_000,
        },
      ],
    },
    quoteCurrency: 'USD',
  },
  PORTFOLIO_CHARTS: {
    homeChartCollapsed: false,
    homeChartRemountNonce: 0,
  },
  RATE: {
    rates: {},
    fiatRateSeriesCache: {},
  },
  WALLET: {
    keys: {
      'key-1': {
        id: 'key-1',
        totalBalance: 123.45,
        wallets: [
          {
            id: 'wallet-1',
            balance: {sat: 1, crypto: '1'},
          },
        ],
      },
    },
  },
};

jest.mock('react-redux', () => ({
  useSelector: (selector: (state: typeof mockState) => unknown) =>
    selector(mockState),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: typeof mockState) => unknown) =>
    selector(mockState),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('react-native-reanimated', () => {
  const ReactNative = require('react-native');

  return {
    __esModule: true,
    default: {
      View: ReactNative.View,
    },
    Easing: {
      linear: jest.fn(),
      cubic: jest.fn(),
      inOut: jest.fn(() => jest.fn()),
    },
    cancelAnimation: jest.fn(),
    interpolate: (value: number, input: number[], output: number[]) => {
      if (value <= input[0]) {
        return output[0];
      }
      return output[output.length - 1];
    },
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedStyle: (factory: () => object) => factory(),
    useDerivedValue: (factory: () => number) => ({value: factory()}),
    useSharedValue: (value: number) => ({value}),
    withTiming: (
      toValue: number,
      _config?: unknown,
      callback?: (finished?: boolean) => void,
    ) => {
      callback?.(true);
      return toValue;
    },
  };
});

jest.mock('@components/base/TouchableOpacity', () => {
  const ReactNative = require('react-native');

  return {
    TouchableOpacity: ({
      children,
      onPress,
      onLongPress,
      ...rest
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
    }) => (
      <ReactNative.TouchableOpacity
        onPress={onPress}
        onLongPress={onLongPress}
        {...rest}>
        {children}
      </ReactNative.TouchableOpacity>
    ),
  };
});

jest.mock('./CollapseContentButton', () => {
  const ReactNative = require('react-native');

  return ({
    onPress,
    onPressIn,
    onPressOut,
    accessibilityLabel,
    accessibilityState,
  }: {
    onPress?: () => void;
    onPressIn?: () => void;
    onPressOut?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: Record<string, unknown>;
  }) => (
    <ReactNative.TouchableOpacity
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
    />
  );
});
jest.mock('./InfoSvg', () => () => null);
jest.mock('../../../../components/styled/Text', () => {
  const ReactNative = require('react-native');

  return {
    BaseText: ReactNative.Text,
    H2: ReactNative.Text,
  };
});
jest.mock('../../../../components/styled/Containers', () => ({
  ActiveOpacity: 0.8,
  ScreenGutter: '16px',
}));
jest.mock('../../../../utils/helper-methods', () => ({
  formatFiatAmount: (amount: number, currency: string) =>
    `${currency} ${amount}`,
}));
jest.mock('../../../../utils/hideBalances', () => ({
  maskIfHidden: (_hide: boolean, value: number) => String(value),
}));

jest.mock('../../../../utils/portfolio/assets', () => ({
  getQuoteCurrency: () => 'USD',
  getVisibleKeysFromKeys: (keys: typeof mockState.WALLET.keys) =>
    Object.values(keys),
  getVisibleWalletsFromKeys: (keys: typeof mockState.WALLET.keys) =>
    Object.values(keys).flatMap(key => key.wallets),
  walletHasNonZeroLiveBalance: () => true,
}));

jest.mock('../../../../store/app/app.actions', () => ({
  showBottomNotificationModal: (payload: unknown) => ({
    type: 'SHOW_BOTTOM_NOTIFICATION_MODAL',
    payload,
  }),
  toggleHideAllBalances: () => ({
    type: 'TOGGLE_HIDE_ALL_BALANCES',
  }),
}));

jest.mock('../../../../store/portfolio-charts', () => ({
  setHomeChartCollapsed: (payload: unknown) => ({
    type: 'SET_HOME_CHART_COLLAPSED',
    payload,
  }),
}));

jest.mock('../../../../components/charts/ChartChangeRow', () => {
  const ReactNative = require('react-native');

  return ({
    percent,
    deltaFiatFormatted,
    rangeLabel,
  }: {
    percent?: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
  }) => (
    <ReactNative.Text testID="chart-change-row">{`${percent}|${
      deltaFiatFormatted || ''
    }|${rangeLabel || ''}`}</ReactNative.Text>
  );
});

jest.mock('../../../../components/charts/BalanceHistoryChart', () => {
  const ReactMock = require('react');
  const ReactNative = require('react-native');

  return ({
    onChangeRowData,
  }: {
    onChangeRowData?: (data: {
      percent: number;
      deltaFiatFormatted?: string;
      rangeLabel?: string;
    }) => void;
  }) => {
    ReactMock.useEffect(() => {
      onChangeRowData?.({
        percent: 12.3,
        deltaFiatFormatted: '$45.67',
        rangeLabel: 'All time',
      });
    }, [onChangeRowData]);

    return <ReactNative.View testID="balance-history-chart" />;
  };
});

const theme = {
  dark: false,
  colors: {
    background: '#fff',
    text: '#000',
  },
};

const renderPortfolioBalance = () =>
  render(
    <ThemeProvider theme={theme}>
      <PortfolioBalance />
    </ThemeProvider>,
  );

describe('PortfolioBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.APP.hideAllBalances = false;
    mockState.PORTFOLIO_CHARTS.homeChartCollapsed = false;
    mockState.WALLET.keys['key-1'].totalBalance = 123.45;
  });

  it('keeps the initial chart change-row callback result on first mount', async () => {
    const screen = renderPortfolioBalance();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('chart-change-row')).toHaveTextContent(
      '12.3|$45.67|All time',
    );
  });

  it('exposes collapse control accessibility state and pressed feedback', () => {
    const screen = renderPortfolioBalance();

    const collapseButton = screen.getByLabelText('Collapse portfolio chart');

    expect(collapseButton.props.accessibilityState).toMatchObject({
      expanded: true,
      selected: false,
    });

    fireEvent(collapseButton, 'pressIn');
    expect(
      screen.getByLabelText('Collapse portfolio chart').props
        .accessibilityState,
    ).toMatchObject({
      expanded: true,
      selected: true,
    });

    fireEvent(collapseButton, 'pressOut');
    expect(
      screen.getByLabelText('Collapse portfolio chart').props
        .accessibilityState,
    ).toMatchObject({
      expanded: true,
      selected: false,
    });
  });

  it('expands the collapsed chart on press instead of pressIn', () => {
    mockState.PORTFOLIO_CHARTS.homeChartCollapsed = true;
    const screen = renderPortfolioBalance();
    const expandOverlay = screen.getByLabelText('Expand portfolio chart');

    expect(expandOverlay.props.accessibilityState).toMatchObject({
      expanded: false,
    });

    fireEvent(expandOverlay, 'pressIn');
    expect(mockDispatch).not.toHaveBeenCalled();

    fireEvent.press(expandOverlay);
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'SET_HOME_CHART_COLLAPSED',
      payload: false,
    });
  });

  it('uses a smaller balance font for long fiat values', () => {
    mockState.WALLET.keys['key-1'].totalBalance = 1234567890123;

    const screen = renderPortfolioBalance();

    expect(screen.getByText('USD 1234567890123')).toHaveStyle({
      fontSize: 32,
      lineHeight: 48,
    });
  });
});
