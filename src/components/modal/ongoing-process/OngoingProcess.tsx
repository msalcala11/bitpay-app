import React, {useMemo} from 'react';
import {ActivityIndicator, Dimensions, Platform} from 'react-native';
import styled from 'styled-components/native';
import {LightBlack, SlateDark, White} from '../../../styles/colors';
import {useAppSelector} from '../../../utils/hooks';
import {BlurContainer} from '../../blur/Blur';
import {BaseText} from '../../styled/Text';
import BaseModal from '../base/BaseModal';
import {useOngoingProcess} from '../../../contexts';

export type OnGoingProcessMessages =
  | 'GENERAL_AWAITING'
  | 'CREATING_KEY'
  | 'LOGGING_IN'
  | 'LOGGING_OUT'
  | 'PAIRING'
  | 'CREATING_ACCOUNT'
  | 'UPDATING_ACCOUNT'
  | 'IMPORTING'
  | 'IMPORT_SCANNING_FUNDS'
  | 'DELETING_KEY'
  | 'ADDING_WALLET'
  | 'ADDING_ACCOUNT'
  | 'ADDING_EVM_CHAINS'
  | 'ADDING_SPL_CHAINS'
  | 'LOADING'
  | 'FETCHING_PAYMENT_OPTIONS'
  | 'FETCHING_PAYMENT_INFO'
  | 'JOIN_WALLET'
  | 'SENDING_PAYMENT'
  | 'ACCEPTING_PAYMENT'
  | 'GENERATING_ADDRESS'
  | 'GENERATING_GIFT_CARD'
  | 'SYNCING_WALLETS'
  | 'REJECTING_CALL_REQUEST'
  | 'SAVING_LAYOUT'
  | 'SAVING_ADDRESSES'
  | 'EXCHANGE_GETTING_DATA'
  | 'CALCULATING_FEE'
  | 'CONNECTING_COINBASE'
  | 'FETCHING_COINBASE_DATA'
  | 'UPDATING_TXP'
  | 'CREATING_TXP'
  | 'SENDING_EMAIL'
  | 'REDIRECTING'
  | 'REMOVING_BILL'
  | 'BROADCASTING_TXP'
  | 'SWEEPING_WALLET'
  | 'SCANNING_FUNDS'
  | 'SCANNING_FUNDS_WITH_PASSPHRASE'
  | 'CREATING_PASSKEY'
  | 'DELETING_PASSKEY'
  | 'WAITING_FOR_MAX_AMOUNT';

const Row = styled.View`
  background-color: ${({theme}) => (theme.dark ? LightBlack : White)};
  border-radius: 10px;
  flex-direction: row;
  padding: 20px;
  max-width: 60%;
  padding-right: 47px;
`;

const ActivityIndicatorContainer = styled.View`
  flex-direction: column;
  justify-content: center;
  align-items: center;
  margin-right: 15px;
`;

const Message = styled(BaseText)`
  font-weight: 700;
  flex-wrap: wrap;
  line-height: 22px;
`;

const ModalWrapper = styled.View`
  flex: 1;
  width: 100%;
  align-items: center;
  justify-content: center;
  margin-left: -20px;
`;

const OnGoingProcessModal: React.FC = React.memo(() => {
  const {message, isVisible} = useOngoingProcess();
  const appWasInit = useAppSelector(({APP}) => APP.appWasInit);
  const screenDimensions = Dimensions.get(
    Platform.OS === 'android' ? 'screen' : 'window',
  );
  const deviceHeight = screenDimensions?.height ?? 0;
  const deviceWidth = screenDimensions?.width ?? 0;

  const modalContent = useMemo(
    () => (
      <Row>
        <ActivityIndicatorContainer>
          <ActivityIndicator color={SlateDark} />
        </ActivityIndicatorContainer>
        <Message>{message}</Message>
        <BlurContainer />
      </Row>
    ),
    [message],
  );

  return (
    <BaseModal
      id={'ongoingProcess'}
      deviceHeight={deviceHeight}
      deviceWidth={deviceWidth}
      presentationStyle="overFullScreen"
      isVisible={appWasInit && isVisible}
      backdropOpacity={0.4}
      coverScreen={true}
      statusBarTranslucent={true}
      animationIn={'fadeInRight'}
      animationOut={'fadeOutLeft'}
      backdropTransitionOutTiming={0}
      hideModalContentWhileAnimating={true}
      useNativeDriverForBackdrop={true}
      useNativeDriver={true}>
      <ModalWrapper>{modalContent}</ModalWrapper>
    </BaseModal>
  );
});

export default OnGoingProcessModal;
