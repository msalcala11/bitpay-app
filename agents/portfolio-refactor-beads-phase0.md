# Phase 0 (Bead Decomposition) — Inventory and Feature Flag

## Preamble

### Why this document exists

Prior review cycles of the v18 refactor plan surfaced several cases where the plan asserted something about the repo that turned out to be wrong, and it took multiple review rounds to catch each one:

- **`populateOneWallet` was never a real function.** The v1 kernel exposes four per-phase handlers (`handlePrepareWalletOnPopulateWorklet`, etc.) and a separate orchestrator (`runSingleWalletPopulateOnWorklet`). The plan's Phase 5 snippet referenced `populateOneWallet` as if it were kernel API for several revisions before we verified.
- **`extractSeries` was file-local, not exported.** An early Phase 2 snippet called `fiatRateStore.extractSeries(...)` as if it were public. It isn't. The plan now calls for a v2-owned clone.
- **`getPortfolioKvStore()` did not exist in the repo** despite the plan's Phase 7.5 wipe implementation referencing it as if it did.
- **Signing-context wrap granularity** was initially drawn as "once around an entire wallet session" when v1's actual pattern is "per handler call." Took a deliberate code-reading pass to catch.

Each of these silent assumption failures could have been caught by a small grep-and-report step at Phase 0 execution time. The current Phase 0 prose ("Produce PORTFOLIO_REFACTOR_INVENTORY.md") bundles ~17 load-bearing assumptions into one big doc, where a failure can be buried inside a section and missed. Breaking Phase 0 into **beads** — small, atomic, evidence-producing verification units — makes each assumption a named checkpoint that either passes with evidence or escalates.

This document replaces the v18 Phase 0 prose with a bead-structured execution plan. The deliverable is still `PORTFOLIO_REFACTOR_INVENTORY.md` + a feature flag; the *path* to that deliverable is now auditable.

### What this replaces

In v18, Phase 0 is roughly:

> Read `src/portfolio/**` plus consumers. Produce `PORTFOLIO_REFACTOR_INVENTORY.md` with 12 numbered items. Add `PORTFOLIO_V2` feature flag.
>
> **LOC ledger:** +30 / 0 / +30.

That framing is correct at the 10,000-foot level but gives an implementing agent no structure for knowing when each item is "done," no way to parallelize independent work, and no explicit handling for assumption failures. This document expands it into ~27 beads with explicit dependencies, pass/fail criteria, and aggregation.

The end-of-phase acceptance (`PORTFOLIO_REFACTOR_INVENTORY.md` exists, flag works) and the LOC ledger are unchanged.

### What is a "bead"

A bead is a small unit of work with three properties:

1. **Atomic**: does one thing (verifies one assumption, produces one artifact, or aggregates a specific output). If two assumptions are tightly coupled (verifying them costs about the same as verifying one), combine into a single bead with multiple sub-items. If they are independent, keep them separate.
2. **Self-contained**: an agent executing a single bead needs only the bead's own specification — not the rest of the plan, not prior context. Every bead states the background, the commands to run, the pass criteria, and what to do on failure.
3. **Evidence-producing**: a pass is a pass *with file:line citations, command output, or concrete artifacts*. "It looks like this works" is never a pass. A plausible-looking agent narration without evidence is a fail.

Beads come in four flavors:

- **V (verify)**: check an assumption the plan makes about the repo. Pass = assumption holds with cited evidence. Fail = assumption doesn't hold; escalation may change the plan.
- **D (discover)**: find something the plan references by role but not by exact name (e.g., "the specific post-auth Redux action"). Pass = a concrete answer with evidence.
- **P (produce)**: create a concrete artifact in the codebase (feature flag scaffolding, for now).
- **A (aggregate)**: consume outputs from prior beads and assemble a deliverable (the inventory doc).

### Execution model

**Parallelism.** Beads without upstream dependencies may be dispatched concurrently. A reasonable decomposition: run all verification/discovery beads in parallel, wait for their outputs, then run the production and aggregation beads sequentially. See the dependency graph below.

**Evidence format.** Each bead emits a small JSON-ish record:

```
{
  id: "<bead-id>",
  status: "pass" | "pass-with-deviation" | "fail-recoverable" | "fail-escalate",
  evidence: [
    "src/foo.ts:42  <cited line>",
    "yarn test: 1234 tests, 0 failures",
    ...
  ],
  deviation?: "<what was found that wasn't expected but doesn't block>",
  fail_reason?: "<concrete reason the assumption doesn't hold>",
  recommended_plan_amendment?: "<if fail-escalate, a proposed plan change>"
}
```

These records are aggregated by the final aggregation bead into the inventory doc.

**Cache warming.** A shared scratchpad (e.g., a `.beads/` directory) holds each bead's evidence record and any raw greps/reads it produced. The aggregation bead consumes this scratchpad. After phase 0 completes the scratchpad is discarded; the inventory doc is the persistent record.

### Escalation protocol

Four fail modes, in increasing severity:

1. **pass-with-deviation**: the bead passes but found something unexpected (e.g., a file is in a slightly different path than the plan says). The bead's evidence records the deviation; the aggregation bead notes it in the inventory; downstream phases use the corrected fact. No human escalation.

2. **fail-recoverable**: the bead's stated question has a wrong premise but the correct answer is obvious from evidence (e.g., plan says "look in `core/pnl/foo.ts:12`" and the function is actually in `core/pnl/foo.ts:34`). Bead updates its evidence with the corrected location and reports pass-with-deviation. No human escalation.

3. **fail-plan-wrong**: the bead's assumption doesn't hold and there's no obvious recovery (e.g., v1 does NOT rewind before tip for reorg protection). Bead reports `fail-escalate` with a proposed amendment. The aggregation bead will surface these failures prominently in the inventory. A human or planning agent must decide: adjust the plan, add v2-owned work, or reduce scope. **No downstream phase depending on this bead may start until the escalation is resolved.**

4. **fail-infra**: the bead's tooling failed (grep errored, repo was in a bad state, etc.). Retry with more careful commands; if persistent, escalate as infrastructure issue.

**Rule**: fail-escalate findings are load-bearing. They change the plan. Never "patch around" a fail-escalate by stubbing it out or assuming it's fine.

### Bead template

Each bead below follows this structure:

```
#### [ID]: [Name]
- **Flavor**: V / D / P / A
- **Depends on**: [bead ids or "none"]
- **Unblocks**: [phases that can start after this bead passes]
- **Estimated effort**: [minutes | hours]
- **Risk of fail**: [low | medium | high] — informal estimate of how likely
  an assumption failure is

**Background**: Why this matters for the v2 refactor. Links to specific
guardrails, kernels, or behaviors.

**Question**: The specific thing being answered.

**Verification steps**: Concrete commands, in order.

**Pass criteria**: What a "pass" looks like, with evidence format.

**Fail criteria**: What triggers a failure; which of the four fail modes
applies.

**Output artifact**: The specific record/snippet this bead adds to the
scratchpad.
```

### Dependency graph

ASCII DAG. Nodes are beads; edges are "depends-on." Horizontal dotted lines group beads by category.

```
A1 (MMKV adapter)         ────┐
A2 (MMKV prefixes)        ────┤
A3 (no getPortfolioKvStore yet) ──┐
                                   │
B1 (FiatRateStore API)    ────┐    │
B2 (BwsFiatRateProvider)  ────┤    │
                               │    │
C1 (populate handlers)    ────┤    │
C2 (v1 orchestrator)      ─── C1   │
C3 (reorg rewind ★)       ─── C1   │
C4 (no populateOneWallet) ────┤    │
                               │    │
D1 (portfolio Redux slices)─┐  │    │
D2 (state paths)            D1 │    │
D3 (getStore/RootState)   ────┤    │
D4 (Show Portfolio setting) D1 │    │
D5 (post-auth action ★)   ────┤    │
                               │    │
E1 (ticker collapse)      ────┤    │
E2 (allocation order)     ────┤    │
E3 (key-scope nav)        ────┤    │
E4 (pull-to-refresh)      ────┤    │
E5 (quote switching)      ────┤    │
E6 (interval fetch scope) ────┤    │
E7 (timeframe side effects) ──┤    │
                               │    │
F1 (bundle mode + hybrids)────┤    │
                               │    │
G1 (reset path inventory) ────┤    │
                               ▼    ▼
H1 (export catalog)   ─── (depends on nothing)
H2 (call graph)       ─── H1
                               │
I1 (kept-file LOC)    ─── (depends on nothing)
I2 (deleted-file LOC) ─── (depends on nothing)
I3 (yarn test baseline)─── (depends on nothing)
                               │
J1 (PORTFOLIO_V2 flag)──── A1, A2  (needs to know MMKV layout)
                               │
                               ▼
K1 (aggregate inventory) ── ALL above
```

