import {
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';

import {
  createPortfolioTxHistorySigningDispatchContextOnRN,
  type PortfolioTxHistorySigningContextBuildMetrics,
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

function nowMs(): number {
  const candidate = globalThis?.performance?.now?.();
  return Number.isFinite(candidate) ? Number(candidate) : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function metricMs(value?: number): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

type PopulateSigningContextSlowWalletSummary = {
  walletId: string;
  requestPrivKeyPresent: boolean;
  totalElapsedMs: number;
  nitroModulesProxyElapsedMs: number;
  nitroFetchElapsedMs: number;
  requestPrivKeySec1DerElapsedMs: number;
  objectAssemblyElapsedMs: number;
  otherElapsedMs: number;
};

function summarizePopulateSigningContextSlowWallets(
  walletMetrics: Array<{
    walletId: string;
    metrics: PortfolioTxHistorySigningContextBuildMetrics;
  }>,
): PopulateSigningContextSlowWalletSummary[] {
  return walletMetrics
    .map(({walletId, metrics}) => {
      const totalElapsedMs = metricMs(metrics.totalElapsedMs);
      const nitroModulesProxyElapsedMs = metricMs(
        metrics.nitroModulesProxy?.elapsedMs,
      );
      const nitroFetchElapsedMs = metricMs(metrics.nitroFetch?.elapsedMs);
      const requestPrivKeySec1DerElapsedMs = metricMs(
        metrics.requestPrivKeySec1Der?.elapsedMs,
      );
      const objectAssemblyElapsedMs = metricMs(metrics.objectAssemblyElapsedMs);
      return {
        walletId,
        requestPrivKeyPresent: metrics.requestPrivKeyPresent === true,
        totalElapsedMs: roundMs(totalElapsedMs),
        nitroModulesProxyElapsedMs: roundMs(nitroModulesProxyElapsedMs),
        nitroFetchElapsedMs: roundMs(nitroFetchElapsedMs),
        requestPrivKeySec1DerElapsedMs: roundMs(requestPrivKeySec1DerElapsedMs),
        objectAssemblyElapsedMs: roundMs(objectAssemblyElapsedMs),
        otherElapsedMs: roundMs(
          Math.max(
            0,
            totalElapsedMs -
              nitroModulesProxyElapsedMs -
              nitroFetchElapsedMs -
              requestPrivKeySec1DerElapsedMs -
              objectAssemblyElapsedMs,
          ),
        ),
      };
    })
    .sort((a, b) => b.totalElapsedMs - a.totalElapsedMs)
    .slice(0, 5);
}

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
    case 'snapshots.getInvalidHistory':
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
  const walletId = getWalletIdFromRequest(args.request);
  const credentials = walletId
    ? args.sessionCredentialsByWalletId.get(walletId)
    : undefined;

  // Even requests that do not need BWS signing can still need Nitro Fetch on
  // the runtime (for example, analysis/chart rate warming). Always provide the
  // shared request context so non-wallet worklet queries keep working with
  // fetch preview disabled.
  return createPortfolioTxHistorySigningDispatchContextOnRN({
    requestPrivKey:
      String((credentials as any)?.requestPrivKey || '').trim() || undefined,
    requestPubKey:
      String((credentials as any)?.requestPubKey || '').trim() || undefined,
    requestCount: args.request.method === 'snapshots.processNextPage' ? 4 : 1,
  });
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
  let requestPrivKeyWalletCount = 0;
  const startedAt = nowMs();
  const walletBuildMetrics: Array<{
    walletId: string;
    metrics: PortfolioTxHistorySigningContextBuildMetrics;
  }> = [];
  let contextBuildElapsedMs = 0;
  let nitroModulesProxyElapsedMs = 0;
  let nitroModulesProxyCacheMissCount = 0;
  let nitroFetchElapsedMs = 0;
  let nitroFetchCacheMissCount = 0;
  let requestPrivKeySec1DerElapsedMs = 0;
  let requestPrivKeySec1DerBitcoreLoadElapsedMs = 0;
  let requestPrivKeySec1DerBitcoreLoadCacheMissCount = 0;
  let requestPrivKeySec1DerPrivateKeyParseElapsedMs = 0;
  let requestPrivKeySec1DerPrivateKeyToBufferElapsedMs = 0;
  let requestPrivKeySec1DerEncodeElapsedMs = 0;
  let objectAssemblyElapsedMs = 0;

  for (const wallet of wallets) {
    const walletId = String(wallet?.summary?.walletId || wallet?.walletId || '').trim();
    const requestPrivKey = String(wallet?.credentials?.requestPrivKey || '').trim();
    const requestPubKey = String(wallet?.credentials?.requestPubKey || '').trim();
    if (!walletId) {
      continue;
    }

    if (requestPrivKey) {
      requestPrivKeyWalletCount += 1;
    }

    const metrics: PortfolioTxHistorySigningContextBuildMetrics = {};
    out[walletId] = createPortfolioTxHistorySigningDispatchContextOnRN({
      requestPrivKey: requestPrivKey || undefined,
      requestPubKey: requestPubKey || undefined,
      requestCount: 4,
    }, metrics);
    walletBuildMetrics.push({walletId, metrics});
    contextBuildElapsedMs += metricMs(metrics.totalElapsedMs);
    nitroModulesProxyElapsedMs += metricMs(metrics.nitroModulesProxy?.elapsedMs);
    nitroModulesProxyCacheMissCount += metrics.nitroModulesProxy?.cacheMiss
      ? 1
      : 0;
    nitroFetchElapsedMs += metricMs(metrics.nitroFetch?.elapsedMs);
    nitroFetchCacheMissCount += metrics.nitroFetch?.cacheMiss ? 1 : 0;
    requestPrivKeySec1DerElapsedMs += metricMs(
      metrics.requestPrivKeySec1Der?.elapsedMs,
    );
    requestPrivKeySec1DerBitcoreLoadElapsedMs += metricMs(
      metrics.requestPrivKeySec1Der?.bitcoreLoadElapsedMs,
    );
    requestPrivKeySec1DerBitcoreLoadCacheMissCount +=
      metrics.requestPrivKeySec1Der?.bitcoreLoadCacheMiss ? 1 : 0;
    requestPrivKeySec1DerPrivateKeyParseElapsedMs += metricMs(
      metrics.requestPrivKeySec1Der?.privateKeyParseElapsedMs,
    );
    requestPrivKeySec1DerPrivateKeyToBufferElapsedMs += metricMs(
      metrics.requestPrivKeySec1Der?.privateKeyToBufferElapsedMs,
    );
    requestPrivKeySec1DerEncodeElapsedMs += metricMs(
      metrics.requestPrivKeySec1Der?.sec1DerEncodeElapsedMs,
    );
    objectAssemblyElapsedMs += metricMs(metrics.objectAssemblyElapsedMs);

    populated = true;
  }

  const elapsedMs = nowMs() - startedAt;
  const bucketOverheadElapsedMs = Math.max(0, elapsedMs - contextBuildElapsedMs);
  const contextOtherElapsedMs = Math.max(
    0,
    contextBuildElapsedMs -
      nitroModulesProxyElapsedMs -
      nitroFetchElapsedMs -
      requestPrivKeySec1DerElapsedMs -
      objectAssemblyElapsedMs,
  );
  const requestPrivKeySec1DerHelperOtherElapsedMs = Math.max(
    0,
    requestPrivKeySec1DerElapsedMs -
      requestPrivKeySec1DerBitcoreLoadElapsedMs -
      requestPrivKeySec1DerPrivateKeyParseElapsedMs -
      requestPrivKeySec1DerPrivateKeyToBufferElapsedMs -
      requestPrivKeySec1DerEncodeElapsedMs,
  );

  console.log('[portfolio-populate-startup] transport populate signing contexts', {
    walletCount: wallets.length,
    populatedWalletCount: populated ? Object.keys(out).length : 0,
    requestPrivKeyWalletCount,
    elapsedMs: roundMs(elapsedMs),
    mode: 'lazy_runtime_hydration_with_js_precompute',
    breakdown: {
      contextBuildElapsedMs: roundMs(contextBuildElapsedMs),
      bucketOverheadElapsedMs: roundMs(bucketOverheadElapsedMs),
      nitroModulesProxyElapsedMs: roundMs(nitroModulesProxyElapsedMs),
      nitroModulesProxyCacheMissCount,
      nitroFetchElapsedMs: roundMs(nitroFetchElapsedMs),
      nitroFetchCacheMissCount,
      requestPrivKeySec1DerElapsedMs: roundMs(requestPrivKeySec1DerElapsedMs),
      objectAssemblyElapsedMs: roundMs(objectAssemblyElapsedMs),
      contextOtherElapsedMs: roundMs(contextOtherElapsedMs),
      requestPrivKeySec1DerBreakdown: {
        bitcoreLoadElapsedMs: roundMs(requestPrivKeySec1DerBitcoreLoadElapsedMs),
        bitcoreLoadCacheMissCount:
          requestPrivKeySec1DerBitcoreLoadCacheMissCount,
        privateKeyParseElapsedMs: roundMs(
          requestPrivKeySec1DerPrivateKeyParseElapsedMs,
        ),
        privateKeyToBufferElapsedMs: roundMs(
          requestPrivKeySec1DerPrivateKeyToBufferElapsedMs,
        ),
        sec1DerEncodeElapsedMs: roundMs(requestPrivKeySec1DerEncodeElapsedMs),
        helperOtherElapsedMs: roundMs(
          requestPrivKeySec1DerHelperOtherElapsedMs,
        ),
      },
    },
    slowWallets: summarizePopulateSigningContextSlowWallets(walletBuildMetrics),
  });

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
      const isPopulateStartRequest = request.method === 'populate.startJob';
      const requestStartedAt = isPopulateStartRequest ? nowMs() : 0;
      const requestWalletCount = isPopulateStartRequest
        ? Array.isArray((request.params as any)?.wallets)
          ? (request.params as any).wallets.length
          : 0
        : 0;

      if (isPopulateStartRequest) {
        console.log('[portfolio-populate-startup] transport dispatch begin', {
          requestId: request.id,
          walletCount: requestWalletCount,
          awaitTerminal: (request.params as {awaitTerminal?: boolean})
            ?.awaitTerminal === true,
        });
      }

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

      const dispatchContextStartedAt = isPopulateStartRequest ? nowMs() : 0;
      const dispatchContext: PortfolioRuntimeDispatchContext = {
        singleRequestSigningContext: buildSingleRequestSigningContextForRequest({
          request,
          sessionCredentialsByWalletId,
        }),
        populateJobSigningContextsByWalletId:
          buildPopulateJobSigningContextsForRequest(request),
      };

      if (isPopulateStartRequest) {
        console.log('[portfolio-populate-startup] transport dispatch context ready', {
          requestId: request.id,
          walletCount: requestWalletCount,
          populateSigningContextCount: dispatchContext
            .populateJobSigningContextsByWalletId
            ? Object.keys(dispatchContext.populateJobSigningContextsByWalletId)
                .length
            : 0,
          elapsedMs: roundMs(nowMs() - dispatchContextStartedAt),
          totalElapsedMs: roundMs(nowMs() - requestStartedAt),
        });
      }

      const dispatchOnRuntime = shouldAwaitPopulateTerminalResponse(request)
        ? dispatchPortfolioPopulateStartAndWaitOnRuntime
        : dispatchPortfolioRequestOnRuntime;

      const runOnRuntimeStartedAt = isPopulateStartRequest ? nowMs() : 0;
      await runOnRuntimeAsync(
        config.runtime,
        dispatchOnRuntime,
        config.host,
        request,
        dispatchContext,
        (response: WorkerResponse) => {
          if (isPopulateStartRequest) {
            console.log('[portfolio-populate-startup] transport response', {
              requestId: request.id,
              walletCount: requestWalletCount,
              ok: response.ok,
              elapsedMs: roundMs(nowMs() - requestStartedAt),
              responseState:
                response.ok && (response as any)?.result?.status
                  ? (response as any).result.status.state
                  : undefined,
            });
          }
          reconcileSessionCredentialsAfterResponse({
            request,
            response,
            walletId,
            sessionCredentialsByWalletId,
          });
          onResponse(response);
        },
        (message: string, stack?: string) => {
          if (isPopulateStartRequest) {
            console.log('[portfolio-populate-startup] transport runtime rejection', {
              requestId: request.id,
              walletCount: requestWalletCount,
              elapsedMs: roundMs(nowMs() - requestStartedAt),
              message,
            });
          }
          reconcileSessionCredentialsAfterFatalError({
            request,
            walletId,
            sessionCredentialsByWalletId,
          });
          onFatalError(buildRuntimeErrorFromDetails(message, stack));
        },
      )
        .then(() => {
          if (isPopulateStartRequest) {
            console.log(
              '[portfolio-populate-startup] transport runOnRuntimeAsync settled',
              {
                requestId: request.id,
                walletCount: requestWalletCount,
                elapsedMs: roundMs(nowMs() - runOnRuntimeStartedAt),
                totalElapsedMs: roundMs(nowMs() - requestStartedAt),
              },
            );
          }
        })
        .catch(error => {
          if (isPopulateStartRequest) {
            console.log('[portfolio-populate-startup] transport fatal error', {
              requestId: request.id,
              walletCount: requestWalletCount,
              elapsedMs: roundMs(nowMs() - requestStartedAt),
              message:
                error instanceof Error ? error.message : String(error || ''),
            });
          }
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
