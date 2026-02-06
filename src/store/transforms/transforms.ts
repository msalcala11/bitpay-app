import merge from 'lodash.merge';
import {createTransform} from 'redux-persist';
import {Key, Wallet} from '../wallet/wallet.models';
import {BwcProvider} from '../../lib/bwc';
import type {PortfolioState} from '../portfolio/portfolio.models';
import type {BalanceSnapshot} from '../portfolio/portfolio.models';
import {
  BitpaySupportedUtxoCoins,
  OtherBitpaySupportedCoins,
} from '../../constants/currencies';
import {ContactState} from '../contact/contact.reducer';
import {WalletState} from '../wallet/wallet.reducer';
import {buildWalletObj} from '../wallet/utils/wallet';
import {ContactRowProps} from '../../components/list/ContactRow';
import {getErrorString} from '../../utils/helper-methods';
import {LogActions} from '../log';
import * as initLogs from '../log/initLogs';
import {
  encryptAppStore,
  decryptAppStore,
  encryptShopStore,
  decryptShopStore,
  encryptWalletStore,
  decryptWalletStore,
} from './encrypt';
import {logManager} from '../../managers/LogManager';
import {
  hydrateBalanceSnapshotsFromSeriesV1,
  isBalanceSnapshotSeriesV1,
  packBalanceSnapshotsToSeriesV1,
} from '../../core/pnl/snapshotSeries';
import type {BalanceSnapshotStored} from '../../core/pnl/types';

const getUtcDayStartMs = (tsMs: number): number => {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const BWCProvider = BwcProvider.getInstance();

// Helper for logging transform failures before the store exists
const logTransformFailure = (
  phase: 'encrypt' | 'decrypt',
  store: 'Wallet' | 'App' | 'Shop',
  error: unknown,
) => {
  try {
    initLogs.add(
      LogActions.persistLog(
        LogActions.error(
          `${phase}${store}Store failed - ${getErrorString(error)}`,
        ),
      ),
    );
  } catch (_) {}
};

export const bootstrapWallets = (wallets: Wallet[]) => {
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
        logManager.info(successLog);
        // build wallet obj with bwc client credentials
        return merge(
          walletClient,
          wallet,
          buildWalletObj({
            ...walletClient.credentials,
            ...wallet,
          } as any),
        );
      } catch (err: unknown) {
        const errorLog = `Failed to bindWalletClient - ${
          wallet.id
        } - ${getErrorString(err)}`;
        initLogs.add(LogActions.persistLog(LogActions.error(errorLog)));
      }
    })
    .filter((w): w is NonNullable<typeof w> => w !== undefined);
};

