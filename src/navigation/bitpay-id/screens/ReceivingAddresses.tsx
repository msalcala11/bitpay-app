import React from 'react';
import styled from 'styled-components/native';
import {View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import {Br, HEIGHT} from '../../../components/styled/Containers';
import {CurrencyListIcons} from '../../../constants/SupportedCurrencyOptions';
import {H3, H5, Paragraph} from '../../../components/styled/Text';
import {BaseText} from '../../wallet/components/KeyDropdownOption';
import {LightBlack, Slate, Slate10, Slate30} from '../../../styles/colors';
import AddSvg from '../../../../assets/img/add.svg';
import AddWhiteSvg from '../../../../assets/img/add-white.svg';
import {TouchableOpacity} from 'react-native-gesture-handler';
import Button from '../../../components/button/Button';
import {t} from 'i18next';
import ChevronRight from '../components/ChevronRight';

const AddressItem = styled.View`
  align-items: center;
  border: 0.75px solid ${Slate};
  border-color: ${({theme: {dark}}) => (dark ? Slate : Slate30)};
  border-radius: 8px;
  flex-direction: row;
  padding: 12px 15px;
  margin-top: 10px;
  padding-left: 2px;
`;

const AddressItemText = styled(Paragraph)`
  flex-grow: 1;
  margin-left: 0px;
`;

const AddButton = styled.View`
  height: 30px;
  width: 30px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Slate10)};
  border-radius: 8px;
  align-items: center;
  justify-content: center;
  margin-left: 11px;
  margin-right: 9px;
`;

const ReceivingAddresses = () => {
  const theme = useTheme();
  return (
    <View style={{padding: 16, flexDirection: 'column', height: HEIGHT - 110}}>
      <View style={{flexGrow: 1}}>
        <H3>Choose your BitPay ID Receiving Addresses</H3>
        <Br />
        <Paragraph>
          Decide what wallets you would like to receive to when a friend sends
          crypto to your email address. Each incoming payment will be sent to a
          newly generated address.
        </Paragraph>
        <Br />
        <Br />
        <H5>Receiving Addresses</H5>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {CurrencyListIcons.btc({height: 25})}
            <AddressItemText>
              Select a <BaseText style={{fontSize: 16}}>BTC Wallet</BaseText>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {CurrencyListIcons.bch({height: 25})}
            <AddressItemText>
              Select a <BaseText style={{fontSize: 16}}>BCH Wallet</BaseText>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {CurrencyListIcons.eth({height: 25})}
            <AddressItemText>
              Select a <BaseText style={{fontSize: 16}}>ETH Wallet</BaseText>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            <AddButton>{theme.dark ? <AddWhiteSvg /> : <AddSvg />}</AddButton>
            <AddressItemText>Add Wallet</AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
      </View>
      <Button buttonStyle={'primary'} onPress={() => console.log('save')}>
        {t('Save Defaults')}
      </Button>
      <Button
        buttonStyle={'primary'}
        buttonType={'link'}
        onPress={() => console.log('save')}>
        {t('Add Custom Address')}
      </Button>
    </View>
  );
};

export default ReceivingAddresses;
