import {yupResolver} from '@hookform/resolvers/yup';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import React, {useEffect, useState} from 'react';
import {Controller, useForm} from 'react-hook-form';
import styled from 'styled-components/native';
import {Trans, useTranslation} from 'react-i18next';
import {Keyboard, Linking, Platform, View} from 'react-native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import Button, {ButtonState} from '../../../../components/button/Button';
import {
  ActiveOpacity,
  HEIGHT,
  WIDTH,
} from '../../../../components/styled/Containers';
import {H5, Paragraph} from '../../../../components/styled/Text';
import {BillScreens} from '../bill/BillGroup';
import {
  SectionContainer,
  SectionHeader,
  SectionHeaderButton,
  SectionHeaderContainer,
  SectionSpacer,
} from './styled/ShopTabComponents';
import {LinkBlue, Slate30, SlateDark} from '../../../../styles/colors';
import CautionIconSvg from '../../../../../assets/img/bills/caution.svg';
import {BillList} from '../bill/components/BillList';
import {PaymentList} from '../bill/components/PaymentList';
import {
  useAppDispatch,
  useAppSelector,
  useLogger,
} from '../../../../utils/hooks';
import {BillPayAccount} from '../../../../store/shop/shop.models';
import {BASE_BITPAY_URLS} from '../../../../constants/config';
import {Network} from '../../../../constants';
import {ShopEffects} from '../../../../store/shop';
import {AppActions, AppEffects} from '../../../../store/app';
import BillPitch from '../bill/components/BillPitch';
import {Analytics} from '../../../../store/analytics/analytics.effects';
import {getBillAccountEventParams} from '../bill/utils';
import {sleep} from '../../../../utils/helper-methods';
import {BWCErrorMessage} from '../../../../constants/BWCError';
import {showBottomNotificationModal} from '../../../../store/app/app.actions';
import {CustomErrorMessage} from '../../../wallet/components/ErrorMessages';
import {joinWaitlist} from '../../../../store/app/app.effects';
import UserInfo from './UserInfo';
import {BitPayIdEffects} from '../../../../store/bitpay-id';
import BoxInput from '../../../../components/form/BoxInput';
import yup from '../../../../lib/yup';

export const billPayServicePaused = true;

const billPayServicePausedLearnMoreUrl = 'https://bitpay.com';

const Subtitle = styled(Paragraph)`
  font-size: 14px;
  line-height: 21px;
  width: 310px;
  margin-top: 10px;
  color: ${({theme}) => (theme.dark ? Slate30 : SlateDark)};
  text-align: center;
  margin-bottom: 20px;
`;

const BillsValueProp = styled.View`
  flex-grow: 1;
  align-items: center;
  justify-content: center;
`;

const CautionIcon = styled(CautionIconSvg)`
  margin-bottom: 24px;
`;

const BillPayServicePausedAlertContainer = styled.View`
  background-color: ${({theme}) => (theme.dark ? '#1C1C1C' : '#F1F3F5')};
  padding: 12px 16px;
  border-radius: 8px;
  margin: 15px 16px 0;
`;

const BillPayServicePausedAlertText = styled(Paragraph)`
  font-size: 14px;
  line-height: 19px;
`;

const BillPayServicePausedAlertLink = styled(Paragraph)`
  font-size: 14px;
  line-height: 19px;
  color: ${LinkBlue};
`;

const BillListContainer = styled.View`
  padding: 15px 16px 0;
  flex: 1;
`;

const BillsHeaderContainer = styled(SectionHeaderContainer)`
  margin-top: 15px;
`;

const BillsHeader = styled(SectionHeader)`
  margin-top: 0;
`;

const BillsHeaderButton = styled(SectionHeaderButton)`
  margin-top: 0;
`;

