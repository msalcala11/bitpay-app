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

const BillSettings = ({
  navigation,
}: StackScreenProps<BillStackParamList, 'BillSettings'>) => {
  const dispatch = useAppDispatch();
  const {t} = useTranslation();
  const user = useAppSelector(
    ({APP, BITPAY_ID}) => BITPAY_ID.user[APP.network],
  );
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: horizontalPadding,
        height: HEIGHT - 150,
      }}>
      <AccountBox>
        <AccountBoxBody>
          <AccountName>{user?.name}</AccountName>
          {user?.phone ? <AccountPhone>{user.phone}</AccountPhone> : null}
        </AccountBoxBody>
        <TouchableOpacity
          activeOpacity={ActiveOpacity}
          onPress={() =>
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
                      navigation.pop();
                    },
                    primary: true,
                  },
                  {
                    text: t('No, cancel'),
                    action: () => {},
                    primary: false,
                  },
                ],
              }),
            )
          }>
          <UnlinkButton>Unlink Account</UnlinkButton>
        </TouchableOpacity>
      </AccountBox>
    </ScrollView>
  );
};

export default BillSettings;
