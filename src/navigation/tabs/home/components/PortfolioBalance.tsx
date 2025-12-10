import React, {useState} from 'react';
import styled from 'styled-components/native';
import {useNavigation} from '@react-navigation/native';
import {BaseText, H2, Link} from '../../../../components/styled/Text';
import {Slate30, SlateDark, White} from '../../../../styles/colors';
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
import OptionsSheet from '../../../wallet/components/OptionsSheet';
import {WalletScreens} from '../../../wallet/WalletGroup';

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

const LinkText = styled(Link)`
  font-weight: 500;
  font-size: 18px;
  text-align: center;
`;

const BalanceSeriesButton = styled(TouchableOpacity)`
  margin-top: 12px;
  align-self: center;
`;

const PortfolioBalance = () => {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const [showTimeframeSheet, setShowTimeframeSheet] = useState(false);
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;
  const portfolioBalance = useSelector(
    ({WALLET}: RootState) => WALLET.portfolioBalance,
  );

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);

  const totalBalance: number = portfolioBalance.current + coinbaseBalance;

  const dispatch = useAppDispatch();
  const percentageDifference = calculatePercentageDifference(
    portfolioBalance.current,
    portfolioBalance.lastDay,
  );

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
    <>
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
            <HiddenBalance>****</HiddenBalance>
          )}
        </TouchableOpacity>
        <BalanceSeriesButton onPress={() => setShowTimeframeSheet(true)}>
          <LinkText>{t('View balance series list')}</LinkText>
        </BalanceSeriesButton>
      </PortfolioContainer>

      <OptionsSheet
        isVisible={showTimeframeSheet}
        closeModal={() => setShowTimeframeSheet(false)}
        title={t('Select Timeframe')}
        options={[
          {
            title: t('1 Day'),
            description: t('Last 24 hours'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: '1D',
              }),
          },
          {
            title: t('1 Week'),
            description: t('Last 7 days'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: '1W',
              }),
          },
          {
            title: t('1 Month'),
            description: t('Last 30 days'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: '1M',
              }),
          },
          {
            title: t('3 Months'),
            description: t('Last 90 days'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: '3M',
              }),
          },
          {
            title: t('1 Year'),
            description: t('Last 365 days'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: '1Y',
              }),
          },
          {
            title: t('All Time'),
            description: t('Full transaction history'),
            onPress: () =>
              navigation.navigate(WalletScreens.WALLET_BALANCE_SERIES, {
                timeframe: 'ALL',
              }),
          },
        ]}
      />
    </>
  );
};

export default PortfolioBalance;
