import type {BwsConfig} from '../../core/shared/bws';
import type {Tx, WalletCredentials} from '../../core/types';
import {
  buildTokenWalletTxHistoryContextFromCredentials,
  normalizeTokenWalletTxHistoryPage,
} from '../../core/tokenTxHistory';
import {
  ensurePortfolioRuntimeSigningGlobals,
  getPortfolioTxHistorySigningDispatchContextOnRuntime,
  signBwsGetRequestWithBitcore,
  signBwsGetRequestWithTransferredNitro,
  takeNextPortfolioTransferredSignHandleOnRuntime,
} from './txHistorySigning';

export const PORTFOLIO_BWS_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';
const TXHISTORY_CACHE_BUST_PARAM = 'r';

type TxHistoryRequestArgs = {
  credentials: WalletCredentials;
  skip: number;
  limit: number;
  reverse?: boolean;
};

function getMultisigContractAddressFromCredentials(
  credentials: WalletCredentials,
): string | undefined {
  'worklet';
  const raw =
    credentials?.multisigEthInfo?.multisigContractAddress ??
    credentials?.multisigContractAddress;
  const multisigContractAddress = String(raw || '').trim();
  return multisigContractAddress || undefined;
}

function getTokenAddressFromCredentials(
  credentials: WalletCredentials,
): string | undefined {
  'worklet';

  const raw =
    credentials?.token?.address ??
    credentials?.tokenAddress;
  const tokenAddress = String(raw || '').trim();
  return tokenAddress || undefined;
}

export function buildPortfolioTxHistoryRequestPath(
  args: TxHistoryRequestArgs,
): string {
  'worklet';
  const params: string[] = [];

  if (Number.isFinite(args.skip) && args.skip > 0) {
    params.push(`skip=${encodeURIComponent(String(args.skip))}`);
  }
  if (Number.isFinite(args.limit) && args.limit > 0) {
    params.push(`limit=${encodeURIComponent(String(args.limit))}`);
  }
  if (args.reverse) {
    params.push('reverse=1');
  }

  const tokenAddress = getTokenAddressFromCredentials(args.credentials);
  if (tokenAddress) {
    params.push(`tokenAddress=${encodeURIComponent(tokenAddress)}`);
  }

  const multisigContractAddress =
    getMultisigContractAddressFromCredentials(args.credentials);
  if (multisigContractAddress) {
    params.push(
      `multisigContractAddress=${encodeURIComponent(multisigContractAddress)}`,
    );
  }

  return params.length > 0
    ? `${TXHISTORY_BASE_PATH}?${params.join('&')}`
    : TXHISTORY_BASE_PATH;
}

export function appendPortfolioTxHistoryCacheBustParam(
  requestPath: string,
  cacheBustValue?: number,
): string {
  'worklet';

  const normalizedRequestPath = String(requestPath || '').trim();
  if (!normalizedRequestPath) {
    throw new Error('A txhistory request path is required before appending the cache-bust param.');
  }

  const separator = normalizedRequestPath.includes('?') ? '&' : '?';
  const normalizedCacheBustValue = Number.isFinite(cacheBustValue)
    ? Math.round(Number(cacheBustValue))
    : Math.round(Math.random() * 100000);

  return `${normalizedRequestPath}${separator}${TXHISTORY_CACHE_BUST_PARAM}=${normalizedCacheBustValue}`;
}

function getWalletCopayerId(credentials: WalletCredentials): string {
  'worklet';
  const copayerId = String(credentials?.copayerId || '').trim();
  if (!copayerId) {
    throw new Error('Wallet credentials are missing copayerId for BWS txhistory requests.');
  }
  return copayerId;
}

function getWalletRequestPrivKey(credentials: WalletCredentials): string {
  'worklet';
  const runtimeContext = getPortfolioTxHistorySigningDispatchContextOnRuntime();
  const requestPrivKeyFromContext = String(runtimeContext?.requestPrivKey || '').trim();
  if (requestPrivKeyFromContext) {
    return requestPrivKeyFromContext;
  }

  const requestPrivKey = String(credentials?.requestPrivKey || '').trim();
  if (!requestPrivKey) {
    throw new Error(
      'Wallet credentials are missing requestPrivKey for BWS txhistory signing.',
    );
  }
  return requestPrivKey;
}

function buildSignedHeaders(args: {
  credentials: WalletCredentials;
  requestPath: string;
}): Record<string, string> {
  'worklet';

  const copayerId = getWalletCopayerId(args.credentials);
  const requestPrivKey = getWalletRequestPrivKey(args.credentials);
  const transferredNitro = takeNextPortfolioTransferredSignHandleOnRuntime();
  const signature = transferredNitro
    ? signBwsGetRequestWithTransferredNitro(
        args.requestPath,
        transferredNitro.firstHashHybrid,
        transferredNitro.signHandleHybrid,
        transferredNitro.privateKeyHandle,
      )
    : signBwsGetRequestWithBitcore(args.requestPath, requestPrivKey);

  return {
    Accept: 'application/json',
    'x-client-version': PORTFOLIO_BWS_CLIENT_VERSION_HEADER,
    'x-identity': copayerId,
    'x-signature': signature,
  };
}

function tryParseJson(text: string): unknown {
  'worklet';

  if (!text) {
    return [];
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function fetchPortfolioTxHistoryPageByRequest(args: {
  credentials: WalletCredentials;
  cfg: BwsConfig;
  skip: number;
  limit: number;
  reverse?: boolean;
}): Promise<Tx[]> {
  'worklet';

  ensurePortfolioRuntimeSigningGlobals();

  const requestPath = buildPortfolioTxHistoryRequestPath({
    credentials: args.credentials,
    skip: args.skip,
    limit: args.limit,
    reverse: args.reverse,
  });
  const signedRequestPath = appendPortfolioTxHistoryCacheBustParam(requestPath);

  const baseUrl = String(args.cfg?.baseUrl || '').trim();
  if (!baseUrl) {
    throw new Error('BWS baseUrl is required for portfolio txhistory requests.');
  }

  const headers = buildSignedHeaders({
    credentials: args.credentials,
    requestPath: signedRequestPath,
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${signedRequestPath}`, {
      method: 'GET',
      headers,
    });
  } catch (error: unknown) {
    const runtimeError = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Portfolio txhistory request failed for ${signedRequestPath}: ${runtimeError.message}`,
    );
  }

  const rawResponseText = await response.text();
  if (!response.ok) {
    const responsePreview = rawResponseText
      ? rawResponseText.slice(0, 400)
      : 'Empty response body.';
    throw new Error(
      `BWS txhistory request failed with status ${response.status} for ${signedRequestPath}. ${responsePreview}`,
    );
  }

  const parsed = tryParseJson(rawResponseText);
  const txs = Array.isArray(parsed) ? (parsed as Tx[]) : [];
  return normalizeTokenWalletTxHistoryPage({
    txs,
    context: buildTokenWalletTxHistoryContextFromCredentials(args.credentials),
  });
}
