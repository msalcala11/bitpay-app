import {useCallback, useRef} from 'react';
import type {SharedValue} from 'react-native-reanimated';
import ChartAxisLabel from './ChartAxisLabel';

type AxisLabelSnapshot = {
  value?: number;
  index?: number;
  arrayLength?: number;
};

type UseChartAxisLabelRenderersArgs = {
  minLabel?: AxisLabelSnapshot;
  maxLabel?: AxisLabelSnapshot;
  quoteCurrency: string;
  currencyAbbreviation?: string;
  chartWidth?: number;
  contentOpacity?:
    | number
    | SharedValue<number>
    | Readonly<SharedValue<number>>;
};

const hasRenderableAxisLabel = (label?: AxisLabelSnapshot): boolean => {
  return (
    !!label &&
    typeof label.index === 'number' &&
    typeof label.arrayLength === 'number' &&
    label.arrayLength > 0 &&
    label.value != null
  );
};

export const useChartAxisLabelRenderers = ({
  minLabel,
  maxLabel,
  quoteCurrency,
  currencyAbbreviation,
  chartWidth,
  contentOpacity,
}: UseChartAxisLabelRenderersArgs) => {
  const minLabelRef = useRef(minLabel);
  minLabelRef.current = minLabel;

  const maxLabelRef = useRef(maxLabel);
  maxLabelRef.current = maxLabel;

  const quoteCurrencyRef = useRef(quoteCurrency);
  quoteCurrencyRef.current = quoteCurrency;

  const currencyAbbreviationRef = useRef(currencyAbbreviation);
  currencyAbbreviationRef.current = currencyAbbreviation;

  const chartWidthRef = useRef(chartWidth);
  chartWidthRef.current = chartWidth;

  const contentOpacityRef = useRef(contentOpacity);
  contentOpacityRef.current = contentOpacity;

  const MinAxisLabel = useCallback(() => {
    const label = minLabelRef.current;
    if (!hasRenderableAxisLabel(label)) {
      return null;
    }

    return (
      <ChartAxisLabel
        value={label.value}
        index={label.index}
        arrayLength={label.arrayLength}
        quoteCurrency={quoteCurrencyRef.current}
        currencyAbbreviation={currencyAbbreviationRef.current}
        type="min"
        contentOpacity={contentOpacityRef.current}
        chartWidth={chartWidthRef.current}
      />
    );
  }, []);

  const MaxAxisLabel = useCallback(() => {
    const label = maxLabelRef.current;
    if (!hasRenderableAxisLabel(label)) {
      return null;
    }

    return (
      <ChartAxisLabel
        value={label.value}
        index={label.index}
        arrayLength={label.arrayLength}
        quoteCurrency={quoteCurrencyRef.current}
        currencyAbbreviation={currencyAbbreviationRef.current}
        type="max"
        contentOpacity={contentOpacityRef.current}
        chartWidth={chartWidthRef.current}
      />
    );
  }, []);

  return {
    MinAxisLabel,
    MaxAxisLabel,
  };
};

export default useChartAxisLabelRenderers;
