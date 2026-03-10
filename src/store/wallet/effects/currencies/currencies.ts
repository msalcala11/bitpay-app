import {Effect} from '../../../index';
import axios from 'axios';
import {Token} from '../../wallet.models';
import {
  failedGetTokenOptions,
  successGetCustomTokenOptions,
  successImport,
} from '../../wallet.actions';
import {
  BitpaySupportedTokens,
  CurrencyOpts,
  SUPPORTED_VM_TOKENS,
} from '../../../../constants/currencies';
import {BASE_BWS_URL} from '../../../../constants/config';
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';
import {AppActions} from '../../../app';
import {buildWalletObj, mapAbbreviationAndName} from '../../utils/wallet';
import merge from 'lodash.merge';
import {tokenManager} from '../../../../managers/TokenManager';
import {logManager} from '../../../../managers/LogManager';
import {populateTokenInfo} from '../../utils/token-options';
import {AppDispatch} from '../../../../utils/hooks';

const TOKEN_OPTIONS_YIELD_EVERY = 150;
let tokenOptionsRefreshPromise: Promise<void> | null = null;

const yieldToEventLoop = (): Promise<void> => {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
      return;
    }
    setTimeout(resolve, 0);
  });
};

export const startGetTokenOptions =
  (): Effect<Promise<void>> => async dispatch => {
    logManager.info('starting [startGetTokenOptions]');

    if (
      Object.keys(tokenManager.getTokenOptions().tokenOptionsByAddress).length
    ) {
      dispatch(AppActions.appTokensDataLoaded());
      refreshTokenOptionsFromNetwork(dispatch);
      return;
    }

    await refreshTokenOptionsFromNetwork(dispatch);
  };

export const addCustomTokenOption =
  (token: Token, chain: string): Effect =>
  async dispatch => {
    try {
      const customTokenOptionsByAddress: {[key in string]: Token} = {};
      const customTokenDataByAddress: {[key in string]: CurrencyOpts} = {};
      if (
        BitpaySupportedTokens[getCurrencyAbbreviation(token.address, chain)]
      ) {
        return;
      } // remove bitpay supported tokens and currencies
      populateTokenInfo({
        chain,
        token,
        tokenOptionsByAddress: customTokenOptionsByAddress,
        tokenDataByAddress: customTokenDataByAddress,
      });
      dispatch(
        successGetCustomTokenOptions({
          customTokenOptionsByAddress,
          customTokenDataByAddress,
        }),
      );
    } catch (e) {
      const errString = e instanceof Error ? e.message : JSON.stringify(e);
      logManager.error(`Add custom options: ${errString}`);
      dispatch(failedGetTokenOptions());
    }
  };

const refreshTokenOptionsFromNetwork = async (
  dispatch: AppDispatch,
): Promise<void> => {
  if (tokenOptionsRefreshPromise) {
    return tokenOptionsRefreshPromise;
  }

  tokenOptionsRefreshPromise = (async () => {
    try {
      let tokenOptionsByAddress: {[key in string]: Token} = {};
      let tokenDataByAddress: {[key in string]: CurrencyOpts} = {};

      for await (const chain of SUPPORTED_VM_TOKENS) {
        let tokens: Token[] = [];
        try {
          const {data} = await axios.get<Token[]>(
            `${BASE_BWS_URL}/v1/service/oneInch/getTokens/${chain}`,
          );
          tokens = data;
        } catch {
          logManager.info(
            `request: ${BASE_BWS_URL}/v1/service/oneInch/getTokens/${chain} failed - continue anyway [startGetTokenOptions]`,
          );
        }

        if (!Array.isArray(tokens)) {
          logManager.error(
            `Unexpected response [startGetTokenOptions]: ${tokens}`,
          );
          return;
        }

        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
          const token = tokens[tokenIndex];
          if (
            BitpaySupportedTokens[getCurrencyAbbreviation(token.address, chain)]
          ) {
            continue;
          }

          populateTokenInfo({
            chain,
            token,
            tokenOptionsByAddress,
            tokenDataByAddress,
          });

          if (
            tokenIndex > 0 &&
            tokenIndex % TOKEN_OPTIONS_YIELD_EVERY === 0
          ) {
            await yieldToEventLoop();
          }
        }

        await yieldToEventLoop();
      }

      tokenManager.setTokenOptions({tokenOptionsByAddress, tokenDataByAddress});
      logManager.info('successful [startGetTokenOptions]');
    } catch (e) {
      const errorStr = e instanceof Error ? e.message : JSON.stringify(e);
      dispatch(failedGetTokenOptions());
      logManager.error(`failed [startGetTokenOptions]: ${errorStr}`);
    } finally {
      dispatch(AppActions.appTokensDataLoaded());
      tokenOptionsRefreshPromise = null;
    }
  })();

  return tokenOptionsRefreshPromise;
};

export const startCustomTokensMigration =
  (): Effect<Promise<void>> =>
  async (dispatch, getState): Promise<void> => {
    return new Promise(async resolve => {
      logManager.info('[startCustomTokensMigration] - starting...');
      const {customTokenOptions, customTokenData} = getState().WALLET;
      Object.values(customTokenOptions || {}).forEach(token => {
        logManager.info(`Migrating: ${JSON.stringify(token)}`);
        const chain =
          customTokenData[token.symbol.toLowerCase()]?.chain || 'eth';
        let customToken: Token = {
          name: token.name,
          symbol: token.symbol?.toLowerCase(),
          decimals: Number(token.decimals),
          address: token.address?.toLowerCase(),
        };
        addCustomTokenOption(customToken, chain);
      });
      logManager.info('success [startCustomTokensMigration]}');
      return resolve();
    });
  };

export const startPolMigration =
  (): Effect<Promise<void>> =>
  async (dispatch, getState): Promise<void> => {
    return new Promise(async resolve => {
      logManager.info('[startPolMigration] - starting...');
      const {keys} = getState().WALLET;

      Object.values(keys).forEach(key => {
        key.wallets = key.wallets.map(wallet => {
          const {currencyAbbreviation, currencyName} = dispatch(
            mapAbbreviationAndName(
              wallet.credentials.coin,
              wallet.credentials.chain,
              wallet.credentials?.token?.address,
            ),
          );
          return merge(
            wallet,
            buildWalletObj({
              ...wallet.credentials,
              ...wallet,
              currencyAbbreviation,
              currencyName,
            }),
          );
        });
        dispatch(
          successImport({
            key,
          }),
        );
      });
      logManager.info('success [startPolMigration]}');
      return resolve();
    });
  };
