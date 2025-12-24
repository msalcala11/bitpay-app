import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {useNavigation} from '@react-navigation/native';
import {
  ScreenGutter,
} from '../../../../components/styled/Containers';
import Button from '../../../../components/button/Button';
import {HomeSectionTitle} from './Styled';
import AssetsList from './AssetsList';
import {AssetRowItem, getAssetsSectionMockItems} from './AssetsMockData';
import AssetsGainLossDropdown from './AssetsGainLossDropdown';

const Container = styled.View`margin-bottom: 30px;`;

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
  const items: AssetRowItem[] = useMemo(
    () => getAssetsSectionMockItems(),
    [],
  );

  return (
    <Container>
      <Header>
        <HomeSectionTitle>Assets</HomeSectionTitle>
        <AssetsGainLossDropdown onPress={() => {}} />
      </Header>

      <AssetsList items={items} />

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
