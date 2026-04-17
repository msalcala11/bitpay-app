import {scheduleOnRN} from 'react-native-worklets';

import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
  type PortfolioTxHistorySigningDispatchContext,
} from '../adapters/rn/txHistorySigning';
import {getRuntimeErrorDetails} from '../adapters/rn/workletRuntimeShared';
import type {WorkerRequest, WorkerResponse} from '../core/engine/workerProtocol';
import type {PortfolioRuntimeHostBootstrapConfig} from './portfolioHost';
import {
  canHandlePortfolioRequestOnRuntime,
  handlePortfolioRequestOnRuntime,
} from './worklet/portfolioRequestWorklet';
import {
  handleGetPopulateJobStatusOnWorklet,
  type PortfolioPopulateJobSigningContextMap,
} from './worklet/portfolioPopulateJobWorklet';
import type {PortfolioPopulateJobStartResult} from '../core/engine/populateJob';

export type PortfolioRuntimeDispatchContext = {
  singleRequestSigningContext?: PortfolioTxHistorySigningDispatchContext | null;
  populateJobSigningContextsByWalletId?: PortfolioPopulateJobSigningContextMap;
};

const TERMINAL_POPULATE_POLL_MS = 250;

function delayOnRuntime(ms: number): Promise<void> {
  'worklet';

  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)), undefined);
  });
}

export function dispatchPortfolioRequestOnRuntime(
  config: PortfolioRuntimeHostBootstrapConfig,
  req: WorkerRequest,
  dispatchContext: PortfolioRuntimeDispatchContext | null | undefined,
  resolveOnRN: (response: WorkerResponse) => void,
  rejectOnRN: (message: string, stack?: string) => void,
): void {
  'worklet';

  void (async () => {
    try {
      setPortfolioTxHistorySigningDispatchContextOnRuntime(
        dispatchContext?.singleRequestSigningContext,
      );

      if (!canHandlePortfolioRequestOnRuntime(req.method)) {
        throw new Error(
          `Portfolio runtime worklet dispatch does not support ${String(
            req.method,
          )}.`,
        );
      }

      const response = await handlePortfolioRequestOnRuntime(
        config,
        req,
        dispatchContext?.populateJobSigningContextsByWalletId,
      );
      clearPortfolioTxHistorySigningDispatchContextOnRuntime();
      scheduleOnRN(resolveOnRN, response);
    } catch (error: unknown) {
      clearPortfolioTxHistorySigningDispatchContextOnRuntime();
      const details = getRuntimeErrorDetails(error);
      scheduleOnRN(rejectOnRN, details.message, details.stack);
    }
  })();
}

export function dispatchPortfolioPopulateStartAndWaitOnRuntime(
  config: PortfolioRuntimeHostBootstrapConfig,
  req: WorkerRequest<'populate.startJob'>,
  dispatchContext: PortfolioRuntimeDispatchContext | null | undefined,
  resolveOnRN: (response: WorkerResponse<'populate.startJob'>) => void,
  rejectOnRN: (message: string, stack?: string) => void,
): void {
  'worklet';

  void (async () => {
    try {
      setPortfolioTxHistorySigningDispatchContextOnRuntime(
        dispatchContext?.singleRequestSigningContext,
      );

      const initialResponse = await handlePortfolioRequestOnRuntime(
        config,
        req,
        dispatchContext?.populateJobSigningContextsByWalletId,
      );
      clearPortfolioTxHistorySigningDispatchContextOnRuntime();

      if (!initialResponse.ok) {
        scheduleOnRN(resolveOnRN, initialResponse as WorkerResponse<'populate.startJob'>);
        return;
      }

      const startResult =
        initialResponse.result as PortfolioPopulateJobStartResult;
      const jobId = String(
        startResult?.jobId || (req.params as {jobId?: string})?.jobId || '',
      ).trim();
      if (!jobId) {
        throw new Error(
          'Portfolio populate start did not return a valid jobId.',
        );
      }

      let terminalStatus = startResult.status;
      while (!terminalStatus || terminalStatus.inProgress) {
        await delayOnRuntime(TERMINAL_POPULATE_POLL_MS);
        const nextStatus = await handleGetPopulateJobStatusOnWorklet(
          config,
          jobId,
        );
        if (!nextStatus) {
          throw new Error(
            `Portfolio populate job ${jobId} became unavailable before completion.`,
          );
        }
        terminalStatus = nextStatus;
      }

      scheduleOnRN(resolveOnRN, {
        id: req.id,
        ok: true,
        result: {
          jobId,
          status: terminalStatus,
        },
      } as WorkerResponse<'populate.startJob'>);
    } catch (error: unknown) {
      clearPortfolioTxHistorySigningDispatchContextOnRuntime();
      const details = getRuntimeErrorDetails(error);
      scheduleOnRN(rejectOnRN, details.message, details.stack);
    }
  })();
}
