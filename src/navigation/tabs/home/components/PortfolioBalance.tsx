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
  getPercentageDifferenceFromPercentRatio,
  getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots,
  hasSnapshotsForWallets,
} from '../../../../utils/assets';
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
  const portfolioBalance = useSelector(
    ({WALLET}: RootState) => WALLET.portfolioBalance,
  );

  const keys = useSelector(({WALLET}: RootState) => WALLET.keys);
  const portfolio = useSelector(({PORTFOLIO}: RootState) => PORTFOLIO);
  const {rates, lastDayRates, fiatRateSeriesCache} = useSelector(
    ({RATE}: RootState) => RATE,
  );

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
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

  const legacyPercentageDifference = calculatePercentageDifference(
    portfolioBalance.current,
    portfolioBalance.lastDay,
  );

  const hasSnapshots = hasSnapshotsForWallets({
    snapshotsByWalletId: portfolio?.snapshotsByWalletId || {},
    wallets: walletsAcrossKeys,
  });

  const portfolioPnlPercentageDifference = useMemo(() => {
    if (!hasSnapshots) {
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

    if (!pnl.available) {
      return legacyPercentageDifference;
    }

    return getPercentageDifferenceFromPercentRatio(pnl.percentRatio);
  }, [
    fiatRateSeriesCache,
    hasSnapshots,
    lastDayRates,
    legacyPercentageDifference,
    portfolio?.quoteCurrency,
    portfolio?.snapshotsByWalletId,
    rates,
    walletsAcrossKeys,
  ]);

  const percentageDifference = hasSnapshots
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
    </PortfolioContainer>
  );
};

export default PortfolioBalance;
