import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {BaseText, H2} from '../../../../components/styled/Text';
import {SlateDark, White} from '../../../../styles/colors';
import {useSelector} from 'react-redux';
import {RootState} from '../../../../store';
import {
  calculatePercentageDifference,
  formatFiatAmount,
} from '../../../../utils/helper-methods';
import InfoSvg from './InfoSvg';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {
  showBottomNotificationModal,
  toggleHideAllBalances,
} from '../../../../store/app/app.actions';
import Percentage from '../../../../components/percentage/Percentage';
import {COINBASE_ENV} from '../../../../api/coinbase/coinbase.constants';
import {useTranslation} from 'react-i18next';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {maskIfHidden} from '../../../../utils/hideBalances';
import {
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  isFiatLoadingForWallets,
  getPercentageDifferenceFromPercentRatio,
  getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots,
} from '../../../../utils/assets';
import type {Wallet} from '../../../../store/wallet/wallet.models';
import BalanceChart from '../../../../components/balance-chart/BalanceChart';
import {useBalanceChartData} from '../../../../utils/hooks';

const PortfolioContainer = styled.View`
  justify-content: center;
  align-items: center;
`;

const PortfolioBalanceHeader = styled(TouchableOpacity)`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
`;

const PortfolioBalanceTitle = styled(BaseText)`
  margin-right: 3px;
  font-size: 13px;
  line-height: 18px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

const PortfolioBalanceText = styled(BaseText)`
  font-weight: bold;
  font-size: 31px;
  line-height: 40px;
  color: ${({theme}) => theme.colors.text};
  margin: 2px 0;
`;

const PercentageWrapper = styled.View`
  align-items: center;
`;

const HiddenBalance = styled(H2)`
  line-height: 50px;
  margin: 6px 0;
`;

const ChartWrapper = styled.View`
  margin-top: 12px;
  width: 100%;
