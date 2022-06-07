import {createStackNavigator} from '@react-navigation/stack';
import React from 'react';
import {
  baseNavigatorOptions,
  baseScreenOptions,
} from '../../../constants/NavigationOptions';
import ShopHome, {ShopHomeParamList} from './ShopHome';
import {HeaderTitle} from '../../../components/styled/Text';
import {t} from 'i18next';
import {NavigatorScreenParams} from '@react-navigation/native';
import {
  CardConfig,
  Category,
  DirectIntegrationApiObject,
  GiftCard,
  PhoneCountryInfo,
} from '../../../store/shop/shop.models';
import ArchivedGiftCards from './gift-card/screens/ArchivedGiftCards';
import BuyGiftCard from './gift-card/screens/BuyGiftCard';
import EnterEmail from './gift-card/screens/EnterEmail';
import EnterPhone from './gift-card/screens/EnterPhone';
import GiftCardDetails from './gift-card/screens/GiftCardDetails';
import MerchantCategory from './merchant/screens/MerchantCategory';
import MerchantDetails from './merchant/screens/MerchantDetails';

export type ShopStackParamList = {
  Home: NavigatorScreenParams<ShopHomeParamList>;
  ArchivedGiftCards: {giftCards: GiftCard[]; supportedGiftCards: CardConfig[]};
  BuyGiftCard: {cardConfig: CardConfig};
  EnterEmail: {
    cardConfig: CardConfig;
    initialEmail: string;
    onSubmit: (email: string) => void;
  };
  EnterPhone: {
    cardConfig: CardConfig;
    initialPhone: string;
    initialPhoneCountryInfo: PhoneCountryInfo;
    onSubmit: ({
      phone,
      phoneCountryInfo,
    }: {
      phone: string;
      phoneCountryInfo: PhoneCountryInfo;
    }) => void;
  };
  GiftCardDetails: {cardConfig: CardConfig; giftCard: GiftCard};
  MerchantCategory: {
    category: Category;
    integrations: DirectIntegrationApiObject[];
  };
  MerchantDetails: {directIntegration: DirectIntegrationApiObject};
};

export enum ShopScreens {
  HOME = 'Home',
  ARCHIVED_GIFT_CARDS = 'ArchivedGiftCards',
  BUY_GIFT_CARD = 'BuyGiftCard',
  ENTER_EMAIL = 'EnterEmail',
  ENTER_PHONE = 'EnterPhone',
  GIFT_CARD_DETAILS = 'GiftCardDetails',
  MERCHANT_CATEGORY = 'MerchantCategory',
  MERCHANT_DETAILS = 'MerchantDetails',
}

const Shop = createStackNavigator<ShopStackParamList>();

const ShopStack = () => {
  return (
    <Shop.Navigator
      initialRouteName={ShopScreens.HOME}
      screenOptions={{
        ...baseNavigatorOptions,
        ...baseScreenOptions,
      }}>
      <Shop.Screen
        name={ShopScreens.HOME}
        component={ShopHome}
        options={{
          headerLeft: () => null,
          headerTitle: () => <HeaderTitle>{t('Shop with crypto')}</HeaderTitle>,
        }}
      />
      <Shop.Screen
        name={ShopScreens.ARCHIVED_GIFT_CARDS}
        component={ArchivedGiftCards}
        options={{
          headerTitle: () => <HeaderTitle>Archived Gift Cards</HeaderTitle>,
        }}
      />
      <Shop.Screen name={ShopScreens.BUY_GIFT_CARD} component={BuyGiftCard} />
      <Shop.Screen
        name={ShopScreens.ENTER_EMAIL}
        component={EnterEmail}
        options={{
          headerTitle: () => <HeaderTitle>Enter Email</HeaderTitle>,
        }}
      />
      <Shop.Screen
        name={ShopScreens.ENTER_PHONE}
        component={EnterPhone}
        options={{
          headerTitle: () => <HeaderTitle>Enter Phone</HeaderTitle>,
        }}
      />
      <Shop.Screen
        name={ShopScreens.GIFT_CARD_DETAILS}
        component={GiftCardDetails}
        options={{
          gestureEnabled: false,
        }}
      />
      <Shop.Screen
        name={ShopScreens.MERCHANT_CATEGORY}
        component={MerchantCategory}
      />
      <Shop.Screen
        name={ShopScreens.MERCHANT_DETAILS}
        component={MerchantDetails}
      />
    </Shop.Navigator>
  );
};

export default ShopStack;
