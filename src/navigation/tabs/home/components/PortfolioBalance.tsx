import React, {useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {BaseText, H2} from '../../../../components/styled/Text';
import {SlateDark, White} from '../../../../styles/colors';
import {useSelector} from 'react-redux';
import {RootState} from '../../../../store';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import InfoSvg from './InfoSvg';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {
  showBottomNotificationModal,
  toggleHideAllBalances,
} from '../../../../store/app/app.actions';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import {COINBASE_ENV} from '../../../../api/coinbase/coinbase.constants';
import {useTranslation} from 'react-i18next';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {maskIfHidden} from '../../../../utils/hideBalances';
import {
  getQuoteCurrency,
  getVisibleKeysFromKeys,
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../../../utils/portfolio/assets';
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

const HiddenBalance = styled(H2)`
  line-height: 50px;
  margin: 6px 0;
`;

const PortfolioBalance = () => {
  const {t} = useTranslation();
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;

  const keys = useSelector(({WALLET}: RootState) => WALLET.keys);
  const portfolio = useSelector(({PORTFOLIO}: RootState) => PORTFOLIO);
  const {rates, fiatRateSeriesCache} = useSelector(({RATE}: RootState) => RATE);

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);

  const [selectedBalance, setSelectedBalance] = useState<number | undefined>();

  const visibleKeys = useMemo(
    () => getVisibleKeysFromKeys(keys, homeCarouselConfig),
    [homeCarouselConfig, keys],
  );

  const visibleCurrentBalance = useMemo(
    () =>
      visibleKeys.reduce((total, key) => total + (key.totalBalance || 0), 0),
    [visibleKeys],
  );

  const totalBalance: number = visibleCurrentBalance + coinbaseBalance;

  const dispatch = useAppDispatch();

  const walletsAcrossKeys: Wallet[] = useMemo(() => {
    const allWallets = getVisibleWalletsFromKeys(keys, homeCarouselConfig);
    const snapshotsMap = portfolio?.snapshotsByWalletId || {};

    const byId = new Map<string, Wallet>();
    for (const w of allWallets) {
      if (!w?.id) {
        continue;
      }
      const hasSnaps = !!snapshotsMap[w.id]?.length;
      if (!walletHasNonZeroLiveBalance(w) && !hasSnaps) {
        continue;
      }
      if (!byId.has(w.id)) {
        byId.set(w.id, w);
      }
    }
    return Array.from(byId.values());
  }, [homeCarouselConfig, keys, portfolio?.snapshotsByWalletId]);

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency: portfolio?.quoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  });

  const displayedTotalBalance =
    typeof selectedBalance === 'number' ? selectedBalance : totalBalance;

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
              {formatFiatAmount(displayedTotalBalance, defaultAltCurrency.isoCode, {
                currencyDisplay: 'symbol',
              })}
            </PortfolioBalanceText>
          </>
        ) : (
          <HiddenBalance>{maskIfHidden(true, totalBalance)}</HiddenBalance>
        )}
      </TouchableOpacity>

      {!hideAllBalances ? (
        <BalanceHistoryChart
          wallets={walletsAcrossKeys}
          snapshotsByWalletId={portfolio?.snapshotsByWalletId || {}}
          quoteCurrency={quoteCurrency}
          rates={rates}
          fiatRateSeriesCache={fiatRateSeriesCache}
          // NOTE: Coinbase balance is intentionally excluded from the balance chart
          // (Option B per product requirements) because we do not have historized
          // Coinbase balance snapshots.
          onSelectedBalanceChange={setSelectedBalance}
        />
      ) : null}
    </PortfolioContainer>
  );
};

export default PortfolioBalance;
