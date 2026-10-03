# BIP-02 bounded repair report

**Status: repairs implemented; not release-ready pending full app/device native verification and explicit residual-risk acceptance. The original repairs were subsequently committed at the user's request as `3debd640c7bd617babed09d2dfc6fbc462982381`. The guard-ordering follow-up below addresses review of that commit. No push, PR, release, output archive, duplicate repository, or standalone repair patch was created.**

Original validation session: October 1–2, 2026 (America/New_York). The original starting HEAD was `04486e844a90c4268e31cc2873c3392112a79c55`, on `bip-02`, with reviewed parent `ad06764ccb9ba28e66e741d5151c9d7f31aa5787`. Work was performed directly in `/Users/marty/open-source/bitpay-app`.

## October 3, 2026: optional-refresh preservation and EDDSA retry repairs

This repair starts at `0d1af4b54a22986c8b432e79297897bafa1e7080`, whose tree is
identical to `c720545760e66ef75593b61fcac2c43834291ac6`. The tracked working tree
was clean. The existing unrelated untracked files remain untouched. The user
requested both fixes and a local commit; GitHub remains read-only.

**Optional filesystem failures:** a read-only primary-preservation check now lives
outside the scrub block. It remembers the last validated serialized primary,
rejects its disappearance, invalid replacement or unreadable registered state,
and accepts a changed valid GCM primary only with deferred completion. A valid
concurrent save observed before the migration's own root write is never overwritten
by the stale selected source. The existing migration-only filesystem helpers accept
a preservation callback and invoke it before and after each RNFS operation,
including rejection. This prevents a failed optional promotion/refresh, or a later
cleanup await, from proceeding to another deletion on the assumption that the old
primary is still usable. Preservation exceptions propagate through optional-work
and cleanup catches using the existing identity-based diagnostic classification.
AsyncStorage cleanup and final completion/retirement boundaries also recheck the
primary. Required reads remain strict; intact primaries retain deferrable refresh
behavior and successful retries. No new record fields or backup files are added.

**EDDSA metadata:** directional coverage permits only an additional
`fingerPrintEDDSA` when the old key properties did not own that field and the new
value is the pinned SDK's eight lowercase hexadecimal characters. All other key
properties and associations remain exactly equal, and every old protected field
must still match. Existing, removed, changed, null or malformed fingerprints gain
no exception. Additional or changed derivation settings and changed private
material still produce `SOURCE_CONFLICT`. The same narrow predicate governs
retained AsyncStorage sources and marked optional refresh temps.

The 64 added repository tests cover both platforms' unchanged/changed-valid/missing/
invalid primary matrices for optional writes, promotions and verification; later
cleanup existence/read/unlink/AsyncStorage awaits that resolve or reject; and
EDDSA additions with strict negative controls for both retained-source locations.
Unsafe cases assert no writes/deletions after the injected primary failure, no
completion or legacy-key retirement, and retention of remaining recovery files.
The SDK integration test forces AsyncStorage deletion failure, executes the actual
`startAddEDDSAKey()` effect and pinned SDK, persists through the Redux adapter,
reloads migration modules, then verifies successful deletion retry and byte-exact
retention of the enriched primary. A corresponding optional-promotion test covers
repeated deferral, enrichment and eventual completion. The pre-upgrade SDK input
is synthesized by omitting its two EDDSA additions; it is not represented as an
archived historical app fixture.

Before production edits, the 25 initial regression cases produced **13 failures
and 12 passes**: twelve missing/invalid-primary cases incorrectly resolved, and the
actual EDDSA upgrade incorrectly raised `SOURCE_CONFLICT`. The other controls
resolved as expected. These are modeled storage failures, not evidence that RNFS
errors cause MMKV loss or measurements of real-device failure rates.

The Android Hermes driver additionally runs a four-process sequence using real
MMKV, Keychain, RNFS, AsyncStorage, the SDK/effect, persistence transforms, adapter
and cleanup bridge. Only the first AsyncStorage deletion failure is injected in
JavaScript; the enriched root and retained old source survive an actual process
restart before retry. The original legacy/fresh scenarios and raw RKStorage scans
remain included. This is application-path instrumentation, not a full UI upgrade
or physical-device certification.

Final validation: **141 Jest suites, 2,706 tests passed and 2 skipped; all 368
focused tests passed.** Targeted ESLint and formatting passed. TypeScript retains
its 2,024 baseline diagnostics with no introduced or removed normalized diagnostic.
The Android debug/test build, Android test bundle and iOS JavaScript bundle passed.
API 34 / SQLite 3.39.2 Hermes instrumentation passed **six scenarios and 22 process
launches**. The new EDDSA scenario retained five readable CBC markers before cleanup
and zero after retry, preserving the enriched primary exactly; the following launch
made zero native cleanup calls. No physical-device or new iOS native-build claim
is made.

Actual commands, outcomes and source hashes are in
`test/vault/results/preservation-repair.json`; full logs are in
`/private/tmp/bip02-preservation-repair-A4yizJ`. The native SQLite implementation,
provider dependency patch, MMKV scrub algorithm, encryption formats, independent
key generation and ordinary backup policy are unchanged. Completed migrations keep
their fast path. Previously documented native-compaction residuals, physical-phone
and 16 KiB OS-page validation, and explicit owner acceptance remain release gates.
The earlier tables below retain their original provenance and are not claims that
all old native fault campaigns were rerun for this repair.

## October 2, 2026: Android RKStorage follow-up

