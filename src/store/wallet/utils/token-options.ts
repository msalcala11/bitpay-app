import {BitpaySupportedCoins, CurrencyOpts} from '../../../constants/currencies';
import {Token} from '../wallet.models';

const CHAIN_SUFFIX_BY_CHAIN: {[chain: string]: string} = {
  eth: 'e',
  matic: 'm',
  arb: 'arb',
  base: 'base',
  op: 'op',
  sol: 'sol',
};

const CHAIN_BY_SUFFIX: {[suffix: string]: string} = Object.entries(
  CHAIN_SUFFIX_BY_CHAIN,
).reduce((chainsBySuffix, [chain, suffix]) => {
  chainsBySuffix[suffix] = chain;
  return chainsBySuffix;
}, {} as {[suffix: string]: string});

const isToken = (value: unknown): value is Token => {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Token).symbol === 'string' &&
    typeof (value as Token).name === 'string' &&
    typeof (value as Token).address === 'string' &&
    typeof (value as Token).decimals === 'number' &&
    Number.isFinite((value as Token).decimals)
  );
};

const getChainFromTokenAddressKey = (key: string): string | undefined => {
  const suffix = key.match(/_([a-zA-Z]+)$/)?.[1];
  return suffix ? CHAIN_BY_SUFFIX[suffix] : undefined;
};

const addTokenChainSuffix = (address: string, chain: string): string => {
  const suffix = CHAIN_SUFFIX_BY_CHAIN[chain];
  const normalizedAddress = chain === 'sol' ? address : address.toLowerCase();
  return `${normalizedAddress}_${suffix}`;
};

const getFeeCurrency = (chain: string): string => {
  switch (chain.toLowerCase()) {
    case 'eth':
      return 'eth';
    case 'matic':
      return 'matic';
    case 'arb':
    case 'base':
    case 'op':
      return 'eth';
    case 'sol':
      return 'sol';
    default:
      return 'eth';
  }
};

export const buildTokenCurrencyData = (
  token: Token,
  chain: string,
): CurrencyOpts => {
  const baseCurrency = BitpaySupportedCoins[chain];
  const protocolPrefix = baseCurrency?.paymentInfo?.protocolPrefix;

  return {
    name: token.name.replace('(PoS)', '').trim(),
    chain,
    coin: token.symbol.toLowerCase(),
    feeCurrency: getFeeCurrency(chain),
    logoURI: token.logoURI,
    address: token.address,
    unitInfo: {
      unitName: token.symbol.toUpperCase(),
      unitToSatoshi: 10 ** token.decimals,
      unitDecimals: token.decimals,
      unitCode: token.symbol,
    },
    properties: {
      hasMultiSig: false,
      hasMultiSend: false,
      isUtxo: false,
      isERCToken: true,
      isStableCoin: false,
      singleAddress: true,
      isCustom: true,
    },
    paymentInfo: {
      paymentCode: 'EIP681b',
      protocolPrefix: {
        livenet: protocolPrefix?.livenet ?? chain,
        testnet: protocolPrefix?.testnet ?? chain,
        regtest: protocolPrefix?.regtest ?? chain,
      },
      ratesApi: '',
      blockExplorerUrls: baseCurrency?.paymentInfo?.blockExplorerUrls ?? '',
      blockExplorerUrlsTestnet:
        baseCurrency?.paymentInfo?.blockExplorerUrlsTestnet ?? '',
    },
    feeInfo: {
      feeUnit: baseCurrency?.feeInfo?.feeUnit ?? 'Gwei',
      feeUnitAmount: baseCurrency?.feeInfo?.feeUnitAmount ?? 1e9,
      blockTime: baseCurrency?.feeInfo?.blockTime ?? 0.2,
      maxMerchantFee: baseCurrency?.feeInfo?.maxMerchantFee ?? 'urgent',
    },
  };
};

export const populateTokenInfo = ({
  chain,
  token,
  tokenOptionsByAddress,
  tokenDataByAddress,
}: {
  chain: string;
  token: Token;
  tokenOptionsByAddress: {[key in string]: Token};
  tokenDataByAddress: {[key in string]: CurrencyOpts};
}) => {
  const tokenAddressWithSuffix = addTokenChainSuffix(token.address, chain);
  tokenOptionsByAddress[tokenAddressWithSuffix] = token;
  tokenDataByAddress[tokenAddressWithSuffix] = buildTokenCurrencyData(
    token,
    chain,
  );
};

export const buildTokenManagerStateFromTokenOptions = (
  tokenOptions: unknown,
): {
  tokenOptionsByAddress: {[key in string]: Token};
  tokenDataByAddress: {[key in string]: CurrencyOpts};
} => {
  const tokenOptionsByAddress: {[key in string]: Token} = {};
  const tokenDataByAddress: {[key in string]: CurrencyOpts} = {};

  if (!tokenOptions || typeof tokenOptions !== 'object') {
    return {tokenOptionsByAddress, tokenDataByAddress};
  }

  Object.entries(tokenOptions as {[key: string]: unknown}).forEach(
    ([tokenKey, tokenValue]) => {
      if (!isToken(tokenValue)) {
        return;
      }

      const chain = getChainFromTokenAddressKey(tokenKey);
      if (!chain) {
        return;
      }

      populateTokenInfo({
        chain,
        token: tokenValue,
        tokenOptionsByAddress,
        tokenDataByAddress,
      });
    },
  );

  return {tokenOptionsByAddress, tokenDataByAddress};
};
