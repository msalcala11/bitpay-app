import {BwcProvider} from '../../../../lib/bwc';
import {BitpaySupportedCoins} from '../../../../constants/currencies';
import {getCurrencyCodeFromCoinAndChain} from '../../../../navigation/bitpay-id/utils/bitpay-id-utils';
import {Effect} from '../../..';
import {LogActions} from '../../../log';

const BWC = BwcProvider.getInstance();
export interface PayProPaymentOption {
  chain: string;
  currency: string;
  decimals: number;
  estimatedAmount: number;
  minerFee: number;
  network: string;
  requiredFeeRate: number;
  selected: boolean;
}
export interface PayProOptions {
  time: string;
  expires: string;
  memo: string;
  paymentId: string;
  paymentOptions: PayProPaymentOption[];
  payProUrl: string;
  verified: boolean;
}

export const GetPayProOptions =
  (paymentUrl: string, attempt: number = 1): Effect<Promise<PayProOptions>> =>
  async (dispatch): Promise<PayProOptions> => {
    dispatch(LogActions.info('PayPro Options: try... ' + attempt));
    const bwc = BWC.getPayProV2();
    const options: any = {
      paymentUrl,
      unsafeBypassValidation: true,
    };
    const payOpts = await bwc.getPaymentOptions(options).catch(async err => {
      let errorStr;
      if (err instanceof Error) {
        errorStr = err.message;
      } else {
        errorStr = JSON.stringify(err);
      }
      dispatch(LogActions.error(`PayPro Options ERR: ${errorStr}`));
      if (attempt <= 0) {
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
        return dispatch(GetPayProOptions(paymentUrl, ++attempt));
      } else {
        throw err;
      }
    });
    dispatch(
      LogActions.info('PayPro Options: SUCCESS', JSON.stringify(payOpts)),
    );
    console.log('payOpts', JSON.stringify(payOpts, null, 4));
    return payOpts;
  };

export const GetPayProDetails =
  (params: {
    paymentUrl: string;
    coin: string;
    chain: string;
    payload?: {address?: string};
    attempt?: number;
  }): Effect<Promise<any>> =>
  async (dispatch): Promise<any> => {
    let {paymentUrl, coin, chain, payload, attempt = 1} = params;
    dispatch(LogActions.info('PayPro Details: try... ' + attempt));
    const bwc = BWC.getPayProV2();
    const options: any = {
      paymentUrl,
      chain: chain.toUpperCase(),
      currency: getCurrencyCodeFromCoinAndChain(coin.toLowerCase(), chain),
      payload,
      unsafeBypassValidation: true,
    };

    const payDetails = await bwc
      .selectPaymentOption(options)
      .catch(async err => {
        let errorStr;
        if (err instanceof Error) {
          errorStr = err.message;
        } else {
          errorStr = JSON.stringify(err);
        }
        dispatch(LogActions.error(`PayPro Details ERR: ${errorStr}`));
        if (attempt <= 0) {
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          return dispatch(
            GetPayProDetails({
              paymentUrl,
              coin,
              chain,
              payload,
              attempt: ++attempt,
            }),
          );
        } else {
          throw err;
        }
      });
    dispatch(
      LogActions.info('PayPro Details: SUCCESS', JSON.stringify(payDetails)),
    );
    console.log('payDetails', JSON.stringify(payDetails, null, 4));
    return payDetails;
  };

export const HandlePayPro =
  ({
    payProDetails,
    payProOptions,
    url,
    coin,
    chain,
  }: {
    payProDetails: any;
    payProOptions?: PayProOptions;
    url: string;
    coin: string;
    chain: string;
  }): Effect<Promise<any>> =>
  async (dispatch): Promise<any> => {
    if (!payProDetails) {
      return;
    }
    let invoiceID;
    let requiredFeeRate;

    if (payProDetails.requiredFeeRate) {
      requiredFeeRate = !BitpaySupportedCoins[chain.toLowerCase()].properties
        .isUtxo
        ? parseInt((payProDetails.requiredFeeRate * 1.1).toFixed(0), 10) // Workaround to avoid gas price supplied is lower than requested error
        : Math.ceil(payProDetails.requiredFeeRate * 1000);
    }

    try {
      const {memo, network} = payProDetails;
      if (!payProOptions) {
        payProOptions = await dispatch(GetPayProOptions(url));
      }
      console.log('payProOptions', JSON.stringify(payProOptions, null, 4));
      const invoiceCurrency = getCurrencyCodeFromCoinAndChain(
        GetInvoiceCurrency(coin).toLowerCase(),
        chain,
      );
      const paymentOptions = payProOptions.paymentOptions;
      const {estimatedAmount, minerFee} = paymentOptions.find(
        option => option?.currency === invoiceCurrency,
      ) as PayProPaymentOption;
      const {outputs, toAddress, data, gasLimit} =
        payProDetails.instructions[0];
      if (coin === 'xrp' && outputs) {
        invoiceID = outputs[0].invoiceID;
      }
      const confirmScreenParams = {
        amount: estimatedAmount,
        toAddress,
        description: memo,
        data,
        gasLimit,
        invoiceID,
        payPro: payProDetails,
        coin,
        network,
        payProUrl: url,
        requiredFeeRate,
        minerFee, // For payments with Coinbase accounts
      };
      return confirmScreenParams;
    } catch (err) {
      let errorStr;
      if (err instanceof Error) {
        errorStr = err.message;
      } else {
        errorStr = JSON.stringify(err);
      }
      dispatch(LogActions.error(`HandlePayPro ERR: ${errorStr}`));
    }
  };

export const GetInvoiceCurrency = (c: string) => {
  switch (c.toUpperCase()) {
    case 'USDP':
      return 'PAX'; // TODO workaround. Remove this when usdp is accepted as an option
    default:
      return c;
  }
};