`;

const PortfolioBalance = () => {
  const {t} = useTranslation();
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;
  const portfolioBalance = useSelector(
    ({WALLET}: RootState) => WALLET.portfolioBalance,
  );

  const keys = useSelector(({WALLET}: RootState) => WALLET.keys);
  const portfolio = useSelector(({PORTFOLIO}: RootState) => PORTFOLIO);
  const {rates, lastDayRates, fiatRateSeriesCache} = useSelector(
    ({RATE}: RootState) => RATE,
  );

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const homeCarouselConfig = useAppSelector(
    ({APP}) => APP.homeCarouselConfig,
  );
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);

  const totalBalance: number = portfolioBalance.current + coinbaseBalance;

  const dispatch = useAppDispatch();

  const walletsAcrossKeys: Wallet[] = useMemo(() => {
    const allWallets = Object.values(keys || {}).flatMap((k: any) =>
      Array.isArray(k?.wallets) ? k.wallets : [],
    );

    const byId = new Map<string, Wallet>();
    for (const w of allWallets) {
      if (!w?.id) {
        continue;
      }
      if (w.hideWallet || w.hideWalletByAccount) {
        continue;
      }
      const sat = (w as any)?.balance?.sat as number | undefined;
      if (!(typeof sat === 'number' && sat > 0)) {
        continue;
      }
      if (!byId.has(w.id)) {
        byId.set(w.id, w);
      }
    }
    return Array.from(byId.values());
  }, [keys]);

  const chartWallets = useMemo(() => {
    const visibleWallets = getVisibleWalletsFromKeys(keys, homeCarouselConfig);
    const byId = new Map<string, Wallet>();
    for (const w of visibleWallets) {
      if (!w?.id) {
        continue;
      }
      if (!byId.has(w.id)) {
        byId.set(w.id, w);
      }
    }
    return Array.from(byId.values());
  }, [homeCarouselConfig, keys]);

  const quoteCurrency = useMemo(() => {
    return getQuoteCurrency({
      portfolioQuoteCurrency: portfolio?.quoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolio?.quoteCurrency]);

  const {
    data: chartData,
    selectedTimeframe,
    setSelectedTimeframe,
  } = useBalanceChartData({
    wallets: chartWallets,
    snapshotsByWalletId: portfolio?.snapshotsByWalletId || {},
    fiatRateSeriesCache,
    quoteCurrency,
    initialTimeframe: 'ALL',
  });

  const isChartLoading = useMemo(() => {
    if (!chartWallets.length) {
      return false;
    }
    if (portfolio?.populateStatus?.inProgress) {
      return true;
    }
    if (
      isFiatLoadingForWallets({
        quoteCurrency,
        wallets: chartWallets,
        snapshotsByWalletId: portfolio?.snapshotsByWalletId || {},
      })
    ) {
      return true;
    }
    return !chartData.data.length;
  }, [
    chartData.data.length,
    chartWallets,
    portfolio?.populateStatus?.inProgress,
    portfolio?.snapshotsByWalletId,
    quoteCurrency,
  ]);

  const legacyPercentageDifference = calculatePercentageDifference(
    portfolioBalance.current,
    portfolioBalance.lastDay,
  );

  const isPortfolioPopulateCompleted =
    !portfolio?.populateStatus?.inProgress &&
    typeof portfolio?.lastPopulatedAt === 'number';

  const portfolioPnlPercentageDifference = useMemo(() => {
    if (!isPortfolioPopulateCompleted) {
      return null;
    }

    const pnl = getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots({
      snapshotsByWalletId: portfolio?.snapshotsByWalletId || {},
      wallets: walletsAcrossKeys,
      quoteCurrency: portfolio?.quoteCurrency,
      timeframe: '1D',
      rates,
      lastDayRates,
      fiatRateSeriesCache,
    });

    return getPercentageDifferenceFromPercentRatio(pnl.percentRatio);
  }, [
    fiatRateSeriesCache,
    isPortfolioPopulateCompleted,
    lastDayRates,
    portfolio?.quoteCurrency,
    portfolio?.snapshotsByWalletId,
    rates,
    walletsAcrossKeys,
  ]);

  const percentageDifference = isPortfolioPopulateCompleted
    ? portfolioPnlPercentageDifference
    : legacyPercentageDifference;

  const showPortfolioBalanceInfoModal = () => {
    dispatch(
      showBottomNotificationModal({
        type: 'info',
        title: t('Portfolio balance'),
        message: t(
          'Your Portfolio Balance is the total of all your crypto assets.',
        ),
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('GOT IT'),
            action: () => null,
            primary: true,
          },
        ],
      }),
    );
  };

  return (
    <PortfolioContainer>
      <PortfolioBalanceHeader
        activeOpacity={ActiveOpacity}
        onPress={showPortfolioBalanceInfoModal}>
        <PortfolioBalanceTitle>{t('Portfolio Balance')}</PortfolioBalanceTitle>
        <InfoSvg width={16} height={16} />
      </PortfolioBalanceHeader>
      <TouchableOpacity
        onLongPress={() => {
          dispatch(toggleHideAllBalances());
        }}>
        {!hideAllBalances ? (
          <>
            <PortfolioBalanceText>
              {formatFiatAmount(totalBalance, defaultAltCurrency.isoCode, {
                currencyDisplay: 'symbol',
              })}
            </PortfolioBalanceText>
            {percentageDifference ? (
              <PercentageWrapper>
                <Percentage
                  percentageDifference={percentageDifference}
                  hideArrow
                  rangeLabel={t('Last Day')}
                />
              </PercentageWrapper>
            ) : null}
          </>
        ) : (
          <HiddenBalance>{maskIfHidden(true, totalBalance)}</HiddenBalance>
        )}
      </TouchableOpacity>
      {!hideAllBalances && chartWallets.length ? (
        <ChartWrapper>
          <BalanceChart
            data={chartData}
            quoteCurrency={quoteCurrency}
            selectedTimeframe={selectedTimeframe}
            onTimeframeChange={setSelectedTimeframe}
            isLoading={isChartLoading}
          />
        </ChartWrapper>
      ) : null}
    </PortfolioContainer>
  );
};

export default PortfolioBalance;