The separately authorized RKStorage cleanup is implemented in the working tree based on `f307e0aec2c95d71905d8188bddf37b6cc5c5c3e`. Its conditional guarantee applies only to installations that complete the new, independent cleanup marker. Deferred or unverified installations retain the RKStorage residual risk. See [BIP-02-RKSTORAGE-REPORT.md](BIP-02-RKSTORAGE-REPORT.md) for the implementation, native/application-path evidence, limitations, and release gates. The historical findings and results below describe the earlier repair; they do not retroactively include this cleanup or accept the existing MMKV crash residuals.

## Review follow-up: primary guard after backup deferral

On October 2, 2026, review identified that `measure()` short-circuited its primary guard when the awaited backup check returned `false`. A disappeared or invalid primary could therefore return control to startup when no AsyncStorage source remained. This was a modeled combined-failure defect, not evidence that scrub work itself caused the primary loss.

The correction evaluates the backup check and then the primary guard separately. Backup absence/change can defer cleanup only after that guard runs. A rejected backup read still propagates as a strict failure outside the metadata catch. The scrub algorithm, storage mutations, coverage bounds, persistent record format, and recovery policy are unchanged.

Fifteen regression cases were added: six scrub outcome/ordering combinations, one strict backup-read rejection, and eight integration cases covering missing, invalid, changed-valid, and unchanged primary states while either metadata measurement or backup inspection is pending. The integration cases use the production migration and guard, real serialized/encrypted test snapshots, modeled platform boundaries, and no AsyncStorage source. Unsafe cases must reject with `PRESERVATION_FAILURE`; all deferred attempts retain `wipeDone: false` and the legacy credential, perform no further writes, and preserve the observed primary/log values. Valid-primary cases also verify successful completion on retry without rollback.

Before the production change, the targeted command below reported **8 failures and 7 passes**: four migration cases incorrectly resolved, two scrub cases incorrectly deferred, and two controls showed the missing post-backup guard call. With the fix, all **252 tests across the six focused suites passed**, including all fifteen new cases. Changed-file ESLint, Prettier, and `git diff --check` also passed.

```sh
node node_modules/.bin/jest src/store/vault-scrub.spec.ts src/store/vault-migration.spec.ts --runInBand --forceExit --testNamePattern='backup-check ordering'
node node_modules/.bin/jest src/store/vault-migration.spec.ts src/store/vault-scrub.spec.ts src/store/vault-diagnostics.spec.ts src/store/encryption-key.spec.ts src/store/transforms/transforms.spec.ts src/store/persistence-guard.spec.ts --runInBand --forceExit
node node_modules/.bin/eslint src/store/vault-scrub.ts src/store/vault-scrub.spec.ts src/store/vault-migration.spec.ts
```

The red control was run with the new tests and unchanged `3debd640c` production code before applying the fix. Follow-up results are recorded separately in `test/vault/results/checks.json`. The full-suite, native, build, and device results below remain the original repair's evidence; those checks were not rerun for this guard-only correction. The original working-tree inventory/hashes are a historical snapshot of that repair. Full-app/device gates and acceptance of the two documented native-crash residuals remain outstanding.

## Initial state and authority

The required starting SHA was verified before editing. Initial tracked working tree was clean. These pre-existing untracked paths were recorded and were not edited by this task:

```text
?? deliverables/
?? docs/
?? index.worklets-stress.js
?? scripts/run-retaining-serializable-stress-android.js
?? src-master.zip
?? src-uncompressed-s.zip
?? src/portfolio/runtime/testing/
```

The supplied archive SHA-256 matched `6740d6538b6ce984bb66df16b4829ad167dffa04ea3e2d73c1fb190c3f8fa53c`. It was safely extracted to `/private/tmp/bip02-final-repair-yl0ueiig/bip02-review-evidence`. The README, harness configuration, mocks, tests, `scrubfuzz.cpp`, and `killfuzz.py` were inspected before execution. Exploratory JS tests that print returned key values were not run unchanged. Relevant experiments were converted into assertions against the production implementation. The superseded single-process scrub prototypes were not used as wrapper-equivalent certification.

The full final prompt explicitly superseded the earlier clearing scrub, storage-location-only selection, and blanket legacy-Keychain-read-error stop rules. This repair retains the six requirements: independent random key, protected verified key storage, supported legacy migration, bounded preservation/cleanup, no modern-key fallback, and unchanged ordinary encryption/storage behavior. #2278 and remediation still ship together; standalone #2278 GCM under the unversioned service remains unsupported.

## Source pins and fixture provenance

| Input                   | Verified source                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical app fixture  | `v.14.32.0` → `cd3af945fe00c704ad500918ff85f5e8ada040cc`                                                                                                                                                          |
| Historical importer     | `v.14.14.0` → `7f5e457cbab65b142db56fbbf7ccddaabb01f355`; introduction `4dc6a8921dc4917e6552763da0864ed3e795c0a8`                                                                                                 |
| EDDSA field-list fix    | `2130ecfe8cd54d6955509968f8b012b56ee57ac9`, adding the two EDDSA fields                                                                                                                                           |
| Later reader            | Remote tag `v14.46.3` → exactly `5dcdef9281db5d86d25a04e7af034781280d065a`; checked with `git ls-remote`, not substituted from a current branch                                                                   |
| RN MMKV                 | Published `react-native-mmkv@3.3.1`, package git head `1d86ae5b7f553d2de2ddf9f32a4d0d59c6035e70`                                                                                                                  |
| MMKV core               | Package gitlink `package/MMKV` → `f77545297d3e034066607954288a3710c80e5b4f`; all 75 published core/wrapper files checked matched the installed package, and relevant core files also matched that upstream commit |
| Historical key producer | Isolated `bitcore-wallet-client@10.10.0`, also confirmed in the 14.32.0 app manifest                                                                                                                              |
| Serializer              | Actual archived field serializer plus `redux-persist-transform-encrypt@3.0.1` with the archived `unencryptedStores` patch, through Redux Persist 6.0.0                                                            |

