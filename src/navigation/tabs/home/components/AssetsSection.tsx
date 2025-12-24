import React, {useMemo} from 'react';
import styled, {useTheme} from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../../components/styled/Containers';
import {BaseText, H7} from '../../../../components/styled/Text';
import Button from '../../../../components/button/Button';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {
  LightBlack,
  LightBlue,
  Slate30,
  SlateDark,
  White,
} from '../../../../styles/colors';
import {HomeSectionTitle} from './Styled';
import ChevronRightSvg from './ChevronRightSvg';
import {getDifferenceColor} from '../../../../components/percentage/Percentage';
import ChevronDown from './ChevronDown';

type AssetRowItem = {
  key: string;
  currencyAbbreviation: string;
  chain: string;
  name: string;
  cryptoAmount: string;
  fiatAmount: string;
  deltaFiat: string;
  deltaPercent: string;
  isPositive: boolean;
};

const Container = styled.View`margin-bottom: 15px;`;

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 0 ${ScreenGutter} 0 16px;
`;

const Dropdown = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  border-radius: 50px;
  padding: 10px 14px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
`;

const DropdownText = styled(BaseText)`
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 15px;
  margin-right: 10px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

const Row = styled(TouchableOpacity)<{isLast: boolean}>`
  flex-direction: row;
  align-items: center;
  padding: 14px 0;
  border-bottom-width: ${({isLast}) => (isLast ? 0 : 1)}px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : LightBlue)};
`;

const IconContainer = styled.View`
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
`;

const AssetInfo = styled.View`
  flex: 1;
  justify-content: center;
`;

const AssetName = styled(BaseText)`
  font-size: 13px;
  font-weight: 400;
  color: ${({theme}) => theme.colors.text};
`;

const AssetAmount = styled(H7)`
  margin-top: 2px;
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const Values = styled.View`
  align-items: flex-end;
  justify-content: center;
  margin-right: 12px;
`;

const FiatAmount = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme}) => theme.colors.text};
`;

const DeltaFiat = styled(BaseText)<{isPositive: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive}) => getDifferenceColor(isPositive, dark)};
`;

const PercentPill = styled.View`
  border-radius: 50px;
  padding: 8px 10px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
  margin-right: 14px;
`;

const PercentText = styled(BaseText)<{isPositive: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive}) => getDifferenceColor(isPositive, dark)};
`;

const ButtonContainer = styled.View`
  margin: 0px ${ScreenGutter} 0;
`;

const AssetsSection: React.FC = () => {
  const theme = useTheme();
  const items: AssetRowItem[] = useMemo(
    () => [
      {
        key: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        name: 'BTC',
        cryptoAmount: '0.56748',
        fiatAmount: '$52,458.18',
        deltaFiat: '-$1,267.15',
        deltaPercent: '-12.1%',
        isPositive: false,
      },
      {
        key: 'eth',
        currencyAbbreviation: 'eth',
        chain: 'eth',
        name: 'ETH',
        cryptoAmount: '0.56748',
        fiatAmount: '$52,458.18',
        deltaFiat: '+$1,267.14',
        deltaPercent: '+12.1%',
        isPositive: true,
      },
      {
        key: 'xrp',
        currencyAbbreviation: 'xrp',
        chain: 'xrp',
        name: 'XRP',
        cryptoAmount: '0.56748',
        fiatAmount: '$52,458.18',
        deltaFiat: '-$1,267.15',
        deltaPercent: '-12.1%',
        isPositive: false,
      },
      {
        key: 'usdc',
        currencyAbbreviation: 'usdc',
        chain: 'eth',
        name: 'USDC',
        cryptoAmount: '0.56748',
        fiatAmount: '$52,458.18',
        deltaFiat: '+$1,267.14',
        deltaPercent: '+12.1%',
        isPositive: true,
      },
    ],
    [],
  );

  return (
    <Container>
      <Header>
        <HomeSectionTitle>Assets</HomeSectionTitle>
        <Dropdown activeOpacity={ActiveOpacity} onPress={() => {}}>
          <DropdownText>Today’s Gain/Loss</DropdownText>
          <ChevronDown />
        </Dropdown>
      </Header>

      <List>
        {items.map((item, index) => {
          const option = SupportedCurrencyOptions.find(o => {
            return (
              o.currencyAbbreviation === item.currencyAbbreviation &&
              o.chain === item.chain
            );
          });

          return (
            <Row
              key={item.key}
              activeOpacity={ActiveOpacity}
              onPress={() => {}}
              isLast={index === items.length - 1}>
              <IconContainer>
                <CurrencyImage
                  img={option?.img}
                  imgSrc={option?.imgSrc as unknown as number}
                  size={40}
                />
              </IconContainer>

              <AssetInfo>
                <AssetName numberOfLines={1} ellipsizeMode="tail">
                  {item.name}
                </AssetName>
                <AssetAmount>{item.cryptoAmount}</AssetAmount>
              </AssetInfo>

              <Values>
                <FiatAmount>{item.fiatAmount}</FiatAmount>
                <DeltaFiat isPositive={item.isPositive}>{item.deltaFiat}</DeltaFiat>
              </Values>

              <PercentPill>
                <PercentText isPositive={item.isPositive}>
                  {item.deltaPercent}
                </PercentText>
              </PercentPill>

              <ChevronRightSvg width={9} height={15} gray />
            </Row>
          );
        })}
      </List>

      <ButtonContainer>
        <Button buttonStyle="secondary" height={50} buttonOutline onPress={() => {}}>
          See All Assets
        </Button>
      </ButtonContainer>
    </Container>
  );
};

export default AssetsSection;
