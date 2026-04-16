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
import type {PortfolioPopulateJobSigningContextMap} from './worklet/portfolioPopulateJobWorklet';

export type PortfolioRuntimeDispatchContext = {
  singleRequestSigningContext?: PortfolioTxHistorySigningDispatchContext | null;
  populateJobSigningContextsByWalletId?: PortfolioPopulateJobSigningContextMap;
};

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
