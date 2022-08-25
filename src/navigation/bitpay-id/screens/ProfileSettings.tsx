import {StackScreenProps} from '@react-navigation/stack';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {useDispatch, useSelector} from 'react-redux';
import styled from 'styled-components/native';
import Avatar from '../../../components/avatar/BitPayIdAvatar';
import {ScreenGutter} from '../../../components/styled/Containers';
import {BaseText, H3, H5, Paragraph} from '../../../components/styled/Text';
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
import {BitpayIdScreens, BitpayIdStackParamList} from '../BitpayIdStack';
import {TouchableOpacity} from 'react-native-gesture-handler';
import {useNavigation} from '@react-navigation/native';
import ChevronRight from '../components/ChevronRight';

type ProfileProps = StackScreenProps<BitpayIdStackParamList, 'Profile'>;

const ProfileSettingsScreenContainer = styled.View`
  margin: 0 ${ScreenGutter};
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

export const ProfileSettingsScreen: React.FC<ProfileProps> = () => {
  const {t} = useTranslation();
  const dispatch = useDispatch();
  const navigation = useNavigation();
  const network = useSelector<RootState, Network>(({APP}) => APP.network);
  const syncGiftCardPurchasesWithBitPayId = useSelector<RootState, boolean>(
    ({SHOP}) => SHOP.syncGiftCardPurchasesWithBitPayId,
  );
  const user = useSelector<RootState, User | null>(
    ({BITPAY_ID}) => BITPAY_ID.user[network],
  );

  const hasName = user?.givenName || user?.familyName;

  if (!user) {
    return <></>;
  }

  return (
    <ProfileSettingsScreenContainer>
      <ProfileInfoContainer>
        <AvatarContainer>
          <Avatar size={77} />
        </AvatarContainer>

        {hasName ? (
          <H3>
            {user.givenName} {user.familyName}
          </H3>
        ) : null}

        <EmailAddress>{user.email}</EmailAddress>
      </ProfileInfoContainer>

      <H5>Receive Settings</H5>

      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() =>
          navigation.navigate('BitpayId', {
            screen: BitpayIdScreens.RECEIVING_ADDRESSES,
          })
        }>
        <SettingsItem>
          <SettingsSectionBody>
            <SettingsSectionHeader>
              {t('Receive via BitPay ID')}
            </SettingsSectionHeader>
            <SettingsSectionDescription>
              {t('Simply receive tokens/coins to your BitPay ID.')}
            </SettingsSectionDescription>
          </SettingsSectionBody>
          <ChevronRight />
        </SettingsItem>
      </TouchableOpacity>

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
    </ProfileSettingsScreenContainer>
  );
};

export default ProfileSettingsScreen;
