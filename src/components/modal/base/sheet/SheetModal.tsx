import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, AppStateStatus} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import {BlurContainer} from '../../../blur/Blur';
import {HEIGHT, SheetParams} from '../../../styled/Containers';
import BaseModal from '../BaseModal';

interface Props extends SheetParams {
  isVisible: boolean;
  fullscreen?: boolean;
  onBackdropPress: (props?: any) => void;
  onModalHide?: () => void;
  children?: any;
  modalLibrary?: 'bottom-sheet' | 'react-native-modal';
}

type SheetModalProps = React.PropsWithChildren<Props>;

const SheetModal: React.FC<SheetModalProps> = ({
  children,
  isVisible,
  fullscreen,
  onBackdropPress,
  onModalHide,
  placement,
  modalLibrary = 'react-native-modal',
}) => {
  const bottomSheetModalRef = useRef<BottomSheetModal>(null);

  const [isModalVisible, setModalVisible] = useState(isVisible);
  useEffect(() => {
    function onAppStateChange(status: AppStateStatus) {
      if (isVisible && status === 'background') {
        setModalVisible(false);
        onBackdropPress();
      }
    }
    setModalVisible(isVisible);
    if (isVisible) {
      bottomSheetModalRef.current?.present();
    } else {
      bottomSheetModalRef.current?.dismiss();
    }

    const subscriptionAppStateChange = AppState.addEventListener(
      'change',
      onAppStateChange,
    );

    return () => subscriptionAppStateChange.remove();
  }, [isVisible, onBackdropPress]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        onPress={onBackdropPress}
        pressBehavior={'close'}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [onBackdropPress],
  );

  return modalLibrary === 'bottom-sheet' ? (
    <BottomSheetModal
      backdropComponent={renderBackdrop}
      backgroundStyle={{borderRadius: 18}}
      enableDismissOnClose={true}
      enableDynamicSizing={true}
      enableOverDrag={false}
      enablePanDownToClose={false}
      handleComponent={null}
      index={0}
      ref={bottomSheetModalRef}>
      <BottomSheetView style={{height: fullscreen ? HEIGHT - 20 : undefined}}>
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  ) : (
    <BaseModal
      id={'sheetModal'}
      isVisible={isModalVisible}
      backdropOpacity={0.4}
      backdropTransitionOutTiming={0}
      hideModalContentWhileAnimating={true}
      useNativeDriverForBackdrop={true}
      useNativeDriver={true}
      testID="modalBackdrop"
      onBackdropPress={onBackdropPress}
      animationIn={placement === 'top' ? 'slideInDown' : 'slideInUp'}
      animationOut={placement === 'top' ? 'slideOutUp' : 'slideOutDown'}
      onModalHide={onModalHide}
      // swipeDirection={'down'}
      // onSwipeComplete={hideModal}
      style={{
        position: 'relative',
        justifyContent: placement === 'top' ? 'flex-start' : 'flex-end',
        margin: 0,
      }}>
      <>
        {children}
        <BlurContainer />
      </>
    </BaseModal>
  );
};

export default SheetModal;
