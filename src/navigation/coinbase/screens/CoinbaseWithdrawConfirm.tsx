import React, {useState, useEffect} from 'react';
import {Alert} from 'react-native';
import {useNavigation, useRoute} from '@react-navigation/native';
import {RouteProp} from '@react-navigation/core';
import {useSelector} from 'react-redux';
import {RootState} from '../../../store';
import {useAppDispatch} from '../../../utils/hooks';
import {Wallet} from '../../../store/wallet/wallet.models';
import SwipeButton from '../../../components/swipe-button/SwipeButton';
import PaymentSent from '../../wallet/components/PaymentSent';
import {sleep} from '../../../utils/helper-methods';
import {startOnGoingProcessModal} from '../../../store/app/app.effects';
import {OnGoingProcessMessages} from '../../../components/modal/ongoing-process/OngoingProcess';
import {
  dismissOnGoingProcessModal,
  showBottomNotificationModal,
} from '../../../store/app/app.actions';
import {
  Amount,
  ConfirmContainer,
  DetailsList,
  Header,
  SendingFrom,
  SendingTo,
} from '../../wallet/screens/send/confirm/Shared';
import {CoinbaseStackParamList} from '../CoinbaseStack';
import {COINBASE_ENV} from '../../../api/coinbase/coinbase.constants';
import {find} from 'lodash';
import {getCoinbaseExchangeRate} from '../../../store/coinbase/coinbase.effects';
import {CoinbaseEffects} from '../../../store/coinbase';
import {CoinbaseErrorsProps} from '../../../api/coinbase/coinbase.types';
import CoinbaseAPI from '../../../api/coinbase';

export interface CoinbaseWithdrawConfirmParamList {
  accountId: string;
  wallet: Wallet | undefined;
  amount: number;
}

const CoinbaseWithdrawConfirm = () => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation();
  const route =
    useRoute<RouteProp<CoinbaseStackParamList, 'CoinbaseWithdraw'>>();
  const {accountId, wallet, amount} = route.params;
  const [showPaymentSentModal, setShowPaymentSentModal] = useState(false);
  const [resetSwipeButton, setResetSwipeButton] = useState(false);

  const accountData = useSelector(({COINBASE}: RootState) => {
    return find(COINBASE.accounts[COINBASE_ENV], {id: accountId});
  });
  const exchangeRates = useSelector(
    ({COINBASE}: RootState) => COINBASE.exchangeRates,
  );

  const sendStatus = useSelector<RootState, 'success' | 'failed' | null>(
    ({COINBASE}) => COINBASE.sendTransactionStatus,
  );

  const sendError = useSelector<RootState, CoinbaseErrorsProps | null>(
    ({COINBASE}) => COINBASE.sendTransactionError,
  );

  const apiLoading = useSelector<RootState, boolean>(
    ({COINBASE}) => COINBASE.isApiLoading,
  );

  const currency = wallet?.credentials.coin;
  const toAddress = wallet?.receiveAddress;

  useEffect(() => {
    if (!resetSwipeButton) {
      return;
    }
    const timer = setTimeout(() => {
      setResetSwipeButton(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [resetSwipeButton]);

  const showError = async (error: CoinbaseErrorsProps | null) => {
    const errMsg = CoinbaseAPI.parseErrorToString(error);
    dispatch(
      showBottomNotificationModal({
        type: 'error',
        title: 'Error Sending Transaction',
        message: errMsg,
        enableBackdropDismiss: false,
        actions: [
          {
            text: 'OK',
            action: () => {
              dispatch(CoinbaseEffects.clearSendTransactionStatus());
              navigation.goBack();
            },
            primary: true,
          },
        ],
      }),
    );
  };

  const askForTwoFactor = (sendError: CoinbaseErrorsProps) => {
    Alert.prompt(
      'Enter 2FA code',
      'Two Factor verification code is required for sending this transaction.',
      [
        {
          text: 'Cancel',
          onPress: () => {
            showError(sendError);
          },
          style: 'cancel',
        },
        {
          text: 'OK',
          onPress: code => {
            dispatch(CoinbaseEffects.clearSendTransactionStatus());
            sendTransaction(code);
          },
        },
      ],
      'secure-text',
      '',
      'number-pad',
    );
  };

  const recipientData = {
    recipientName: wallet?.credentials.walletName || 'BitPay Wallet',
    recipientAddress: toAddress,
    img: wallet?.img || wallet?.credentials.coin,
  };

  const sendingFrom = {
    walletName: accountData?.name || 'Coinbase Account',
    img: 'coinbase',
  };

  const fiatAmountValue = getCoinbaseExchangeRate(
    amount,
    currency.toUpperCase(),
    exchangeRates,
  );

  const total = {
    cryptoAmount: amount + ' ' + currency.toUpperCase(),
    fiatAmount: fiatAmountValue.toFixed(2) + ' USD',
  };

  const buildTx = {
    to: toAddress,
    amount: amount,
    currency: currency,
  };

  useEffect(() => {
    if (!apiLoading && sendStatus === 'failed') {
      if (sendError?.errors[0].id === 'two_factor_required') {
        // Ask 2FA
        askForTwoFactor(sendError);
      } else {
        // Show error
        showError(sendError);
      }
    }

    if (!apiLoading && sendStatus === 'success') {
      setShowPaymentSentModal(true);
    }
  }, [apiLoading, sendStatus, sendError]);

  const sendTransaction = async (code?: string) => {
    dispatch(startOnGoingProcessModal(OnGoingProcessMessages.SENDING_PAYMENT));
    await sleep(400);
    dispatch(CoinbaseEffects.sendTransaction(accountId, buildTx, code));
    dispatch(dismissOnGoingProcessModal());
  };

  return (
    <ConfirmContainer>
      <DetailsList>
        <Header>Summary</Header>
        <SendingTo recipient={recipientData} hr />
        <SendingFrom sender={sendingFrom} hr />
        <Amount description={'Total'} amount={total} />
      </DetailsList>

      <SwipeButton
        title={'Slide to send'}
        forceReset={resetSwipeButton}
        onSwipeComplete={sendTransaction}
      />

      <PaymentSent
        isVisible={showPaymentSentModal}
        onCloseModal={async () => {
          dispatch(CoinbaseEffects.clearSendTransactionStatus());
          setShowPaymentSentModal(false);
          navigation.goBack();
        }}
      />
    </ConfirmContainer>
  );
};

export default CoinbaseWithdrawConfirm;
