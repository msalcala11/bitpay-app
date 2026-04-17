import {
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';

import {
  createPortfolioTxHistorySigningDispatchContextOnRN,
  type PortfolioTxHistorySigningDispatchContext,
} from '../adapters/rn/txHistorySigning';
import {
  buildRuntimeErrorFromDetails,
  toRuntimeError,
} from '../adapters/rn/workletRuntimeShared';
import type {WorkerRequest, WorkerResponse} from '../core/engine/workerProtocol';
import type {WalletCredentials} from '../core/types';
import type {PortfolioClientTransport} from './portfolioClient';
import type {PortfolioRuntimeHostBootstrapConfig} from './portfolioHost';
import {shouldDispatchPortfolioRequestOnRuntimeWorklet} from './portfolioRequestRouting';
import {
  dispatchPortfolioPopulateStartAndWaitOnRuntime,
  dispatchPortfolioRequestOnRuntime,
  type PortfolioRuntimeDispatchContext,
} from './portfolioWorkletDispatch';
import type {PortfolioPopulateJobSigningContextMap} from './worklet/portfolioPopulateJobWorklet';

export type WorkletPortfolioTransportConfig = {
  runtime: WorkletRuntime;
  host: PortfolioRuntimeHostBootstrapConfig;
};

function cloneWalletCredentialsForTransport(
  credentials: WalletCredentials,
): WalletCredentials {
  try {
    return JSON.parse(JSON.stringify(credentials || {})) as WalletCredentials;
  } catch {
    return {...(credentials || {})};
  }
}

function getWalletIdFromRequest(request: WorkerRequest): string | undefined {
  const params = request.params as any;
  switch (request.method) {
    case 'snapshots.prepareWallet':
      return typeof params?.wallet?.walletId === 'string'
        ? params.wallet.walletId
        : undefined;
    case 'snapshots.processNextPage':
    case 'snapshots.closeWalletSession':
    case 'snapshots.clearWallet':
    case 'snapshots.getIndex':
    case 'snapshots.getLatestSnapshot':
    case 'snapshots.listSnapshots':
    case 'snapshots.finishWallet':
      return typeof params?.walletId === 'string' ? params.walletId : undefined;
    default:
      return undefined;
  }
}

function buildSingleRequestSigningContextForRequest(args: {
  request: WorkerRequest;
  sessionCredentialsByWalletId: Map<string, WalletCredentials>;
}): PortfolioTxHistorySigningDispatchContext | undefined {
  if (args.request.method !== 'snapshots.processNextPage') {
    return undefined;
  }

  const walletId = getWalletIdFromRequest(args.request);
  if (!walletId) {
    return undefined;
  }

  const credentials = args.sessionCredentialsByWalletId.get(walletId);
  const requestPrivKey = String((credentials as any)?.requestPrivKey || '').trim();
  if (!requestPrivKey) {
    return undefined;
  }

  try {
    return createPortfolioTxHistorySigningDispatchContextOnRN({
      requestPrivKey,
      requestCount: 4,
    });
  } catch {
    return {
      requestPrivKey,
      nextSignHandleIndex: 0,
    };
  }
}

function buildPopulateJobSigningContextsForRequest(
  request: WorkerRequest,
): PortfolioPopulateJobSigningContextMap | undefined {
  if (request.method !== 'populate.startJob') {
    return undefined;
  }

  const wallets = Array.isArray((request.params as any)?.wallets)
    ? ((request.params as any).wallets as Array<{walletId?: string; summary?: {walletId?: string}; credentials?: WalletCredentials}>)
    : [];

  const out: PortfolioPopulateJobSigningContextMap = {};
  let populated = false;

  for (const wallet of wallets) {
    const walletId = String(wallet?.summary?.walletId || wallet?.walletId || '').trim();
    const requestPrivKey = String(wallet?.credentials?.requestPrivKey || '').trim();
    if (!walletId || !requestPrivKey) {
      continue;
    }

    try {
      out[walletId] = createPortfolioTxHistorySigningDispatchContextOnRN({
        requestPrivKey,
        requestCount: 4,
      });
    } catch {
      out[walletId] = {
        requestPrivKey,
        nextSignHandleIndex: 0,
      };
    }

    populated = true;
  }

  return populated ? out : undefined;
}

function reconcileSessionCredentialsAfterResponse(args: {
  request: WorkerRequest;
  response?: WorkerResponse;
  walletId?: string;
  sessionCredentialsByWalletId: Map<string, WalletCredentials>;
}): void {
  const {request, response, walletId, sessionCredentialsByWalletId} = args;

  if (response?.ok === true && request.method === 'debug.clearAll') {
    sessionCredentialsByWalletId.clear();
    return;
  }

  if (!walletId) {
    return;
  }

  const shouldDeleteCredentials =
    (response?.ok === true &&
      (request.method === 'snapshots.closeWalletSession' ||
        request.method === 'snapshots.clearWallet' ||
        request.method === 'snapshots.finishWallet')) ||
    (response?.ok === false && request.method === 'snapshots.prepareWallet');

  if (shouldDeleteCredentials) {
    sessionCredentialsByWalletId.delete(walletId);
  }
}

function reconcileSessionCredentialsAfterFatalError(args: {
  request: WorkerRequest;
  walletId?: string;
  sessionCredentialsByWalletId: Map<string, WalletCredentials>;
}): void {
  const {request, walletId, sessionCredentialsByWalletId} = args;
  if (!walletId) {
    return;
  }

  if (
    request.method === 'snapshots.closeWalletSession' ||
    request.method === 'snapshots.clearWallet' ||
    request.method === 'snapshots.finishWallet' ||
    request.method === 'snapshots.prepareWallet'
  ) {
    sessionCredentialsByWalletId.delete(walletId);
  }
}

function shouldAwaitPopulateTerminalResponse(
  request: WorkerRequest,
): request is WorkerRequest<'populate.startJob'> {
  if (request.method !== 'populate.startJob') {
    return false;
  }

  return (request.params as {awaitTerminal?: boolean})?.awaitTerminal === true;
}

export function createWorkletPortfolioTransport(
  config: WorkletPortfolioTransportConfig,
): PortfolioClientTransport {
  const sessionCredentialsByWalletId = new Map<string, WalletCredentials>();

  return {
    dispatch: async (
      request: WorkerRequest,
      onResponse: (response: WorkerResponse) => void,
      onFatalError: (error: Error) => void,
    ): Promise<void> => {
      const walletId = getWalletIdFromRequest(request);
      if (request.method === 'snapshots.prepareWallet' && walletId) {
        const credentials = (request.params as any)?.credentials as WalletCredentials;
        if (credentials) {
          sessionCredentialsByWalletId.set(
            walletId,
            cloneWalletCredentialsForTransport(credentials),
          );
        }
      }

      if (!shouldDispatchPortfolioRequestOnRuntimeWorklet(request)) {
        onFatalError(
          new Error(
            `Portfolio request ${String(
              request.method,
            )} is not routed to the worklet runtime.`,
          ),
        );
        return;
      }

      const dispatchContext: PortfolioRuntimeDispatchContext = {
        singleRequestSigningContext: buildSingleRequestSigningContextForRequest({
          request,
          sessionCredentialsByWalletId,
        }),
        populateJobSigningContextsByWalletId:
          buildPopulateJobSigningContextsForRequest(request),
      };

      const dispatchOnRuntime = shouldAwaitPopulateTerminalResponse(request)
        ? dispatchPortfolioPopulateStartAndWaitOnRuntime
        : dispatchPortfolioRequestOnRuntime;

      await runOnRuntimeAsync(
        config.runtime,
        dispatchOnRuntime,
        config.host,
        request,
        dispatchContext,
        (response: WorkerResponse) => {
          reconcileSessionCredentialsAfterResponse({
            request,
            response,
            walletId,
            sessionCredentialsByWalletId,
          });
          onResponse(response);
        },
        (message: string, stack?: string) => {
          reconcileSessionCredentialsAfterFatalError({
            request,
            walletId,
            sessionCredentialsByWalletId,
          });
          onFatalError(buildRuntimeErrorFromDetails(message, stack));
        },
      ).catch(error => {
        reconcileSessionCredentialsAfterFatalError({
          request,
          walletId,
          sessionCredentialsByWalletId,
        });
        onFatalError(toRuntimeError(error));
      });
    },
    destroy: () => {
      sessionCredentialsByWalletId.clear();
    },
  };
}
