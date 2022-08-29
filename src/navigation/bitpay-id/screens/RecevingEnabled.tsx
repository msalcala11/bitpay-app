import React from 'react';
import styled from 'styled-components/native';
import Button from '../../../components/button/Button';
import {Br, HEIGHT} from '../../../components/styled/Containers';
import SuccessSvg from '../../../../assets/img/success.svg';
import {
  BaseText,
  H3,
  Paragraph,
  TextAlign,
} from '../../../components/styled/Text';
import {t} from 'i18next';

const ViewContainer = styled.View`
  padding: 16px;
  flex-direction: column;
  height: ${HEIGHT - 110}px;
`;

const ViewBody = styled.View`
  flex-grow: 1;
  align-items: center;
  justify-content: center;
  padding: 20px;
`;

const EmailContainer = styled.View`
  background-color: rgba(34, 64, 196, 0.35);
  align-items: center;
  height: 48px;
  padding: 0 14px 0 17px;
  border-radius: 48px;
  width: 100%;
  max-width: 300px;
  margin-top: 32px;
  flex-direction: row;
`;

const EmailText = styled(BaseText)`
  font-size: 16px;
  font-weight: 500;
`;

const ReceivingEnabled = () => {
  return (
    <ViewContainer>
      <ViewBody>
        <SuccessSvg height={50} width={50} style={{marginBottom: 24}} />
        <TextAlign align="center">
          <H3>Receiving to BitPay ID has been enabled!</H3>
        </TextAlign>
        <Br />
        <TextAlign align="center">
          <Paragraph>
            Your friends and family can now send you crypto to your BitPay ID.
          </Paragraph>
        </TextAlign>
        <EmailContainer>
          <EmailText style={{flexGrow: 1}}>satoshi@nakamoto.com</EmailText>
          <SuccessSvg height={20} width={20} />
        </EmailContainer>
      </ViewBody>
      <Button buttonStyle={'primary'} onPress={() => console.log('hi')}>
        {t('Go back to settings')}
      </Button>
      <Br />
      <Button
        buttonStyle={'primary'}
        buttonType={'link'}
        onPress={() => console.log('save')}>
        {t('Set up SMS Authentication')}
      </Button>
    </ViewContainer>
  );
};

export default ReceivingEnabled;
