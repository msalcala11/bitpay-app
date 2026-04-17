import type {BwsConfig} from '../../core/shared/bws';
import type {Tx, WalletCredentials} from '../../core/types';
import {
  ensurePortfolioRuntimeSigningGlobals,
  getPortfolioTxHistorySigningDispatchContextOnRuntime,
  signBwsGetRequestWithBitcore,
  signBwsGetRequestWithTransferredNitro,
  takeNextPortfolioTransferredSignHandleOnRuntime,
} from './txHistorySigning';

export const PORTFOLIO_BWS_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';

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

  const baseUrl = String(args.cfg?.baseUrl || '').trim();
  if (!baseUrl) {
    throw new Error('BWS baseUrl is required for portfolio txhistory requests.');
  }

  const headers = buildSignedHeaders({
    credentials: args.credentials,
    requestPath,
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${requestPath}`, {
      method: 'GET',
      headers,
    });
  } catch (error: unknown) {
    const runtimeError = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Portfolio txhistory request failed for ${requestPath}: ${runtimeError.message}`,
    );
  }

  const rawResponseText = await response.text();
  if (!response.ok) {
    const responsePreview = rawResponseText
      ? rawResponseText.slice(0, 400)
      : 'Empty response body.';
    throw new Error(
      `BWS txhistory request failed with status ${response.status} for ${requestPath}. ${responsePreview}`,
    );
  }

  const parsed = tryParseJson(rawResponseText);
  return Array.isArray(parsed) ? (parsed as Tx[]) : [];
}
