import React, {useState} from 'react';
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
import usePortfolioAssetRows from '../hooks/usePortfolioAssetRows';

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
  const populateInProgress = !!portfolio.populateStatus?.inProgress;
  const {
    visibleItems,
    isFiatLoading,
    isPnlLoading,
    isPopulateLoadingByKey,
    hasAnyPortfolioData,
  } = usePortfolioAssetRows({
    gainLossMode,
    maxVisibleItems: 4,
  });

  const items = visibleItems;

  const showSkeletonRows =
    !items.length && (populateInProgress || isFiatLoading || isPnlLoading);

  if (!populateInProgress && !hasAnyPortfolioData && !showSkeletonRows) {
    return null;
  }

  if (!items.length && !showSkeletonRows) {
    return null;
  }

  return (
    <Container>
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
        isPnlLoading={isPnlLoading}
        populateInProgress={populateInProgress}
        isPopulateLoadingByKey={isPopulateLoadingByKey}
        showSkeletonRows={showSkeletonRows}
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

export default AssetsSection;
