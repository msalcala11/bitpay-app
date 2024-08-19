import React, {memo, ReactElement} from 'react';
import {
  Column,
  CurrencyImageContainer,
  CurrencyColumn,
  Row,
  ActiveOpacity,
  RowContainer,
  BadgeContainer,
} from '../styled/Containers';
import {Badge, H5, ListItemSubText} from '../styled/Text';
import styled from 'styled-components/native';
import {CurrencyImage} from '../currency-image/CurrencyImage';
import {BitpaySupportedEvmCoins} from '../../constants/currencies';
import {
  formatCryptoAddress,
  formatCurrencyAbbreviation,
  getProtocolName,
} from '../../utils/helper-methods';
import {ActivityIndicator, Platform, View} from 'react-native';
import {ProgressBlue} from '../../styles/colors';
import Blockie from '../blockie/Blockie';
import {WalletRowProps} from './WalletRow';
import {SearchableItem} from '../chain-search/ChainSearch';

const SpinnerContainer = styled.View`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding-right: 10px;
`;

const BalanceColumn = styled(Column)`
  align-items: flex-end;
`;

export interface AccountRowListBase extends SearchableItem {}

export type AccountRowListProps = AccountRowListBase & AccountRowProps[];
export interface AccountRowProps extends SearchableItem {
  id: string;
  keyId: string;
  copayerId?: string;
  chains: string[];
  wallets: WalletRowProps[];
  accountName: string;
  accountNumber: number;
  receiveAddress: string;
  isMultiNetworkSupported: boolean;
  fiatBalance: number;
  fiatLockedBalance: number;
  fiatConfirmedLockedBalance: number;
  fiatSpendableBalance: number;
  fiatPendingBalance: number;
  fiatBalanceFormat: string;
  fiatLockedBalanceFormat: string;
  fiatConfirmedLockedBalanceFormat: string;
  fiatSpendableBalanceFormat: string;
  fiatPendingBalanceFormat: string;
}

interface Props {
  id: string;
  accountItem: AccountRowProps;
  hideIcon?: boolean;
  isLast?: boolean;
  onPress: () => void;
  hideBalance: boolean;
}

export const buildTestBadge = (
  network: string,
  chain: string,
  isToken: boolean | undefined,
): ReactElement | undefined => {
  if (isToken || ['livenet', 'mainnet'].includes(network)) {
    return;
  }
  // logic for mapping test networks to chain
  const badgeLabel = getProtocolName(chain, network);

  return (
    <BadgeContainer>
      <Badge>{badgeLabel}</Badge>
    </BadgeContainer>
  );
};

export const buildUncompleteBadge = (
  isComplete: boolean | undefined,
): ReactElement | undefined => {
  if (isComplete) {
    return;
  }
  // logic for mapping test networks to chain
  const badgeLabel = 'Incomplete';

  return (
    <BadgeContainer>
      <Badge>{badgeLabel}</Badge>
    </BadgeContainer>
  );
};

const AccountListRow = ({
  accountItem,
  hideIcon,
  onPress,
  isLast,
  hideBalance,
}: Props) => {
  const {
    accountName,
    fiatBalanceFormat,
    receiveAddress,
    wallets,
    isMultiNetworkSupported,
  } = accountItem;
  const {
    currencyAbbreviation,
    isToken,
    network,
    multisig,
    isComplete,
    isScanning,
    cryptoBalance,
    chain,
  } = wallets[0];

  const _currencyAbbreviation =
    formatCurrencyAbbreviation(currencyAbbreviation);

  // @ts-ignore
  const showFiatBalance = Number(cryptoBalance.replaceAll(',', '')) > 0;

  return (
    <RowContainer
      activeOpacity={ActiveOpacity}
      onPress={onPress}
      style={{borderBottomWidth: isLast || !hideIcon ? 0 : 1}}>
      {!hideIcon ? (
        <CurrencyImageContainer>
          {isMultiNetworkSupported ? (
            <Blockie size={40} seed={receiveAddress} />
          ) : (
            <CurrencyImage
              img={wallets[0].img}
              badgeUri={wallets[0].badgeImg}
              size={40}
            />
          )}
        </CurrencyImageContainer>
      ) : null}
      {isMultiNetworkSupported ? (
        <H5 ellipsizeMode="tail" numberOfLines={1}>
          {accountName}
        </H5>
      ) : (
        <CurrencyColumn>
          <Row>
            <H5 ellipsizeMode="tail" numberOfLines={1}>
              {accountName}
            </H5>
          </Row>
          <Row style={{alignItems: 'center'}}>
            <ListItemSubText
              ellipsizeMode="tail"
              numberOfLines={1}
              style={{marginTop: Platform.OS === 'ios' ? 2 : 0}}>
              {`${_currencyAbbreviation} ${multisig ? multisig : ''}`}
            </ListItemSubText>
            {buildTestBadge(network, chain, isToken)}
            {buildUncompleteBadge(isComplete)}
          </Row>
        </CurrencyColumn>
      )}
      {isMultiNetworkSupported ? (
        <BalanceColumn>
          {!hideBalance ? (
            <H5 numberOfLines={1} ellipsizeMode="tail">
              {fiatBalanceFormat}
            </H5>
          ) : (
            <H5>****</H5>
          )}
        </BalanceColumn>
      ) : !isScanning ? (
        <BalanceColumn>
          {!hideBalance ? (
            <>
              <H5 numberOfLines={1} ellipsizeMode="tail">
                {cryptoBalance}
              </H5>
              {showFiatBalance && (
                <ListItemSubText textAlign={'right'}>
                  {network === 'testnet'
                    ? 'Test - No Value'
                    : fiatBalanceFormat}
                </ListItemSubText>
              )}
            </>
          ) : (
            <H5>****</H5>
          )}
        </BalanceColumn>
      ) : (
        <SpinnerContainer>
          <ActivityIndicator color={ProgressBlue} />
        </SpinnerContainer>
      )}
    </RowContainer>
  );
};

export default memo(AccountListRow);
