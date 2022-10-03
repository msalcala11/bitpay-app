import React, {ReactElement} from 'react';
import styled from 'styled-components/native';

import Avatar from '../../../../components/avatar/Avatar';

import {CurrencyListIcons} from '../../../../constants/SupportedCurrencyOptions';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {SUPPORTED_CURRENCIES} from '../../../../constants/currencies';
import {useAppSelector} from '../../../../utils/hooks';
import {RootState} from '../../../../store';
import {BitpaySupportedEthereumTokenOpts} from '../../../../constants/tokens';
import {Token} from '../../../../store/wallet/wallet.models';
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';

interface ContactIconProps {
  size?: number;
  name?: string;
  coin?: string;
  chain: string;
}

interface BadgeProps {
  img: string | ((props?: any) => ReactElement);
  size?: number;
}

const ContactIconContainer = styled.View`
  position: relative;
`;

const CoinBadgeContainer = styled.View`
  position: absolute;
  right: -13px;
  bottom: -1px;
`;

const CoinBadge: React.FC<BadgeProps> = ({size = 20, img}) => {
  return (
    <CoinBadgeContainer>
      <CurrencyImage img={img} size={size} />
    </CoinBadgeContainer>
  );
};

const ContactIcon: React.FC<ContactIconProps> = ({
  coin,
  chain,
  size = 50,
  name,
}) => {
  const tokenOptions = useAppSelector(({WALLET}: RootState) => {
    return {
      ...BitpaySupportedEthereumTokenOpts,
      ...WALLET.tokenOptions,
      ...WALLET.customTokenOptions,
    };
  }) as {[key in string]: Token};

  const img =
    coin &&
    chain &&
    (SUPPORTED_CURRENCIES.includes(coin)
      ? CurrencyListIcons[coin]
      : tokenOptions &&
        tokenOptions[getCurrencyAbbreviation(coin, chain)] &&
        tokenOptions[getCurrencyAbbreviation(coin, chain)]?.logoURI
      ? (tokenOptions[getCurrencyAbbreviation(coin, chain)].logoURI as string)
      : '');

  const badge = img ? <CoinBadge size={size / 2.5} img={img} /> : null;
  const initials = name
    ? name
        .trim()
        .split(' ')
        .map(n => n.charAt(0))
        .join('')
        .toUpperCase()
    : '';

  return (
    <ContactIconContainer>
      <Avatar size={size} initials={initials} badge={() => badge} />
    </ContactIconContainer>
  );
};

export default ContactIcon;
