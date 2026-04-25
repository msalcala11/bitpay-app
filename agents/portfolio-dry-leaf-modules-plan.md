# Portfolio Pure Leaf Module DRY Plan

Standalone refactor plan for reducing duplicated portfolio business logic without enabling
`react-native-worklets` bundle mode.

## Goal

DRY duplicated portfolio helper logic by moving shared business rules into pure,
worklet-compatible leaf modules that both JS and worklet runtime files can import.

This plan intentionally does **not** require Worklets bundle mode. The current codebase
already proves the middle path works: worklet runtime files import selected
`src/portfolio/core/**` modules today. The refactor should expand that pattern only for
small, pure helpers.

## Non-Goals

- Do not enable Worklets bundle mode.
- Do not DRY runtime boundary plumbing: MMKV bridges, fetch/signing adapters, populate
  session state, queue execution, worklet globals, reset orchestration, or runtime locks.
- Do not move UI formatting into worklet leaf modules unless the formatting is already
  pure and needed by both JS and worklet code.
- Do not introduce imports from RN, Redux, navigation, components, adapters, MMKV, or
  runtime worklet modules into shared leaf modules.

## Guiding Rule

DRY business rules aggressively; keep runtime plumbing boring and local.

Shared modules must be:

- Pure.
- Tiny.
- `'worklet'` annotated for runtime-used functions.
- Free of module-scope mutable caches unless proven safe with bundle mode off.
- Free of host/runtime objects such as MMKV storage bridges, fetch contexts, Redux store
  access, React hooks, and runtime globals.
- Importable from both normal JS and worklet runtime files.

---

## Phase 0: Safety Net

Before moving code, pin behavior with focused tests or confirm existing coverage.

### Atomic amount tests

Cover:

- Safe integer parsing.
- Unsafe large number parsing.
- Decimal strings.
- Scientific notation strings and numbers.
- Empty values.
- Invalid strings.
- Negative values.
- BigInt inputs.
- BTC/BCH/LTC/DOGE 8 decimals.
- ETH/MATIC/ARB/BASE/OP 18 decimals.
- XRP 6 decimals.
- SOL 9 decimals.
- Token decimals override.
- `formatBigIntDecimal` max-decimal behavior.
- Trailing zero trimming.
- `ratioBigIntToNumber` with zero denominator and signed inputs.

### Fiat-rate classifier tests

Cover:

- `wbtc -> btc`.
- `weth -> eth`.
- `matic -> pol`.
- `pol -> pol`.
- Legacy ETH-side MATIC token address becomes native `pol`.
- SOL/Solana token addresses preserve case.
- Non-SOL token addresses lowercase.
- Native coins omit `chain` and `tokenAddress`.

### Interval mapping tests

Cover:

- `1D`, `1W`, `1M`, `ALL` map to themselves.
- `3M`, `1Y`, `5Y` map to `ALL`.

### Rate point normalization tests

Cover:

- Object-shaped points.
- Tuple-shaped points if supported by the helper.
- Invalid `ts` / `rate` filtering.
- Ascending timestamp sort.

### Baseline duplicate inventory

Run:

```sh
rg -n "function (normalizeNonNegativeInteger|getAtomicDecimals|parseScientificToTruncatedIntegerString|parseAtomicToBigint|getPow10BigInt|makeAtomicToUnitNumberConverter|ratioBigIntToNumber|formatBigIntDecimal|formatAtomicAmount)" src/portfolio src/utils
rg -n "function (normalizeFiatRateSeriesCoin|getFiatRateAssetRef|resolveStoredFiatRateInterval|sanitizeRatePoints|getAssetIdFromWallet)" src/portfolio
```

Expected current duplicate clusters:

- `src/portfolio/core/format.ts`
- `src/portfolio/core/pnl/analysisStreaming.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts`
- `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts`
- `src/utils/portfolio/core/format.ts`

---

## Phase 1: Extract Atomic Amount Primitives

Create:

```txt
src/portfolio/core/atomicAmount.ts
```

Move the canonical implementations currently in `src/portfolio/core/format.ts`.
That file is already written in a mostly worklet-compatible style and is the best
source of truth for the extracted helper bodies.

### Exports

