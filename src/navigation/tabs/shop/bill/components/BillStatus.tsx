import React from 'react';
import {t} from 'i18next';
import styled from 'styled-components/native';
import {Paragraph} from '../../../../../components/styled/Text';

export type BillStatusString = 'dueSoon' | 'complete';
interface BillStatusProps {
  status: BillStatusString;
}

const statusColors = {
  dueSoon: {
    backgroundColor: '#ffd8de',
    color: '#b51b16',
  },
  complete: {
    backgroundColor: '#CBF3E8',
    color: '#0B754A',
  },
};

const StatusContainer = styled.View<BillStatusProps>`
  background-color: ${({status}) => statusColors[status].backgroundColor}
  border-radius: 6px;
  padding: 0 10px;
`;

const StatusText = styled(Paragraph)<BillStatusProps>`
  color: ${({status}) => statusColors[status].color};
  font-size: 14px;
`;

export default ({status}: BillStatusProps = {status: 'dueSoon'}) => {
  return (
    <StatusContainer status={status}>
      <StatusText status={status}>
        {status === 'dueSoon' ? t('Due in 1 day') : t('Completed')}
      </StatusText>
    </StatusContainer>
  );
};
