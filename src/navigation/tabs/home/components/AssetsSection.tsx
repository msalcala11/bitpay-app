import React, {useEffect, useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {useNavigation} from '@react-navigation/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import Button from '../../../../components/button/Button';
import {HomeSectionTitle} from './Styled';
import AssetsList from './AssetsList';
import {
  AssetRowItem,
  buildAssetRowItemsFromPortfolioSnapshots,
  GainLossMode,
  buildWalletIdsByAssetGroupKey,
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  isFiatLoadingForWallets,
  getPopulateLoadingByAssetKey,
  getDisplayAssetRowItems,
} from '../../../../utils/assets';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import AssetsGainLossDropdown from './AssetsGainLossDropdown';
import {useAppSelector} from '../../../../utils/hooks';
import type {Key} from '../../../../store/wallet/wallet.models';
import type {Rates} from '../../../../store/rate/rate.models';

const Container = styled.View`
  margin-top: 5px;
  margin-bottom: 25px;
`;

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 0 ${ScreenGutter} 0 16px;
`;

const ButtonContainer = styled.View`
  margin: 0px ${ScreenGutter} 0;
`;

const AssetsSection: React.FC = () => {
  const navigation = useNavigation();
  const [gainLossMode, setGainLossMode] = useState<GainLossMode>('1D');
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const rates = useAppSelector(({RATE}) => RATE.rates) as Rates;
  const lastDayRates = useAppSelector(({RATE}) => RATE.lastDayRates) as Rates;
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;
  const wallets = useMemo(() => {
    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keys]);

  const walletIdsByAssetKey = useMemo(() => {
    return buildWalletIdsByAssetGroupKey(wallets);
  }, [wallets]);

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency: portfolio.quoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  });

  const isFiatLoading = useMemo(() => {
    return isFiatLoadingForWallets({
      quoteCurrency,
      wallets,
      snapshotsByWalletId: portfolio.snapshotsByWalletId || {},
    });
  }, [quoteCurrency, wallets, portfolio.snapshotsByWalletId]);

  const hasAnySnapshots = useMemo(() => {
    for (const v of Object.values(portfolio.snapshotsByWalletId || {})) {
      if (Array.isArray(v) && v.length > 0) {
        return true;
      }
    }
    return false;
  }, [portfolio.snapshotsByWalletId]);

  const allItems: AssetRowItem[] = useMemo(() => {
    return buildAssetRowItemsFromPortfolioSnapshots({
      snapshotsByWalletId: portfolio.snapshotsByWalletId || {},
      wallets,
      quoteCurrency,
      gainLossMode,
      rates,
      lastDayRates,
      fiatRateSeriesCache,
      collapseAcrossChains: true,
    });
  }, [
    gainLossMode,
    portfolio.snapshotsByWalletId,
    quoteCurrency,
    wallets,
    rates,
    lastDayRates,
    fiatRateSeriesCache,
  ]);

  const items: AssetRowItem[] = useMemo(() => {
    const display = getDisplayAssetRowItems({
      items: allItems,
      gainLossMode,
      options: SupportedCurrencyOptions,
    });

    return display.slice(0, 4);
  }, [allItems, gainLossMode]);

  const [isPopulateLoadingByKey, setIsPopulateLoadingByKey] = useState<
    Record<string, boolean> | undefined
  >(undefined);

  useEffect(() => {
    if (!portfolio.populateStatus?.inProgress) {
      if (isPopulateLoadingByKey) {
        setIsPopulateLoadingByKey(undefined);
      }
      return;
    }

    setIsPopulateLoadingByKey(prev => {
      return getPopulateLoadingByAssetKey({
        items,
        walletIdsByAssetKey,
        populateStatus: portfolio.populateStatus,
        prev: prev || undefined,
      });
    });
  }, [
    isPopulateLoadingByKey,
    items,
    portfolio.populateStatus,
    walletIdsByAssetKey,
  ]);

  if (!portfolio.populateStatus?.inProgress && !hasAnySnapshots) {
    return null;
  }

  if (!items.length) {
    return null;
  }

  return (
    <Container>
      <Header>
        <HomeSectionTitle>Assets</HomeSectionTitle>
        <AssetsGainLossDropdown
          onPress={() => {}}
          onChange={value => setGainLossMode(value)}
        />
      </Header>

      <AssetsList
        items={items}
        isFiatLoading={isFiatLoading}
        isPopulateLoading={portfolio.populateStatus?.inProgress}
        isPopulateLoadingByKey={isPopulateLoadingByKey}
      />

      <ButtonContainer>
        <Button
          buttonStyle="secondary"
          height={50}
          buttonOutline
          onPress={() => (navigation as any).navigate('AllAssets')}>
          See All Assets
        </Button>
      </ButtonContainer>
    </Container>
  );
};

export default AssetsSection;
