import React from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';
import {useTranslation} from 'react-i18next';
import {BillStackParamList} from '../BillStack';
import {ScrollView} from 'react-native';
import {LightBlack, LinkBlue, Slate10} from '../../../../../styles/colors';
import {BaseText} from '../../../../../components/styled/Text';
import {horizontalPadding} from '../../components/styled/ShopTabComponents';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {AppActions} from '../../../../../store/app';
import {TouchableOpacity} from 'react-native-gesture-handler';
import {
  ActiveOpacity,
  HEIGHT,
} from '../../../../../components/styled/Containers';
import {BitPayIdEffects} from '../../../../../store/bitpay-id';
import {ShopEffects} from '../../../../../store/shop';
import {useFocusEffect} from '@react-navigation/native';
import {Analytics} from '../../../../../store/analytics/analytics.effects';

const AccountBox = styled.View`
  background-color: ${({theme}) => (theme.dark ? LightBlack : Slate10)};
  flex-direction: row;
  align-items: center;
  padding: 12px 16px;
  margin-top: 20px;
  border-radius: 12px;
`;

const AccountName = styled(BaseText)`
  font-size: 16px;
  font-weight: 500;
`;

const AccountPhone = styled(AccountName)`
  font-weight: 400;
  margin-top: 2px;
`;

const AccountBoxBody = styled.View`
  flex-grow: 1;
`;

const UnlinkButton = styled(BaseText)`
  font-size: 16px;
  color: ${LinkBlue};
`;

const formatUSPhone = (unformattedPhone: string) => {
  if (!unformattedPhone.startsWith('+1') || unformattedPhone.length !== 12) {
    return unformattedPhone;
  }
  const areaCode = unformattedPhone.substring(2, 5);
  const nextThree = unformattedPhone.substring(5, 8);
  const lastFour = unformattedPhone.substring(8, 12);
  return `(${areaCode}) ${nextThree}-${lastFour}`;
};

const BillSettings = ({
  navigation,
}: StackScreenProps<BillStackParamList, 'BillSettings'>) => {
  const dispatch = useAppDispatch();
  const {t} = useTranslation();
  const user = useAppSelector(
    ({APP, BITPAY_ID}) => BITPAY_ID.user[APP.network],
  );
  useFocusEffect(() => {
    dispatch(Analytics.track('Bill Pay — Viewed Bill Pay Settings'));
  });
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: horizontalPadding,
        height: HEIGHT - 150,
      }}>
      <AccountBox>
        <AccountBoxBody>
          <AccountName>{user?.name}</AccountName>
          {user?.phone ? (
            <AccountPhone>{formatUSPhone(user.phone)}</AccountPhone>
          ) : null}
        </AccountBoxBody>
        <TouchableOpacity
          activeOpacity={ActiveOpacity}
          onPress={() => {
            dispatch(
              AppActions.showBottomNotificationModal({
                type: 'warning',
                title: t('Confirm'),
                message: t(
                  'Are you sure you would like to unlink your Method account?',
                ),
                enableBackdropDismiss: true,
                onBackdropDismiss: () => {},
                actions: [
                  {
                    text: t("Yes, I'm sure"),
                    action: () => {
                      dispatch(BitPayIdEffects.startResetMethodUser());
                      dispatch(ShopEffects.startGetBillPayAccounts());
                      dispatch(
                        Analytics.track('Bill Pay — Unlinked Method Account'),
                      );
                      navigation.pop();
                    },
                    primary: true,
                  },
                  {
                    text: t('No, cancel'),
                    action: () => {
                      dispatch(
                        Analytics.track(
                          'Bill Pay — Canceled Confirm Unlink Method Account Modal',
                        ),
                      );
                    },
                    primary: false,
                  },
                ],
              }),
            );
            dispatch(
              Analytics.track(
                'Bill Pay — Viewed Confirm Unlink Method Account Modal',
              ),
            );
          }}>
          <UnlinkButton>Unlink Account</UnlinkButton>
        </TouchableOpacity>
      </AccountBox>
    </ScrollView>
  );
};

export default BillSettings;
