import React from 'react';
import BalanceHistoryChart, {
  type BalanceHistoryChartProps,
} from './BalanceHistoryChart';

type SharedBalanceHistoryChartProps = Pick<
  BalanceHistoryChartProps,
  | 'wallets'
  | 'snapshotsByWalletId'
  | 'quoteCurrency'
  | 'rates'
  | 'fiatRateSeriesCache'
> &
  Omit<
    BalanceHistoryChartProps,
    | 'wallets'
    | 'snapshotsByWalletId'
    | 'quoteCurrency'
    | 'rates'
    | 'fiatRateSeriesCache'
  >;

const SharedBalanceHistoryChart = (
  props: SharedBalanceHistoryChartProps,
): React.ReactElement => {
  const {
    wallets,
    snapshotsByWalletId,
    quoteCurrency,
    rates,
    fiatRateSeriesCache,
    ...chartProps
  } = props;

  return (
    <BalanceHistoryChart
      wallets={wallets}
      snapshotsByWalletId={snapshotsByWalletId}
      quoteCurrency={quoteCurrency}
      rates={rates}
      fiatRateSeriesCache={fiatRateSeriesCache}
      {...chartProps}
    />
  );
};

export type {SharedBalanceHistoryChartProps};
export default SharedBalanceHistoryChart;