export const Bills = () => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation();
  const {t} = useTranslation();
  const logger = useLogger();

  const appNetwork = useAppSelector(({APP}) => APP.network) as Network;

  const accounts = useAppSelector(
    ({SHOP}) => SHOP.billPayAccounts[appNetwork],
  ) as BillPayAccount[];

  const apiToken = useAppSelector(
    ({BITPAY_ID}) => BITPAY_ID.apiToken[appNetwork],
  );

  const isJoinedWaitlist = useAppSelector(({SHOP}) => SHOP.isJoinedWaitlist);

  const verificationBaseUrl = `${BASE_BITPAY_URLS[appNetwork]}/wallet-verify?product=billpay`;

  const [connected, setConnected] = useState(!!accounts.length);

  const user = useAppSelector(
    ({APP, BITPAY_ID}) => BITPAY_ID.user[APP.network],
  );
  const userEmail = user?.email;
  const isVerified = !!(user && user.country);

  const [available, setAvailable] = useState(user && user.country === 'US');
  const [waitlistButtonState, setWaitlistButtonState] = useState<ButtonState>();
  const [connectButtonState, setConnectButtonState] = useState<ButtonState>();

  const schema = yup.object().shape({
    email: yup.string().email().required().trim(),
  });

  const {
    control,
    handleSubmit,
    formState: {errors},
  } = useForm<{email: string}>({
    resolver: !userEmail ? yupResolver(schema) : undefined,
  });

  useEffect(() => {
    const billsConnected = !!accounts.length && !!user?.methodEntityId;
    setConnected(billsConnected);
    const isAvailable = async () => {
      if (user && user.country === 'US' && !connected) {
        const billPayAvailable = await dispatch(
          ShopEffects.startCheckIfBillPayAvailable(),
        ).catch(_ => false);
        setAvailable(billPayAvailable);
        await dispatch(ShopEffects.startGetBillPayAccounts()).catch(() => {});
      }
    };
    isAvailable();
  }, [accounts.length, connected, dispatch, user]);

  useFocusEffect(() => {
    dispatch(AppActions.setHasViewedBillsTab());
  });

  const onWaitlistSubmit = async (email?: string) => {
    try {
      setWaitlistButtonState('loading');
      const resolvedEmail = userEmail || email;
      if (!resolvedEmail) {
        throw new Error(t('Email is required'));
      }
      await dispatch(joinWaitlist(resolvedEmail, 'BillPay Waitlist', 'bill-pay'));
      await sleep(500);
      setWaitlistButtonState('success');
    } catch (err) {
      setWaitlistButtonState('failed');
      logger.warn('Error joining waitlist: ' + BWCErrorMessage(err));
      await sleep(500);
      await dispatch(
        showBottomNotificationModal(
          CustomErrorMessage({
            errMsg: BWCErrorMessage(err),
            title: t('Error joining waitlist'),
          }),
        ),
      );
      await sleep(500);
      setWaitlistButtonState(undefined);
    }
  };

  const onWaitlistFormSubmit = handleSubmit(async ({email}) => {
    try {
      Keyboard.dismiss();
      await onWaitlistSubmit(email);
    } catch (err) {
      throw err;
    }
  });

  const connectBills = async () => {
    if (user?.methodVerified) {
      navigation.navigate(BillScreens.CONNECT_BILLS_OPTIONS, {});
      return;
    }
    setConnectButtonState('loading');
    try {
      const userInfo = await dispatch(
        BitPayIdEffects.startFetchBasicInfo(apiToken, {
          includeExternalData: true,
        }),
      );
      setConnectButtonState(undefined);
      if (userInfo.methodVerified) {
        navigation.navigate(BillScreens.CONNECT_BILLS_OPTIONS, {});
        return;
      }
    } catch (err) {
      setConnectButtonState(undefined);
    }
    verifyUserInfo();
  };

  const verifyUserInfo = async () => {
    dispatch(
      AppActions.showBottomNotificationModal({
        type: 'info',
        title: t('Confirm Your Info'),
        message: '',
        message2: <UserInfo />,
        modalLibrary: 'bottom-sheet',
        enableBackdropDismiss: true,
        onBackdropDismiss: () => {},
        actions: [
          {
            text: t('THIS IS CORRECT'),
            action: () => {
              navigation.navigate(BillScreens.CONNECT_BILLS, {
                tokenType: 'auth',
              });
              dispatch(Analytics.track('Bill Pay - Confirmed User Info'));
              if (!user?.methodVerified) {
                dispatch(Analytics.track('Bill Pay - Started Application'));
              }
            },
            primary: true,
          },
          {
            text: t('UPDATE INFO'),
            action: () => {
              Linking.openURL('https://bitpay.com/request-help/wizard');
              dispatch(Analytics.track('Bill Pay - Clicked Update User Info'));
            },
          },
        ],
      }),
    );
  };

  return (
    <SectionContainer
      style={{minHeight: HEIGHT - (Platform.OS === 'android' ? 200 : 225)}}>
      {billPayServicePaused ? (
        connected ? (
          <>
            <BillPayServicePausedAlertContainer>
              <BillPayServicePausedAlertText>
                {t(
                  'Bill Pay service will be temporarily paused beginning December 26th, 2025 at 12:00 PM EST. At this time, we are unable to provide a confirmed timeline for when the Bill Pay service will resume.',
                )}{' '}
                <BillPayServicePausedAlertLink
                  onPress={() =>
                    dispatch(
                      AppEffects.openUrlWithInAppBrowser(
                        billPayServicePausedLearnMoreUrl,
                      ),
                    )
                  }>
                  {t('Learn more')}
                </BillPayServicePausedAlertLink>
              </BillPayServicePausedAlertText>
            </BillPayServicePausedAlertContainer>
            <BillListContainer>
              <PaymentList
                accounts={accounts}
                variation={'large'}
                onPress={(accountObj, payment) => {
                  navigation.navigate(BillScreens.PAYMENT, {
                    account: accountObj,
                    payment,
                    showBillPayServicePausedAlert: true,
                  });
                }}
              />
            </BillListContainer>
          </>
        ) : (
          <BillsValueProp>
            <CautionIcon />
            <H5>{t('Join the Bill Pay waitlist')}</H5>
            <Subtitle>
              {t(
                "Bill Pay is temporarily unavailable. Join the waitlist to get updates when it's available again.",
              )}
            </Subtitle>

            {isJoinedWaitlist ? (
              <Paragraph style={{textAlign: 'center', fontSize: 14}}>
                {t('You have joined the waitlist.')}
              </Paragraph>
            ) : (
              <>
                {!userEmail ? (
                  <View style={{width: WIDTH - 32, marginBottom: 16}}>
                    <Controller
                      control={control}
                      render={({field: {onChange, onBlur, value}}) => (
                        <BoxInput
                          placeholder={t('Enter Email')}
                          onBlur={onBlur}
                          onChangeText={(text: string) => onChange(text)}
                          error={errors.email?.message}
                          keyboardType={'email-address'}
                          value={value}
                          returnKeyType="done"
                        />
                      )}
                      name="email"
                    />
                  </View>
                ) : null}

                <Button
                  state={waitlistButtonState}
                  style={{width: WIDTH - 32, marginTop: 8}}
                  height={50}
                  buttonStyle="secondary"
                  onPress={() => {
                    if (userEmail) {
                      onWaitlistSubmit().catch(_ => {});
                      return;
                    }
                    onWaitlistFormSubmit().catch(_ => {});
                  }}>
                  {t('Join waitlist')}
                </Button>
              </>
            )}
          </BillsValueProp>
        )
      ) : !isVerified ? (
        <>
          <BillPitch />
          <Button
            height={50}
            onPress={() => {
              dispatch(
                AppEffects.openUrlWithInAppBrowser(
                  `${verificationBaseUrl}&context=createAccount`,
                ),
              );
              dispatch(Analytics.track('Bill Pay - Clicked Sign Up'));
            }}>
            {t('Sign Up')}
          </Button>
          <View style={{height: 10}} />
          <Button
            height={50}
            buttonStyle="secondary"
            onPress={() => {
              dispatch(
                AppEffects.openUrlWithInAppBrowser(
                  `${verificationBaseUrl}&context=login`,
                ),
              );
              dispatch(
                Analytics.track(
                  'Bill Pay - Clicked I Already Have an Account',
                ),
              );
            }}>
            {t('I already have an account')}
          </Button>
        </>
      ) : available ? (
        <>
          {!connected ? (
            <>
              <BillPitch />
              <Button
                state={connectButtonState}
                height={50}
                onPress={async () => {
                  connectBills();
                  dispatch(
                    Analytics.track('Bill Pay - Clicked Connect My Bills'),
                  );
                }}>
                {t('Connect My Bills')}
              </Button>
            </>
          ) : (
            <>
              <BillsHeaderContainer>
                <BillsHeader>{t('My Bills')}</BillsHeader>
                <TouchableOpacity
                  activeOpacity={ActiveOpacity}
                  onPress={() => {
                    navigation.navigate(BillScreens.PAYMENTS, {});
                    dispatch(
                      Analytics.track('Bill Pay - Clicked View All Payments'),
                    );
                  }}>
                  <BillsHeaderButton>{t('View All Payments')}</BillsHeaderButton>
                </TouchableOpacity>
              </BillsHeaderContainer>
              <BillList
                accounts={accounts}
                variation={'pay'}
                onPress={account => {
                  navigation.navigate(BillScreens.PAY_BILL, {account});
                  dispatch(
                    Analytics.track(
                      'Bill Pay - Clicked Pay Bill',
                      getBillAccountEventParams(account),
                    ),
                  );
                }}
              />
              {accounts.some(account => account.isPayable) ? (
                <>
                  <Button
                    style={{marginTop: 20, marginBottom: 10}}
                    height={50}
                    buttonStyle="secondary"
                    onPress={() => {
                      navigation.navigate(BillScreens.PAY_ALL_BILLS, {
                        accounts,
                      });
                      dispatch(
                        Analytics.track('Bill Pay — Clicked Pay All Bills'),
                      );
                    }}>
                    {t('Pay All Bills')}
                  </Button>
                  <Button
                    buttonType={'link'}
                    onPress={() => {
                      connectBills();
                      dispatch(
                        Analytics.track(
                          'Bill Pay - Clicked Connect More Bills',
                        ),
                      );
                    }}>
                    {connectButtonState
                      ? t('Loading...')
                      : t('Connect More Bills')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    style={{marginTop: 20, marginBottom: 10}}
                    state={connectButtonState}
                    height={50}
                    buttonStyle="secondary"
                    onPress={() => {
                      connectBills();
                      dispatch(
                        Analytics.track(
                          'Bill Pay - Clicked Connect More Bills',
                        ),
                      );
                    }}>
                    {t('Connect More Bills')}
                  </Button>
                </>
              )}
              <SectionSpacer />
            </>
          )}
        </>
      ) : (
        <>
          <BillsValueProp>
            <CautionIcon />
            <H5>{t("Bill Pay isn't available in your area")}</H5>
            <Subtitle>
              <Trans
                i18nKey="BillPayUnavailableInYourLocation"
                values={{states: t('states')}}
                components={[
                  <Subtitle
                    style={{color: LinkBlue}}
                    onPress={() =>
                      dispatch(
                        AppActions.showBottomNotificationModal({
                          type: 'info',
                          title: t('Available States'),
                          message: t(
                            'Bill Pay is available in Alabama, Alaska, Delaware, District of Columbia, Florida, Georgia, Illinois, Iowa, Kansas, Maine, Massachusetts, Mississippi, Nebraska, New Jersey, New Mexico, Ohio, Oregon, South Dakota, Tennessee, Washington',
                          ),
                          enableBackdropDismiss: true,
                          onBackdropDismiss: () => {},
                          actions: [
                            {
                              text: t('GOT IT'),
                              action: () => {},
                              primary: true,
                            },
                          ],
                        }),
                      )
                    }
                  />,
                ]}
              />
            </Subtitle>
            {isJoinedWaitlist ? (
              <Paragraph style={{textAlign: 'center', fontSize: 14}}>
                {t('You have joined the waitlist.')}
              </Paragraph>
            ) : (
              <Button
                state={waitlistButtonState}
                style={{width: WIDTH - 32, marginTop: 24}}
                height={50}
                buttonStyle="secondary"
                onPress={() => onWaitlistSubmit().catch(_ => {})}>
                {t('Join waitlist')}
              </Button>
            )}
          </BillsValueProp>
        </>
      )}
    </SectionContainer>
  );
};