`test/vault/fixtures/provenance.json` records fixture/source/lock hashes. `test/vault/generate-legacy-fixtures.cjs` runs in a separate scratch fixture project; its pinned inputs are retained under `test/vault/fixture-project`. The archived transform body matches the tag; only its relative `Network` import changes for the isolated location. The archived serializer patch is an input fixture, not an implementation diff.

The generated keys are offline throwaway test data, never funded or used for real wallets by this task. No secret values are printed by the generators or evidence runners. Fixtures cover the app-path-style key before and after historical `encrypt(password)`, which leaves `xPrivKeyEDDSA` unwrapped. Constructor-password `xPrivKeyEDDSAEncrypted` is explicitly **library-supported defensive coverage**, not a demonstrated shipped-app creation flow. The whole-CBC variant and malformed/race/conflict cases are labeled defensive synthetic states. Fixtures are not claimed to be captured device saves.

The historical importer was gated by `APP.migrationMMKVStorageComplete` in `AppInitialization`, ran after store initialization, copied AsyncStorage into MMKV, and restarted. The tests reproduce that ordering and its pending-import state; they do not invent an ungated tagged release.

## Finding-to-fix mapping

| Repair                                               | Implemented behavior and assertion coverage                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: rejected scrub work deliberately lost the primary | The migration never calls `clearAll()` and never rewrites saved registered values during scrub. It uses a bounded hybrid plan, current verified backup prerequisite, exact layout/coverage checks, fixed deferrals, and no old-value restoration over concurrent changes. Rejected growth plus cache purge preserves the migrated primary.                                                        |
| B: historical EDDSA omission                         | Legacy-only decoding accepts the two named omitted fields only in an otherwise validated CBC snapshot. Bare extended-key syntax/checksum and opaque password-blob shape are checked without constructing clients or unlocking passwords. Other plaintext, malformed envelopes, mixed formats, and modern unwrapped values remain rejected. Ordinary encryption formats/AAD are unchanged.         |
| C: unfinished AsyncStorage import                    | Validated AsyncStorage protected material is compared with selected active state, including active recovery-file state. An empty/import-pending root plus its matching cache backup no longer defeats import. Equivalent/superset active state stays authoritative. Conflicts preserve both sources read-only. Comparison is rechecked before deletion if active data changed during the attempt. |
| D: unreadable legacy credential                      | Present, absent, and unreadable old credentials are distinct. Only the old service's read error permits a read-only identifier candidate for actual CBC envelopes. Whole-snapshot validation and verified random-key storage still precede migrated writes. Unreadable legacy retirement remains unresolved cleanup until reset/read-back or absence is verified.                                 |
| E: optional refresh promoted as required on retry    | Equivalent refresh temps or digest-bound optional refresh provenance remain deferrable with a verified modern primary covering their protected contents. Three consecutive failures and later success are tested. Sole/distinct required temps stay strict; a valid target alone cannot authorize deleting a distinct temp. A newer primary is not rolled back.                                   |
| F: unsafe/generic reporting                          | Fixed codes/phases replace raw native/parser/cause propagation. Actual startup and crypto-transform reporting paths are tested for sentinel absence and single reporting. The Retry UI remains; its unconditional “data was preserved” claim was removed because the explicitly retained native-crash residual can lose local data.                                                               |
| Branch-only input                                    | Unsupported plaintext `PORTFOLIO_CHARTS` stops read-only with `UNSUPPORTED_FORMAT`, after modern-key detection priority. The ordinary adapter sanitizer is unchanged.                                                                                                                                                                                                                             |
| Defensive review findings                            | Hidden GCM inside CBC is detected before passing any legacy candidate to GCM decryption. Public marker text is not an envelope. Null-prototype snapshot dictionaries prevent malformed reducer names from manufacturing an inherited `_persist` and causing a destructive rewrite.                                                                                                                |

### Production files

- `src/store/vault-migration.ts`: source inventory/selection, narrow EDDSA compatibility, legacy-only read exception, optional-temp provenance/retry, hybrid integration, and safe classified failures (C1–C6).
- `src/store/vault-scrub.ts` (new): migration-only default-instance scrub, exact string-entry arithmetic and bounded plan/verification (C4/C6).
- `src/store/vault-diagnostics.ts` (new): fixed classification and sanitized startup reporting, using identity-based metadata rather than reading arbitrary exception properties (C2/C4/C6).
- `src/store/index.ts`: startup crypto failures are held for the single sanitized startup boundary, without extra failure-log dispatches or duplicate reporting. `reduxStorage` and ordinary backup logic are unchanged (F/C6).
- `src/store/transforms/transforms.ts`: crypto failure messages/rethrows are sanitized; decrypt failures report at startup once. Successful transform behavior and coverage are unchanged (F/C6).
- `index.js`: existing startup rejection handler uses the sanitized reporter and keeps the existing Retry action (F/C6).

No production native code, dependencies, app lockfiles, `deviceUID`, app-lock/signing authorization, recovery UI, or general migration framework changed. `encryption-key.ts`, the strict file primitives, importer guard/dispatch, AES-GCM primitives/AAD, persistence guard, and ordinary backup policy remain in place.

### Tests and supporting files