```ts
export function getEvmDecimals(): number;
export function getMaxAtomicToUnitFractionDigits(): number;
export function getRatioScale(): bigint;
export function normalizeNonNegativeInteger(value: number): number;
export function getAtomicDecimals(credentials: WalletCredentials): number;
export function toSignificantStr(n: number, maxDecimals: number): string;
export function parseScientificToTruncatedIntegerString(s: string): string | null;
export function parseAtomicToBigint(v: number | string | bigint): bigint;
export function getPow10BigInt(decimals: number): bigint;
export function makeAtomicToUnitNumberConverter(
  decimals: number,
  maxFractionDigits?: number,
): (atomic: bigint) => number;
export function ratioBigIntToNumber(n: bigint, d: bigint): number;
export function formatBigIntDecimal(
  atomic: bigint,
  decimals: number,
  maxDecimals?: number,
): string;
export function formatAtomicAmount(
  atomic: number | string | bigint,
  credentials: WalletCredentials,
  opts?: { maxDecimals?: number },
): string;
export function bigIntAbs(value: bigint): bigint;
export function parseNumberishToBigint(value: unknown): bigint;
```

### Implementation notes

- Use `import type {WalletCredentials} from './types';`.
- Put `'worklet'` in every function used from worklet runtime code.
- Keep constants behind tiny helpers where practical, matching the current
  `core/format.ts` comment about bundle mode off.
- Prefer deterministic computation over module-scope caches.
- Preserve the current large-number parsing comments. They are load-bearing and explain
  why `BigInt(number)` is unsafe for atomic units.
- `parseNumberishToBigint` and `bigIntAbs` are currently local to worklet files, but they
  are pure and should live here if shared.

### Update imports

Replace local helper definitions with imports in:

- `src/portfolio/core/pnl/analysisStreaming.ts`
- `src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts`
- `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts`
- `src/portfolio/core/format.ts`

`src/portfolio/core/format.ts` should become a wrapper/re-export surface for atomic
helpers plus portfolio display formatting helpers such as `formatChainAndNetwork`,
`formatWalletId`, `formatUnixTimeSecondsToLocal`, and `titleCase`.

### Reconcile legacy utils copy

`src/utils/portfolio/core/format.ts` has another independently-evolving atomic parser.
Pick one of these paths:

1. Preferred: migrate its callers to `src/portfolio/core/atomicAmount.ts` or
   `src/portfolio/core/format.ts`.
2. Acceptable short-term: make it import/re-export the canonical helpers.
3. Avoid: leaving two real implementations in place.

### Acceptance checks

```sh
rg -n "function (normalizeNonNegativeInteger|getAtomicDecimals|parseScientificToTruncatedIntegerString|parseAtomicToBigint|getPow10BigInt|makeAtomicToUnitNumberConverter|ratioBigIntToNumber|formatBigIntDecimal|formatAtomicAmount)" src/portfolio/runtime src/portfolio/core/pnl/analysisStreaming.ts
```

Expected: zero local definitions in runtime files and `analysisStreaming.ts`.

---

## Phase 2: Reuse Stored Fiat-Rate Interval Mapping

Canonical helper already exists:

```txt
src/portfolio/core/fiatRatesShared.ts
```

Use:

```ts
resolveStoredFiatRateInterval(...)
```

Replace the local copy in:

```txt
src/portfolio/core/pnl/analysisStreaming.ts
```

### Acceptance check

```sh
rg -n "function resolveStoredFiatRateInterval|const resolveStoredFiatRateInterval" src/portfolio
```

Expected: only the canonical definition in `fiatRatesShared.ts`.

---

## Phase 3: DRY Fiat-Rate Asset Classification

Use existing canonical helpers:

```txt
src/portfolio/core/fiatRatesShared.ts
src/portfolio/core/pnl/rates.ts
```

Canonical exports:

```ts
normalizeFiatRateSeriesChain
normalizeFiatRateSeriesTokenAddress
normalizeFiatRateSeriesCoin
getFiatRateAssetRef
```

Replace local copies in:

```txt
src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts
```

This is high-value because classifier drift causes real correctness bugs:

- Token-vs-native fetch mismatches.
- Legacy MATIC/POL regressions.
- Wrong SOL token address casing.
- Different JS and worklet behavior for the same wallet summary.

### Acceptance check

```sh
rg -n "function normalizeFiatRateSeriesCoin|function getFiatRateAssetRef|function normalizeFiatRateSeriesTokenAddress|function normalizeFiatRateSeriesChain" src/portfolio/runtime
```

