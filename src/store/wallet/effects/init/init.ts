import {Effect, RootState} from '../../../index';
import {WalletActions} from '../../index';
import {startGetRates} from '../rates/rates';
import {startGetTokenOptions} from '../currencies/currencies';
import {startUpdateAllWalletStatusForKeysNoUI} from '../status/status';
import {LogActions} from '../../../log';
import {successUpdateKeysTotalBalance, successUpdateWalletStatus} from '../../wallet.actions';

export const startWalletStoreInit =
  (): Effect<Promise<void>> => async (dispatch, getState: () => RootState) => {
    dispatch(LogActions.info('starting [startWalletStoreInit]'));
    try {
      const {WALLET} = getState();

      // both needed for startUpdateAllKeyAndWalletStatus
      await dispatch(startGetTokenOptions()); // needed for getRates. Get more recent 1inch tokens list
      await dispatch(startGetRates({init: true})); // populate rates and alternative currency list

      if (Object.keys(WALLET.keys).length) {
        // Use the no-UI version and collect all updates
        const {keyUpdates, walletUpdates} = await dispatch(
          startUpdateAllWalletStatusForKeysNoUI({
            keys: Object.values(WALLET.keys),
            force: true,
          }),
        );

        // Batch dispatch all wallet updates
        walletUpdates.forEach(({wallet, balance, pendingTxps, singleAddress}) => {
          dispatch(
            successUpdateWalletStatus({
              keyId: wallet.credentials.keyId,
              walletId: wallet.id,
              status: {
                balance,
                pendingTxps,
                singleAddress: !!singleAddress,
              },
            }),
          );
        });

        // Single dispatch for all key updates
        if (keyUpdates.length > 0) {
          dispatch(successUpdateKeysTotalBalance(keyUpdates));
        }
      }

      dispatch(WalletActions.successWalletStoreInit());
      dispatch(LogActions.info('success [startWalletStoreInit]'));
    } catch (e) {
      let errorStr;
      if (e instanceof Error) {
        errorStr = e.message;
      } else {
        errorStr = JSON.stringify(e);
      }
      dispatch(WalletActions.failedWalletStoreInit());
      dispatch(LogActions.error(`failed [startWalletStoreInit]: ${errorStr}`));
    }
  };
