import React, {useLayoutEffect, useState} from 'react';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  ActiveOpacity,
  OptionContainer,
  OptionInfoContainer,
  OptionList,
  OptionListContainer,
} from '../../../components/styled/Containers';
import {
  HeaderTitle,
  OptionDescription,
  OptionTitle,
} from '../../../components/styled/Text';
import haptic from '../../../components/haptic-feedback/haptic';
import MultisigOptions from './MultisigOptions';
import {useTranslation} from 'react-i18next';
import {useAppDispatch, useLogger} from '../../../utils/hooks';
import {Analytics} from '../../../store/analytics/analytics.effects';
import {WalletGroupParamList, WalletScreens} from '../WalletGroup';
import {startOnGoingProcessModal} from '../../../store/app/app.effects';
import {startCreateKey} from '../../../store/wallet/effects';
import {
  dismissOnGoingProcessModal,
  setHomeCarouselConfig,
  showBottomNotificationModal,
} from '../../../store/app/app.actions';
import {sleep} from '../../../utils/helper-methods';
import {getBaseKeyCreationCoinsAndTokens} from '../../../constants/currencies';

type CreationOptionsScreenProps = NativeStackScreenProps<
  WalletGroupParamList,
  WalletScreens.CREATION_OPTIONS
>;
export interface Option {
  id: string;
  title: string;
  description: string;
  cta: () => void;
}

const CreationOptions: React.FC<CreationOptionsScreenProps> = ({
  navigation,
}) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const logger = useLogger();
  const [showMultisigOptions, setShowMultisigOptions] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      gestureEnabled: false,
      headerTitle: () => <HeaderTitle>{t('Select an Option')}</HeaderTitle>,
      headerTitleAlign: 'center',
    });
  }, [navigation, t]);

  const optionList: Option[] = [
    {
      id: 'basic',
      title: t('New Key'),
      description: t(
        'Add coins like Bitcoin and Dogecoin and also tokens like USDC and APE',
      ),
      cta: async () => {
        try {
          const context = 'createNewKey';
          dispatch(
            Analytics.track('Clicked Create New Key', {
              context: 'CreationOptions',
            }),
          );
          await dispatch(startOnGoingProcessModal('CREATING_KEY'));
          const createdKey = await dispatch(
            startCreateKey(getBaseKeyCreationCoinsAndTokens()),
          );

          dispatch(setHomeCarouselConfig({id: createdKey.id, show: true}));

          navigation.navigate('BackupKey', {context, key: createdKey});
          dispatch(dismissOnGoingProcessModal());
        } catch (e: any) {
          logger.error(e.message);
          dispatch(dismissOnGoingProcessModal());
          await sleep(500);
          showErrorModal(e.message);
        }
      },
    },
    {
      id: 'import',
      title: t('Import Key'),
      description: t(
        'Use an existing recovery phrase to import an existing wallet',
      ),
      cta: () => {
        dispatch(
          Analytics.track('Clicked Import Key', {
            context: 'CreationOptions',
          }),
        );
        navigation.navigate('Import');
      },
    },
    {
      id: 'multisig',
      title: t('Multisig Wallet'),
      description: t(
        'Requires multiple people or devices and is the most secure',
      ),
      cta: () => setShowMultisigOptions(true),
    },
  ];

  const showErrorModal = (e: string) => {
    dispatch(
      showBottomNotificationModal({
        type: 'warning',
        title: t('Something went wrong'),
        message: e,
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('OK'),
            action: () => {},
            primary: true,
          },
        ],
      }),
    );
  };

  return (
    <>
      <OptionContainer>
        <OptionListContainer>
          {optionList.map(({cta, id, title, description}: Option) => (
            <OptionList
              activeOpacity={ActiveOpacity}
              onPress={() => {
                haptic('impactLight');
                cta();
              }}
              key={id}>
              <OptionInfoContainer>
                <OptionTitle>{title}</OptionTitle>
                <OptionDescription>{description}</OptionDescription>
              </OptionInfoContainer>
            </OptionList>
          ))}
        </OptionListContainer>
      </OptionContainer>
      <MultisigOptions
        isVisible={showMultisigOptions}
        setShowMultisigOptions={setShowMultisigOptions}
      />
    </>
  );
};

export default CreationOptions;
