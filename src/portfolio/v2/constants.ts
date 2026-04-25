/**
 * Portfolio v2 constants.
 *
 * MMKV keys, canonical-rate quote, and bounded-cache caps live here so no other
 * module inlines string literals or magic numbers. Reset and wipe code must
 * import these constants rather than hard-coding the strings.
 *
 * See `agents/portfolio-refactor-implementation-plan.md`,
 * "Constants and key names" section.
 */

export const PORTFOLIO_V2_FLAG_KEY = 'portfolio:v2:flag';
export const PORTFOLIO_CACHE_INVALID_KEY = 'portfolio:v2:cacheInvalid';
export const MANIFEST_KEY = 'portfolio:v2:manifest:v1';
export const POPULATE_QUEUE_KEY = 'portfolio:v2:populate:queue:v1';

/**
 * Monotonic work-epoch key. Bumped through the canonical helper at every
 * reset/quote-switch/visibility-change boundary so any in-flight compute,
 * populate, or rate-fetch operation can detect it is stale before publishing
 * to MMKV, manifest, queue, or `sharedPortfolioState.value`.
 */
export const PORTFOLIO_WORK_EPOCH_KEY = 'portfolio:v2:workEpoch';

/**
 * Approximate published-state payload size at which `publishPortfolioState`
 * emits a metrics warning. Phase 1 publishes the canonical shape unchanged via
 * `projectPortfolioStateForUi(...)`; this threshold exists so unexpectedly
 * large payloads surface before they reach Reanimated's invalidation path.
 */
export const PORTFOLIO_PUBLISH_WARN_BYTES = 750_000;

/**
 * Approximate MMKV value size at which v2 storage writes should warn. Writers
 * should shard portfolio data before reaching this threshold unless a
 * test-covered exception explicitly allows an oversized value.
 */
export const PORTFOLIO_MMKV_VALUE_WARN_BYTES = 500_000;

/**
 * Wallet-count chunk size for compute-runtime recompute work. Bounded to keep
 * a single recompute pass interruptible by the work-epoch guard and to keep
 * publish-time payloads predictable.
 */
export const PORTFOLIO_RECOMPUTE_CHUNK_WALLET_COUNT = 25;

/**
 * Production v2 keeps the existing daily snapshot compression behavior: older
 * tx events are compacted into one authoritative UTC-day snapshot.
 */
export const PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_ENABLED = true;
export const PORTFOLIO_DAILY_SNAPSHOT_COMPRESSION_AGE_DAYS = 90;

/**
 * Maximum snapshot rows emitted into a single wallet snapshot chunk write.
 * Chunk writers split larger batches before calling the v2 MMKV write helper.
 */
export const PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET = 128;

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
