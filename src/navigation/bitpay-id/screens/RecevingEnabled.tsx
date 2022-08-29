import React from 'react';
import styled from 'styled-components/native';
import Button from '../../../components/button/Button';
import {Br, HEIGHT} from '../../../components/styled/Containers';
import {H3, Paragraph, TextAlign} from '../../../components/styled/Text';
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

const ReceivingEnabled = () => {
  return (
    <ViewContainer>
      <ViewBody>
        <TextAlign align="center">
          <H3>Receiving to BitPay ID has been enabled!</H3>
        </TextAlign>
        <Br />
        <TextAlign align="center">
          <Paragraph>
            Your friends and family can now send you crypto to your BitPay ID.
          </Paragraph>
        </TextAlign>
        <Br />
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
