import React from 'react';
import styled, {useTheme} from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import Button from '../../../../components/button/Button';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../../components/styled/Containers';
import {BaseText, H7} from '../../../../components/styled/Text';
import {CurrencyListIcons} from '../../../../constants/SupportedCurrencyOptions';
import ChevronRightSvg from './ChevronRightSvg';
import ChevronDownLight from '../../../../../assets/img/chevron-down-lightmode.svg';
import ChevronDownDark from '../../../../../assets/img/chevron-down-darkmode.svg';
import {
  Caution,
  LightBlack,
  LightBlue,
  Slate30,
  SlateDark,
  Success,
} from '../../../../styles/colors';
import {HomeSectionTitle} from './Styled';

const AssetsContainer = styled.View`
  margin: 8px 0 2px;
`;

const HeaderRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 0 ${ScreenGutter} 8px;
`;

const FilterPill = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 18px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background: ${({theme: {dark}}) => (dark ? LightBlack : 'transparent')};
`;

const FilterLabel = styled(BaseText)`
  font-size: 13px;
  font-weight: 500;
  color: ${({theme}) => theme.colors.text};
`;

const ListContainer = styled.View`
  margin: 0 ${ScreenGutter} 4px;
`;

const AssetRow = styled(TouchableOpacity)<{isLast?: boolean}>`
  flex-direction: row;
  align-items: center;
  padding: 12px 0;
  border-bottom-width: ${({isLast}) => (isLast ? 0 : 1)}px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : LightBlue)};
`;

const IconWrapper = styled.View`
  width: 44px;
  height: 44px;
  justify-content: center;
  align-items: center;
  margin-right: 8px;
`;

const AssetInfo = styled.View`
  flex: 1;
`;

const AssetName = styled(H7)`
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
`;

const AssetAmount = styled(BaseText)`
  font-size: 13px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const ValueColumn = styled.View`
  align-items: flex-end;
  justify-content: center;
  gap: 6px;
`;

const PriceText = styled(BaseText)`
  font-size: 16px;
  font-weight: 500;
`;

const ChangeRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 8px;
`;

const ChangeText = styled(BaseText)<{positive?: boolean}>`
  font-size: 13px;
  font-weight: 500;
  color: ${({positive}) => (positive ? Success : Caution)};
`;

const PercentPill = styled.View<{positive?: boolean}>`
  padding: 5px 10px;
  border-radius: 18px;
  border: 1px solid ${({positive}) => (positive ? Success : Caution)};
  background-color: ${({positive}) =>
    positive ? 'rgba(47, 207, 164, 0.1)' : 'rgba(181, 27, 22, 0.08)'};
`;

const PercentText = styled(BaseText)<{positive?: boolean}>`
  font-size: 13px;
  font-weight: 600;
  color: ${({positive}) => (positive ? Success : Caution)};
`;

const ArrowContainer = styled.View`
  margin-left: 12px;
`;

const FooterButtonContainer = styled.View`
  margin: 14px ${ScreenGutter} 6px;
`;

const assetsData = [
  {
    id: 'btc',
    name: 'Bitcoin',
    ticker: 'BTC',
    amount: '0.56748',
    price: '$52,458.18',
    changeValue: '-$1,267.15',
    changePercent: '-12.1%',
    positive: false,
    icon: CurrencyListIcons.btc,
  },
  {
    id: 'eth',
    name: 'ETH',
    ticker: 'ETH',
    amount: '0.56748',
    price: '$52,458.18',
    changeValue: '+$1,267.14',
    changePercent: '+12.1%',
    positive: true,
    icon: CurrencyListIcons.eth,
  },
  {
    id: 'xrp',
    name: 'XRP',
    ticker: 'XRP',
    amount: '0.56748',
    price: '$52,458.18',
    changeValue: '-$1,267.15',
    changePercent: '-12.1%',
    positive: false,
    icon: CurrencyListIcons.xrp,
  },
  {
    id: 'usdc',
    name: 'USDC',
    ticker: 'USDC',
    amount: '0.56748',
    price: '$52,458.18',
    changeValue: '+$1,267.14',
    changePercent: '+12.1%',
    positive: true,
    icon: CurrencyListIcons.usdc_e,
  },
];

const Assets = () => {
  const theme = useTheme();
  const ChevronDown = theme.dark ? ChevronDownDark : ChevronDownLight;

  return (
    <AssetsContainer>
      <HeaderRow>
        <HomeSectionTitle>Assets</HomeSectionTitle>
        <FilterPill activeOpacity={ActiveOpacity}>
          <FilterLabel>Today’s Gain/Loss</FilterLabel>
          <ChevronDown width={12} height={8} />
        </FilterPill>
      </HeaderRow>
      <ListContainer>
        {assetsData.map((asset, index) => (
          <AssetRow
            key={asset.id}
            activeOpacity={ActiveOpacity}
            isLast={index === assetsData.length - 1}>
            <IconWrapper>
              <CurrencyImage img={asset.icon} size={40} />
            </IconWrapper>
            <AssetInfo>
              <AssetName numberOfLines={1}>{asset.ticker}</AssetName>
              <AssetAmount numberOfLines={1}>{asset.amount}</AssetAmount>
            </AssetInfo>
            <ValueColumn>
              <PriceText>{asset.price}</PriceText>
              <ChangeRow>
                <ChangeText positive={asset.positive}>
                  {asset.changeValue}
                </ChangeText>
                <PercentPill positive={asset.positive}>
                  <PercentText positive={asset.positive}>
                    {asset.changePercent}
                  </PercentText>
                </PercentPill>
              </ChangeRow>
            </ValueColumn>
            <ArrowContainer>
              <ChevronRightSvg />
            </ArrowContainer>
          </AssetRow>
        ))}
      </ListContainer>
      <FooterButtonContainer>
        <Button
          buttonStyle={'secondary'}
          height={58}
          onPress={() => {}}>
          See All Assets
        </Button>
      </FooterButtonContainer>
    </AssetsContainer>
  );
};

export default Assets;