Expected: no runtime-local duplicate definitions, only imports.

---

## Phase 4: DRY Asset ID Construction

Canonical helper already exists:

```txt
src/portfolio/core/pnl/assetId.ts
```

Use:

```ts
getAssetIdFromWallet(...)
```

Replace the local copy in:

```txt
src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts
```

### Acceptance check

```sh
rg -n "function getAssetIdFromWallet|const getAssetIdFromWallet" src/portfolio
```

Expected: only the canonical helper in `core/pnl/assetId.ts`.

---

## Phase 5: Consolidate Rate Point Normalization

Current overlap:

- `sanitizeRatePoints(...)` in `src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts`
- `normalizeStoredFiatRateSeriesPoints(...)` in
  `src/portfolio/core/pnl/storedFiatRateSeries.ts`

Preferred path:

- Use `normalizeStoredFiatRateSeriesPoints(...)` directly if its tuple/object compatibility
  and sorting behavior match the `sanitizeRatePoints(...)` call sites.

If a narrower generic helper is needed, create:

```txt
src/portfolio/core/pnl/rateSeriesMath.ts
```

Potential exports:

```ts
export function normalizeFiatRatePoints(candidate: unknown): FiatRatePoint[];
export function isSortedByTsAsc(points: readonly FiatRatePoint[]): boolean;
export function findNearestRatePoint(
  points: readonly FiatRatePoint[],
  targetTs: number,
): FiatRatePoint | null;
```

Do not overbuild this phase. Consolidate only if the semantics are truly shared.
Atomic amount and classifier DRY are higher priority.

### Acceptance check

```sh
rg -n "function sanitizeRatePoints|const sanitizeRatePoints" src/portfolio
```

Expected: zero definitions if fully consolidated, or one canonical definition if a named
helper remains.

---

## Phase 6: Add Import Hygiene Guardrails

Add a lightweight test or script to prevent accidental dependency creep.

### Leaf module import restrictions

The following modules must not import RN, Redux, navigation, components, adapters, MMKV,
or runtime worklet modules:

- `src/portfolio/core/atomicAmount.ts`
- `src/portfolio/core/fiatRatesShared.ts`
- `src/portfolio/core/pnl/rates.ts`
- `src/portfolio/core/pnl/assetId.ts`
- `src/portfolio/core/pnl/storedFiatRateSeries.ts`
- `src/portfolio/core/pnl/rateSeriesMath.ts` if added

Suggested restricted import patterns:

```txt
react
react-native
@react-native
src/store
src/navigation
src/components
src/portfolio/adapters
src/portfolio/runtime
src/utils
```

Allow type-only imports from `src/portfolio/core/**`.

### Duplicate definition guard

Add a grep-style test that fails if runtime files define extracted helpers locally:

```sh
rg -n "function (normalizeNonNegativeInteger|getAtomicDecimals|parseAtomicToBigint|getPow10BigInt|ratioBigIntToNumber|getFiatRateAssetRef|getAssetIdFromWallet)" src/portfolio/runtime src/portfolio/core/pnl/analysisStreaming.ts
```

Expected: zero matches after this refactor.

---

## Phase 7: Validation

Run targeted tests first, then broader checks.

Suggested sequence:

```sh
yarn test src/portfolio/core
yarn test src/portfolio/core/pnl
yarn test src/portfolio/runtime/worklet
yarn typecheck
```

If this repo uses different test script names, use the nearest existing scripts.

Also run any snapshot-builder and PnL parity tests available, because atomic parsing feeds
balance math directly.

---

## Expected Payoff

This refactor likely saves a few hundred lines immediately, not thousands. The larger win
is correctness:

- Atomic parsing and BigInt conversion stop drifting across JS, analysis, populate, and
  snapshot-builder paths.
- Fiat-rate classifier behavior becomes single-source, reducing token-vs-native and alias
  regressions.
- Interval storage mapping is single-source.
- Asset IDs are constructed consistently across JS and worklet paths.

This gives much of the practical deduplication benefit that bundle mode originally
promised, while avoiding the blast radius of making v18 depend on an experimental global
bundling configuration.

## Suggested Order

1. Atomic amount primitives.
2. Stored interval mapping.
3. Fiat-rate asset classifier.
4. Asset ID construction.
5. Rate point normalization.
6. Import hygiene guardrails.
7. Full validation.

The first three phases deliver the highest risk reduction and should be prioritized.
