import React, {useCallback, useEffect, useRef} from 'react';
import {ActivityIndicator} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import styled from 'styled-components/native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import {LightBlack, SlateDark, White} from '../../../styles/colors';
import {useAppSelector} from '../../../utils/hooks';
import {BlurContainer} from '../../blur/Blur';
import {BaseText} from '../../styled/Text';
import {HEIGHT} from '../../../components/styled/Containers';

import BaseModal from '../base/BaseModal';

export type OnGoingProcessMessages =
  | 'GENERAL_AWAITING'
  | 'CREATING_KEY'
  | 'LOGGING_IN'
  | 'LOGGING_OUT'
  | 'PAIRING'
  | 'CREATING_ACCOUNT'
  | 'UPDATING_ACCOUNT'
  | 'IMPORTING'
  | 'DELETING_KEY'
  | 'ADDING_WALLET'
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
  | 'SCANNING_FUNDS_WITH_PASSPHRASE';

const OnGoingProcessContainer = styled.View`
  max-width: 60%;
  justify-content: center;
  align-items: center;
`;

const Row = styled.View`
  background-color: ${({theme}) => (theme.dark ? LightBlack : White)};
  border-radius: 10px;
  flex-direction: row;
  padding: 20px;
`;

const ActivityIndicatorContainer = styled.View`
  flex-direction: column;
  justify-content: center;
  align-items: center;
  margin-right: 15px;
  transform: scale(1.1);
`;

const Message = styled(BaseText)`
  font-weight: 700;
  flex-wrap: wrap;
`;

const OnGoingProcessModal: React.FC = () => {
  const message = useAppSelector(({APP}) => APP.onGoingProcessModalMessage);
  const isVisible = useAppSelector(({APP}) => APP.showOnGoingProcessModal);
  const appWasInit = useAppSelector(({APP}) => APP.appWasInit);

  const modalLibrary: 'bottom-sheet' | 'modal' = 'bottom-sheet';

  const bottomSheetModalRef = useRef<BottomSheetModal>(null);

  const opacityFadeDuration = 200;
  const opacity = useSharedValue(0);
  const animatedStyles = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
    };
  });

  useEffect(() => {
    if (isVisible && appWasInit) {
      bottomSheetModalRef.current?.present();
      setTimeout(() => {
        opacity.value = withTiming(1, {duration: opacityFadeDuration});
      }, 300);
    } else {
      opacity.value = withTiming(0, {duration: opacityFadeDuration});
      setTimeout(() => {
        bottomSheetModalRef.current?.dismiss();
      }, opacityFadeDuration - 50);
    }
  }, [appWasInit, isVisible, opacity]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={0.4}
        pressBehavior={'none'}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  return modalLibrary === 'bottom-sheet' ? (
    <BottomSheetModal
      detached={true}
      bottomInset={HEIGHT / 2}
      backdropComponent={renderBackdrop}
      backgroundStyle={{borderRadius: 18}}
      enableDismissOnClose={true}
      enableDynamicSizing={true}
      enableOverDrag={false}
      enablePanDownToClose={false}
      handleComponent={null}
      backgroundComponent={null}
      index={0}
      ref={bottomSheetModalRef}>
      <BottomSheetView
        style={{
          alignItems: 'center',
        }}>
        <Animated.View style={[animatedStyles]}>
          <OnGoingProcessContainer>
            <Row>
              <ActivityIndicatorContainer>
                <ActivityIndicator color={SlateDark} />
              </ActivityIndicatorContainer>
              <Message>{message}</Message>
              <BlurContainer />
            </Row>
          </OnGoingProcessContainer>
        </Animated.View>
      </BottomSheetView>
    </BottomSheetModal>
  ) : (
    <BaseModal
      id={'ongoingProcess'}
      isVisible={appWasInit && isVisible}
      backdropOpacity={0.4}
      animationIn={'fadeInRight'}
      animationOut={'fadeOutLeft'}
      backdropTransitionOutTiming={0}
      hideModalContentWhileAnimating={true}
      useNativeDriverForBackdrop={true}
      useNativeDriver={true}
      style={{
        alignItems: 'center',
      }}>
      <OnGoingProcessContainer>
        <Row>
          <ActivityIndicatorContainer>
            <ActivityIndicator color={SlateDark} />
          </ActivityIndicatorContainer>
          <Message>{message}</Message>
          <BlurContainer />
        </Row>
      </OnGoingProcessContainer>
    </BaseModal>
  );
};

export default OnGoingProcessModal;