export const bootstrapKey = (key: Key, id: string) => {
  if (id === 'readonly') {
    return key;
  } else if (key.hardwareSource) {
    return key;
  } else if (key.properties?.metadata) {
    try {
      const TssKey = BWCProvider.getTssKey();
      const properties = JSON.parse(JSON.stringify(key.properties));

      if (key.properties.keychain?.privateKeyShare?.data) {
        properties.keychain.privateKeyShare = Buffer.from(
          key.properties.keychain.privateKeyShare.data,
        );
        console.log(
          '[bootstrapKey] privateKeyShare restored, length:',
          properties.keychain.privateKeyShare.length,
        );
      } else if (Buffer.isBuffer(key.properties.keychain?.privateKeyShare)) {
        properties.keychain.privateKeyShare =
          key.properties.keychain.privateKeyShare;
        console.log(
          '[bootstrapKey] privateKeyShare already Buffer, length:',
          properties.keychain.privateKeyShare.length,
        );
      }

      if (key.properties.keychain?.reducedPrivateKeyShare?.data) {
        properties.keychain.reducedPrivateKeyShare = Buffer.from(
          key.properties.keychain.reducedPrivateKeyShare.data,
        );
      } else if (
        Buffer.isBuffer(key.properties.keychain?.reducedPrivateKeyShare)
      ) {
        properties.keychain.reducedPrivateKeyShare =
          key.properties.keychain.reducedPrivateKeyShare;
      }
      const tssKey = new TssKey(properties);
      const _key = merge(key, {
        methods: tssKey,
      });

      const successLog = `bindTssKey - ${id}`;
      initLogs.add(LogActions.info(successLog));
      return _key;
    } catch (err: unknown) {
      const errorLog = `Failed to bindTssKey - ${id} - ${getErrorString(err)}`;
      initLogs.add(LogActions.persistLog(LogActions.error(errorLog)));
    }
  } else {
    try {
      const _key = merge(key, {
        methods: BWCProvider.createKey({
          seedType: 'object',
          seedData: key.properties,
        }),
      });
      const successLog = `bindKey - ${id}`;
      logManager.info(successLog);
      return _key;
    } catch (err: unknown) {
      const errorLog = `Failed to bindWalletKeys - ${id} - ${getErrorString(
        err,
      )}`;
      initLogs.add(LogActions.persistLog(LogActions.error(errorLog)));
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
        const bootstrappedKey = bootstrapKey(key, id);
        const wallets = bootstrapWallets(key.wallets);

        if (bootstrappedKey) {
          outboundState.keys[id] = {...bootstrappedKey, wallets};
        }
      }
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

export const transformPortfolioPopulateStatus = createTransform<
  PortfolioState,
  PortfolioState
>(
  inboundState => inboundState,
  outboundState => {
    if (outboundState?.populateStatus?.inProgress) {
      return {
        ...outboundState,
        populateStatus: {
          ...outboundState.populateStatus,
          inProgress: false,
          currentWalletId: undefined,
        },
      };
    }
    return outboundState;
  },
  {whitelist: ['PORTFOLIO']},
);

// Persist portfolio snapshots in a compact series format to reduce storage + parse costs.
const ENABLE_PORTFOLIO_SNAPSHOT_SERIES_PERSIST_COMPRESSION = true;

export const transformPortfolioSnapshotSeriesV1 = createTransform<
  PortfolioState,
  any
>(
  inboundState => {
    if (!ENABLE_PORTFOLIO_SNAPSHOT_SERIES_PERSIST_COMPRESSION) {
      return inboundState;
    }
    try {
      const map = (inboundState as any)?.snapshotsByWalletId || {};
      const outMap: Record<string, any> = {};

      for (const [walletId, snapsRaw] of Object.entries(map)) {
        const snaps = Array.isArray(snapsRaw) ? (snapsRaw as BalanceSnapshot[]) : [];
        if (!snaps.length) continue;

        const compressionEnabled = snaps.some(s => (s as any)?.eventType === 'daily');
        const createdAt =
          typeof (snaps[snaps.length - 1] as any)?.createdAt === 'number'
            ? Number((snaps[snaps.length - 1] as any).createdAt)
            : Date.now();

        const minimal: BalanceSnapshotStored[] = snaps.map(s => {
          const markRate =
            typeof (s as any)?.costBasisRateFiat === 'number'
              ? (s as any).costBasisRateFiat
              : typeof (s as any)?.markRate === 'number'
                ? (s as any).markRate
                : 0;

          return {
            id: String((s as any)?.id || ''),
            walletId: String((s as any)?.walletId || walletId),
            chain: String((s as any)?.chain || ''),
            coin: String((s as any)?.coin || ''),
            network: String((s as any)?.network || ''),
            assetId: String((s as any)?.assetId || ''),
            timestamp: Number((s as any)?.timestamp || 0),
            eventType: ((s as any)?.eventType || 'tx') as any,
            txIds: Array.isArray((s as any)?.txIds) ? (s as any).txIds.map(String) : undefined,
            cryptoBalance: String((s as any)?.cryptoBalance || '0'),
            balanceDeltaAtomic: (s as any)?.balanceDeltaAtomic,
            remainingCostBasisFiat: Number((s as any)?.remainingCostBasisFiat || 0),
            quoteCurrency: String((s as any)?.quoteCurrency || (inboundState as any)?.quoteCurrency || ''),
            markRate: Number(markRate || 0),
            createdAt: typeof (s as any)?.createdAt === 'number' ? (s as any).createdAt : undefined,
          };
        });

        const series = packBalanceSnapshotsToSeriesV1({
          snapshots: minimal,
          compressionEnabled,
          createdAt,
        });

        if (series) {
          outMap[walletId] = series;
        }
      }

      return {
        ...inboundState,
        snapshotsByWalletId: outMap as any,
      };
    } catch (_) {
      return inboundState;
    }
  },
  outboundState => {
    try {
      const map = (outboundState as any)?.snapshotsByWalletId || {};
      const outMap: Record<string, BalanceSnapshot[]> = {};

      for (const [walletId, value] of Object.entries(map)) {
        if (isBalanceSnapshotSeriesV1(value)) {
          const minimal = hydrateBalanceSnapshotsFromSeriesV1(value);
          const snaps: BalanceSnapshot[] = minimal.map(s => {
            const units = Number(s.cryptoBalance || '0');
            const markRate = Number(s.markRate || 0);
            const fiatBalance = units * markRate;
            const remainingCostBasisFiat = Number(s.remainingCostBasisFiat || 0);
            const avgCostFiatPerUnit = units > 0 ? remainingCostBasisFiat / units : 0;
            const unrealizedPnlFiat = fiatBalance - remainingCostBasisFiat;
            const txIds =
              Array.isArray(s.txIds) && s.txIds.length > 1 ? s.txIds : undefined;

            return {
              id: s.id,
              chain: s.chain,
              coin: s.coin,
              network: s.network,
              assetId: s.assetId,
              timestamp: s.timestamp,
              dayStartMs: s.eventType === 'daily' ? getUtcDayStartMs(s.timestamp) : undefined,
              eventType: s.eventType,
              txIds,
              balanceDeltaAtomic: s.balanceDeltaAtomic,
              cryptoBalance: s.cryptoBalance,
              avgCostFiatPerUnit,
              remainingCostBasisFiat,
              unrealizedPnlFiat,
              costBasisRateFiat: markRate,
              quoteCurrency: s.quoteCurrency,
              createdAt: s.createdAt,
            } as BalanceSnapshot;
          });
          outMap[walletId] = snaps;
        } else if (Array.isArray(value)) {
          // Support uncompressed/raw snapshots when inbound packing is disabled.
          outMap[walletId] = value as BalanceSnapshot[];
        }
      }

      return {
        ...outboundState,
        snapshotsByWalletId: outMap,
      };
    } catch (_) {
      return outboundState;
    }
  },
  {whitelist: ['PORTFOLIO']},
);

export const encryptSpecificFields = (secretKey: string) => {
  return createTransform(
    // Encrypt specified fields on inbound (saving to storage)
    (inboundState, key) => {
      if (key === 'WALLET') {
        try {
          return encryptWalletStore(inboundState, secretKey);
        } catch (error) {
          logTransformFailure('encrypt', 'Wallet', error);
        }
      }
      if (key === 'APP') {
        try {
          return encryptAppStore(inboundState, secretKey);
        } catch (error) {
          logTransformFailure('encrypt', 'App', error);
        }
      }
      if (key === 'SHOP') {
        try {
          return encryptShopStore(inboundState, secretKey);
        } catch (error) {
          logTransformFailure('encrypt', 'Shop', error);
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
          logTransformFailure('decrypt', 'Wallet', error);
        }
      }
      if (key === 'APP') {
        try {
          return decryptAppStore(outboundState, secretKey);
        } catch (error) {
          logTransformFailure('decrypt', 'App', error);
        }
      }
      if (key === 'SHOP') {
        try {
          return decryptShopStore(outboundState, secretKey);
        } catch (error) {
          logTransformFailure('decrypt', 'Shop', error);
        }
      }
      return outboundState;
    },
  );
};
