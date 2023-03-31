import React, {useLayoutEffect} from 'react';
import {StackScreenProps} from '@react-navigation/stack';
import {BillStackParamList} from '../BillStack';
import {t} from 'i18next';
import {
  H6,
  HeaderTitle,
  Paragraph,
} from '../../../../../components/styled/Text';
import styled from 'styled-components/native';
import Button from '../../../../../components/button/Button';
import {BaseText} from '../../../../wallet/components/KeyDropdownOption';
import {Image, View} from 'react-native';
import {Action, Black, LightBlack, SlateDark, White} from '../../../../../styles/colors';
import {createMaterialTopTabNavigator} from '@react-navigation/material-top-tabs';

const Tab = createMaterialTopTabNavigator();

const HeroSection = styled.View`
  background-color: #eceffd;
  width: 100%;
  padding: 16px;
`;

const AmountDue = styled(BaseText)`
  font-size: 50px;
  font-weight: 500;
  text-align: center;
  margin-top: 110px;
`;

const DueDate = styled(Paragraph)`
  margin-bottom: 20px;
  text-align: center;
`;

const AccountDetails = styled.View`
  background-color: #fbfbff;
  flex-direction: row;
  align-items: center;
  padding: 16px;
`;

const AccountIcon = styled.View`
  height: 40px;
  width: 40px;
  //   border: 1px solid #e1e4e7;
  border-radius: 40px;
  align-items: center;
  justify-content: center;
  margin-right: 16px;
  //   padding: 1px;
`;

const Payments = ({
  navigation,
  route,
}: //   route,
//   navigation,
StackScreenProps<BillStackParamList, 'Payments'>) => {
  const {merchant} = route.params;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTransparent: true,
      headerTitle: () => {
        return (
          <HeaderTitle>
            {merchant
              ? t(`${merchant.merchantName} Payments`)
              : t('All Payments')}
          </HeaderTitle>
        );
      },
    });
  });
  return (
    <>
      <HeroSection>
        <AmountDue>$103.64</AmountDue>
        <DueDate>Amount due: 01/31/23</DueDate>
        <Button height={50} onPress={() => console.log('hi')}>
          {merchant ? t('Pay Bill') : t('Pay All Bills')}
        </Button>
      </HeroSection>
      {merchant ? (
        <AccountDetails>
          <AccountIcon>
            <Image
              style={{height: 40, width: 40}}
              resizeMode={'contain'}
              source={{uri: merchant.merchantIcon}}
            />
          </AccountIcon>
          <View>
            <H6>{merchant.merchantName}</H6>
            <Paragraph style={{color: SlateDark}}>
              Credit Card ****1234
            </Paragraph>
          </View>
        </AccountDetails>
      ) : null}
      <Tab.Navigator
        initialRouteName="Current"
        screenOptions={{
          tabBarActiveTintColor: Black,
          tabBarInactiveTintColor: LightBlack,
          tabBarLabelStyle: {
            fontSize: 16,
            textTransform: 'none',
            fontWeight: '500',
            // paddingVertical: Platform.select({
            //   ios: 4,
            //   android: 2,
            // }),
          },
          tabBarIndicatorStyle: {
            backgroundColor: Action,
            height: 3,
          },
          tabBarStyle: {backgroundColor: White, height: 63, paddingTop: 6},
        }}>
        <Tab.Screen
          name="Current"
          component={() => <></>}
          options={{
            tabBarLabel: merchant ? t('Current Bill') : t('Current Bills'),
          }}
        />
        <Tab.Screen
          name="Past"
          component={() => <></>}
          options={{tabBarLabel: 'Past Payments'}}
        />
      </Tab.Navigator>
    </>
  );
};

export default Payments;
