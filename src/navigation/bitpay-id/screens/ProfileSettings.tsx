import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSelector} from 'react-redux';
import styled from 'styled-components/native';
import Avatar from '../../../components/avatar/BitPayIdAvatar';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../components/styled/Containers';
import {
  BaseText,
  H3,
  H5,
  Link,
  Paragraph,
} from '../../../components/styled/Text';
import ToggleSwitch from '../../../components/toggle-switch/ToggleSwitch';
import {Network} from '../../../constants';
import {RootState} from '../../../store';
import {User} from '../../../store/bitpay-id/bitpay-id.models';
import {ShopActions, ShopEffects} from '../../../store/shop';
import {
  LightBlack,
  NeutralSlate,
  Slate,
  SlateDark,
} from '../../../styles/colors';
import {BitpayIdScreens, BitpayIdGroupParamList} from '../BitpayIdGroup';
import {StyleSheet, TouchableOpacity, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import ChevronRight from '../components/ChevronRight';
import {BitPayIdEffects} from '../../../store/bitpay-id';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {SectionSpacer} from '../../tabs/shop/components/styled/ShopTabComponents';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import Button from '@/components/button/Button';

type ProfileProps = NativeStackScreenProps<
  BitpayIdGroupParamList,
  BitpayIdScreens.PROFILE
>;

const ProfileSettingsScreenContainer = styled.SafeAreaView`
  flex: 1;
`;

const ScrollView = styled.ScrollView`
  margin: 0 ${ScreenGutter};
  padding-bottom: 100px;
`;

const ProfileInfoContainer = styled.View`
  display: flex;
  align-items: center;
  margin: 50px 0 36px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : NeutralSlate)};
  border-radius: 12px;
  padding: 20px;
  padding-bottom: 25px;
`;

const AvatarContainer = styled.View`
  margin-top: -58px;
  padding-bottom: 18px;
`;

const EmailAddress = styled(Paragraph)`
  color: ${({theme: {dark}}) => (dark ? Slate : SlateDark)};
`;

const EmailAddressNotVerified = styled(Paragraph)`
  font-size: 14px;
`;

const SettingsSection = styled.View`
  flex-direction: row;
  padding: 20px 0;
  border: ${({theme: {dark}}) => (dark ? SlateDark : '#E5E5E5')};
  border-radius: 12px;
  padding: 16px;
  margin-top: 16px;
  margin-bottom: 8px;
`;

const SettingsItem = styled(SettingsSection)`
  display: flex;
  flex-direction: row;
  align-items: center;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : NeutralSlate)};
  border: none;
`;

const SettingsSectionBody = styled.View`
  flex-shrink: 1;
  padding-right: 40px;
  flex-grow: 1;
`;

const SettingsSectionHeader = styled(BaseText)`
  font-weight: 500;
  font-size: 14px;
  margin-bottom: 10px;
`;

const SettingsSectionDescription = styled(BaseText)`
  font-size: 12px;
  line-height: 18px;
`;

export const ProfileSettingsScreen = ({route}: ProfileProps) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const navigation = useNavigation();
  const network = useSelector<RootState, Network>(({APP}) => APP.network);
  const syncGiftCardPurchasesWithBitPayId = useSelector<RootState, boolean>(
    ({SHOP}) => SHOP.syncGiftCardPurchasesWithBitPayId,
  );
  const user = useAppSelector(({BITPAY_ID}) => BITPAY_ID.user[network]);
  const apiToken = useAppSelector(
    ({APP, BITPAY_ID}) => BITPAY_ID.apiToken[APP.network],
  );

  const [isModalShown, setIsModalShown] = useState(false);

  // const styles = StyleSheet.create({
  //   container: {
  //     flex: 1,
  //     padding: 24,
  //     backgroundColor: LightBlack,
  //   },
  //   contentContainer: {
  //     flex: 1,
  //     alignItems: 'center',
  //     // backgroundColor: LightBlack,
  //   },
  // });

  const bottomSheetRef = useRef<BottomSheet>(null);

  const bottomSheetModalRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['25%', '50%'], []);

  const renderBackdrop = useCallback(
    props => (
      <BottomSheetBackdrop
        {...props}
        pressBehavior={'close'}
        //disappearsOnIndex={1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  // callbacks
  const handlePresentModalPress = useCallback(() => {
    bottomSheetModalRef.current?.present();
  }, []);
  const handleModalSheetChanges = useCallback((index: number) => {
    console.log('handleModalSheetChanges', index);
  }, []);

  // callbacks
  const handleSheetChanges = useCallback((index: number) => {
    console.log('handleSheetChanges', index);
  }, []);

  bottomSheetRef.current;

  useEffect(() => {
    dispatch(BitPayIdEffects.startFetchSession());
    if (apiToken) {
      dispatch(BitPayIdEffects.startFetchSecuritySettings());
      dispatch(BitPayIdEffects.startFetchBasicInfo(apiToken));
    }
  }, [apiToken, dispatch]);

  const hasName = user?.givenName || user?.familyName;

  if (!user) {
    return <></>;
  }

  return (
    <ProfileSettingsScreenContainer>
      <ScrollView>
        <ProfileInfoContainer>
          <AvatarContainer>
            <Avatar size={77} bright={true} />
          </AvatarContainer>

          {hasName ? (
            <H3>
              {user.givenName} {user.familyName}
            </H3>
          ) : null}

          <EmailAddress
            onPress={() => {
              bottomSheetModalRef.current?.present();
              // if (!isModalShown) {
              //   setIsModalShown(true);
              // } else {
              //   bottomSheetRef.current?.close();
              //   setTimeout(() => {
              //     setIsModalShown(false);
              //   }, 500);
              // }
            }}>
            {user.email}
          </EmailAddress>
          {!user.verified ? (
            <EmailAddressNotVerified>
              <Link
                accessibilityLabel="resend-link-button"
                onPress={() => navigation.navigate('VerifyEmail')}>
                {t('Verify email address')}
              </Link>
            </EmailAddressNotVerified>
          ) : null}
        </ProfileInfoContainer>

        <H5>{t('Account Settings')}</H5>

        {user.verified ? (
          <>
            <TouchableOpacity
              activeOpacity={ActiveOpacity}
              onPress={() =>
                navigation.navigate(BitpayIdScreens.RECEIVE_SETTINGS)
              }>
              <SettingsItem>
                <SettingsSectionBody>
                  <SettingsSectionHeader>
                    {t('Receive via Email Address')}
                  </SettingsSectionHeader>
                  <SettingsSectionDescription>
                    {t('Receive crypto without wallet addresses or QR codes.')}
                  </SettingsSectionDescription>
                </SettingsSectionBody>
                <ChevronRight />
              </SettingsItem>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={ActiveOpacity}
              onPress={() =>
                navigation.navigate(BitpayIdScreens.ENABLE_TWO_FACTOR)
              }>
              <SettingsItem>
                <SettingsSectionBody>
                  <SettingsSectionHeader>
                    {t('Two-Factor Authentication')}
                  </SettingsSectionHeader>
                  <SettingsSectionDescription>
                    {t(
                      'Secure your account with time-based one-time 6-digit codes.',
                    )}
                  </SettingsSectionDescription>
                </SettingsSectionBody>
                <ChevronRight />
              </SettingsItem>
            </TouchableOpacity>
          </>
        ) : null}

        <SettingsSection>
          <SettingsSectionBody>
            <SettingsSectionHeader>
              {t('Sync Gift Card Purchases')}
            </SettingsSectionHeader>
            <SettingsSectionDescription>
              {t(
                'If enabled, your gift card purchases will be associated with your BitPay ID, allowing you to keep track of your gift card purchases even if this device is lost.',
              )}
            </SettingsSectionDescription>
          </SettingsSectionBody>
          <ToggleSwitch
            isEnabled={syncGiftCardPurchasesWithBitPayId}
            onChange={() => {
              dispatch(ShopActions.toggledSyncGiftCardPurchasesWithBitPayId());
              dispatch(ShopEffects.startFetchCatalog());
            }}
          />
        </SettingsSection>
        <SectionSpacer />
      </ScrollView>
      {isModalShown ? (
        <BottomSheet
          ref={bottomSheetRef}
          onChange={handleSheetChanges}
          enablePanDownToClose
          style={{backgroundColor: LightBlack}}
          backgroundStyle={{backgroundColor: LightBlack}}>
          <BottomSheetView style={{backgroundColor: LightBlack, height: 300}}>
            <BaseText>Awesome 🎉</BaseText>
          </BottomSheetView>
        </BottomSheet>
      ) : null}

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
          index={1}
          snapPoints={snapPoints}
          onChange={handleModalSheetChanges}>
          <BottomSheetView style={{backgroundColor: LightBlack, height: 300}}>
            <BaseText>Awesome 🎉</BaseText>
          </BottomSheetView>
        </BottomSheetModal>
        {/* </View> */}
      </BottomSheetModalProvider>
    </ProfileSettingsScreenContainer>
  );
};

export default ProfileSettingsScreen;
