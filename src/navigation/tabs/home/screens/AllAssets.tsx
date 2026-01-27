import React, {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {RootStackParamList} from '../../../../Root';
import {useTheme} from 'styled-components/native';
import {useStackScreenOptions} from '../../../utils/headerHelpers';
import {HeaderTitle} from '../../../../components/styled/Text';
import HeaderBackButton from '../../../../components/back/HeaderBackButton';
import {EmptyListContainer} from '../../../../components/styled/Containers';
import {H5} from '../../../../components/styled/Text';
import GhostSvg from '../../../../../assets/img/ghost-straight-face.svg';
import AssetsGainLossDropdown from '../components/AssetsGainLossDropdown';
import AssetsSearchPill from '../components/AssetsSearchPill';
import AssetsList from '../components/AssetsList';
import {
  buildAssetRowItemsFromPortfolioSnapshots,
  buildWalletIdsByAssetGroupKey,
  findSupportedCurrencyOptionForAsset,
  GainLossMode,
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  isFiatLoadingForWallets,
  getPopulateLoadingByAssetKey,
  getDisplayAssetRowItems,
} from '../../../../utils/assets';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../../constants/currencies';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {useAppSelector} from '../../../../utils/hooks';
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';
import type {Key} from '../../../../store/wallet/wallet.models';
import type {Rates} from '../../../../store/rate/rate.models';

type Props = NativeStackScreenProps<RootStackParamList, 'AllAssets'>;

const ScreenContainer = styled.SafeAreaView`
  flex: 1;
`;

const Content = styled.ScrollView`
  flex: 1;
`;

const FiltersRow = styled.View`
  flex-direction: row;
  gap: 12px;
  padding: 12px 16px;
`;

const FILTER_HEIGHT = 40;

const AllAssets: React.FC<Props> = ({navigation, route}) => {
  const theme = useTheme();
  const commonOptions = useStackScreenOptions(theme);
  const [query, setQuery] = useState('');
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

  const keyId = route.params?.keyId;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      const subset: Record<string, Key> = {[keyId]: keys[keyId]};
      return getVisibleWalletsFromKeys(subset);
    }
    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

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

  useLayoutEffect(() => {
    navigation.setOptions({
      ...commonOptions,
      headerLeft: () => <HeaderBackButton />,
      headerTitle: () => <HeaderTitle>Assets</HeaderTitle>,
    });
  }, [navigation, commonOptions]);

  const items = useMemo(() => {
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

  const visibleItems = useMemo(() => {
    return getDisplayAssetRowItems({
      items,
      gainLossMode,
      options: SupportedCurrencyOptions,
    });
  }, [gainLossMode, items]);
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return visibleItems;
    }

    return visibleItems.filter(item => {
      const option = findSupportedCurrencyOptionForAsset({
        options: SupportedCurrencyOptions,
        currencyAbbreviation: item.currencyAbbreviation,
        chain: item.chain,
        tokenAddress: item.tokenAddress,
      });

      const optionCurrencyName = option?.currencyName;
      const chainDisplayName =
        BitpaySupportedCoins[option?.chain || item.chain]?.name;
      const tokenDisplayName = option?.tokenAddress
        ? BitpaySupportedTokens[
            getCurrencyAbbreviation(option.tokenAddress, option.chain)
          ]?.name
        : undefined;
      return (
        item.name.toLowerCase().includes(q) ||
        item.currencyAbbreviation.toLowerCase().includes(q) ||
        item.chain.toLowerCase().includes(q) ||
        (optionCurrencyName || '').toLowerCase().includes(q) ||
        (chainDisplayName || '').toLowerCase().includes(q) ||
        (tokenDisplayName || '').toLowerCase().includes(q)
      );
    });
  }, [query, visibleItems]);

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
        items: filteredItems,
        walletIdsByAssetKey,
        populateStatus: portfolio.populateStatus,
        prev: prev || undefined,
      });
    });
  }, [
    filteredItems,
    isPopulateLoadingByKey,
    portfolio.populateStatus,
    walletIdsByAssetKey,
  ]);

  const showGhostTown = !items.length;

  return (
    <ScreenContainer>
      <Content>
        <FiltersRow>
          <AssetsSearchPill
            value={query}
            onChangeText={setQuery}
            height={FILTER_HEIGHT}
          />
          <AssetsGainLossDropdown
            onPress={() => {}}
            onChange={value => setGainLossMode(value)}
            height={FILTER_HEIGHT}
          />
        </FiltersRow>

        {showGhostTown ? (
          <EmptyListContainer>
            <H5>{"It's a ghost town in here"}</H5>
            <GhostSvg style={{marginTop: 20}} />
          </EmptyListContainer>
        ) : (
          <AssetsList
            items={filteredItems}
            isFiatLoading={isFiatLoading}
            isPopulateLoading={portfolio.populateStatus?.inProgress}
            isPopulateLoadingByKey={isPopulateLoadingByKey}
          />
        )}
      </Content>
    </ScreenContainer>
  );
};

export default AllAssets;