★ = high-risk beads; escalation likely.

**Parallelizable tranches:**

- **Tranche 1** (run first, in parallel): A1, A2, A3, B1, B2, C1, C4, D1, D3, D5, E1–E7, F1, G1, H1, I1, I2, I3. Each is independent, each has its own grep/read pattern.
- **Tranche 2** (after tranche 1): C2 (needs C1), C3 (needs C1), D2 (needs D1), D4 (needs D1), H2 (needs H1), J1 (needs A1, A2).
- **Tranche 3** (after all prior): K1 aggregates.

### Aggregation and deliverable

The end-of-phase deliverable remains `PORTFOLIO_REFACTOR_INVENTORY.md`, structured to match v18's Phase 0 item list (Mermaid graph, exports, Redux slices, state paths, MMKV prefixes, etc.). Each item in the inventory cites the bead(s) that produced it. Fail-escalate findings appear in a dedicated "Plan Amendments Required Before Downstream Phases Start" section at the top.

Plus the PORTFOLIO_V2 feature flag committed to the repo.

---

## Beads

---

### Group A — Structural verification (MMKV + adapter + key layout)

These beads confirm the plan's assumptions about the repo's MMKV layer are accurate. Phase 1's `getPortfolioKvStore()` helper, Phase 7.5's `wipePortfolioMmkvKeys`, and every bead or phase that reads/writes MMKV depends on these facts.

#### A1: MMKV adapter layout

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 1 (scaffold `kvStore.ts`), Phase 7.5 (wipe implementation), J1 (feature flag scaffolding)
- **Estimated effort**: 15 minutes
- **Risk of fail**: low — already verified in prior informal audits

**Background**: The plan assumes a dedicated MMKV instance at `id: 'bitpay.portfolio.engine'`, accessed via `getPortfolioMmkvStorageOnRN()` in `src/portfolio/adapters/rn/workletMmkvBridge.ts`, with exported constants `PORTFOLIO_WORKLET_MMKV_STORAGE_ID` and `PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY`. It also assumes the `MmkvKvStore` wrapper in `src/portfolio/adapters/rn/mmkvKvStore.ts` is constructed as `new MmkvKvStore(storage, {storageId, registryKey})`. Every downstream MMKV operation builds on this — if any of these names are wrong, the whole wipe/reset machinery silently lands in the wrong namespace. This is the foundation.

**Question**: Do the three constants and two accessor functions exist in the repo, at the paths the plan cites, with the shapes the plan expects?

**Verification steps**:

```bash
# 1. Open workletMmkvBridge.ts and confirm exports.
cat src/portfolio/adapters/rn/workletMmkvBridge.ts

# 2. Confirm these exports exist by name:
grep -n "export const PORTFOLIO_WORKLET_MMKV_STORAGE_ID" src/portfolio/adapters/rn/workletMmkvBridge.ts
grep -n "export const PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY" src/portfolio/adapters/rn/workletMmkvBridge.ts
grep -n "export function getPortfolioMmkvStorageOnRN" src/portfolio/adapters/rn/workletMmkvBridge.ts
grep -n "export function createPortfolioMmkvStorageOnRN" src/portfolio/adapters/rn/workletMmkvBridge.ts

# 3. Confirm the MMKV id used in createPortfolioMmkvStorageOnRN is literally
#    'bitpay.portfolio.engine' (no prefix variations).
grep -n "id:" src/portfolio/adapters/rn/workletMmkvBridge.ts

# 4. Open mmkvKvStore.ts and confirm the constructor signature.
cat src/portfolio/adapters/rn/mmkvKvStore.ts | head -200

# 5. Confirm constructor takes `(storage, {storageId, registryKey})`.
grep -n "constructor" src/portfolio/adapters/rn/mmkvKvStore.ts
```

**Pass criteria**: All five grep results return matches; the MMKV id string matches exactly; `MmkvKvStore` constructor takes a storage instance and an options object with `storageId` and `registryKey`.

Evidence record format:
```
{
  id: "A1",
  status: "pass",
  evidence: [
    "src/portfolio/adapters/rn/workletMmkvBridge.ts:8  export const PORTFOLIO_WORKLET_MMKV_STORAGE_ID = 'bitpay.portfolio.engine';",
    "src/portfolio/adapters/rn/workletMmkvBridge.ts:9  export const PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY = DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY;",
    "src/portfolio/adapters/rn/workletMmkvBridge.ts:14 export function createPortfolioMmkvStorageOnRN(): MMKV { return new MMKV({id: PORTFOLIO_WORKLET_MMKV_STORAGE_ID}); }",
    "src/portfolio/adapters/rn/workletMmkvBridge.ts:20 export function getPortfolioMmkvStorageOnRN(): MMKV { ... }",
    "src/portfolio/adapters/rn/mmkvKvStore.ts:160 export class MmkvKvStore implements KvStore { constructor(storage, {storageId, registryKey}) { ... } }"
  ]
}
```

**Fail criteria**: Any of the five names doesn't exist; the MMKV id is not `'bitpay.portfolio.engine'`; the constructor signature is different (e.g., takes a single config object instead). Any of these triggers **fail-plan-wrong** (the entire MMKV wipe scope depends on this being right).

**Output artifact**: Evidence record in scratchpad; also copy the first ~40 lines of both files (verbatim) into the scratchpad so the aggregation bead can quote them directly.

---

#### A2: Portfolio MMKV key prefix inventory

