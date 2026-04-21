import React, {useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {NavigationProp, useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import type {RootStackParamList} from '../../../../Root';
import {ScreenGutter} from '../../../../components/styled/Containers';
import Button from '../../../../components/button/Button';
import {HomeSectionTitle} from './Styled';
import AssetsList from './AssetsList';
import {GainLossMode} from '../../../../utils/portfolio/assets';
import AssetsGainLossDropdown from './AssetsGainLossDropdown';
import {useAppSelector} from '../../../../utils/hooks';
import {
  useDevLayoutTrace,
  useDevRenderTrace,
} from '../../../../utils/hooks/useDevRenderTrace';
import usePortfolioAssetRows from '../hooks/usePortfolioAssetRows';
import useScreenFocusRefreshToken from '../hooks/useScreenFocusRefreshToken';

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
  const {t} = useTranslation();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [gainLossMode, setGainLossMode] = useState<GainLossMode>('1D');
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const focusRefreshToken = useScreenFocusRefreshToken();
  const {
    visibleItems,
    isFiatLoading,
    isPopulateLoadingByKey,
    hasAnyPortfolioData,
  } = usePortfolioAssetRows({
    gainLossMode,
    externalRefreshToken: focusRefreshToken,
  });

  const items = useMemo(() => {
    return visibleItems.slice(0, 4);
  }, [visibleItems]);
  const itemSignature = useMemo(() => {
    return items
      .map(
        item =>
          `${item.key}:${item.fiatAmount}:${item.deltaFiat}:${item.deltaPercent}:${item.showScopedPnlLoading ? '1' : '0'}:${item.showPnlPlaceholder ? '1' : '0'}`,
      )
      .join('|');
  }, [items]);
  const populateLoadingSignature = useMemo(() => {
    return Object.entries(isPopulateLoadingByKey || {})
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, loading]) => `${key}:${loading ? '1' : '0'}`)
      .join('|');
  }, [isPopulateLoadingByKey]);
  const assetsSectionOnLayout = useDevLayoutTrace('HomeAssetsSectionLayout');

  useDevRenderTrace('AssetsSection', {
    gainLossMode,
    focusRefreshToken:
      focusRefreshToken == null ? '' : String(focusRefreshToken),
    populateInProgress: !!portfolio.populateStatus?.inProgress,
    populateWalletsCompleted: portfolio.populateStatus?.walletsCompleted ?? null,
    populateFinishedAt: portfolio.populateStatus?.finishedAt ?? null,
    lastPopulatedAt: portfolio.lastPopulatedAt ?? null,
    visibleItemCount: visibleItems.length,
    renderedItemCount: items.length,
    itemSignature,
    isFiatLoading: !!isFiatLoading,
    populateLoadingSignature,
    hasAnyPortfolioData,
  });

  if (!portfolio.populateStatus?.inProgress && !hasAnyPortfolioData) {
    return null;
  }

  if (!items.length) {
    return null;
  }

  return (
    <Container onLayout={assetsSectionOnLayout}>
      <Header>
        <HomeSectionTitle>{t('Assets')}</HomeSectionTitle>
        <AssetsGainLossDropdown
          value={gainLossMode}
          onChange={setGainLossMode}
        />
      </Header>

      <AssetsList
        items={items}
        isFiatLoading={isFiatLoading}
        populateInProgress={!!portfolio.populateStatus?.inProgress}
        isPopulateLoadingByKey={isPopulateLoadingByKey}
      />

      <ButtonContainer>
        <Button
          buttonStyle="secondary"
          height={50}
          buttonOutline
          testID="home-see-all-assets-button"
          accessibilityLabel="See all assets"
          onPress={() => navigation.navigate('AllAssets')}>
          {t('See All Assets')}
        </Button>
      </ButtonContainer>
    </Container>
  );
};

export default React.memo(AssetsSection);
