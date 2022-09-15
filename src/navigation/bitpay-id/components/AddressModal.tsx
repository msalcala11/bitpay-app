import React, {useEffect, useState} from 'react';
import Modal from 'react-native-modal';
import styled, {useTheme} from 'styled-components/native';
import {ActionContainer, WIDTH} from '../../../components/styled/Containers';
import {
  BitPay,
  Black,
  LightBlack,
  Midnight,
  Slate30,
  White,
} from '../../../styles/colors';
import Button from '../../../components/button/Button';
import {HeaderTitle, Paragraph} from '../../../components/styled/Text';
import {useTranslation} from 'react-i18next';
import {ReceivingAddress} from '../../../store/bitpay-id/bitpay-id.models';
import CopySvg from '../../../../assets/img/copy.svg';
import CopiedSvg from '../../../../assets/img/copied-success.svg';
import {CurrencyListIcons} from '../../../constants/SupportedCurrencyOptions';

const ModalContainer = styled.View`
  justify-content: center;
  width: ${WIDTH - 30}px;
  background-color: ${({theme: {dark}}) => (dark ? Black : White)};
  border-radius: 10px;
  padding: 22px 24px;
  overflow: hidden;
`;

const HeaderContainer = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: 11px;
  margin-left: -9px;
`;

const AddressContainer = styled.View`
  background-color: ${({theme: {dark}}) => (dark ? Midnight : '#eceffd')};
  border-radius: 8px;
  margin: 0;
  flex-direction: row;
  padding: 12px;
  padding-right: 1px;
`;

const AddressTextContainer = styled.View`
  flex-shrink: 1;
  border-right-width: 1px;
  border-right-color: ${({theme: {dark}}) =>
    dark ? 'rgba(73, 137, 255, 0.25)' : 'rgba(34, 64, 196, 0.25)'};
  padding-right: 12px;
  min-height: 20px;
  flex-direction: row;
  align-items: center;
`;
const AddressText = styled(Paragraph)`
  color: ${({theme: {dark}}) => (dark ? White : BitPay)};
  font-size: 12px;
  line-height: 16px;
  letter-spacing: -0.5px;
`;

const CopyContainer = styled.TouchableOpacity`
  width: 50px;
  height: 100%;
  flex-shrink: 0;
  align-items: center;
  flex-direction: row;
  justify-content: center;
`;

const Divider = styled.View`
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Slate30)};
  height: 1px;
  margin: 24px -24px 19px;
`;

const AddressModal = ({
  isVisible,
  onClose,
  receivingAddress,
}: {
  isVisible: boolean;
  onClose: () => void;
  receivingAddress?: ReceivingAddress;
}) => {
  const theme = useTheme();
  const {t} = useTranslation();

  const [copied, setCopied] = useState(false);
  const CurrencyIcon =
    CurrencyListIcons[receivingAddress?.currency.toLowerCase() || ''];

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => {
      setCopied(false);
    }, 3000);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Modal
      isVisible={isVisible}
      backdropOpacity={theme.dark ? 0.8 : 0.6}
      backdropColor={theme.dark ? LightBlack : Black}
      animationIn={'fadeInUp'}
      animationOut={'fadeOutDown'}
      backdropTransitionOutTiming={0}
      hideModalContentWhileAnimating={true}
      useNativeDriverForBackdrop={true}
      useNativeDriver={true}
      onBackdropPress={() => onClose()}
      style={{
        alignItems: 'center',
      }}>
      <ModalContainer>
        <HeaderContainer>
          {receivingAddress ? <CurrencyIcon height={30} /> : null}
          <HeaderTitle>{receivingAddress?.label}</HeaderTitle>
        </HeaderContainer>
        <AddressContainer>
          <AddressTextContainer>
            <AddressText>{receivingAddress?.address}</AddressText>
          </AddressTextContainer>
          <CopyContainer onPress={() => setCopied(true)}>
            {copied ? <CopiedSvg /> : <CopySvg />}
          </CopyContainer>
        </AddressContainer>
        <Divider />
        <ActionContainer>
          <Button onPress={() => console.log('continue')}>
            {t('Remove Address')}
          </Button>
        </ActionContainer>
        <ActionContainer>
          <Button onPress={() => onClose()} buttonStyle={'secondary'}>
            {t('Close')}
          </Button>
        </ActionContainer>
      </ModalContainer>
    </Modal>
  );
};

export default AddressModal;
