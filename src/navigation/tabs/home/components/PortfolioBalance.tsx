import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {BaseText, H2} from '../../../../components/styled/Text';
import {SlateDark, White} from '../../../../styles/colors';
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
  getPercentageDifferenceFromPercentRatio,
  getVisibleKeysFromKeys,
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../../../utils/portfolio/assets';
import {usePortfolioGainLossSummary} from '../../../../portfolio/ui/hooks/usePortfolioGainLossSummary';
import type {Wallet} from '../../../../store/wallet/wallet.models';

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

const PortfolioBalance = () => {
  const {t} = useTranslation();
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;

  const keys = useAppSelector(({WALLET}) => WALLET.keys);

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);

  const visibleKeys = useMemo(
    () => getVisibleKeysFromKeys(keys, homeCarouselConfig),
    [homeCarouselConfig, keys],
  );

  const visibleCurrentBalance = useMemo(
    () =>
      visibleKeys.reduce((total, key) => total + (key.totalBalance || 0), 0),
    [visibleKeys],
  );

  const visibleLastDayBalance = useMemo(
    () =>
      visibleKeys.reduce(
        (total, key) => total + (key.totalBalanceLastDay || 0),
        0,
      ),
    [visibleKeys],
  );

  const totalBalance: number = visibleCurrentBalance + coinbaseBalance;

  const dispatch = useAppDispatch();

  const walletsAcrossKeys: Wallet[] = useMemo(() => {
    const allWallets = getVisibleWalletsFromKeys(keys, homeCarouselConfig);

    const byId = new Map<string, Wallet>();
    for (const w of allWallets) {
      if (!w?.id) {
        continue;
      }
      if (!walletHasNonZeroLiveBalance(w)) {
        continue;
      }
      if (!byId.has(w.id)) {
        byId.set(w.id, w);
      }
    }
    return Array.from(byId.values());
  }, [homeCarouselConfig, keys]);

  const legacyPercentageDifference = calculatePercentageDifference(
    visibleCurrentBalance,
    visibleLastDayBalance,
  );

  const {summary: gainLossSummary} = usePortfolioGainLossSummary({
    wallets: walletsAcrossKeys,
    liveFiatTotal: visibleCurrentBalance,
  });

  const percentageDifference = useMemo(() => {
    const runtimePercentageDifference = gainLossSummary.today.available
      ? getPercentageDifferenceFromPercentRatio(
          gainLossSummary.today.percentRatio,
        )
      : null;

    return runtimePercentageDifference ?? legacyPercentageDifference;
  }, [
    gainLossSummary.today.available,
    gainLossSummary.today.percentRatio,
    legacyPercentageDifference,
  ]);

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
            {percentageDifference || percentageDifference === 0 ? (
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
    </PortfolioContainer>
  );
};

export default PortfolioBalance;
