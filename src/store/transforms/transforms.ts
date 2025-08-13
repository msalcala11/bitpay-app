import merge from 'lodash.merge';
import {createTransform} from 'redux-persist';
import {Key, Wallet} from '../wallet/wallet.models';
import {BwcProvider} from '../../lib/bwc';
import {
  BitpaySupportedUtxoCoins,
  OtherBitpaySupportedCoins,
} from '../../constants/currencies';
import {ContactState} from '../contact/contact.reducer';
import {WalletState} from '../wallet/wallet.reducer';
import {buildWalletObj} from '../wallet/utils/wallet';
import {ContactRowProps} from '../../components/list/ContactRow';
import {AddLog} from '../log/log.types';
import {LogActions} from '../log';
import * as preStoreLogs from '../log/preStoreLogs';
import {
  encryptAppStore,
  decryptAppStore,
  encryptShopStore,
  decryptShopStore,
  encryptWalletStore,
  decryptWalletStore,
} from './encrypt';

const BWCProvider = BwcProvider.getInstance();
const initLogs: AddLog[] = [];

const errorToString = (error: unknown): string =>
  error instanceof Error ? error.message : JSON.stringify(error);

// Helper for logging transform failures before the store exists
const logTransformFailure = (
  phase: 'encrypt' | 'decrypt',
  store: 'Wallet' | 'App' | 'Shop',
  error: unknown,
) => {
  preStoreLogs.add(
    LogActions.persistLog(
      LogActions.error(
        `${phase}${store}Store failed - ${errorToString(error)}`,
      ),
    ),
  );
};

export const bootstrapWallets = (
  wallets: Wallet[],
  logHandler?: (addLog: AddLog) => {},
) => {
  return wallets
    .map(wallet => {
      try {
        // reset transaction history
        wallet.transactionHistory = {
          transactions: [],
          loadMore: true,
          hasConfirmingTxs: false,
        };
        const walletClient = BWCProvider.getClient(
          JSON.stringify(wallet.credentials),
        );
        const successLog = `bindWalletClient - ${wallet.id}`;
        if (logHandler) {
          logHandler(LogActions.info(successLog));
        }
        // build wallet obj with bwc client credentials
        return merge(
          walletClient,
          wallet,
          buildWalletObj({
            ...walletClient.credentials,
            ...wallet,
          }),
        );
      } catch (err: unknown) {
        const errStr = err instanceof Error ? err.message : JSON.stringify(err);
        const errorLog = `Failed to bindWalletClient - ${wallet.id} - ${errStr}`;
        if (logHandler) {
          logHandler(LogActions.persistLog(LogActions.error(errorLog)));
        }
      }
    })
    .filter((w): w is NonNullable<typeof w> => w !== undefined);
};

export const bootstrapKey = (
  key: Key,
  id: string,
  logHandler?: (addLog: AddLog) => {},
) => {
  if (id === 'readonly') {
    return key;
  } else if (key.hardwareSource) {
    return key;
  } else {
    try {
      const _key = merge(key, {
        methods: BWCProvider.createKey({
          seedType: 'object',
          seedData: key.properties,
        }),
      });
      const successLog = `bindKey - ${id}`;
      if (logHandler) {
        logHandler(LogActions.info(successLog));
      }
      return _key;
    } catch (err: unknown) {
      const errStr = err instanceof Error ? err.message : JSON.stringify(err);
      const errorLog = `Failed to bindWalletKeys - ${id} - ${errStr}`;
      if (logHandler) {
        logHandler(LogActions.persistLog(LogActions.error(errorLog)));
      }
    }
  }
};

export const bindWalletKeys = createTransform<WalletState, WalletState>(
  // transform state on its way to being serialized and persisted.
  inboundState => {
    const keys = inboundState.keys || {};
    if (Object.keys(keys).length > 0) {
      for (const [id, key] of Object.entries(keys)) {
        key.wallets.forEach(wallet => delete wallet.transactionHistory);

        inboundState.keys[id] = {
          ...key,
        };
      }
    }
    return inboundState;
  },
  // transform state being rehydrated
  outboundState => {
    const keys = outboundState.keys || {};
    if (Object.keys(keys).length > 0) {
      for (const [id, key] of Object.entries(keys)) {
        const bootstrappedKey = bootstrapKey(key, id, log =>
          initLogs.push(log),
        );
        const wallets = bootstrapWallets(key.wallets, log =>
          initLogs.push(log),
        );

        if (bootstrappedKey) {
          outboundState.keys[id] = {...bootstrappedKey, wallets};
        }
      }

      outboundState.initLogs = initLogs;
    }
    return outboundState;
  },
  {whitelist: ['WALLET']},
);

export const transformContacts = createTransform<ContactState, ContactState>(
  inboundState => inboundState,
  outboundState => {
    try {
      const contactList = outboundState.list || [];
      if (contactList.length > 0) {
        const migratedContacts = contactList.map(contact => ({
          ...contact,
          chain:
            contact.chain ||
            (OtherBitpaySupportedCoins[contact.coin] ||
            BitpaySupportedUtxoCoins[contact.coin]
              ? contact.coin
              : 'eth'),
        })) as ContactRowProps[];
        outboundState.list = migratedContacts;
      }
      return outboundState;
    } catch (_) {
      return outboundState;
    }
  },
  {whitelist: ['CONTACT']},
);

export const encryptSpecificFields = (secretKey: string) => {
  return createTransform(
    // Encrypt specified fields on inbound (saving to storage)
    (inboundState, key) => {
      if (key === 'WALLET') {
        try {
          return encryptWalletStore(inboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('encrypt', 'Wallet', error);
          } catch (_) {}
        }
      }
      if (key === 'APP') {
        try {
          return encryptAppStore(inboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('encrypt', 'App', error);
          } catch (_) {}
        }
      }
      if (key === 'SHOP') {
        try {
          return encryptShopStore(inboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('encrypt', 'Shop', error);
          } catch (_) {}
        }
      }
      return inboundState;
    },
    // Decrypt specified fields on outbound (loading from storage)
    (outboundState, key) => {
      if (key === 'WALLET') {
        try {
          return decryptWalletStore(outboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('decrypt', 'Wallet', error);
          } catch (_) {}
        }
      }
      if (key === 'APP') {
        try {
          return decryptAppStore(outboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('decrypt', 'App', error);
          } catch (_) {}
        }
      }
      if (key === 'SHOP') {
        try {
          return decryptShopStore(outboundState, secretKey);
        } catch (error) {
          try {
            logTransformFailure('decrypt', 'Shop', error);
          } catch (_) {}
        }
      }
      return outboundState;
    },
  );
};
