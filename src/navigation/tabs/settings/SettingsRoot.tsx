import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useMemo, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {View, ScrollView, SafeAreaView} from 'react-native';
import styled from 'styled-components/native';
import AngleRight from '../../../../assets/img/angle-right.svg';
import Avatar from '../../../components/avatar/BitPayIdAvatar';
import {
  ActiveOpacity,
  ScreenGutter,
  Setting,
  SettingIcon,
  SettingTitle,
  Hr,
} from '../../../components/styled/Containers';
import {RootState} from '../../../store';
import {User} from '../../../store/bitpay-id/bitpay-id.models';
import {useAppDispatch} from '../../../utils/hooks';
import {useSelector} from 'react-redux';
import {useScrollToTop} from '@react-navigation/native';
import {SettingsScreens, SettingsGroupParamList} from './SettingsGroup';

export type SettingsListType =
  | 'General'
  | 'Contacts'
  | 'Crypto'
  | 'Wallets & Keys'
  | 'Security'
  | 'External Services'
  | 'Notifications'
  | 'Connections'
  | 'About BitPay';

export type SettingsHomeProps = NativeStackScreenProps<
  SettingsGroupParamList,
  SettingsScreens.SETTINGS_HOME
>;

export const SettingsContainer = styled(SafeAreaView)`
  flex: 1;
`;

export const SettingsComponent = styled(ScrollView)`
  padding: 10px 0;
`;

export const SettingsHomeContainer = styled(ScrollView)`
  padding: 10px 0;
`;

const BitPayIdSettingsLink = styled(Setting)`
  height: auto;
  margin-bottom: 32px;
`;

const BitPayIdAvatarContainer = styled.View`
  margin-right: ${ScreenGutter};
`;

const BitPayIdUserContainer = styled.View`
  display: flex;
  flex-grow: 1;
  flex-direction: column;
`;

const BitPayIdSettingTitle = styled(SettingTitle)`
  color: ${({theme}) => theme.colors.text};
  flex-grow: 1;
`;

const BitPayIdUserText = styled.Text<{bold?: boolean}>`
  display: flex;
  font-size: 14px;
  line-height: 19px;
  font-weight: ${({bold}) => (bold ? 700 : 400)};
  color: ${({theme}) => theme.colors.text};
`;

const SettingsHome: React.FC<SettingsHomeProps> = ({route, navigation}) => {
  const {redirectTo} = route.params || {};
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const user = useSelector<RootState, User | null>(
    ({APP, BITPAY_ID}) => BITPAY_ID.user[APP.network],
  );
  const scrollViewRef = useRef<ScrollView>(null);
  useScrollToTop(scrollViewRef);

  const memoizedSettingsConfigs: {id: SettingsListType; title: string}[] = useMemo(
    () => [
      {
        id: 'General',
        title: t('General'),
      },
      {
        id: 'Contacts',
        title: t('Contacts'),
      },
      {
        id: 'Crypto',
        title: t('Crypto'),
      },
      {
        id: 'Wallets & Keys',
        title: t('Wallets & Keys'),
      },
      {
        id: 'Security',
        title: t('Security'),
      },
      {
        id: 'Notifications',
        title: t('Notifications'),
      },
      {
        id: 'Connections',
        title: t('Connections'),
      },
      {
        id: 'External Services',
        title: t('External Services'),
      },
      {
        id: 'About BitPay',
        title: t('About BitPay'),
      },
    ],
    [t],
  );

  const memoizedSettingsList = useMemo(() => {
    return memoizedSettingsConfigs.map(({id, title}) => {
      return (
        <View key={id}>
          <Setting
            activeOpacity={ActiveOpacity}
            onPress={() => {
              navigation.navigate('SettingsDetails', {
                initialRoute: id,
                ...(id === 'Connections' ? {redirectTo} : {}),
              });
            }}>
            <SettingTitle>{title}</SettingTitle>
            <SettingIcon suffix>
              <AngleRight />
            </SettingIcon>
          </Setting>
          <Hr />
        </View>
      );
    });
  }, [memoizedSettingsConfigs, redirectTo, navigation]);

  return (
    <SettingsContainer>
      <SettingsHomeContainer ref={scrollViewRef}>
        <BitPayIdSettingsLink
          style={{paddingHorizontal: 15}}
          onPress={() => {
            if (user) {
              navigation.navigate('BitPayIdProfile');
            } else {
              navigation.navigate('Login');
            }
          }}>
          <BitPayIdAvatarContainer>
            <Avatar size={50} />
          </BitPayIdAvatarContainer>
          {user ? (
            <BitPayIdUserContainer>
              {user.givenName || user.familyName ? (
                <BitPayIdUserText bold>
                  {user.givenName} {user.familyName}
                </BitPayIdUserText>
              ) : null}
              <BitPayIdUserText>{user.email}</BitPayIdUserText>
            </BitPayIdUserContainer>
          ) : (
            <BitPayIdSettingTitle>
              {t('Log In or Sign Up')}
            </BitPayIdSettingTitle>
          )}
          <SettingIcon suffix>
            <AngleRight />
          </SettingIcon>
        </BitPayIdSettingsLink>

        {memoizedSettingsList}
      </SettingsHomeContainer>
    </SettingsContainer>
  );
};

export default SettingsHome;
