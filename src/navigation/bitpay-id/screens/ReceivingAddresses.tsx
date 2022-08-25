import React from 'react';
import styled from 'styled-components/native';
import {View} from 'react-native';
import {Br} from '../../../components/styled/Containers';
import {H3, H5, Paragraph} from '../../../components/styled/Text';
import {BaseText} from '../../wallet/components/KeyDropdownOption';
import {LightBlack, Slate} from '../../../styles/colors';
import ChevronRightSvg from '../../../../assets/img/angle-right.svg';
import AddSvg from '../../../../assets/img/add.svg';
import {TouchableOpacity} from 'react-native-gesture-handler';

const AddressItem = styled.View`
  align-items: center;
  border: 0.75px solid ${Slate};
  border-radius: 8px;
  flex-direction: row;
  padding: 12px 15px;
  margin-top: 10px;
`;

const AddressItemText = styled(Paragraph)`
  flex-grow: 1;
  margin-left: 8px;
`;

const AddButton = styled.View`
  height: 30px;
  width: 30px;
  background-color: ${LightBlack};
  border-radius: 8px;
  align-items: center;
  justify-content: center;
`;

const ReceivingAddresses = () => (
  <View style={{padding: 16}}>
    <H3>Choose your BitPay ID Receiving Addresses</H3>
    <Br />
    <Paragraph>
      Decide what wallets you would like to receive to when a friend sends
      crypto to your email address. Each incoming payment will be sent to a
      newly generated address.
    </Paragraph>
    <Br />
    <H5>Receiving Addresses</H5>
    <TouchableOpacity activeOpacity={0.8}>
      <AddressItem>
        <AddressItemText>
          Select a <BaseText style={{fontSize: 16}}>BTC Wallet</BaseText>
        </AddressItemText>
        <ChevronRightSvg height={16} />
      </AddressItem>
    </TouchableOpacity>
    <TouchableOpacity activeOpacity={0.8}>
      <AddressItem>
        <AddressItemText>
          Select a <BaseText style={{fontSize: 16}}>BCH Wallet</BaseText>
        </AddressItemText>
        <ChevronRightSvg height={16} />
      </AddressItem>
    </TouchableOpacity>
    <TouchableOpacity activeOpacity={0.8}>
      <AddressItem>
        <AddressItemText>
          Select a <BaseText style={{fontSize: 16}}>ETH Wallet</BaseText>
        </AddressItemText>
        <ChevronRightSvg height={16} />
      </AddressItem>
    </TouchableOpacity>
    <TouchableOpacity activeOpacity={0.8}>
      <AddressItem>
        <AddButton>
          <AddSvg />
        </AddButton>
        <AddressItemText>Add Wallet</AddressItemText>
        <ChevronRightSvg height={16} />
      </AddressItem>
    </TouchableOpacity>
  </View>
);

export default ReceivingAddresses;
