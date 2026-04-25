import {clearRecordedPortfolioV2MetricsForTesting} from './metrics';
import {clearPortfolioRuntimeLogPayloadsForTesting} from './logPortfolioRuntimeError';

export function resetPortfolioV2DebugStateForTesting(): void {
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
}
