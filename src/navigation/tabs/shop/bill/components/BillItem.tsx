import React from 'react';
import {Image, View} from 'react-native';
import styled from 'styled-components/native';
import {H6, Paragraph} from '../../../../../components/styled/Text';
import {SlateDark} from '../../../../../styles/colors';
import {BaseText} from '../../../../wallet/components/KeyDropdownOption';

const ItemContainer = styled.View`
  border-radius: 8px;
  border: 1px solid #e1e4e7;
  height: 116px;
  padding: 16px;
`;

const AccountType = styled(Paragraph)`
  font-size: 14px;
  color: ${SlateDark};
  margin-top: -5px;
`;

const AccountDetails = styled.View`
  flex-direction: row;
  align-items: center;
  flex-grow: 1;
`;

const AccountBody = styled.View`
  flex-direction: row;
`;

const AccountBalance = styled(BaseText)`
  font-size: 20px;
`;

interface BillItemProps {
  variation: 'small' | 'large';
}

export default ({variation}: BillItemProps = {variation: 'large'}) => {
  const merchantIcon = 'https://static.methodfi.com/mch_logos/mch_300485.png';
  return (
    <ItemContainer>
      <AccountBody>
        <AccountDetails>
          <Image
            style={{height: 30, width: 30, marginRight: 8, marginTop: -4}}
            resizeMode={'contain'}
            source={{uri: merchantIcon}}
          />
          <View>
            <H6>AT&T</H6>
            <AccountType>Cell Phone</AccountType>
          </View>
        </AccountDetails>
        <AccountBalance>$103.64</AccountBalance>
      </AccountBody>
    </ItemContainer>
  );
};
