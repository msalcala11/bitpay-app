jest.mock('../../../../lib/bwc', () => ({
  BwcProvider: {
    getInstance: jest.fn(),
  },
}));

jest.mock('../../../../managers/LogManager', () => ({
  logManager: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import {BwcProvider} from '../../../../lib/bwc';
import {updateKeyStatus} from './status';

const createBalance = ({
  fiat,
  fiatLastDay,
}: {
  fiat: number;
  fiatLastDay: number;
}) => ({
  sat: 0,
  satAvailable: 0,
  satLocked: 0,
  satConfirmedLocked: 0,
  satConfirmed: 0,
  satConfirmedAvailable: 0,
  satSpendable: 0,
  satPending: 0,
  crypto: '0',
  cryptoLocked: '0',
  cryptoConfirmedLocked: '0',
  cryptoSpendable: '0',
  cryptoPending: '0',
  fiat,
  fiatLocked: 0,
  fiatConfirmedLocked: 0,
  fiatSpendable: 0,
  fiatPending: 0,
  fiatLastDay,
});

describe('updateKeyStatus', () => {
  it('keeps scoped account refreshes from recomputing untouched wallets', async () => {
    const getStatusAll = jest.fn(
      (
        _credentials: unknown,
        _opts: unknown,
        cb: (err: null, bulkStatus: unknown[]) => void,
      ) => cb(null, []),
    );

    (BwcProvider.getInstance as jest.Mock).mockReturnValue({
      getClient: () => ({
        bulkClient: {
          getStatusAll,
        },
      }),
    });

    const scopedWallet = {
      id: 'wallet-scoped',
      receiveAddress: 'account-1',
      pendingTxps: [],
      singleAddress: false,
      pendingTssSession: false,
      currencyAbbreviation: 'btc',
      chain: 'btc',
      network: 'livenet',
      balance: createBalance({fiat: 0, fiatLastDay: 0}),
      credentials: {
        copayerId: 'copayer-1',
        isComplete: () => true,
      },
    };
    const untouchedWallet = {
      id: 'wallet-untouched',
      receiveAddress: 'account-2',
      pendingTxps: [],
      singleAddress: false,
      pendingTssSession: false,
      currencyAbbreviation: 'btc',
      chain: 'btc',
      network: 'livenet',
      balance: createBalance({fiat: 20, fiatLastDay: 15}),
      credentials: {
        copayerId: 'copayer-2',
        isComplete: () => true,
      },
    };
    const key = {
      id: 'key-1',
      wallets: [scopedWallet, untouchedWallet],
    };

    const state = {
      APP: {
        defaultAltCurrency: {
          isoCode: 'USD',
        },
      },
      RATE: {
        rates: {},
        lastDayRates: {},
      },
      WALLET: {
        balanceCacheKey: {},
        useUnconfirmedFunds: false,
      },
    };

    const getState = () => state;
    const dispatch = (action: any) =>
      typeof action === 'function' ? action(dispatch, getState) : action;

    const result = await updateKeyStatus({
      key: key as any,
      accountAddress: 'account-1',
      force: true,
      dataOnly: true,
    })(dispatch as any, getState as any);

    expect(getStatusAll).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        keyId: 'key-1',
        totalBalance: 20,
        totalBalanceLastDay: 15,
      }),
    );
    expect(result?.walletUpdates).toEqual([
      expect.objectContaining({
        walletId: 'wallet-scoped',
      }),
    ]);
  });
});