Changed tests: `src/store/vault-migration.spec.ts`, `src/store/transforms/transforms.spec.ts`.
New tests: `src/store/vault-scrub.spec.ts`, `src/store/vault-diagnostics.spec.ts`.
Supporting fixture/model/native source files are listed in `test/vault/README.md` and the final status inventory below. `test/vault/mmkv-model.ts` is a platform-boundary byte model, not a second migration implementation. Native verification executes the actual working-tree migration with a real pinned-core default MMKV and modeled other platform boundaries.

Obsolete clear/restore and blanket legacy-read-stop expectations were replaced only where the prompt amended them. Their preservation, retry, missing-key, and sensitive-data protections remain covered. Existing full persistence, password, all-field, alternate-source, wrong-backend, concurrent caller, unknown-key, and completed-fast-path tests remain.

## State, source selection, and retry

The separate `bitpay.vault.migration` record retains `status: started|complete` and `wipeDone`. Optional `refresh: {path: main|bak, digest: SHA256(ciphertext temp)}` identifies exactly which optional refresh was attempted. No private payload or vault secret is added to the record. Existing records without this field remain valid. Equivalent unmarked refresh temps are recognized by verified contents; unmarked distinct temps retain strict treatment.

| Stage/failure                                                                                          | Behavior                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioned entry missing with a record, unreadable, invalid, wrong backend, or GCM without a usable key | Stop without identifier fallback, regeneration, or destructive cleanup; retain bounded pre-record/pre-GCM wrong-backend replacement only.                                                                          |
| Old service read rejects                                                                               | Record a safe notice; a supported CBC copy may try the identifier read-only. New-key write/read-back failure still stops before migrated writes.                                                                   |
| Required legacy filesystem copy cannot be rewritten                                                    | Strict stop; the migration is not zero-space and full-disk failure of a required copy is not made best-effort.                                                                                                     |
| Earlier migrated-root write                                                                            | Still occurs after required-copy migration and before pre-scrub refresh. Its native-compaction interruption exposure is retained and separately tested below.                                                      |
| Optional current-backup refresh/promotion/verification fails                                           | Preserve usable modern primary and needed temps, skip scrub, remain incomplete, retry. Distinct required data and sole recovery sources are not silently ignored.                                                  |
| Known filler remains                                                                                   | Prepare/verify current backup before its potentially compacting removal; verify ownership/content, removal, registered values, and bounded growth. Never overwrite the same leftover key as a shortcut.            |
| Metadata fails, layout is unproven, or encoded filler/deletion cannot fit                              | Safe deferred code; no completion. Read failures outside the metadata-only rule remain strict.                                                                                                                     |
| Registered state changes during await                                                                  | Validate a changed root under the vault key; if usable, abandon stale plan without writing older values back. Missing/invalid previously present root stops. Recheck AsyncStorage preservation before deleting it. |
| Scrub write/growth rejected                                                                            | Verify current values remain usable; leave incomplete, retain legacy credential, retry later. Never clear the primary.                                                                                             |
| Cleanup/legacy retirement fails                                                                        | Defer completion; startup can use verified modern state. Retry retirement even when the initial legacy read was unreadable.                                                                                        |
| Completed record                                                                                       | Validate/read only the versioned key and return on the existing fast path; no new scrub/metadata/source comparison every launch.                                                                                   |

The protected projection contains exactly the named wallet fields, mainnet identity `priv`, and named mainnet gift-card fields. Keys/values are compared at their contexts, with required key/wallet/public-derivation associations and read-only presence. Wallet balances/display names are not made a new conflict policy. Opaque password ciphertext is compared exactly, never unlocked to guess equivalence. Fingerprints/IDs/counts alone are not treated as proof.

“Empty/import-pending” means a validated selected active snapshot has an empty defined protected projection and `APP.migrationMMKVStorageComplete !== true`. It does not mean an empty file or disposable read-only wallets. AsyncStorage may replace this state only when its validated snapshot also preserves the necessary existing associations. A selected state covering the incoming material stays authoritative with its other logical contents. Unique/conflicting material stops before writes. Invalid/unreadable inputs are not manufactured into empty snapshots; an invalid AsyncStorage source beside an empty active state is preserved rather than discarded. Distinct valid filesystem generations are not compared for blanket equality.

The old importer remains guarded once a versioned key/record exists and dispatches its completion action. Only AsyncStorage `persist:root` is deleted, after a verified destination and preservation check; unrelated keys are untouched.

## Hybrid scrub coverage and bounds

### Configuration and threshold

The pinned default application instance is `new MMKV()` with no custom capacity/path, MMKV encryption, expiration, or compare-before-set option. iOS uses Documents/mmkv; Android uses files/mmkv, both addressed via `RNFS.DocumentDirectoryPath + '/mmkv/mmkv.default'`. The wrapper's `trim()` performs `clearMemoryCache()` followed by native `trim()`; `size` is `actualSize()`, not physical capacity.

