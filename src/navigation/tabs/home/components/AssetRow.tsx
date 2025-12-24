import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {BaseText, H7} from '../../../../components/styled/Text';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {
  LightBlack,
  LightBlue,
  Slate30,
  SlateDark,
  White,
} from '../../../../styles/colors';
import {getDifferenceColor} from '../../../../components/percentage/Percentage';
import ChevronRightSvg from './ChevronRightSvg';
import {AssetRowItem} from './AssetsMockData';

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

interface Props {
  item: AssetRowItem;
  isLast: boolean;
  onPress?: () => void;
}

const AssetRow: React.FC<Props> = ({item, isLast, onPress}) => {
  const option = useMemo(() => {
    return SupportedCurrencyOptions.find(o => {
      return o.currencyAbbreviation === item.currencyAbbreviation && o.chain === item.chain;
    });
  }, [item.chain, item.currencyAbbreviation]);

  return (
    <Row
      activeOpacity={ActiveOpacity}
      isLast={isLast}
      onPress={onPress || (() => {})}>
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
        <PercentText isPositive={item.isPositive}>{item.deltaPercent}</PercentText>
      </PercentPill>

      <ChevronRightSvg width={9} height={15} gray />
    </Row>
  );
};

export default AssetRow;
