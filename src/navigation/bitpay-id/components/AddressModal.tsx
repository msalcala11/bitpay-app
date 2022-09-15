import React, {useEffect} from 'react';
import Modal from 'react-native-modal';
import {useDispatch} from 'react-redux';
import styled from 'styled-components/native';
import {
  ActionContainer,
  ScreenGutter,
  WIDTH,
} from '../../../components/styled/Containers';
import {BitPay, LightBlack, White} from '../../../styles/colors';
import Button from '../../../components/button/Button';
import {HeaderTitle, Paragraph} from '../../../components/styled/Text';
import {useTranslation} from 'react-i18next';
import {ReceivingAddress} from '../../../store/bitpay-id/bitpay-id.models';

const ModalContainer = styled.View`
  justify-content: center;
  width: ${WIDTH - 30}px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : White)};
  border-radius: 10px;
  padding: ${ScreenGutter};
`;

const AddressContainer = styled.View`
  background-color: #eceffd;
  border-radius: 8px;
  margin: 20px 0;
  padding: 12px;
  flex-direction: row;
`;

const AddressTextContainer = styled.View`
  flex-shrink: 1;
`;
const AddressText = styled(Paragraph)`
  color: ${BitPay};
  font-size: 12px;
  line-height: 16px;
  letter-spacing: -0.5px;
`;

const CopyContainer = styled.View`
  width: 40px;
  border-left-width: 1px;
  border-left-color: rgba(34, 64, 196, 0.25);
  height: 100%;
  flex-shrink: 0;
  margin-left: 12px;
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
  const {t} = useTranslation();
  const dispatch = useDispatch();

  return (
    <Modal
      isVisible={isVisible}
      backdropOpacity={0.4}
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
        <HeaderTitle>{receivingAddress?.label}</HeaderTitle>
        <AddressContainer>
          <AddressTextContainer>
            <AddressText>{receivingAddress?.address}</AddressText>
          </AddressTextContainer>
          <CopyContainer></CopyContainer>
        </AddressContainer>
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