Core `m_expectedCapacity` is the maximum of the OS base page and page-rounded requested capacity; the wrapper supplies the default expected capacity. The 64 KiB small-file threshold bounds the base-page granules of these supported default ARM configurations; x86 uses a smaller base page. Arm documents [4, 16 and 64 KiB AArch64 granules](https://documentation-service.arm.com/static/670e4dc89fbc7343d3e4cee1), while Android documents its [4/16 KiB configurations](https://developer.android.com/guide/practices/page-sizes). Actual tests used a 16 KiB macOS arm64 kernel and a 4 KiB Android arm64 guest. Equality belongs to the small-file branch. This is neither a maximum root size nor a claim about every future OS/page/configuration.

### Encoding and compacted layout

Let `v(x)` be unsigned varint32 width; `k` the UTF-8 byte length of the actual key; `n` the UTF-8 byte length of its string value. The exact pinned string entry is:

```text
K(key) = v(k) + k
Q(n)   = v(n) + n
E(key,n) = K(key) + v(Q(n)) + Q(n)
A_expected(nonempty) = 4 + sum(E(actualKey, actualValueUTF8Bytes))
A_expected(empty) = 0
```

The first `4` is the internal dictionary placeholder. The file has a separate four-byte actual-size header. Tests construct an independent byte encoding and compare actual native `actualSize`, including Unicode, empty strings, and varint transitions. No filler-key shortcut is used to size root/log entries.

For `bitpay.vault.scrub`, `k=18`, `K=19`, and the deletion record `D=K+v(0)=20`. A nonempty larger-file dictionary may use the free-tail plan only when the complete registered map is current and `storage.size === A_expected`. This proves the relevant compacted layout; it does not claim that the immediately preceding trim did work, that the file shrank, or that its tail is clean. A mismatch defers, rather than trusting a void return. Empty dictionaries explicitly require actual size zero and reserve a fresh four-byte placeholder for their first insertion.

### Free-tail branch

For physical length `F`, let `B=A_expected` for nonempty data and `B=4` for a zero-entry dictionary about to receive its first entry. The usable tail is `T=F-4-B`. A bounded 32-step integer search chooses the largest `n >= 0` satisfying:

```text
E(scrub,n) + D < T
```

`T` is not the filler payload length. An empty string is a genuine encoded entry and is permitted at the tightest fitting boundary. If no encoded entry plus deletion fits, the attempt defers explicitly. This is a documented fit constraint, not a constant cap on supported multi-megabyte roots.

The native append guard uses `incoming >= spaceLeft`, so strict inequality reserves deletion space and avoids compaction/growth for both calls. First insertion into an empty dictionary has its separately reserved placeholder and uses the pinned empty-dictionary writeback path. Filler absence is checked before insertion, avoiding the same-key/one-key overwrite optimization. Exact logical sizes after set/delete are verified. Physical length must stay equal during the claimed no-growth set/delete sequence; later trim may shrink it but may not grow it.

Because `E(n+1)-E(n) <= 3`, choosing the maximum fitting `n` leaves only 1–3 bytes after the deletion record. The verified compacted prefix contains the current registered strings; filler/deletion cover the historical tail except that terminal fragment. It cannot contain enough of a legacy CBC block/envelope to recover an in-scope protected value. The only accepted bare legacy EDDSA values are structurally checked extended private keys or opaque password-ciphertext objects, not arbitrary short plaintext. No complete extended key/password blob can survive in that fragment. The final trim copies only the live registered dictionary and cannot reintroduce discarded history.

This is a coverage argument about recoverable protected values, **not** a promise to zero every old byte or erase deleted flash blocks. Raw prefix scans alone do not establish it. The native scans also recover candidate ciphertext from snapshot fragments, attempt identifier decryption, and search known bare/opaque EDDSA fixture material.

### Small-file overfill and separate resource bounds

For `F <= 65,536`, first trim may return at minimum capacity without compacting. A new, absent scrub key receives exactly `F` ASCII zero bytes. Its entry cannot fit in the old file, forcing the pinned compact/writeback path and covering the old `F`-byte extent. Growth is allowed here. Rejection must leave the migrated primary intact; tests reproduce the old clearing algorithm's failure and the repaired preservation/retry behavior.

Let `S=max(4,A_expected)`, `L=S+4+E(scrub,F)`, and `c` the number of existing live keys. The core doubles capacity until it exceeds `L + 8*ceil(L/(c+1))`. The code computes that bound with at most 32 doublings and verifies observed length. The default registry has at most two live registered keys. This is a relative physical/live-size bound, not an arbitrary enormous payload.

- Filler memory: at most `F`; in the small branch at most 64 KiB. The larger branch's filler is strictly smaller than its available tail. JS/native copies and registered snapshots make total working memory `O(F+S)`; the measured process peaks include harness overhead.
- Disk: no growth in the verified tail set/delete branch. Small overfill is bounded by the exact core growth calculation. Existing-filler removal has its own conservative bound using the actual live dictionary including that filler.
- CPU/work: UTF-8/entry calculations and read-back are linear in live/filler bytes; search/doubling loops have 32-iteration limits. Native trim includes its existing live-entry ordering/compaction cost. There is at most one filler insertion, at most two deletions, and two trim calls per attempt.
- Retry growth: small overfill is restricted to files at most the threshold. Once a failed-shrink/restart history is larger, an unproven compact layout defers; it is not overfilled repeatedly into unchecked growth. No fixed multi-megabyte allocation ceiling silently defers otherwise proven large layouts.
- Integer domain: lengths must be positive safe integers and compatible with the pinned wrapper's signed-int `actualSize` exposure (`<= 2^31-1`). Unsupported bounds defer explicitly.

Two metadata observations at each measurement checkpoint are tied to rechecked logical size, full registered values/key set, and current-backup assumptions. The default configuration is single-process and migration precedes ordinary store writers. These checks do not claim atomicity against arbitrary external file mutation or prevent OS cache purge.

## Diagnostics

Fixed error/deferred codes are: `MODERN_KEY_FAILURE`, `NEW_KEY_VERIFICATION`, `INVALID_LEGACY_INPUT`, `UNSUPPORTED_FORMAT`, `SOURCE_CONFLICT`, `REQUIRED_COPY_FAILURE`, `OPTIONAL_REFRESH_DEFERRED`, `LEGACY_KEY_UNREADABLE`, `CLEANUP_DEFERRED`, `UNKNOWN_STORAGE_KEY`, `SCRUB_MEASUREMENT_DEFERRED`, `SCRUB_COVERAGE_DEFERRED`, `SCRUB_WRITE_REJECTED`, `SCRUB_STATE_CHANGED`, `PRESERVATION_FAILURE`, and `STARTUP_FAILURE`.

Predefined phases are key, inventory, classify, required-copy, root-write, refresh, scrub, cleanup, persist, and startup. Classification never copies native messages, parser input, nested causes, arbitrary reporting objects, key IDs, ciphertext, or sensitive native paths. Unknown failures receive a fixed classification. A WeakMap identity lookup avoids invoking hostile getters/prototype traps. Tests reach the actual init-log and Sentry boundary with synthetic sentinels, including completed-startup rehydration, and assert one sanitized report. No production telemetry was queried or sent by these tests.

## Validation results

The required repository commands, their actual statuses, and comparisons are retained in `test/vault/results/checks.json`. Full temporary logs remain under `/private/tmp/bip02-final-repair-yl0ueiig`.

| Command/check                                 | Unchanged baseline                               | Repaired working tree                                                                                 |
| --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `yarn test:ci`                                | exit 0; 139 suites, 2,479 passed, 2 skipped      | exit 0; 141 suites, 2,575 passed, 2 skipped                                                           |
| Six focused migration/crypto/reporting suites | Original tests retained; new assertions added    | exit 0; 237 passed                                                                                    |
| `npx tsc --noEmit`                            | exit 2; 2,026 diagnostics                        | exit 2; 2,024 diagnostics; 0 introduced                                                               |
| `npx eslint . --ext .js,.jsx,.ts,.tsx`        | exit 1; 632 errors, 697 warnings                 | exit 1; same 632 errors, 697 warnings                                                                 |
| `yarn prettier:check`                         | exit 0                                           | exit 0                                                                                                |
| CommonJS tooling lint (Node syntax)           | new tooling                                      | exit 0; no errors/warnings                                                                            |
| `git diff --check`                            | clean                                            | clean                                                                                                 |
| Android `:app:assembleDebug`                  | not repeated as a separate pre-edit build        | exit 0; pinned debug APK built                                                                        |
| iOS `pod install --deployment`                | stale generated Pods identified                  | exit 1 on clean retry: existing lock checksum discrepancy; native app build blocked                   |
| iOS / Android final JS bundles                | not repeated as separate pre-edit bundles        | exit 0 / exit 0                                                                                       |
| Actual pinned-core erasure cases              | Original clearing control is red, exit 1         | 13 macOS 16 KiB + 13 Android 4 KiB cases pass, exits 0                                                |
| Deliberately timed native kills               | Supplied prototype/control inspected and sampled | 96 recovery scenarios asserted across two 48-case passes, exit 0; residual losses observed, not fixed |

The initial Jest attempt could not start because ignored installed dependencies were React Native 0.87.1 / Worklets 0.12.1 instead of this commit's 0.82.0 / 0.8.1. `COREPACK_ENABLE_AUTO_PIN=0 yarn install --frozen-lockfile` succeeded without tracked changes. The unchanged-source baseline was then run with the correct pins.

TypeScript comparison normalizes moved line/column numbers. Two existing ambient `require` redeclaration diagnostics were not emitted in the final compilation; no dependency declaration was edited and this is not claimed as an unrelated type-system repair. Full Jest retains its pre-existing worker teardown warning. The standalone CommonJS parser option only selects Node 22-compatible syntax; no lint rule or repository gate was weakened.

The Android app debug build succeeded with the pinned JDK 17/NDK and bounded workers. Both final platform JavaScript bundles compiled to scratch. iOS native build is blocked: deployment-mode Pods installation requires changing the committed Podfile checksum, from `4c22e1a9ab9a161b45190306ef176800a1072619` to `2d77c0721b56ccd64df7fa2dc8069d67a1a6059d`. The latter is also the SHA-1 of the exact starting commit's Podfile, proving this is pre-existing. A clean attempt preserved the old generated 0.87 Pods directory and restored it after failure. No lockfile was altered, no pod update was substituted, and no successful iOS native build is claimed.

## Native evidence and measurements

Reproduction commands and distinctions are in `test/vault/README.md`. The native runner executes the actual production migration; only platform boundaries are modeled. Default MMKV uses the unchanged pinned core, each API invocation reopens the file, and wrapper trim is reproduced. Secure storage/journal/AsyncStorage are modeled, filesystem backups are host scratch files, and the identifier is synthetic. Thus **real kernel/core results are not full mobile-app or hardware-secure-storage certification**.

`test/vault/results/native-mac.json` and `native-android.json` retain actual case manifests, commands/source hashes, pre/post scan counts, per-mutation file sizes/times, and observed memory peaks. These cover minimum-capacity history, root removal, no-key history, 2/4 MiB live roots, constructor-password defensive data, tight empty-filler fit, insufficient-tail safe deferral/retry, rejected growth/cache purge, real injected shrink failure, and leftover filler. Encoding/threshold/stale-layout/race boundaries are additionally asserted in the independent boundary model.

The unchanged starting production migration is a **red** native control: rejected growth results in `rejected scrub lost primary`, exit 1. The repaired run preserves it, even after modeled cache purge, and succeeds when the rejection clears. `RLIMIT_FSIZE` is a rejected-growth model, not every ENOSPC/COW/filesystem failure. The test-only interposer rejects `ftruncate` shrink requests; production core/native code is unchanged.

| Environment / case                       | Filler bytes | File before → after filler | End-to-end ms | Peak native worker MiB |
| ---------------------------------------- | ------------ | -------------------------- | ------------- | ---------------------- |
| macOS 16 KiB: minimum-capacity           | 16,384       | 16,384 → 65,536            | 250           | 1.5                    |
| macOS 16 KiB: two-megabyte               | 2,095,713    | 4,194,304 → 4,194,304      | 972           | 20.5                   |
| macOS 16 KiB: four-megabyte              | 4,192,323    | 8,388,608 → 8,388,608      | 1,638         | 39.5                   |
| macOS 16 KiB: near-capacity-zero-filler  | 0            | 131,072 → 131,072          | 306           | 1.9                    |
| macOS 16 KiB: failed-shrink-large        | 947,141      | 1,048,576 → 1,048,576      | 416           | 4.9                    |
| Android 4 KiB: minimum-capacity          | 4,096        | 4,096 → 32,768             | 13,678        | 10.3                   |
| Android 4 KiB: two-megabyte              | 2,095,713    | 4,194,304 → 4,194,304      | 13,345        | 19.1                   |
| Android 4 KiB: four-megabyte             | 4,192,323    | 8,388,608 → 8,388,608      | 12,474        | 35.4                   |
| Android 4 KiB: near-capacity-zero-filler | 0            | 131,072 → 131,072          | 13,282        | 6.5                    |
| Android 4 KiB: failed-shrink-large       | 947,141      | 1,048,576 → 1,048,576      | 13,521        | 7.3                    |

All successful final native erasure cases have zero identifier-decryptable CBC candidates, known bare EDDSA occurrences, and unwrapped constructor-password EDDSA ciphertext occurrences. Markers are reported as supporting counts. The current-core seeds are serialized legacy wallet fixtures, not captured old-version MMKV binaries; actual released-app native-file upgrades remain a release gate.

Timing is host/harness wall time, including process/ADB transport and verification overhead, not app launch latency. Per-operation times include native worker startup and metadata checks. Peak file size includes setup history; set-filler before/after lengths separately establish grow/no-grow behavior. Native worker peak memory is measured per worker; Node peak RSS is process-wide/high-water, not an isolated allocation attribution. No device-performance claim is inferred from these numbers.

### Inside-native kills: separate phases and actual recovery

`test/vault/results/native-kills.json` and `native-kills-repeat.json` record two deliberate operation-marked 48-case SIGKILL passes. A second pass checked the no-source window rather than treating a first pass with no observed loss in that subgroup as evidence of safety. The initial-root-write case asserts that compaction is required. After termination, subsequent platform operations are stopped; a fresh migration attempt reads the actual surviving default file and backup/AsyncStorage sources. Assertions compare recovered wallet properties, not just IDs/counts. Trials whose native operation completed before termination must retain all protected contents.

| Phase / available recovery | Trials | Killed while worker active | Actual selected sources     | Recovered key sets    |
| -------------------------- | ------ | -------------------------- | --------------------------- | --------------------- |
| root-write:current         | 16     | 12                         | main-backup: 1, primary: 15 | 2 keys: 16            |
| root-write:older           | 16     | 12                         | main-backup: 2, primary: 14 | 1 keys: 2, 2 keys: 14 |
| root-write:none            | 16     | 13                         | none: 1, primary: 15        | 0 keys: 1, 2 keys: 15 |
| root-write:async           | 16     | 12                         | async: 2, primary: 14       | 2 keys: 16            |
| scrub:current              | 16     | 12                         | main-backup: 2, primary: 14 | 2 keys: 16            |
| scrub:purged               | 16     | 12                         | none: 3, primary: 13        | 0 keys: 3, 2 keys: 13 |

The current fixture contains two distinct key sets. An older backup contains only the original one. Zero means no usable local source remained; no subsequent cache purge was needed in the earlier-root-write/no-backup case. Full-property comparisons, not counts alone, are asserted by the driver.

These are schedule-dependent experimental outcomes, not production failure rates. An assertion that the expected residual was observed is not a claim that the residual is fixed or accepted. The earlier supplied prototype baseline was also inspected/run on macOS; it is not substituted for the corrected JS planner/precondition tests.

## Required limitations and release blockers

Historical scope statement for the original repair (the dated follow-up above supplies the current conditional status): “Historical Android RKStorage residual bytes are not remediated by this change. The fix remains incomplete on affected devices until that separately scoped cleanup ships.”

“The hybrid scrub preserves the primary on rejected scrub work but does not make native MMKV compaction crash-atomic. Recovery after a scrub-phase native-compaction interruption can depend on the required current, verified migrated cache backup; loss of that backup can require the existing wallet recovery mechanism.”

“The earlier write of the migrated MMKV root can trigger compaction before the current new-key backup exists. Recovery depends on other surviving, validated sources, which may be older or absent. Newer protected data can be missing from an older backup, and with no other usable source local data can be lost without a subsequent cache purge. The migration ordering is unchanged in this bounded repair; release acceptance of this residual remains an explicit owner decision.”

Required-copy and modern-key failures remain fail-closed. CBC structural validation is not authenticated decryption. Old-binary downgrade is unsupported; a corrective release must retain modern-key/read compatibility. No owner acceptance of the bounded native-crash risks is inferred from the experiment or this report.

### Unrun full app/device gates and manual procedure

1. Resolve the pre-existing iOS dependency-lock discrepancy separately; do not bypass it. Build signed test apps using the pinned dependencies. On disposable iOS and Android installations, seed tagged legacy fixtures with the test app's **actual** identifier internally, without printing it or changing `deviceUID`.
2. Verify fresh install, released-app upgrade and cold-process reopen through the complete app. Confirm public wallet fingerprints/IDs and opaque password behavior, secure-storage options, Android returned backend, and no fallback when the modern key is unavailable.
3. Repeat real low-space/persistent write failure and retry in the mobile apps. Confirm a rejected scrub write keeps the current primary usable even if cache files disappear. Core RLIMIT tests alone do not establish all filesystem failures.
4. On supported physical phones, cover actual 4/16 KiB configurations where applicable. On iPhone, reboot, unlock once, lock again, then trigger the permitted background/remote-notification launch and confirm key availability and existing app-lock behavior. These physical-phone tests were not run.
5. Stop the app and scan actual app-container MMKV/CRC and filesystem copies. Recover candidate full ciphertext from snapshot fragments, attempt identifier decryption privately, and scan known bare EDDSA fixture material. Report booleans/counts only. Include removed-root, minimum-capacity, repeated-rewrite and leftover-filler histories.
6. Test native-compaction interruptions in the full app separately at the earlier root write and scrub phase. Establish actual current/older/no-backup/AsyncStorage recovery contents, plus scrub backup purge. Obtain explicit owner acceptance of observed/documented residuals before release.
7. In the original run, the informational historical RKStorage/WAL/journal scan was not performed and remediation was outside scope. The separately authorized follow-up now has its own implementation and validation report; the original default-MMKV tests remain insufficient evidence for SQLite cleanup by themselves.

Recommend a staged rollout and monitoring of fixed diagnostic codes and incomplete/completed migration outcomes after owner review and gate completion. This is a recommendation only: no rollout state, telemetry, CI, PR, or release was changed.

## Final working-tree review

The task's tracked/untracked file inventory, source hashes, and diff sizes are retained below and in `test/vault/results`. Synthetic fixtures and source-only test programs are intentional additions. No dependency tree, compiled native binary, raw MMKV file, bundle, environment file, credential, or real wallet data was added to the reviewable tree. The pre-existing untracked paths remain separate from this task's additions.

```text
 M index.js
 M src/store/index.ts
 M src/store/transforms/transforms.spec.ts
 M src/store/transforms/transforms.ts
 M src/store/vault-migration.spec.ts
 M src/store/vault-migration.ts
?? BIP-02-REPAIR-REPORT.md
?? deliverables/
?? docs/
?? index.worklets-stress.js
?? scripts/run-retaining-serializable-stress-android.js
?? src-master.zip
?? src-uncompressed-s.zip
?? src/portfolio/runtime/testing/
?? src/store/vault-diagnostics.spec.ts
?? src/store/vault-diagnostics.ts
?? src/store/vault-scrub.spec.ts
?? src/store/vault-scrub.ts
?? test/vault/
```

Task-added paths (including nested fixtures/results; pre-existing untracked groups above are excluded):

- `BIP-02-REPAIR-REPORT.md`
- `src/store/vault-diagnostics.spec.ts`
- `src/store/vault-diagnostics.ts`
- `src/store/vault-scrub.spec.ts`
- `src/store/vault-scrub.ts`
- `test/vault/CMakeLists.txt`
- `test/vault/README.md`
- `test/vault/fixture-project/package-lock.json`
- `test/vault/fixture-project/package.json`
- `test/vault/fixture-project/released-encrypt.patch`
- `test/vault/fixture-project/released/constants.ts`
- `test/vault/fixture-project/released/v14_32_0/encrypt.ts.source`
- `test/vault/fixtures/legacy-14.32.json`
- `test/vault/fixtures/provenance.json`
- `test/vault/generate-legacy-fixtures.cjs`
- `test/vault/kill-one.py`
- `test/vault/mmkv-model.ts`
- `test/vault/native-api.cpp`
- `test/vault/results/checks.json`
- `test/vault/results/initial-state.json`
- `test/vault/results/native-android.json`
- `test/vault/results/native-kills.json`
- `test/vault/results/native-kills-repeat.json`
- `test/vault/results/native-mac.json`
- `test/vault/results/native-preflight-results.json`
- `test/vault/results/pinned-core-source-check.json`
- `test/vault/results/published-package-verification.json`
- `test/vault/results/source-provenance.json`
- `test/vault/results/supplied-programs.json`
- `test/vault/results/supplied-prototype-kills.txt`
- `test/vault/run-native.cjs`
- `test/vault/supplied/killfuzz.py`
- `test/vault/supplied/scrubfuzz.cpp`
- `test/vault/results/working-tree-inventory.json`

Tracked diff (new files are accounted for separately):

```text
 index.js                                |    5 +-
 src/store/index.ts                      |   14 +-
 src/store/transforms/transforms.spec.ts |    4 +-
 src/store/transforms/transforms.ts      |   33 +-
 src/store/vault-migration.spec.ts       | 1292 ++++++++++++++++++++++++-------
 src/store/vault-migration.ts            |  650 +++++++++++++---
 6 files changed, 1567 insertions(+), 431 deletions(-)
```

New production helpers: 304 lines. New dedicated regression suites: 474 lines. Additional model/native/generator sources, fixture data, isolated lock input, results and report are individually listed above. These are facts for review, not a correctness budget.

Re-read areas: rejected-write preservation, asynchronous races/current-backup checks, source conflicts and deletion guards, temp provenance across retries, single-candidate legacy decoding, modern-key priority, completed fast path, native encoding/coverage bounds, and logging/reporting privacy. No unresolved rejected-write or source-selection defect is claimed repaired merely by a green exploratory test. The implemented assertions and the explicitly unrun gates above define the evidence limits.
