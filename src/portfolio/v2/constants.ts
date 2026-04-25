/**
 * Portfolio v2 constants.
 *
 * MMKV keys, canonical-rate quote, and bounded-cache caps live here so no other
 * module inlines string literals or magic numbers. Reset and wipe code must
 * import these constants rather than hard-coding the strings.
 *
 * See `agents/portfolio-refactor-implementation-plan-standalone-final.md`,
 * "Constants and key names" section.
 */

export const PORTFOLIO_V2_FLAG_KEY = 'portfolio:v2:flag';
export const PORTFOLIO_CACHE_INVALID_KEY = 'portfolio:v2:cacheInvalid';
export const MANIFEST_KEY = 'portfolio:v2:manifest:v1';
export const POPULATE_QUEUE_KEY = 'portfolio:v2:populate:queue:v1';

/**
 * The stable persisted-rates quote. All asset rate series used for portfolio
 * PnL are persisted under `rate:v1:USD:*`. Quote switches bridge from this
 * canonical quote to the target quote via the BTC bridge formula.
 */
export const CANONICAL_RATE_QUOTE = 'USD' as const;

/**
 * Soft cap on the bounded LRU `scopedByWalletSet` cache. May be exceeded
 * temporarily when more than eight scoped routes are mounted simultaneously;
 * LRU resumes once those scopes unmount.
 */
export const MAX_SCOPED_CACHE_ENTRIES = 8;

/**
 * Hard cap on every emitted balance-chart `Series.points` array. The compute
 * runtime resolves a chart sample grid of at most this many timestamps before
 * running the PnL formula.
 */
export const MAX_CHART_POINTS = 89;

/**
 * Debounce window for passive `onLiveRatesUpdated` triggers before scheduling
 * a `liveRateTouch` recompute. Phase 0 may adjust based on the existing
 * live-rate effect's update frequency, but this single constant must be the
 * source of truth and covered by the debounce/coalescing test.
 */
export const PASSIVE_LIVE_RATE_RECOMPUTE_DEBOUNCE_MS = 150;
