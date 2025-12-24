import React from 'react';
import styled from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {BaseText} from '../../../../components/styled/Text';
import {Slate30, SlateDark, White} from '../../../../styles/colors';
import ChevronDown from './ChevronDown';

const Container = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  border-radius: 50px;
  padding: 10px 14px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
`;

const Label = styled(BaseText)`
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 15px;
  margin-right: 10px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

interface Props {
  label?: string;
  onPress?: () => void;
}

const AssetsGainLossDropdown: React.FC<Props> = ({
  label = "Today’s Gain/Loss",
  onPress,
}) => {
  return (
    <Container activeOpacity={ActiveOpacity} onPress={onPress || (() => {})}>
      <Label>{label}</Label>
      <ChevronDown />
    </Container>
  );
};

export default AssetsGainLossDropdown;
