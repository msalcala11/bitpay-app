import {DeviceEventEmitter} from 'react-native';

import {Effect} from '../../../index';
import {DeviceEmitterEvents} from '../../../../constants/device-emitter-events';
import {logManager} from '../../../../managers/LogManager';
import {getQuoteCurrency} from '../../../../utils/portfolio/assets';
import {maybePopulatePortfolioForWallets} from '../../../portfolio';
import {updatePortfolioBalance} from '../../wallet.actions';
import {findWalletById} from '../../utils/wallet';
import type {Key, Recipient, Status, Wallet} from '../../wallet.models';
import {startUpdateWalletStatus} from './status';

const maybePopulatePortfolioChartsForWalletIds = async ({
  dispatch,
  getState,
  walletIds,
}: {
  dispatch: any;
  getState: () => any;
  walletIds: string[];
}): Promise<void> => {
  const uniqueWalletIds = Array.from(
    new Set(
      (walletIds || []).filter((walletId): walletId is string => !!walletId),
    ),
  );

  if (!uniqueWalletIds.length) {
    return;
  }

  const state = getState();
  const keys = (state.WALLET?.keys || {}) as Record<string, Key>;
  const wallets = (Object.values(keys) as Key[])
    .flatMap((walletKey: Key) => walletKey.wallets || [])
    .filter((currentWallet: Wallet) => uniqueWalletIds.includes(currentWallet.id));

  if (!wallets.length) {
    return;
  }

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency: state.PORTFOLIO?.quoteCurrency,
    defaultAltCurrencyIsoCode: state.APP?.defaultAltCurrency?.isoCode,
  }).toUpperCase();

  await dispatch(
    maybePopulatePortfolioForWallets({
      wallets,
      quoteCurrency,
    }) as any,
  );
};

/*
 * post broadcasting of payment
 * poll for updated balance -> update balance for: wallet, key, portfolio and local recipient wallet if applicable
 *
 * Kept in its own module so the post-send chart refresh can depend on the
 * portfolio effects without reintroducing the status <-> portfolio require cycle.
 */
export const waitForTargetAmountAndUpdateWallet =
  ({
    key,
    wallet,
    targetAmount,
    recipient,
  }: {
    key: Key;
    wallet: Wallet;
    targetAmount: number;
    recipient?: Recipient;
  }): Effect =>
  async (dispatch, getState) => {
    try {
      // Update history for showing confirming transactions
      DeviceEventEmitter.emit(DeviceEmitterEvents.WALLET_LOAD_HISTORY);

      let retry = 0;

      // wait for expected balance
      const interval = setInterval(() => {
        console.log('waiting for target balance', retry);
        retry++;

        if (retry > 5) {
          DeviceEventEmitter.emit(DeviceEmitterEvents.SET_REFRESHING, false);
          clearInterval(interval);
          return;
        }

        const {
          credentials: {token, multisigEthInfo},
        } = wallet;

        wallet.getStatus(
          {
            tokenAddress: token ? token.address : null,
            multisigContractAddress: multisigEthInfo
              ? multisigEthInfo.multisigContractAddress
              : null,
            network: wallet.network,
          },
          async (err: any, status: Status) => {
            if (err) {
              const errStr =
                err instanceof Error ? err.message : JSON.stringify(err);
              logManager.error(
                `error [waitForTargetAmountAndUpdateWallet]: ${errStr}`,
              );
            }

            const totalAmount = status?.balance?.totalAmount;

            // TODO ETH totalAmount !== targetAmount while the transaction is unconfirmed
            // expected amount - update balance
            if (totalAmount === targetAmount) {
              clearInterval(interval);
              const updatedWalletIds = new Set<string>([wallet.id]);

              await dispatch(
                startUpdateWalletStatus({key, wallet, force: true}),
              );

              // update recipient balance if local
              if (recipient) {
                const {walletId, keyId} = recipient;
                if (walletId && keyId) {
                  const {
                    WALLET: {keys},
                  } = getState();
                  const recipientKey = keys[keyId];
                  const recipientWallet = recipientKey
                    ? findWalletById(recipientKey.wallets, walletId)
                    : undefined;
                  if (recipientKey && recipientWallet) {
                    await dispatch(
                      startUpdateWalletStatus({
                        key: recipientKey,
                        wallet: recipientWallet as Wallet,
                        force: true,
                      }),
                    );
                    updatedWalletIds.add(walletId);
                    console.log('updated recipient wallet');
                  }
                }
              }

              DeviceEventEmitter.emit(DeviceEmitterEvents.WALLET_LOAD_HISTORY);
              await dispatch(updatePortfolioBalance());
              await maybePopulatePortfolioChartsForWalletIds({
                dispatch,
                getState,
                walletIds: Array.from(updatedWalletIds),
              });
              DeviceEventEmitter.emit(
                DeviceEmitterEvents.SET_REFRESHING,
                false,
              );
            }
          },
        );
      }, 5000);
    } catch (err) {
      const errstring =
        err instanceof Error ? err.message : JSON.stringify(err);
      logManager.error(
        `Error WaitingForTargetAmountAndUpdateWallet: ${errstring}`,
      );
    }
  };
