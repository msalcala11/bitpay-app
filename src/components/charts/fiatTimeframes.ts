import type {FiatRateInterval} from '../../store/rate/rate.models';


export const FIAT_CHART_TIMEFRAME_VALUES: FiatRateInterval[] = [
  'ALL',
  '1D',
  '1W',
  '1M',
  '3M',
  '1Y',
  '5Y',
];

export const getFiatChartTimeframeOptions = (
  t: (key: string) => string,
): Array<{label: string; value: FiatRateInterval}> => {
  return FIAT_CHART_TIMEFRAME_VALUES.map(value => ({
    value,
    label: value === 'ALL' ? t('All') : value,
  }));
};

export const getSeriesIntervalForFiatTimeframe = (
  timeframe: FiatRateInterval,
): FiatRateInterval => {
  switch (timeframe) {
    case '3M':
    case '1Y':
    case '5Y':
      return 'ALL';
    default:
      return timeframe;
  }
};


export const getRangeLabelForFiatTimeframe = (
  t: (key: string) => string,
  timeframe: FiatRateInterval,
): string => {
  switch (timeframe) {
    case '1D':
      return t('Last Day');
    case '1W':
      return t('Past Week');
    case '1M':
      return t('Past Month');
    case '3M':
      return t('Past 3 Months');
    case '1Y':
      return t('Past Year');
    case '5Y':
      return t('Past 5 Years');
    case 'ALL':
    default:
      return t('All-time');
  }
};

export const formatSelectedPointLabelForFiatTimeframe = (args: {
  selectedTimeframe: FiatRateInterval;
  selectedDate: Date;
}): string => {
  const {selectedTimeframe, selectedDate} = args;

  if (selectedTimeframe === '1D') {
    return selectedDate.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  if (selectedTimeframe === '1W' || selectedTimeframe === '1M') {
    return selectedDate.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return selectedDate.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

export const formatRangeOrSelectedPointLabel = (args: {
  rangeLabel: string;
  selectedTimeframe: FiatRateInterval;
  selectedDate?: Date;
}): string => {
  const {rangeLabel, selectedTimeframe, selectedDate} = args;
  if (!selectedDate) {
    return rangeLabel;
  }

  return formatSelectedPointLabelForFiatTimeframe({
    selectedTimeframe,
    selectedDate,
  });
};
