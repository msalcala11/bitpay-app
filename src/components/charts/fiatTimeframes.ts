import type {FiatRateInterval} from '../../store/rate/rate.models';

export const FIAT_CHART_TIMEFRAMES: Array<{label: string; value: FiatRateInterval}> = [
  {label: 'All', value: 'ALL'},
  {label: '1D', value: '1D'},
  {label: '1W', value: '1W'},
  {label: '1M', value: '1M'},
  {label: '3M', value: '3M'},
  {label: '1Y', value: '1Y'},
  {label: '5Y', value: '5Y'},
];

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

export const formatRangeOrSelectedPointLabel = (args: {
  rangeLabel: string;
  selectedTimeframe: FiatRateInterval;
  selectedDate?: Date;
}): string => {
  const {rangeLabel, selectedTimeframe, selectedDate} = args;
  if (!selectedDate) {
    return rangeLabel;
  }

  const date = selectedDate;
  if (selectedTimeframe === '1D') {
    return date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  if (selectedTimeframe === '1W' || selectedTimeframe === '1M') {
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};