- **Flavor**: V + D (verifies expected set, discovers any extras)
- **Depends on**: none
- **Unblocks**: Phase 7.5 wipe implementation (guardrail #23's `PORTFOLIO_WIPE_PREFIXES` constant)
- **Estimated effort**: 30 minutes
- **Risk of fail**: medium — plan has a specific expected set but greps often find stragglers

**Background**: `wipePortfolioMmkvKeys` only deletes keys with prefixes in `PORTFOLIO_WIPE_PREFIXES = ['snap:', 'rate:v1:', 'portfolio:v2:']`. Any portfolio-related key with a different prefix would survive a wipe, leaving orphan data that corrupts subsequent populate. The plan's expected set is grounded in an informal audit; this bead verifies it exhaustively.

**Question**: What is the *complete* set of MMKV key prefixes used by portfolio code (v1 + v2)? Does the plan's expected list match?

**Verification steps**:

```bash
# Grep for string-template key construction. Match patterns like:
#   `return \`<prefix>:...\``
#   `key: \`<prefix>:...\``
#   `.setString(\`<prefix>:...\`)`
#   `.getString(\`<prefix>:...\`)`
# The key insight: portfolio MMKV keys are always constructed as template literals
# starting with a lowercased prefix followed by a colon.

grep -rEn "\`[a-z][a-z0-9_-]*:" src/portfolio/core/pnl/
grep -rEn "\`[a-z][a-z0-9_-]*:" src/portfolio/runtime/worklet/
grep -rEn "\`[a-z][a-z0-9_-]*:" src/portfolio/adapters/
grep -rEn "\`[a-z][a-z0-9_-]*:" src/portfolio/service/

# Also search for direct string keys (non-template).
grep -rEn "'[a-z][a-z0-9_-]*:" src/portfolio/

# Extract the unique set of distinct prefixes found.
# A prefix is the part before the first ':' that appears in key position.
```

**Pass criteria**: The complete set of distinct prefixes found is a subset of `['snap:', 'rate:v1:', 'portfolio:v2:']` — the exact set in the plan. Evidence record lists every prefix found with at least one file:line citation per prefix.

**Pass-with-deviation**: Found additional prefixes beyond the expected set (e.g., `pnl:` or `hist:`). Record the extras explicitly; the plan's `PORTFOLIO_WIPE_PREFIXES` will need to be extended to cover them before Phase 7.5.

**Fail-plan-wrong**: Prefix conventions are fundamentally different than strings (e.g., keys use a structured binary encoding instead of prefixed strings). This would invalidate the wipe-by-prefix approach entirely.

**Output artifact**: A table of `{prefix, sample_file:line, purpose}` rows, one per distinct prefix. Aggregator uses this verbatim for the "MMKV key prefixes in use" section of the inventory.

---

#### A3: Verify `getPortfolioKvStore()` does not exist yet

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 1 (confirms the v2 helper needs to be created)
- **Estimated effort**: 5 minutes
- **Risk of fail**: low

**Background**: The plan's Phase 1 creates a new v2 helper `getPortfolioKvStore()`. An earlier plan revision implied it already existed; reviewers caught this. This bead is a cheap sanity check to confirm the helper doesn't already exist somewhere — otherwise Phase 1 would be shadowing or colliding.

**Question**: Is there any existing function named `getPortfolioKvStore` in `src/`?

**Verification steps**:

```bash
grep -rn "getPortfolioKvStore" src/
```

**Pass criteria**: Zero matches, or matches only in the plan documents (`portfolio-refactor-plan-v*.md`). Evidence: `grep` output (empty or plan-docs-only).

**Fail-plan-wrong**: A real `getPortfolioKvStore` already exists in code. Phase 1 would need to either reuse it (if the signature matches) or choose a different name.

**Output artifact**: grep output (copied verbatim to scratchpad).

---

### Group B — FiatRateStore + rate fetch primitives

These beads verify the plan's Phase 2 `ensureFresh` implementation has the primitives it needs. If any of these fail, Phase 2's structural requirement (separate fetch / guard-check / persist with a v2-owned parser) cannot be implemented as specified.

#### B1: `FiatRateStore` API separability

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 2 (ensureFresh structural requirement)
- **Estimated effort**: 20 minutes
- **Risk of fail**: low — verified in prior audits

**Background**: Phase 2's `ensureFresh` must be structured as "freshness-check + fetch, then guard-check, then persist." This requires that `FiatRateStore.getSeries()` (for freshness check) and `setSeries()` (for persistence) are public on the store instance, and that the internal `extractSeries` helper is *not* exported (so v2 must clone it instead of importing — preserving guardrail #2, "don't refactor kernels"). If `extractSeries` were public, v2 would import it and the clone would be redundant; if `getSeries`/`setSeries` were internal, v2 couldn't assemble the fetch/persist split without touching kernel code.

**Question**: Is `FiatRateStore.getSeries` public? Is `FiatRateStore.setSeries` public? Is `extractSeries` file-local (not exported)?

**Verification steps**:

```bash
cat src/portfolio/core/pnl/fiatRateStore.ts

# Confirm class is exported and the methods are public instance methods:
grep -n "export class FiatRateStore" src/portfolio/core/pnl/fiatRateStore.ts
grep -nE "^\s*(async )?getSeries\s*\(" src/portfolio/core/pnl/fiatRateStore.ts
grep -nE "^\s*(async )?setSeries\s*\(" src/portfolio/core/pnl/fiatRateStore.ts

# Confirm extractSeries is a file-local function, not exported:
grep -n "extractSeries" src/portfolio/core/pnl/fiatRateStore.ts
# Expect: the declaration is `function extractSeries(...)` with no `export`
# prefix. If there's `export function extractSeries` or `export { extractSeries }`,
# that would be a deviation.

# Also verify extractSeries is not re-exported elsewhere:
grep -rn "extractSeries" src/portfolio/
```

**Pass criteria**: `FiatRateStore` is exported; `getSeries` and `setSeries` are public instance methods (not `private`); `extractSeries` is a bare `function` (no `export`) and not re-exported from any other file.

**Fail-recoverable**: `extractSeries` is exported from the file. Phase 2 can import it directly instead of cloning (minor plan amendment: drop the clone; import).

**Fail-plan-wrong**: `getSeries` or `setSeries` is `private`. Phase 2 would need to either mark them public (kernel touch — violates guardrail #2) or construct a workaround.

**Output artifact**: Evidence record with file:line citations for each method's visibility.

---

#### B2: `RnBwsFiatRateProvider.loadSeries` worklet + fetch-context shape

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 2 (ensureFresh worklet wrapper); guardrail #26 (dispatch context plumbing)
- **Estimated effort**: 15 minutes
- **Risk of fail**: low

**Background**: Phase 2's worklet wrapper `loadSeriesWorkletWithContext(...)` installs a lightweight dispatch context before calling `provider.loadSeries(...)`. This is because the provider is `'worklet'`-tagged and internally calls `getPortfolioNitroFetchClientOnRuntime()`, which *requires* a dispatch context installed on the runtime (even when the request doesn't need BWS signing — per `portfolioWorkletTransport.ts:137`). If the provider weren't worklet-tagged, the wrapper pattern is unnecessary. If it didn't read from the dispatch context, the wrapper is wrong.

**Question**: Is `RnBwsFiatRateProvider.loadSeries` `'worklet'`-tagged? Does it call `getPortfolioNitroFetchClientOnRuntime()`?

**Verification steps**:

```bash
cat src/portfolio/adapters/rn/bwsFiatRateProvider.ts

grep -n "'worklet'" src/portfolio/adapters/rn/bwsFiatRateProvider.ts
grep -n "getPortfolioNitroFetchClientOnRuntime" src/portfolio/adapters/rn/bwsFiatRateProvider.ts

# Also verify the transport-layer rule cited in guardrail #26:
grep -n "Even requests that do not need BWS signing" src/portfolio/runtime/portfolioWorkletTransport.ts
```

**Pass criteria**: `'worklet'` directive appears inside `loadSeries`; `getPortfolioNitroFetchClientOnRuntime()` is called inside the method; the transport-layer comment exists at the cited location.

**Fail-plan-wrong**: `loadSeries` is not worklet-tagged (would mean the Phase 2 wrapper is unnecessary — plan simplification) OR it doesn't use `getPortfolioNitroFetchClientOnRuntime` (would mean the dispatch-context requirement doesn't apply — guardrail #26 needs rewording).

**Output artifact**: Evidence record; copy the `loadSeries` method body into the scratchpad so Phase 2's implementation can mirror its fetch shape.

---

### Group C — Populate kernel API

These beads verify the plan's Phase 5 `drivePopulateForWallet` orchestrator will actually compose real kernel functions. C3 (reorg rewind) is the single highest-risk bead in Phase 0 — if it fails, Phase 5's LOC estimate increases significantly.

#### C1: Per-phase handler inventory

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 5 (`drivePopulateForWallet`), C2, C3
- **Estimated effort**: 15 minutes
- **Risk of fail**: low — verified in prior audits

**Background**: The plan's Phase 5 orchestrator calls four specific handlers in sequence: `handlePrepareWalletOnPopulateWorklet`, `handleProcessNextPageOnPopulateWorklet`, `handleFinishWalletOnPopulateWorklet`, `handleCloseWalletSessionOnPopulateWorklet`. If any handler is missing or renamed, Phase 5 breaks on first compile.

**Question**: Do these four exported functions exist in `src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts`?

**Verification steps**:

```bash
grep -nE "^export (async )?function handlePrepareWalletOnPopulateWorklet" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
grep -nE "^export (async )?function handleProcessNextPageOnPopulateWorklet" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
grep -nE "^export (async )?function handleFinishWalletOnPopulateWorklet" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
grep -nE "^export (async )?function handleCloseWalletSessionOnPopulateWorklet" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts

# Extract each function's signature (first 10 lines after the declaration)
# so Phase 5 knows the parameter shape.
for fn in handlePrepareWalletOnPopulateWorklet handleProcessNextPageOnPopulateWorklet handleFinishWalletOnPopulateWorklet handleCloseWalletSessionOnPopulateWorklet; do
  echo "=== $fn ==="
  grep -A 20 "export .*function $fn" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts | head -20
done
```

**Pass criteria**: All four functions exist with `export` at file scope. Evidence includes file:line for each export plus the first ~10 lines of each function's signature.

**Fail-plan-wrong**: Any of the four is missing / renamed / has a fundamentally different signature. Phase 5 needs amendment before `drivePopulateForWallet` can be implemented.

**Output artifact**: A table `{handler_name, file:line, first_N_lines_of_signature}` for all four. Phase 5's `drivePopulateForWallet` implementation reads from this table.

---

#### C2: v1 orchestrator + signing-context wrap granularity

- **Flavor**: V
- **Depends on**: C1
- **Unblocks**: Phase 5 (`drivePopulateForWallet` signing-context wrap pattern)
- **Estimated effort**: 20 minutes
- **Risk of fail**: low — verified in prior audits, but worth confirming because the wrap granularity was historically misread

**Background**: v18's `drivePopulateForWallet` mirrors v1's orchestration pattern. Critically, the signing-context wrap is *per-handler-call*, not once per wallet session. v1's `runSingleWalletPopulateOnWorklet` in `portfolioPopulateJobWorklet.ts` wraps `handlePrepareWalletOnPopulateWorklet` with `withWalletSigningContext(...)`, and wraps each loop iteration of `handleProcessNextPageOnPopulateWorklet` similarly, but does *not* wrap `handleFinishWalletOnPopulateWorklet` or `handleCloseWalletSessionOnPopulateWorklet`. An earlier plan revision drew the wrap "once around the whole session" — this is wrong, and guardrail #26 explicitly pins the per-handler pattern.

**Question**: In `portfolioPopulateJobWorklet.ts`, which handler calls are wrapped with `withWalletSigningContext` and which are not? Does the pattern match "prepare + each processNextPage, not finish/close"?

**Verification steps**:

```bash
cat src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts | head -500

grep -n "runSingleWalletPopulateOnWorklet" src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts
grep -n "withWalletSigningContext" src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts

# Find the orchestrator function body and trace each handler call,
# noting whether each is wrapped with withWalletSigningContext.
```

Expected: wrap on `handlePrepareWalletOnPopulateWorklet`, wrap on `handleProcessNextPageOnPopulateWorklet` (inside the page loop), no wrap on `handleFinishWalletOnPopulateWorklet` or `handleCloseWalletSessionOnPopulateWorklet`.

**Pass criteria**: Evidence shows exactly this pattern; call-by-call file:line annotations.

**Pass-with-deviation**: Wrap granularity is slightly different (e.g., `handleFinishWalletOnPopulateWorklet` IS wrapped in v1). Record; Phase 5 should mirror v1's actual pattern, not the plan's summary.

**Fail-plan-wrong**: v1 wraps once around the entire sequence (not per handler). v18's guardrail #26 would then be wrong and needs rewriting.

**Output artifact**: A line-annotated listing of the orchestrator's handler calls with wrap/no-wrap notation. Phase 5 mirrors this exactly.

---

#### C3: v1 reorg protection mechanism

- **Flavor**: V (and possibly D if mechanism is found but in an unexpected place)
- **Depends on**: C1
- **Unblocks**: Phase 5 (reorg-safety claim)
- **Estimated effort**: 1-2 hours
- **Risk of fail**: **HIGH** — this is the single most likely bead to escalate

**Background**: Guardrail in v18: *"App-launch refresh, send-triggered refresh, and pull-to-refresh refreshes must start slightly before the latest persisted tip and overwrite the recent tail snapshots rather than strictly appending from the current tip."* The plan asserts v1 already does this and v18 preserves it. **This has not been verified.** If v1 doesn't do tip-rewind, v18's reorg-safety claim is a fiction and Phase 5 needs new code to implement it. That adds LOC and testing surface to Phase 5.

**Question**: On an incremental populate (not first-ever), does v1 rewind before the latest persisted snapshot tip and re-ingest the recent tail? If so, where is the rewind logic, and what is the rewind-window (hours, days, blocks)?

**Verification steps**:

```bash
# Read the populate handler that processes pages and ingests snapshots.
# The rewind logic, if it exists, is in or around:
#   - handleProcessNextPageOnPopulateWorklet
#   - any "startFrom" or "fromTimestamp" argument passed into tx-history fetch
#   - snapshotStore's ingestion path (dedupe by timestamp/hash)

grep -n "rewind\|tip\|overlap\|overwrite" src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
grep -n "rewind\|tip\|overlap\|overwrite" src/portfolio/core/pnl/snapshotStore.ts
grep -n "rewind\|tip\|overlap\|overwrite" src/portfolio/core/pnl/snapshotStream.ts

# Look for any "start N blocks before tip" or "re-ingest last N hours" logic.
grep -rn "latestTipTs\|latestTip\|tipTs\|fromTs\|fromTimestamp" src/portfolio/core/pnl/
grep -rn "latestTipTs\|latestTip\|tipTs\|fromTs\|fromTimestamp" src/portfolio/runtime/worklet/

# Read tx history fetch entry point to see if it includes an overlap parameter.
cat src/portfolio/core/tokenTxHistory.ts | head -200
cat src/portfolio/core/txHistoryPaging.ts | head -200

# Check for snapshot dedupe / upsert logic in ingestion.
grep -n "upsert\|dedupe\|replace" src/portfolio/core/pnl/snapshotStore.ts
```

If nothing resembling rewind-before-tip is found: **fail-escalate**.

If something is found: document its exact mechanism (rewind window, how the overlap is computed, how dedupe handles repeated snapshots).

**Pass criteria**: Located a concrete mechanism — either (a) populate requests tx history from `tipTs - N` rather than from `tipTs`, OR (b) ingestion re-processes the last K snapshots and upserts. Evidence: file:line + a short prose description of the mechanism.

**Fail-escalate**: No such mechanism exists. Populate strictly appends from the current tip. Recommended plan amendment: Phase 5's `drivePopulateForWallet` gains a pre-prepare step that adjusts the fetch start timestamp to `latestPersistedTipTs - REORG_REWIND_MS` (value TBD), and the snapshot ingestion path needs to tolerate duplicate/superseded snapshots. Estimated +50–100 LOC in Phase 5.

**Output artifact**: A description of the rewind mechanism (if it exists) or a fail-escalate record with the proposed amendment.

---

#### C4: Confirm no `populateOneWallet` exists

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 5 (confirms `drivePopulateForWallet` is net-new, not shadowing)
- **Estimated effort**: 5 minutes
- **Risk of fail**: low

**Background**: An earlier plan revision referenced `populateOneWallet` as if it were a kernel function. It wasn't. Cheap sanity check to confirm no such function exists now either — if one appeared somewhere, Phase 5 would need to either reuse or rename.

**Question**: Is there any function named `populateOneWallet` in `src/`?

**Verification steps**:

```bash
grep -rn "populateOneWallet" src/ --include="*.ts" --include="*.tsx"
```

**Pass criteria**: Zero matches. Evidence: empty grep output.

**Fail-recoverable**: One or more matches found. Phase 5 must either reuse (if signature matches) or choose a different name for the new orchestrator (e.g., `drivePopulateForWallet` — already the plan's choice).

**Output artifact**: grep output.

---

### Group D — Redux and bootstrap

These beads map the Redux surface the plan's `reduxAccess.ts` module will read from, and confirm the bootstrap hooks where v2 initialization must run.

#### D1: Redux slices holding portfolio data

- **Flavor**: D
- **Depends on**: none
- **Unblocks**: D2, D4, Phase 0 inventory item #3
- **Estimated effort**: 45 minutes

**Background**: v18's philosophy is "Redux holds only small cached data for instant UI render; MMKV holds bulk." To enforce that, we need to know what Redux *currently* stores related to portfolio so we can triage: which fields does v2 read (keep), which are replaced by v2 state (delete), which are v1-only (deletable after Phase 8).

**Question**: Which Redux slices contain portfolio-related fields? For each slice, enumerate the fields, estimate their size footprint, and propose a v2 retention label: `keep` (v2 reads it), `delete` (v1 only), or `replace` (v1 stores it; v2 reads same logical data from elsewhere).

**Verification steps**:

```bash
# Find Redux slice definitions.
find src/store -name "*.reducer.ts"
find src/store -name "*.slice.ts"
find src/store -name "*.models.ts"

# Focus on portfolio-adjacent slices:
ls src/store/portfolio/
ls src/store/rate/
ls src/store/wallet/

# For each, read the model / reducer / initial state.
cat src/store/portfolio/portfolio.models.ts
cat src/store/portfolio/portfolio.reducer.ts
cat src/store/rate/rate.models.ts
cat src/store/rate/rate.reducer.ts
```

**Pass criteria**: A table `{slice, field, purpose, estimated_size, v2_label}` for each portfolio-related field. Specific attention to:

- `portfolio.populateStatus`, `lastPopulatedAt`, `quoteCurrency`, `populateDisabled`, `snapshotBalanceMismatchesByWalletId` (from prior audits)
- `rate.rates`, `rate.lastDayRates`, `rate.ratesCacheKey`
- Any other slice with `portfolio`, `snapshot`, `analysis`, `populate`, `chart` fields

**Output artifact**: The full table, committed to the scratchpad. Aggregator quotes verbatim for inventory item #3.

---

#### D2: Exact state paths for `reduxAccess.ts` accessors

- **Flavor**: D
- **Depends on**: D1
- **Unblocks**: Phase 1 (`reduxAccess.ts` accessor implementations)
- **Estimated effort**: 45 minutes

**Background**: Phase 1 defines accessors on `reduxAccess.ts`: `getQuoteCurrencyFromStore()`, `getEligibleStoredWalletsFromStore()`, `getLiveRatesByAssetIdFromStore()`, `getLiveRatesAsOfMsFromStore()`, `getBalancesByWalletIdFromStore()`, `getCurrentEligibleWalletIdSetFromStore()`, `getAssetIdForWalletFromStore()`, `getAssetGroupIdForWalletFromStore()`, `buildPopulateRuntimeContextFromStore()`, `getShowPortfolioEnabledFromStore()`. Each needs an *exact state path* — which slice, which field, which transformation.

**Question**: For each of the ten accessors, what is the exact Redux state path? Include the selector expression an agent would write.

**Verification steps**:

```bash
# For each accessor, trace its logical input:
#   - quoteCurrency: which slice? (probably rate or user or portfolio)
#   - eligibleStoredWallets: visible wallets from which key/wallet slice?
#   - liveRatesByAssetId: rate.rates or similar
#   - liveRatesAsOfMs: timestamp on the rate cache
#   - balancesByWalletId: wallet.balances or similar
#   - currentEligibleWalletIdSet: derived
#   - assetIdForWallet: derived from wallet.chain + currencyAbbreviation + tokenAddress
#   - assetGroupIdForWallet: derived from wallet.currencyAbbreviation (lowercased)
#   - populateRuntimeContext: composition of all wallet data + signing contexts
#   - showPortfolioEnabled: settings slice

# Trace each back to its slice + path.
# For each, write the accessor body that produces the value.
```

**Pass criteria**: A table `{accessor, slice, path_or_derivation, implementation_sketch}` covering all ten accessors. Example row:

```
getQuoteCurrencyFromStore
  slice: portfolio
  path: state.portfolio.quoteCurrency
  impl: () => requireStoreGetter()().portfolio.quoteCurrency ?? 'USD'
```

**Fail-recoverable**: A field the plan assumes exists (e.g., `liveRatesAsOfMs`) doesn't exist in Redux today. Record; Phase 1 must either compute it from what's there, or Phase 0 must flag this as a net-new field v2 will need.

**Output artifact**: The full table of ten accessor implementations.

---

#### D3: Bootstrap layer (getStore, RootState, index.js callback)

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 1 (`reduxAccess.ts` import of `RootState`), Phase 5 (bootstrap wiring)
- **Estimated effort**: 15 minutes

**Background**: v2 bootstrap runs inside the existing `getStore().then(({store, persistor}) => {...})` callback in `index.js`. The plan cites `src/store/index.ts:376` as the `getStore()` definition, `src/store/index.ts:558` as the factory return shape, and `index.js:166` as the callback location. All three need exact current line numbers (may have shifted) and the shape must match the plan's assumption.

**Question**: Where is `getStore()` defined? What does it return? Where does its `.then()` callback live in `index.js`? Where is `RootState` exported from?

**Verification steps**:

```bash
grep -n "export .*getStore" src/store/index.ts
grep -n "export .*RootState" src/store/index.ts
grep -n "getStore().then" index.js

# Show the function body and return shape.
sed -n '370,400p' src/store/index.ts
sed -n '550,570p' src/store/index.ts
sed -n '160,180p' index.js
```

**Pass criteria**: Exact file:line for `getStore()` definition, for its return (the `{store, persistor}` shape), for `RootState` export, and for the `.then()` callback. Evidence quotes the relevant lines verbatim.

**Pass-with-deviation**: Line numbers have shifted. Record the current line numbers; the plan should reference them by symbol, not by line.

**Fail-plan-wrong**: `getStore()` is not an async factory returning `{store, persistor}` (e.g., returns just the store, or uses a different shape). Plan's bootstrap wiring must be rewritten.

**Output artifact**: Cited lines for all four locations, plus a one-sentence confirmation of the factory shape.

---

#### D4: Show Portfolio visibility setting location

- **Flavor**: D
- **Depends on**: D1
- **Unblocks**: Phase 6 (`onShowPortfolioVisibilityChanged` trigger wiring, `getShowPortfolioEnabledFromStore` accessor)
- **Estimated effort**: 30 minutes

**Background**: Phase 6 implements `onShowPortfolioVisibilityChanged(enabled)` tied to a user-facing settings toggle. The plan's accessor `getShowPortfolioEnabledFromStore()` must read from the actual Redux path for this setting. If the setting is stored in AsyncStorage or somewhere else, the accessor pattern changes.

**Question**: Where is the user-facing "Show Portfolio" (or "Show Balances" — exact UI label TBD) setting stored? What Redux path represents its boolean state? Which action/reducer flips it?

**Verification steps**:

```bash
# Candidate: src/store/app/ or src/store/settings/
grep -rn "showPortfolio\|hidePortfolio\|showBalances\|hideBalances" src/store/
grep -rn "showPortfolio\|hidePortfolio\|showBalances\|hideBalances" src/navigation/tabs/settings/

# Find the toggle UI element and trace its dispatch.
grep -rn "Show Portfolio\|Hide Portfolio\|Show Balances" src/navigation/
```

**Pass criteria**: A concrete Redux path for the setting (e.g., `state.app.showPortfolio`); the action name that toggles it; the UI file that dispatches it.

**Pass-with-deviation**: The setting exists but is named differently than v18's prose assumes (e.g., `hideBalances: true` vs. `showPortfolio: false`). The accessor must negate or rename accordingly.

**Fail-plan-wrong**: No such setting exists. v2 is *introducing* this toggle. Phase 6 needs net-new Redux state + action + settings UI wiring — additional LOC scope for Phase 6.

**Output artifact**: Evidence record with path, action name, UI location, and current initial value.

---

#### D5: Post-auth Redux action for PIN/biometric

- **Flavor**: D
- **Depends on**: none
- **Unblocks**: Phase 5 (`app.effects.ts` post-auth wiring), Phase 6 (`onAppLaunchPostAuth` invocation)
- **Estimated effort**: 1-2 hours
- **Risk of fail**: **HIGH** — plan commits to this existing but doesn't name the action

**Background**: v18 requires `onAppLaunchPostAuth(...)` to fire only *after* the user passes the PIN/biometric gate on app launch. The trigger must hook into a specific Redux action or event that fires only at that moment — not on app init, not on store rehydration, not on backgrounding. Prior audits found v1 does not currently gate populate on auth at all, so this wiring is net-new.

**Question**: What specific Redux action/event in the existing codebase represents "PIN/biometric gate cleared on app launch"? Name it. If none exists, propose one.

**Verification steps**:

```bash
# Search auth effects for dispatches that fire on successful PIN/biometric:
find src/store -name "*.effects.ts"
grep -rn "bioMetric\|biometric\|PIN\|pinSuccess\|unlockSuccess\|authSuccess" src/store/
grep -rn "bioMetric\|biometric\|PIN\|pinSuccess\|unlockSuccess\|authSuccess" src/navigation/auth/

# Candidate actions to look at:
#   - APP/LOCK_UNLOCKED
#   - AUTH/PIN_VERIFIED
#   - BIOMETRIC/SUCCESS
#   - APP/SET_ACTIVE (too broad)

# Find the PIN screen and trace its success callback.
find src/ -name "*Pin*" -type f
find src/ -name "*Biometric*" -type f

# Follow the success dispatch to the action name.
```

**Pass criteria**: A concrete action name (or event bus event) that fires *only* after PIN/biometric success on app launch, with evidence of the dispatch site. Ideally the same action does not fire on foregrounding-from-background (that's a separate "resume" moment that shouldn't trigger fresh populate).

**Pass-with-deviation**: The closest match fires on *both* launch-unlock and resume-unlock. Record; Phase 5/6 wiring may need a secondary gate (e.g., "was this the first unlock in this app launch session?").

**Fail-escalate**: No such action exists. v2 is net-new wiring: Phase 5 needs to introduce a post-auth action dispatch, either by modifying the auth screen's success callback or by adding a new effect listener. Estimated +20-40 LOC in Phase 5, plus a UI-side touch (kernel-adjacent but not kernel).

**Output artifact**: The action name + its dispatch location + a note on how it behaves vs. resume-from-background.

---

### Group E — v1 product-behavior fidelity

These beads verify that the product behaviors v18 claims to *preserve* actually exist in v1 today. If any fails, v18's behavior is net-new, not preserved, and scope adjusts accordingly.

#### E1: Cross-chain ticker collapse mechanism

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 3 (asset-group aggregation), Phase 7a (asset list rendering)
- **Estimated effort**: 30 minutes

**Background**: v18 says Home/All Assets/Allocation collapse wallets by lowercased `currencyAbbreviation` so USDC-on-ETH + USDC-on-POL + USDC-on-SOL render as one row. The plan asserts this matches current UX. If it doesn't, v18 is *introducing* the collapse, which has product-visible implications.

**Question**: In the current asset list UI, are wallets grouped by ticker across chains? What is the grouping key — exact field/expression?

**Verification steps**:

```bash
# Read the asset row aggregator.
cat src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts

# Look for grouping by currencyAbbreviation, symbol, or ticker.
grep -n "currencyAbbreviation\|symbol\|ticker\|groupBy" src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts
grep -n "currencyAbbreviation\|symbol\|ticker\|groupBy" src/portfolio/ui/common.ts
grep -n "toLowerCase" src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts
```

**Pass criteria**: Concrete evidence that wallets are grouped by `currencyAbbreviation.toLowerCase()` (or equivalent) for display, with file:line.

**Pass-with-deviation**: Grouping exists but uses a different key (e.g., `symbol`, or `currencyAbbreviation` without lowercasing — case-sensitive). Record; v18's `assetGroupId` definition must match the repo's actual key to preserve behavior.

**Fail-escalate**: No grouping — asset list shows one row per wallet (USDC appears 3x). v18 is introducing the collapse, not preserving it. Product must validate.

**Output artifact**: Grouping key expression + file:line + a ~10-line snippet of the grouping logic.

---

#### E2: Allocation ↔ All Assets ordering parity

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 7e (allocation order contract)
- **Estimated effort**: 30 minutes

**Background**: v18 commits to "Allocation order equals asset-list order." Phase 7e says both reuse the same canonical ranking. This bead confirms the current UX already does this (so we preserve), or flags that v2 is changing the relationship.

**Question**: Do v1's Allocation screen and All Assets / Home asset list share the same ordering function? Name the function/module.

**Verification steps**:

```bash
grep -n "Allocation" src/navigation/tabs/home/screens/Allocation.tsx
grep -n "Allocation" src/navigation/tabs/home/screens/AllAssets.tsx

# Trace each screen to the hook/selector it uses for ordering.
cat src/navigation/tabs/home/screens/Allocation.tsx | head -100
cat src/navigation/tabs/home/screens/AllAssets.tsx | head -100

# Compare: do both call the same ordering function? Or do they each sort
# independently?
```

**Pass criteria**: Both screens use the same ordering function (or both read from a selector that produces the same ordered list).

**Pass-with-deviation**: Both screens order by "descending fiat value" but via different code paths that produce the same ordering. Record; v18 collapses both to `selectOrderedAssetGroupIds`.

**Fail-plan-wrong**: Allocation uses a fundamentally different ordering (e.g., percentage of total, alphabetical). v18's Phase 7e test would fail; product decision needed on which order wins.

**Output artifact**: Both screens' ordering sources, side-by-side.

---

#### E3: Key-scoped navigation preservation

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 7c, 7d, 7e (key-scoped selectors)
- **Estimated effort**: 45 minutes

**Background**: v18 says `AllAssets({keyId})` and row taps from `KeyOverview` preserve key scope through to asset detail. Plan asserts this matches current behavior.

**Question**: In v1, does navigating from KeyOverview → All Assets → asset detail stay within that key's wallets? Or does it fall back to Home-global data at some point?

**Verification steps**:

```bash
cat src/navigation/wallet/screens/KeyOverview.tsx | head -200
grep -n "keyId\|key:" src/navigation/wallet/screens/KeyOverview.tsx

# Find the "See All Assets" nav and trace the keyId through:
grep -rn "AllAssets" src/navigation/
cat src/navigation/tabs/home/screens/AllAssets.tsx | head -100

# Does AllAssets accept a keyId prop? Does it filter?
grep -n "keyId" src/navigation/tabs/home/screens/AllAssets.tsx
grep -n "keyId" src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts
```

**Pass criteria**: `keyId` is passed through KeyOverview → AllAssets → asset detail, and each layer filters to that key's wallets.

**Pass-with-deviation**: `keyId` is passed to AllAssets but not further to asset detail (detail reverts to Home-global). Record; v18 needs to add scoping to asset detail too (already in plan via `selectScopedAssetGroupRows`).

**Fail-escalate**: No `keyId` propagation at all; AllAssets always shows all wallets. v18's key-scoped asset list is net-new scope for Phase 7.

**Output artifact**: The `keyId` propagation chain (or absence thereof) with file:line at each hop.

---

#### E4: Pull-to-refresh current wiring

- **Flavor**: D
- **Depends on**: none
- **Unblocks**: Phase 6 (`onPullToRefresh` trigger wiring)
- **Estimated effort**: 45 minutes

**Background**: v18 ships `onPullToRefresh` as a first-class trigger. The wiring hooks into the RefreshControl on Home, KeyOverview, WalletDetails, AccountDetails. Each screen has its own pull-to-refresh handler today that does *something* (refresh rates, refresh balances, refresh tx history). We need to know what each does so the v2 trigger can replace them cleanly without losing behavior.

**Question**: For each of the four screens (Home, KeyOverview, WalletDetails, AccountDetails), what does pull-to-refresh currently call? What Redux actions does it dispatch? Does it wait for anything?

**Verification steps**:

```bash
grep -rn "RefreshControl\|onRefresh" src/navigation/tabs/home/HomeRoot.tsx
grep -rn "RefreshControl\|onRefresh" src/navigation/wallet/screens/KeyOverview.tsx
grep -rn "RefreshControl\|onRefresh" src/navigation/wallet/screens/WalletDetails.tsx
grep -rn "RefreshControl\|onRefresh" src/navigation/wallet/screens/AccountDetails.tsx

# For each, read the onRefresh handler and enumerate its dispatches.
```

**Pass criteria**: A table `{screen, current_onRefresh_body, v2_trigger_binding}` for all four. `v2_trigger_binding` is the exact call to `onPullToRefresh({changedWalletIds})` the screen should make under v18.

**Output artifact**: The table.

---

#### E5: Quote-currency switching current behavior (BTC bridge?)

- **Flavor**: V + D
- **Depends on**: none
- **Unblocks**: Phase 6 (`onQuoteCurrencyChanged` — determines if it's net-new or preserving)
- **Estimated effort**: 45 minutes

**Background**: v18 introduces `ensureQuoteCurrencyFxBridge` + `recomputeQuoteBridgeFromSharedState` as the BTC-bridge flow. The plan implies v1 does *not* currently use a BTC bridge (i.e., v1 either doesn't handle quote switching well, or it fan-outs per-asset fetches in the new quote). This bead verifies.

**Question**: When the user changes their quote currency in v1 today, what happens? Does the current code fetch all asset rates in the new currency? Does it use any FX bridge? How does the UI update?

**Verification steps**:

```bash
# Find the quote-currency toggle or setting dispatch.
grep -rn "setQuoteCurrency\|changeQuoteCurrency\|SET_QUOTE_CURRENCY" src/store/

# Find rate-fetching logic triggered by the change.
grep -rn "quoteCurrency" src/store/rate/
grep -rn "quoteCurrency" src/portfolio/core/pnl/

# Check for explicit BTC-bridge usage in UI / effects:
grep -rn "FX_BRIDGE_COIN\|btcBridge\|fxBridge" src/store/
grep -rn "getFiatRateSeriesWithFx" src/portfolio/ui/
```

**Pass criteria**: A clear description of current behavior. Either:
- "v1 does not use a BTC bridge for quote switching; it fan-outs per-asset fetches" (expected)
- "v1 already uses a BTC bridge for rate display but not for portfolio PnL" (the FX bridge in `fxRates.ts` is read-side only, which matches prior audit findings)
- or some other variant

**Fail-plan-wrong**: v1 already implements a full BTC-bridge flow for quote switching. v18's `ensureQuoteCurrencyFxBridge` is redundant; simplify.

**Output artifact**: A prose description (5-10 lines) of v1's current quote-switching behavior, cited.

---

#### E6: Fiat-rate interval fetch/persist scope

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 2 (`ensureFresh` interval canonicalization)
- **Estimated effort**: 20 minutes

**Background**: v18 says only `1D`, `1W`, `1M`, `ALL` are fetched/persisted; `3M`, `1Y`, `5Y` derive from `ALL`. Verified in prior audits; re-confirm because this is a foundational fact.

**Question**: In `fiatRateStore.ts` and `fiatRatesShared.ts`, which intervals are actually fetched and persisted? Which are derived?

**Verification steps**:

```bash
grep -n "DEFAULT_STORED_FIAT_RATE_INTERVALS" src/portfolio/core/fiatRatesShared.ts
grep -n "resolveStoredFiatRateInterval" src/portfolio/core/fiatRatesShared.ts

sed -n '20,50p' src/portfolio/core/fiatRatesShared.ts
```

**Pass criteria**: `DEFAULT_STORED_FIAT_RATE_INTERVALS` array contains exactly `['1D', '1W', '1M', 'ALL']`; `resolveStoredFiatRateInterval` maps `3M`/`1Y`/`5Y` → `ALL`.

**Output artifact**: The two relevant constants/functions cited with file:line.

---

#### E7: Timeframe switch side-effect audit

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 6 ("timeframe switches are read-only" claim)
- **Estimated effort**: 30 minutes

**Background**: v18 asserts timeframe switches (and chart scrubbing) trigger zero rate-fetches, snapshot-refreshes, or populate kicks. If v1's timeframe switches do any of these, v18 is subtly changing behavior.

**Question**: When the user switches timeframe on Home, Wallet, AssetDetail, KeyOverview, or Exchange Rate screen in v1, what side effects fire? Any rate fetches, snapshot refreshes, or populate kicks?

**Verification steps**:

```bash
# Find timeframe state and its change handlers.
grep -rn "selectedInterval\|setInterval\|onTimeframeChange\|timeframe" src/navigation/tabs/home/
grep -rn "selectedInterval\|setInterval\|onTimeframeChange\|timeframe" src/navigation/wallet/screens/
grep -rn "selectedInterval\|setInterval\|onTimeframeChange\|timeframe" src/components/charts/BalanceHistoryChart.tsx

# Check if any of the change handlers dispatch fetch/refresh actions.
```

**Pass criteria**: Timeframe change handlers set local state only; no Redux dispatches, no rate-fetch, no populate kicks.

**Fail-plan-wrong**: Timeframe change dispatches (e.g.) `FETCH_RATES` or similar. v18's "read-only" claim is net-new behavior; scope for Phase 6 or Phase 7 expands.

**Output artifact**: Per-screen timeframe-change body, cited.

---

### Group F — Platform / runtime config

#### F1: Bundle mode configuration + hybrid object threading

- **Flavor**: V
- **Depends on**: none
- **Unblocks**: Phase 0 feature flag scaffolding (J1 confirms non-bundle), guardrail #28
- **Estimated effort**: 30 minutes

**Background**: Guardrail #28 prohibits enabling `react-native-worklets` bundle mode globally. This bead confirms the current config is non-bundle, and that Quick Crypto + Nitro Fetch (`react-native-nitro-fetch`) hybrid objects thread through the signing + fetch paths without relying on bundle mode.

**Question**: What is the current `react-native-worklets` configuration? Is bundle mode enabled anywhere? Where do Quick Crypto and Nitro Fetch hybrid objects get initialized, and are they thread-scoped correctly?

**Verification steps**:

```bash
# Check worklets config — babel.config.js, metro.config.js, any workletsBundle flag.
cat babel.config.js
cat metro.config.js
grep -rn "workletsBundleMode\|bundleMode\|workletsBundle" .

# Check Quick Crypto initialization.
grep -rn "react-native-quick-crypto\|QuickCrypto" src/portfolio/

# Check Nitro Fetch.
grep -rn "react-native-nitro-fetch\|NitroFetch\|nitroFetch" src/portfolio/
```

**Pass criteria**: No bundle mode flag set anywhere; Quick Crypto + Nitro Fetch initialization uses the per-call dispatch-context pattern documented in guardrail #26.

**Fail-plan-wrong**: Bundle mode is already enabled globally. Guardrail #28 conflicts with current config — decision needed.

**Output artifact**: Relevant config file snippets + initialization file:line.

---

### Group G — Reset / wipe paths

#### G1: Reset path inventory

- **Flavor**: D
- **Depends on**: none
- **Unblocks**: Phase 7.5 reset-path integration
- **Estimated effort**: 1 hour

**Background**: Phase 7.5 replaces direct MMKV wipes in every reset path (sign-out, logout, clearAllStorage, any "reset app" flow) with `await performResetSequence()`. Need the exhaustive list.

**Question**: What are all the code paths that currently wipe portfolio-adjacent MMKV data? For each, what does it currently do, and where does it live?

**Verification steps**:

```bash
grep -rn "signOut\|logout\|clearAllStorage\|resetApp\|wipeAll" src/
grep -rn "MMKV.*clear\|clearAll\|\.delete\(" src/

# For each match, inspect the call site and determine whether it touches
# portfolio data.
```

**Pass criteria**: A table `{path_name, file:line, current_wipe_scope, v2_replacement}` for each reset path. `v2_replacement` is either `performResetSequence()` or "leave alone (not portfolio-related)."

**Output artifact**: The table.

---

### Group H — Exports and consumer graph

#### H1: Public export catalog with keep/delete/replace labels

- **Flavor**: D
- **Depends on**: none
- **Unblocks**: H2 (consumer graph), Phase 8 (deletion list)
- **Estimated effort**: 1-2 hours

**Background**: Every `index.ts` under `src/portfolio/` exports public symbols. v18's Phase 8 deletes a large chunk. We need each export labeled: `keep` (stays), `delete` (Phase 8 removes), or `replace` (v2 provides a new export with similar role).

**Question**: Enumerate every public export from `src/portfolio/**/index.ts`. For each, label `keep`/`delete`/`replace` per the v18 plan's retention decisions.

**Verification steps**:

```bash
find src/portfolio -name "index.ts"
for f in $(find src/portfolio -name "index.ts"); do
  echo "=== $f ==="
  grep -nE "^export" "$f"
done
```

**Pass criteria**: A table `{file, export_name, label, v2_replacement_or_reason}` covering every export.

**Output artifact**: The table.

---

#### H2: Consumer → portfolio call graph (Mermaid)

- **Flavor**: D
- **Depends on**: H1
- **Unblocks**: Phase 8 deletion validation (every deleted export must have zero remaining consumers)
- **Estimated effort**: 1-2 hours

**Background**: v18 Phase 0 item #1 is a Mermaid call graph from consumer screens/hooks into portfolio public APIs. Used to validate that after Phase 8 deletions, no dangling consumers remain.

**Question**: Which consumer files call which portfolio public exports?

**Verification steps**:

```bash
# For each "keep"-labeled and "replace"-labeled export from H1, find consumers.
# For each "delete"-labeled export, find consumers (they must all migrate by
# Phase 8).
for export_name in <from H1>; do
  grep -rn "$export_name" src/ --include="*.ts" --include="*.tsx"
done
```

Consolidate into a Mermaid `graph LR` with consumers on the left, portfolio exports on the right.

**Pass criteria**: Complete call graph, Mermaid-rendered, every edge cited.

**Output artifact**: The Mermaid source.

---

### Group I — Baselines

#### I1 + I2: Kept-file and deleted-file LOC verification

- **Flavor**: P (measurement)
- **Depends on**: none
- **Unblocks**: Phase 8 LOC ledger validation
- **Estimated effort**: 20 minutes

**Background**: v18 lists specific LOC counts for kept/deleted files. If any count is off by >10%, the LOC ledger needs updating (especially critical for `balanceDiagnostic.ts` which was flagged by reviewers as potentially wrong).

**Question**: What are the exact LOC for each file on the kept list and the deleted list?

**Verification steps**:

```bash
# Kept list (from v18 guardrails, reproduced here for completeness):
wc -l src/portfolio/core/pnl/analysisStreaming.ts
wc -l src/portfolio/core/pnl/snapshotStream.ts
wc -l src/portfolio/core/pnl/snapshotStore.ts
wc -l src/portfolio/core/pnl/fiatRateStore.ts
wc -l src/portfolio/core/pnl/fxRates.ts
wc -l src/portfolio/core/pnl/rates.ts
wc -l src/portfolio/core/pnl/storedFiatRateSeries.ts
wc -l src/portfolio/core/pnl/invalidHistory.ts
wc -l src/portfolio/core/pnl/snapshotHelpers.ts
wc -l src/portfolio/core/pnl/types.ts
wc -l src/portfolio/core/pnl/assetId.ts
wc -l src/portfolio/core/fiatRatesShared.ts
wc -l src/portfolio/core/tokenTxHistory.ts
wc -l src/portfolio/core/txHistoryPaging.ts
wc -l src/portfolio/core/format.ts
wc -l src/portfolio/core/types.ts
wc -l src/portfolio/core/shared/bws.ts
wc -l src/portfolio/core/kv/types.ts
wc -l src/portfolio/runtime/worklet/portfolioWorkletSnapshots.ts
wc -l src/portfolio/runtime/worklet/portfolioWorkletSnapshotBuilder.ts
wc -l src/portfolio/runtime/worklet/portfolioPopulateWorklet.ts
wc -l src/portfolio/runtime/worklet/portfolioWorkletRates.ts
wc -l src/portfolio/runtime/worklet/portfolioWorkletKv.ts

# Deleted list:
wc -l src/portfolio/runtime/portfolioClient.ts
wc -l src/portfolio/runtime/portfolioHost.ts
wc -l src/portfolio/runtime/portfolioRequestRouting.ts
wc -l src/portfolio/runtime/portfolioWorkletTransport.ts
wc -l src/portfolio/runtime/portfolioWorkletDispatch.ts
wc -l src/portfolio/runtime/serialQueue.ts
wc -l src/portfolio/runtime/portfolioRuntime.ts
wc -l src/portfolio/runtime/worklet/portfolioRequestWorklet.ts
wc -l src/portfolio/runtime/worklet/portfolioPopulateJobWorklet.ts
wc -l src/portfolio/runtime/worklet/portfolioWorkletAnalysis.ts
wc -l src/portfolio/core/engine/workerProtocol.ts
wc -l src/portfolio/core/engine/portfolioEngine.ts
wc -l src/portfolio/core/engine/populateJob.ts
wc -l src/portfolio/core/engine/populateDebug.ts
wc -l src/portfolio/service/portfolioPopulateService.ts
wc -l src/portfolio/service/portfolioStaleness.ts
wc -l src/portfolio/debug/balanceDiagnostic.ts  # reviewer flagged

find src/portfolio/ui/hooks -name "*.ts" -exec wc -l {} +
find src/portfolio/ui/selectors -name "*.ts" -exec wc -l {} +
wc -l src/portfolio/ui/common.ts
wc -l src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts
```

**Pass criteria**: A table with `{file, plan_asserted_LOC, actual_LOC, delta_percent}`. Flag any row with `delta_percent > 10%`.

**Output artifact**: The table.

---

#### I3: Baseline `yarn test` metrics

- **Flavor**: P (measurement)
- **Depends on**: none
- **Unblocks**: every phase's "ship-green" acceptance
- **Estimated effort**: 10-30 minutes (depends on test suite size)

**Background**: Every phase ships with `PORTFOLIO_V2=false`, which means tests must stay green throughout. Need the baseline count and pass/fail state *before* any v2 changes.

**Question**: How many tests run? How many pass? Any existing failures?

**Verification steps**:

```bash
yarn test 2>&1 | tee /tmp/baseline_yarn_test.log
# Capture: total count, passed, failed, skipped. Also capture any failing test
# names (must stay failing with same names throughout phases unless explicitly
# fixed).
```

**Pass criteria**: A record of `{total_tests, passed, failed, skipped, failing_test_names}`. Saved to scratchpad.

**Output artifact**: Verbatim summary line from yarn test plus the failing test names (if any).

---

### Group J — Production (feature flag)

#### J1: PORTFOLIO_V2 feature flag scaffolding

- **Flavor**: P (writes code)
- **Depends on**: A1, A2 (MMKV adapter layout verified)
- **Unblocks**: every phase (all of them read this flag)
- **Estimated effort**: 30 minutes

**Background**: The flag is read from JS and worklets, stored at MMKV key `portfolio:v2:flag`, default `false`. This is the single piece of code Phase 0 writes.

**Question**: Implement `src/portfolio/v2/featureFlag.ts` exporting `PORTFOLIO_V2_FLAG_KEY`, `getPortfolioV2Enabled(): boolean`, and `setPortfolioV2Enabled(value: boolean): void`. JS and worklet both readable.

**Verification steps**:

```ts
// src/portfolio/v2/featureFlag.ts
import { getPortfolioMmkvStorageOnRN } from '../adapters/rn/workletMmkvBridge';

export const PORTFOLIO_V2_FLAG_KEY = 'portfolio:v2:flag';

export function getPortfolioV2Enabled(): boolean {
  const storage = getPortfolioMmkvStorageOnRN();
  return storage.getBoolean(PORTFOLIO_V2_FLAG_KEY) ?? false;
}

export function setPortfolioV2Enabled(value: boolean): void {
  const storage = getPortfolioMmkvStorageOnRN();
  if (value) storage.set(PORTFOLIO_V2_FLAG_KEY, true);
  else storage.delete(PORTFOLIO_V2_FLAG_KEY);
}
```

Plus a worklet-side reader if the JS one can't be imported from worklets (confirm via spike if needed; simplest: duplicate the constant and write a `getPortfolioV2EnabledOnRuntime()` 'worklet' function).

Write a small spec at `src/portfolio/v2/__tests__/featureFlag.spec.ts`:
- initial value is false
- set true → reads true
- set false → reads false (key deleted)

**Pass criteria**: File exists; spec passes under `yarn test`; flag is readable from both JS (via direct import) and from a worklet context (smoke-tested via a trivial worklet that reads and returns the value).

**Output artifact**: The `featureFlag.ts` file + spec, committed.

---

### Group K — Aggregation

#### K1: Assemble `PORTFOLIO_REFACTOR_INVENTORY.md`

- **Flavor**: A
- **Depends on**: all prior beads
- **Unblocks**: Phase 0.5 + downstream phases
- **Estimated effort**: 1 hour

**Background**: The final deliverable of Phase 0 is a single markdown document aggregating all bead outputs. It matches the 12 sections v18 Phase 0 originally enumerated, plus a prefix section listing any fail-escalate findings that require plan amendment.

**Question**: How do the bead evidence records assemble into the inventory doc?

**Verification steps**: Run through each bead's scratchpad record. For each, copy its evidence into the corresponding inventory section. Specifically:

```
PORTFOLIO_REFACTOR_INVENTORY.md

## Plan Amendments Required Before Downstream Phases Start
  [Every fail-escalate bead's record goes here, with its proposed amendment.
   If empty, say "None — all assumptions verified."]

## 1. Consumer → Portfolio Call Graph
  [H2 output]

## 2. Public Exports (keep/delete/replace)
  [H1 output]

## 3. Redux Slices with Portfolio Data
  [D1 output]

## 4. Exact State Paths for reduxAccess Accessors
  [D2 output]

## 5. MMKV Key Prefixes in Use
  [A2 output]

## 6. MMKV Adapter Layout
  [A1 + A3 outputs]

## 7. FiatRateStore Fetch/Persist Separability
  [B1 + B2 outputs]

## 8. Exact LOC for Kept/Deleted Files
  [I1 + I2 outputs]

## 9. Baseline yarn test Counts
  [I3 output]

## 10. getStore() + RootState + index.js Callback
  [D3 output]

## 11. Reset Path Inventory
  [G1 output]

## 12. Product-Parity Inventory
### 12a. Cross-chain ticker collapse  [E1]
### 12b. Allocation ↔ All Assets ordering  [E2]
### 12c. Key-scoped navigation  [E3]
### 12d. Pull-to-refresh wiring  [E4]
### 12e. Quote-currency switching  [E5]
### 12f. Interval fetch/persist scope  [E6]
### 12g. Timeframe switch side effects  [E7]
### 12h. Reorg protection mechanism  [C3]  ← note prominently if fail-escalate
### 12i. Bundle mode + hybrid objects  [F1]
### 12j. Post-auth Redux action  [D5]  ← note prominently if fail-escalate

## Feature Flag
  [J1 confirmation]
```

**Pass criteria**: Doc exists at repo root as `PORTFOLIO_REFACTOR_INVENTORY.md`; every section is filled from bead outputs; all fail-escalate findings are prominently surfaced in the top-level amendments section; LOC deviations > 10% are flagged in section 8.

**Fail-escalate**: If any downstream-blocking bead reported fail-escalate, K1 produces the inventory *and* flags that Phases X/Y/Z are blocked until the listed amendments are resolved.

**Output artifact**: `PORTFOLIO_REFACTOR_INVENTORY.md`.

---

## Acceptance criteria for Phase 0

Phase 0 is complete when:

1. Every bead in Groups A-I has a pass or pass-with-deviation verdict in the scratchpad. (Any fail-escalate bead has produced an amendment proposal; if no amendment can be resolved, downstream phases are explicitly blocked and the acceptance is "Phase 0 partial — Phase N requires plan amendment.")
2. J1 has committed the `PORTFOLIO_V2` feature flag with passing spec.
3. K1 has produced `PORTFOLIO_REFACTOR_INVENTORY.md` at repo root.
4. `yarn tsc` and `yarn test` pass (no regression from baseline).

## LOC ledger

Unchanged from v18 Phase 0: **+30 / 0 / +30**. All +30 is in `featureFlag.ts` + its spec. The inventory doc lives outside `src/portfolio/` and is not counted.

## Glossary

Terms referenced in the beads, for agents executing without prior v18 context:

- **SharedValue**: Reanimated's `SharedValue<T>` — a cross-runtime mutable cell.
- **Worklet runtime**: A JS runtime created via `createWorkletRuntime({name, enableEventLoop: true})` that runs `'worklet'`-tagged functions off the main JS thread.
- **Dispatch context**: `PortfolioTxHistorySigningDispatchContext`, a per-runtime global installed via `setPortfolioTxHistorySigningDispatchContextOnRuntime`. Required for Nitro Fetch calls (including non-signing ones) — see guardrail #26.
- **MMKV instance vs. default**: The portfolio data lives in a dedicated `MMKV({id: 'bitpay.portfolio.engine'})`, NOT the default `MMKV()`. Using the wrong instance = keys land in separate namespaces and coordination breaks silently.
- **Registry**: `__bitpay.portfolio.engine.registry.v1__`, an MMKV key that tracks all other keys set/deleted via `MmkvKvStore`. Direct `MMKV.delete` bypasses the registry, leaving `listKeys()` stale.
- **Worklet-tagged**: A function whose first statement is the string literal `'worklet'`, marking it as eligible to run on a worklet runtime.
- **Nitro Fetch**: `react-native-nitro-fetch`, a synchronous-HTTP hybrid object used as the fetch transport inside worklets. The client is obtained via `getPortfolioNitroFetchClientOnRuntime()` which reads from the dispatch context.
- **Bundle mode**: A `react-native-worklets` configuration where all `'worklet'`-tagged functions across the app are bundled into a single bundle. Global-scope; v18 forbids enabling it (guardrail #28).
- **Fail-escalate**: A bead outcome meaning the plan's assumption is wrong and no recovery is obvious within the bead's scope; human or planning-agent decision required before downstream phases proceed.
