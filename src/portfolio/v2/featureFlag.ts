/**
 * `PORTFOLIO_V2` feature flag.
 *
 * Default: `false` until Phase 8a flips it on. The flag gates whether v2
 * code paths run; with the flag off, the app must behave identically to the
 * pre-refactor codebase (Phase 0 acceptance criterion).
 *
 * Persistence: lives at MMKV key `PORTFOLIO_V2_FLAG_KEY` in the dedicated
 * portfolio MMKV instance (`bitpay.portfolio.engine`). The flag is excluded
 * from the v2 wipe-prefix set so debug-clear / sign-out / Show-Portfolio-off
 * during rollout do not silently flip v2 off on a developer's device.
 *
 * Read paths:
 *   - JS thread: `isPortfolioV2EnabledOnJS()` — uses the `MMKV` JS API.
 *   - Worklet runtime: `isPortfolioV2EnabledOnWorklet(bridge)` — uses the
 *     `WorkletMmkvStorageBridge` interface so it can run inside a worklet.
 *
 * Encoding: stored as the string `'1'` for true. Any other value (or absent
 * key) is treated as false. This matches the pattern used by
 * `PORTFOLIO_CACHE_INVALID_KEY` so reset/wipe paths can use the same
 * read/write style.
 */

import {getPortfolioMmkvStorageOnRN} from '../adapters/rn/workletMmkvBridge';
import type {WorkletMmkvStorageBridge} from '../adapters/rn/mmkvKvStore';
import {PORTFOLIO_V2_FLAG_KEY} from './constants';

const FLAG_TRUE_VALUE = '1';

/**
 * JS-thread accessor. Reads the flag from the dedicated portfolio MMKV
 * instance via the JS `MMKV` API.
 */
export function isPortfolioV2EnabledOnJS(): boolean {
  const storage = getPortfolioMmkvStorageOnRN();
  return storage.getString(PORTFOLIO_V2_FLAG_KEY) === FLAG_TRUE_VALUE;
}

/**
 * Worklet-runtime accessor. Callers must pass the `WorkletMmkvStorageBridge`
 * for the dedicated portfolio MMKV instance (obtained from
 * `getPortfolioMmkvNativeStorageOnRN()` on JS or threaded through the
 * runtime's existing KV-config object).
 */
export function isPortfolioV2EnabledOnWorklet(
  bridge: WorkletMmkvStorageBridge,
): boolean {
  'worklet';
  return bridge.getString(PORTFOLIO_V2_FLAG_KEY) === FLAG_TRUE_VALUE;
}

/**
 * Test-only / debug-only setter. Production code should not flip the flag
 * directly; rollout is controlled via Phase 8a's default-on flip plus the
 * kill-switch path.
 */
export function setPortfolioV2EnabledForTesting(enabled: boolean): void {
  const storage = getPortfolioMmkvStorageOnRN();
  if (enabled) {
    storage.set(PORTFOLIO_V2_FLAG_KEY, FLAG_TRUE_VALUE);
  } else {
    storage.delete(PORTFOLIO_V2_FLAG_KEY);
  }
}
