import React from 'react';
import styled from 'styled-components/native';
import {Action, White} from '../../styles/colors';
import {BaseText} from '../styled/Text';
import ProfileIcon from './ProfileIcon';

export interface AvatarProps {
  size: number;
  initials?: string;
  badge?: () => JSX.Element | null;
}

interface InitialsProps {
  size?: number;
  initials: string;
}

const AvatarContainer = styled.View`
  position: relative;
`;

const BadgeContainer = styled.View<{size: number}>`
  position: absolute;
  height: ${({size}) => size}px;
  width: ${({size}) => size}px;
  right: 0;
  bottom: 0;
`;

const InitialsCircle = styled.View`
  background-color: ${Action};
  height: ${77}px;
  width: ${77}px;
  border-radius: 50px;
  align-items: center;
  justify-content: center;
`;

const InitialsText = styled(BaseText)`
  color: ${White};
  font-size: 32px;
  font-weight: 500;
`;

const Initials: React.FC<InitialsProps> = ({initials}) => {
  return (
    <InitialsCircle>
      <InitialsText>{(initials || '').substring(0, 2)}</InitialsText>
    </InitialsCircle>
  );
};

export const Avatar: React.FC<AvatarProps> = props => {
  const {initials = '', size = 35, badge} = props;

  return (
    <AvatarContainer>
      {initials.length ? (
        <Initials size={size} initials={initials} />
      ) : (
        <ProfileIcon size={size} />
      )}

      {badge ? (
        <BadgeContainer size={size * 0.35}>{badge()}</BadgeContainer>
      ) : null}
    </AvatarContainer>
  );
};

export default Avatar;
