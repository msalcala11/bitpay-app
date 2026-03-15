import React from 'react';
import {render} from '@testing-library/react-native';
import {ThemeProvider} from 'styled-components/native';
import TimeframeSelector from './TimeframeSelector';

jest.mock('@components/base/TouchableOpacity', () => {
  const ReactNative = require('react-native');

  return {
    TouchableOpacity: ReactNative.TouchableOpacity,
  };
});

jest.mock('../styled/Containers', () => ({
  ActiveOpacity: 0.8,
}));

jest.mock('../styled/Text', () => {
  const ReactNative = require('react-native');

  return {
    BaseText: ReactNative.Text,
  };
});

const options = [
  {value: '1D', label: '1D', testID: 'timeframe-pill-1d'},
  {value: '1W', label: '1W', testID: 'timeframe-pill-1w'},
  {value: '1M', label: '1M', testID: 'timeframe-pill-1m'},
  {value: 'ALL', label: 'All', testID: 'timeframe-pill-all'},
] as const;

const renderWithTheme = (component: React.ReactElement) =>
  render(<ThemeProvider theme={{dark: false}}>{component}</ThemeProvider>);

describe('TimeframeSelector', () => {
  it('defaults to a container-driven row width', () => {
    const screen = renderWithTheme(
      <TimeframeSelector
        options={[...options]}
        selected="1D"
        onSelect={() => null}
      />,
    );

    expect(screen.getByTestId('timeframe-selector-row')).toHaveStyle({
      width: '100%',
    });
    expect(screen.getByTestId('timeframe-selector-container')).toHaveStyle({
      paddingLeft: 0,
      paddingRight: 0,
    });
  });

  it('supports an optional horizontal inset', () => {
    const screen = renderWithTheme(
      <TimeframeSelector
        options={[...options]}
        selected="1D"
        onSelect={() => null}
        horizontalInset="12px"
      />,
    );

    expect(screen.getByTestId('timeframe-selector-container')).toHaveStyle({
      paddingLeft: 12,
      paddingRight: 12,
    });
  });

  it('supports explicit narrow and wide widths', () => {
    const screen = renderWithTheme(
      <TimeframeSelector
        options={[...options]}
        selected="1D"
        onSelect={() => null}
        width={240}
      />,
    );

    expect(screen.getByTestId('timeframe-selector-row')).toHaveStyle({
      width: 240,
    });

    screen.rerender(
      <ThemeProvider theme={{dark: false}}>
        <TimeframeSelector
          options={[...options]}
          selected="1D"
          onSelect={() => null}
          width={420}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('timeframe-selector-row')).toHaveStyle({
      width: 420,
    });
  });

  it('does not forward transient active props to native components', () => {
    const screen = renderWithTheme(
      <TimeframeSelector
        options={[...options]}
        selected="1D"
        onSelect={() => null}
      />,
    );

    expect(screen.getByTestId('timeframe-pill-1d').props.active).toBeUndefined();
    expect(screen.getByText('1D').props.active).toBeUndefined();
  });
});
