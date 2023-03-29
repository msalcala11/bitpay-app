import React from 'react';
import {t} from 'i18next';
import styled from 'styled-components/native';
import {Paragraph} from '../../../../../components/styled/Text';

interface BillStatusProps {}

const StatusContainer = styled.View`
  background-color: #ffd8de;
  border-radius: 6px;
  padding: 0 10px;
`;

const StatusText = styled(Paragraph)`
  color: #b51b16;
  font-size: 14px;
`;

export default ({}: BillStatusProps) => {
  return (
    <StatusContainer>
      <StatusText>{t('Due in 1 day')}</StatusText>
    </StatusContainer>
  );
};
