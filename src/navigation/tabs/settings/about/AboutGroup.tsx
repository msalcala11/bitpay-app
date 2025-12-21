import React from 'react';
import {Theme} from '@react-navigation/native';
import SessionLogs from './screens/SessionLog';
import SendFeedback, {SendFeedbackParamList} from './screens/SendFeedback';
import {useTranslation} from 'react-i18next';
import StorageUsage from './screens/StorageUsage';
import PortfolioStorageDebug from './screens/PortfolioStorageDebug';
import PortfolioWalletTxEventsDebug from './screens/PortfolioWalletTxEventsDebug';
import {Root} from '../../../../Root';
import {useStackScreenOptions} from '../../../utils/headerHelpers';

interface AboutProps {
  About: typeof Root;
  theme: Theme;
}

export type AboutGroupParamList = {
  StorageUsage: undefined;
  PortfolioStorageDebug: undefined;
  PortfolioWalletTxEventsDebug: {walletId: string};
  SessionLogs: undefined;
  SendFeedback: SendFeedbackParamList | undefined;
};

export enum AboutScreens {
  STORAGE_USAGE = 'StorageUsage',
  PORTFOLIO_STORAGE_DEBUG = 'PortfolioStorageDebug',
  PORTFOLIO_WALLET_TX_EVENTS_DEBUG = 'PortfolioWalletTxEventsDebug',
  SESSION_LOGS = 'SessionLogs',
  SEND_FEEDBACK = 'SendFeedback',
}

const AboutGroup = ({About, theme}: AboutProps) => {
  const commonOptions = useStackScreenOptions(theme);
  const {t} = useTranslation();
  return (
    <About.Group screenOptions={commonOptions}>
      <About.Screen
        name={AboutScreens.STORAGE_USAGE}
        component={StorageUsage}
        options={{
          headerTitle: t('Storage Usage'),
        }}
      />
      <About.Screen
        name={AboutScreens.PORTFOLIO_STORAGE_DEBUG}
        component={PortfolioStorageDebug}
        options={{
          headerTitle: t('Portfolio Storage Debug'),
        }}
      />
      <About.Screen
        name={AboutScreens.PORTFOLIO_WALLET_TX_EVENTS_DEBUG}
        component={PortfolioWalletTxEventsDebug}
        options={{
          headerTitle: t('Portfolio Wallet Tx Events'),
        }}
      />
      <About.Screen
        name={AboutScreens.SESSION_LOGS}
        component={SessionLogs}
        options={{
          headerTitle: t('Session Logs'),
        }}
      />

      <About.Screen
        name={AboutScreens.SEND_FEEDBACK}
        component={SendFeedback}
        options={{
          headerTitle: t('Send Feedback'),
        }}
      />
    </About.Group>
  );
};

export default AboutGroup;
