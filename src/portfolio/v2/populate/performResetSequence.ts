import {clearPortfolioMmkvKeysForReset} from '../kvStore';
import {
  bumpPortfolioWorkEpoch,
  getCurrentPortfolioWorkEpoch,
  resetSharedPortfolioStateForDebugClear,
} from '../sharedState';

let inFlightReset: Promise<void> | undefined;

export function performResetSequence(args?: {
  quoteCurrency?: string;
  reason?: 'reset' | 'debugClear';
}): Promise<void> {
  if (inFlightReset) {
    return inFlightReset;
  }

  inFlightReset = Promise.resolve()
    .then(() => {
      bumpPortfolioWorkEpoch(
        args?.reason === 'debugClear' ? 'debugClear' : 'resetStart',
      );
      clearPortfolioMmkvKeysForReset({reason: 'reset'});
      resetSharedPortfolioStateForDebugClear({
        publishEpoch: getCurrentPortfolioWorkEpoch(),
        quoteCurrency: args?.quoteCurrency,
        reason: args?.reason ?? 'reset',
      });
    })
    .finally(() => {
      inFlightReset = undefined;
    });

  return inFlightReset;
}
