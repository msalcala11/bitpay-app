import React from 'react';
import {Text} from 'react-native';
import {fireEvent, render} from '@testing-library/react-native';
import {ThemeProvider} from 'styled-components/native';
import InteractiveLineChart from './InteractiveLineChart';

const mockLineGraph = jest.fn();

jest.mock('react-native-reanimated', () => {
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Component: any) => Component,
    },
    Easing: {
      cubic: 'cubic',
      out: (value: unknown) => value,
    },
    useAnimatedProps: (updater: () => Record<string, unknown>) => updater(),
    useAnimatedStyle: (updater: () => Record<string, unknown>) => updater(),
    useDerivedValue: (updater: () => unknown) => ({value: updater()}),
    useSharedValue: (value: unknown) => ({value}),
    withTiming: (value: unknown) => value,
  };
});

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));

jest.mock('react-native-svg', () => {
  const ReactNative = require('react-native');

  return {
    __esModule: true,
    default: ReactNative.View,
    Line: ReactNative.View,
  };
});

jest.mock('react-native-graph', () => ({
  LineGraph: (props: any) => {
    const ReactNative = require('react-native');
    mockLineGraph(props);
    const {BottomAxisLabel, TopAxisLabel, onLayout, style, testID} = props;

    return (
      <ReactNative.View testID={testID} style={style} onLayout={onLayout}>
        {TopAxisLabel ? <TopAxisLabel /> : null}
        {BottomAxisLabel ? <BottomAxisLabel /> : null}
      </ReactNative.View>
    );
  },
}));

jest.mock('../loader/Loader', () => () => null);

const points = [
  {date: new Date('2024-01-01T00:00:00.000Z'), value: 1},
  {date: new Date('2024-01-02T00:00:00.000Z'), value: 2},
];

const renderWithTheme = (component: React.ReactElement) =>
  render(<ThemeProvider theme={{dark: false}}>{component}</ThemeProvider>);

describe('InteractiveLineChart', () => {
  beforeEach(() => {
    mockLineGraph.mockClear();
  });

  it('derives the graph width from container layout updates', () => {
    const TopAxisLabel = jest.fn(({width}: {width?: number}) => (
      <Text testID="top-axis-width">{String(width)}</Text>
    ));
    const BottomAxisLabel = jest.fn(({width}: {width?: number}) => (
      <Text testID="bottom-axis-width">{String(width)}</Text>
    ));

    const screen = renderWithTheme(
      <InteractiveLineChart
        points={points}
        color="#0044ff"
        gradientFillColors={['#ffffff', '#000000']}
        TopAxisLabel={TopAxisLabel}
        BottomAxisLabel={BottomAxisLabel}
      />,
    );

    fireEvent(screen.getByTestId('interactive-line-chart-inner'), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 240, height: 220}},
    });

    expect(screen.getByTestId('interactive-line-chart-graph')).toHaveStyle({
      width: 240,
    });
    expect(screen.getByTestId('top-axis-width')).toHaveTextContent('240');
    expect(screen.getByTestId('bottom-axis-width')).toHaveTextContent('240');

    fireEvent(screen.getByTestId('interactive-line-chart-inner'), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 420, height: 220}},
    });

    expect(screen.getByTestId('interactive-line-chart-graph')).toHaveStyle({
      width: 420,
    });
    expect(screen.getByTestId('top-axis-width')).toHaveTextContent('420');
    expect(screen.getByTestId('bottom-axis-width')).toHaveTextContent('420');
  });

  it('does not remount axis labels when derived width changes', () => {
    const onMount = jest.fn();
    const onUnmount = jest.fn();
    const TopAxisLabel = ({width}: {width?: number}) => {
      React.useEffect(() => {
        onMount();
        return () => onUnmount();
      }, []);

      return <Text testID="stable-axis-width">{String(width)}</Text>;
    };

    const screen = renderWithTheme(
      <InteractiveLineChart
        points={points}
        color="#0044ff"
        gradientFillColors={['#ffffff', '#000000']}
        TopAxisLabel={TopAxisLabel}
      />,
    );

    const initialTopAxisRenderer = mockLineGraph.mock.lastCall?.[0]?.TopAxisLabel;

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId('interactive-line-chart-inner'), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 240, height: 220}},
    });

    const topAxisRendererAfterFirstLayout =
      mockLineGraph.mock.lastCall?.[0]?.TopAxisLabel;

    expect(screen.getByTestId('stable-axis-width')).toHaveTextContent('240');
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
    expect(topAxisRendererAfterFirstLayout).toBe(initialTopAxisRenderer);

    fireEvent(screen.getByTestId('interactive-line-chart-inner'), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 420, height: 220}},
    });

    const topAxisRendererAfterSecondLayout =
      mockLineGraph.mock.lastCall?.[0]?.TopAxisLabel;

    expect(screen.getByTestId('stable-axis-width')).toHaveTextContent('420');
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
    expect(topAxisRendererAfterSecondLayout).toBe(initialTopAxisRenderer);
  });

  it('honors an explicit width override', () => {
    const TopAxisLabel = jest.fn(({width}: {width?: number}) => (
      <Text testID="explicit-axis-width">{String(width)}</Text>
    ));

    const screen = renderWithTheme(
      <InteractiveLineChart
        points={points}
        color="#0044ff"
        gradientFillColors={['#ffffff', '#000000']}
        width={360}
        TopAxisLabel={TopAxisLabel}
      />,
    );

    expect(screen.getByTestId('interactive-line-chart-graph')).toHaveStyle({
      width: 360,
    });
    expect(screen.getByTestId('explicit-axis-width')).toHaveTextContent('360');
  });
});
