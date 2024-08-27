import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BlurContainer} from '../../../blur/Blur';
import {SheetParams} from '../../../styled/Containers';
import BaseModal from '../BaseModal';
import {AppState, AppStateStatus, View} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import {LightBlack} from '../../../../styles/colors';

interface Props extends SheetParams {
  isVisible: boolean;
  onBackdropPress: (props?: any) => void;
  onModalHide?: () => void;
  children?: any;
}

type SheetModalProps = React.PropsWithChildren<Props>;

const SheetModal: React.FC<SheetModalProps> = ({
  children,
  isVisible,
  onBackdropPress,
  onModalHide,
  placement,
}) => {
  const bottomSheetModalRef = useRef<BottomSheetModal>(null);

  const [isModalVisible, setModalVisible] = useState(isVisible);
  useEffect(() => {
    console.log('isVisible changed', isVisible);
    function onAppStateChange(status: AppStateStatus) {
      if (isVisible && status === 'background') {
        setModalVisible(false);
        onBackdropPress();
      }
    }
    setModalVisible(isVisible);
    if (isVisible) {
      bottomSheetModalRef.current?.present();
    }

    const subscriptionAppStateChange = AppState.addEventListener(
      'change',
      onAppStateChange,
    );

    return () => subscriptionAppStateChange.remove();
  }, [isVisible]);
  // return (
  //   <BaseModal
  //     id={'sheetModal'}
  //     isVisible={isModalVisible}
  //     backdropOpacity={0.4}
  //     backdropTransitionOutTiming={0}
  //     hideModalContentWhileAnimating={true}
  //     useNativeDriverForBackdrop={true}
  //     useNativeDriver={true}
  //     testID="modalBackdrop"
  //     onBackdropPress={onBackdropPress}
  //     animationIn={placement === 'top' ? 'slideInDown' : 'slideInUp'}
  //     animationOut={placement === 'top' ? 'slideOutUp' : 'slideOutDown'}
  //     onModalHide={onModalHide}
  //     // swipeDirection={'down'}
  //     // onSwipeComplete={hideModal}
  //     style={{
  //       position: 'relative',
  //       justifyContent: placement === 'top' ? 'flex-start' : 'flex-end',
  //       margin: 0,
  //     }}>
  //     <>
  //       {children}
  //       <BlurContainer />
  //     </>
  //   </BaseModal>
  // );


  const handleModalSheetChanges = useCallback((index: number) => {
    console.log('handleModalSheetChanges', index);
  }, []);

  const renderBackdrop = useCallback(
    props => (
      <BottomSheetBackdrop
        {...props}
        pressBehavior={'close'}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  return (
    <BottomSheetModalProvider>
      {/* <View style={styles.container}>
    <Button
      onPress={handlePresentModalPress}
      title="Present Modal"
      color="black"
    /> */}
      <BottomSheetModal
        enableDismissOnClose={true}
        style={{backgroundColor: LightBlack}}
        backgroundStyle={{backgroundColor: LightBlack}}
        backdropComponent={renderBackdrop}
        ref={bottomSheetModalRef}
        index={0}
        enableDynamicSizing={true}
        // snapPoints={snapPoints}
        onChange={handleModalSheetChanges}>
        <BottomSheetView style={{backgroundColor: LightBlack}}>
          <View style={{height: 100}}>
            {/* <BaseText>Awesome 🎉</BaseText> */}
          </View>
        </BottomSheetView>
      </BottomSheetModal>
      {/* </View> */}
    </BottomSheetModalProvider>
  );
};

export default SheetModal;
