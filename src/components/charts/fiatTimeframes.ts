import type {FiatRateInterval} from '../../store/rate/rate.models';

type FiatChartTimeframeLabelFormat = 'time' | 'dateTime' | 'date';

type FiatChartTimeframeMetadata = {
  value: FiatRateInterval;
  selectorOrder: number;
  precomputeOrder: number;
  seriesInterval: FiatRateInterval;
  getSelectorLabel: (t: (key: string) => string) => string;
  getRangeLabel: (t: (key: string) => string) => string;
  selectedPointLabelFormat: FiatChartTimeframeLabelFormat;
};

const FIAT_CHART_TIMEFRAME_METADATA_BY_VALUE: Record<
  FiatRateInterval,
  FiatChartTimeframeMetadata
> = {
  ALL: {
    value: 'ALL',
    selectorOrder: 0,
    precomputeOrder: 3,
    seriesInterval: 'ALL',
    getSelectorLabel: t => t('All'),
    getRangeLabel: t => t('All-time'),
    selectedPointLabelFormat: 'date',
  },
  '1D': {
    value: '1D',
    selectorOrder: 1,
    precomputeOrder: 0,
    seriesInterval: '1D',
    getSelectorLabel: () => '1D',
    getRangeLabel: t => t('Last Day'),
    selectedPointLabelFormat: 'time',
  },
  '1W': {
    value: '1W',
    selectorOrder: 2,
    precomputeOrder: 1,
    seriesInterval: '1W',
    getSelectorLabel: () => '1W',
    getRangeLabel: t => t('Past Week'),
    selectedPointLabelFormat: 'dateTime',
  },
  '1M': {
    value: '1M',
    selectorOrder: 3,
    precomputeOrder: 2,
    seriesInterval: '1M',
    getSelectorLabel: () => '1M',
    getRangeLabel: t => t('Past Month'),
    selectedPointLabelFormat: 'dateTime',
  },
  '3M': {
    value: '3M',
    selectorOrder: 4,
    precomputeOrder: 4,
    seriesInterval: 'ALL',
    getSelectorLabel: () => '3M',
    getRangeLabel: t => t('Past 3 Months'),
    selectedPointLabelFormat: 'date',
  },
  '1Y': {
    value: '1Y',
    selectorOrder: 5,
    precomputeOrder: 5,
    seriesInterval: 'ALL',
    getSelectorLabel: () => '1Y',
    getRangeLabel: t => t('Past Year'),
    selectedPointLabelFormat: 'date',
  },
  '5Y': {
    value: '5Y',
    selectorOrder: 6,
    precomputeOrder: 6,
    seriesInterval: 'ALL',
    getSelectorLabel: () => '5Y',
    getRangeLabel: t => t('Past 5 Years'),
    selectedPointLabelFormat: 'date',
  },
};

const getFiatChartTimeframeMetadata = (
  timeframe: FiatRateInterval,
): FiatChartTimeframeMetadata => {
  return (
    FIAT_CHART_TIMEFRAME_METADATA_BY_VALUE[timeframe] ||
    FIAT_CHART_TIMEFRAME_METADATA_BY_VALUE.ALL
  );
};

export const FIAT_CHART_TIMEFRAME_VALUES: FiatRateInterval[] = Object.values(
  FIAT_CHART_TIMEFRAME_METADATA_BY_VALUE,
)
  .slice()
  .sort((a, b) => a.selectorOrder - b.selectorOrder)
  .map(({value}) => value);

export const FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER: FiatRateInterval[] =
  Object.values(FIAT_CHART_TIMEFRAME_METADATA_BY_VALUE)
    .slice()
    .sort((a, b) => a.precomputeOrder - b.precomputeOrder)
    .map(({value}) => value);

export const getFiatChartTimeframeOptions = (
  t: (key: string) => string,
): Array<{label: string; value: FiatRateInterval}> => {
  return FIAT_CHART_TIMEFRAME_VALUES.map(value => ({
    value,
    label: getFiatChartTimeframeMetadata(value).getSelectorLabel(t),
  }));
};

export const getSeriesIntervalForFiatTimeframe = (
  timeframe: FiatRateInterval,
): FiatRateInterval => {
  return getFiatChartTimeframeMetadata(timeframe).seriesInterval;
};

export const getRangeLabelForFiatTimeframe = (
  t: (key: string) => string,
  timeframe: FiatRateInterval,
): string => {
  return getFiatChartTimeframeMetadata(timeframe).getRangeLabel(t);
};

export const formatSelectedPointLabelForFiatTimeframe = (args: {
  selectedTimeframe: FiatRateInterval;
  selectedDate: Date;
}): string => {
  const {selectedDate} = args;
  const {selectedPointLabelFormat} = getFiatChartTimeframeMetadata(
    args.selectedTimeframe,
  );

  switch (selectedPointLabelFormat) {
    case 'time':
      return selectedDate.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    case 'dateTime':
      return selectedDate.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    case 'date':
    default:
      return selectedDate.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
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

  return formatSelectedPointLabelForFiatTimeframe({
    selectedTimeframe,
    selectedDate,
  });
};
