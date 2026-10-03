# BIP-02 Android RKStorage follow-up

Status: implemented in the provided working tree, with Android emulator and real
Hermes application-path verification. **Not a release approval.** Physical-device
and 16 KiB OS-page validation remain outstanding, as do the previously documented
MMKV residual-risk acceptance decisions. Deferred/unverified installations remain
exposed to historical RKStorage residue; the new guarantee applies only after the
separate cleanup marker has been successfully established.

The later optional-refresh preservation and EDDSA source-comparison repairs are
documented in [BIP-02-REPAIR-REPORT.md](BIP-02-REPAIR-REPORT.md). Their validation is
recorded separately from the original native SQL campaign below.

## Fresh-initialization retry repair

This follow-up starts at `c4cfb008974e8c91726b6e4830f3c560e8dadf67`. Its
tracked working tree was clean; the unrelated untracked files listed below remain
untouched. The review correctly identified a startup lockout: base migration could
finish on a fresh install before the first Redux save, then the next attempt
mistook that completion for evidence of a lost save. The new same-process and
fresh-module regressions both fail with `PRESERVATION_FAILURE` against the original
production implementation. No SQLite cleanup runs in that failure.

The base record now has one optional field, `initializing: true`. Only a new
Android record can acquire it, after strict inventory finds every primary,
AsyncStorage, backup and temporary snapshot absent, with no legacy credential or
legacy-read error. It is written and read-back verified with the initial `started`
record, before completion; it survives all intervening record updates. Missing
means no fresh-initialization exception; any value other than `true` is invalid.
Old started/completed records are never retroactively labeled fresh. This does
not attempt to guess whether an already-ambiguous rootless record from an older
build represents a fresh installation or lost established data.

While this provenance is present and no active source exists, startup can defer
RKStorage maintenance repeatedly, including after base completion and across
process restarts. The provenance does **not** authorize erasure. A usable active
snapshot remains required before cleaning an existing database. Key validation,
strict inventory failures, source preservation guards and verified-absence rules
remain in place.

Retirement happens synchronously after the first ordinary Redux root write and
exact read-back, before its existing asynchronous backup step. A rejected write
cannot retire the provenance. A failed retirement leaves the saved root intact
and retries on a subsequent save or startup. Startup also retires it after finding
a validated active snapshot, before a native inventory/maintenance await. This
covers interruption after the root write but before retirement, and backup-only
recovery. Retirement itself is read-back verified. Subsequent established saves
perform no additional metadata reads or writes; the normal backup policy is
unchanged. Losing all active copies after retirement still stops startup while
RKStorage cleanup is pending.

The production change is limited to the base record extension/retirement helpers,
the Android startup decision and the ordinary adapter's first-save hook. Native
SQL cleanup, provider patch, MMKV scrub, encryption and dependency pins are
unchanged. The tests distinguish interruption between completed API calls from
the previously documented native-compaction crash windows; those residuals and
release acceptance requirements remain outstanding.

Validation commands and safe aggregate outcomes for this repair are recorded in
`test/vault/rkstorage/results/fresh-initialization.json`. Full logs remain in
`/private/tmp/bip02-fresh-repair-lP3oWS`. The older validation tables below describe
the original RKStorage implementation, not checks rerun by this repair.

## Base, authority and preserved work

Work started at the required `f307e0aec2c95d71905d8188bddf37b6cc5c5c3e` on `bip-02` in
`/Users/marty/open-source/bitpay-app`. Initial tracked status was clean. The following
pre-existing untracked groups were recorded and left unchanged:

```text
deliverables/
docs/
index.worklets-stress.js
scripts/run-retaining-serializable-stress-android.js
src-master.zip
src-uncompressed-s.zip
src/portfolio/runtime/testing/
```

Implementation and validation preceded the user’s subsequent request for a local
commit. No push, PR, hosted workflow, release, repository copy, output archive, or
standalone repository patch was created. The dependency patch below is an
explicitly authorized installation input. No app dependency or lockfile upgrade
was made. Test binaries, raw captures, AVDs, dependency extraction and complete logs
remain in scratch or ignored build directories. The retained wallet fixtures are
public, offline-generated throwaway keys, never real wallets.

## Pins and actual backend

The installed versions match the repository: AsyncStorage 2.2.0, React Native
0.82.0, MMKV 3.3.1, RNFS 2.20.0, and Keychain 10.0.0. The exact AsyncStorage tag is
`@react-native-async-storage/async-storage@2.2.0`: tag object
`16b60d23a02f1f5f029bbca2e7a282c7a57c4344`, commit
`3c9560c8874cabb1200b5121815f932b397cf89e`. Its source directory is
`packages/default-storage` (the npm metadata's directory name differs). The four
inspected native source files matched both the published package and that commit
before edits. Original/patched source hashes and npm integrity are retained in the
evidence inventory.

Build output confirms `newArchEnabled=true`, `AsyncStorage_useNextStorage=false`,
and `AsyncStorage_db_size=6L`. These are independent settings: the shipped backend
is the Java `ReactDatabaseSupplier`/`AsyncStorageModule`, not Room. The default
supplier owns schema version 1 and:

```sql
CREATE TABLE catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

The target is resolved with `Context.getDatabasePath("RKStorage")`. Strict NIO
metadata checks distinguish absence from unreadability, reject redirected/non-file
leaves, permit Android's canonical directory aliases, and inspect `-wal`,
`-journal`, and `-shm`. Unknown `RKStorage-*` files, scoped Expo sources, and orphaned
sidecars remain unsupported/pending. No hardcoded application directory is used by
production cleanup. Before SQL maintenance, the actual owner's canonical database
path must match the context target. Unexpected schema objects, columns/version,
attached databases, non-text key/value cells, or unverified integrity cannot
complete cleanup.

The merged manifest has a restart-only `:phoenix` activity from
`react-native-restart`/ProcessPhoenix. The production React contexts use the main
process. Both the cleaner and patched supplier refuse RKStorage ownership in a
secondary process; this is not a general multiprocess database protocol.

## Production changes and their purpose

| File/change                                                           | Requirement addressed                                                                                                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store/vault-rkstorage.ts`                                        | Android-only single-flight startup follow-up, separate marker, explicit prerequisites, active-source rechecks, fixed outcomes and retry behavior.                                                              |
| `src/store/vault-migration.ts`                                        | Reuses completed-record and serialized GCM validation; the repair adds durable fresh-initialization provenance and verified retirement without changing source selection or key generation.                              |
| `src/store/index.ts`                                                  | Existing `getEncryptionKey()` hook calls `prepareVault()` before rehydration; the first ordinary root save retires initialization provenance after exact read-back.                                                                                                           |
| `src/store/vault-diagnostics.ts`                                      | Adds fixed RKStorage deferral codes and phase; no arbitrary native errors/values are forwarded.                                                                                                                |
| `RKStorageCleanup.java`                                               | One fixed, SQLite-managed maintenance operation, strict file/schema checks, streamed live-value comparison, checked journaling and lifecycle postconditions.                                                   |
| `RKStorageModule.java`, `RKStoragePackage.java`, `MainApplication.kt` | Parameterless `inspect()`/`clean()` bridge and normal package registration. The existing new-architecture legacy-module interop was exercised from Hermes. No SQL/path/key interface is exposed.               |
| AsyncStorage dependency patch                                         | Shares actual provider ownership across contexts/lifecycle, removes destructive open/upgrade/corruption fallback and unchecked Expo copying, finalizes insert statements, sanitizes provider error boundaries. |
| `android/app/build.gradle`                                            | Test runner/assets and explicit debug-only fault-injection packaging. Normal builds contain no interposer/wrapper; release sources do not include them.                                                        |

The MMKV scrub, including `f307e0a`'s guard ordering, encryption formats/AAD,
Keychain options, wallet-password handling, authentication/signing, importer policy,
filesystem backup policy are unchanged; the adapter adds only the initial-save retirement hook described above. There is no new
recovery UI or plaintext crash-copy framework.

## Startup and marker lifecycle

`prepareVault()` first runs the existing migration. A returned vault key is not
sufficient: its record must actually be `complete`. Started/deferred/failed base
migrations cannot authorize physical SQLite cleanup. Old completed installations
still enter this follow-up when the new marker is absent, without rekeying or
rerunning the MMKV scrub.

The new key `rkstorage-cleanup-v1` in the existing dedicated
`bitpay.vault.migration` MMKV instance has one completed value, `complete-v1`.
Absence means pending. It contains no key, identifier, snapshot or data fingerprint.
It neither changes nor repurposes the base `status`/`wipeDone` fields. Unknown marker
contents/read failures are strict failures.

While pending, the selected primary, or an existing filesystem recovery source
when the primary is absent, is validated through the existing serialized-snapshot
decoder under the versioned key. Required read failures remain strict. A missing or
invalid previously present primary stops; a usable changed source abandons the
stale attempt without restoring old values. Every awaited native result, including
failure/deferral, is followed by this guard. Native preservation/lifecycle failures
are still fatal even if the active source changed to another usable state.

A genuinely absent file family can be marked absent without creating a database.
If an existing/ambiguous database cannot be paired with a usable active source, an
installation without initialization provenance stops. A fresh initialization
with `initializing: true` may remain pending across restarts until ordinary
persistence creates a valid root; cleanup never manufactures one.
Unavailable bridges or failed metadata observations cannot bypass that distinction.
A database disappearing between a positive inventory and maintenance is not
accepted as verified absence.

Native `LIVE_SOURCE` produces a source conflict, preserving the row. The cleaner
checks the table after SQLite recovery and again under its database lock. A final
ordinary AsyncStorage root read also catches a queued late writer before the
marker. The existing importer is not duplicated or reset. Marker storage/read-back
occurs only after native success, restored ownership, source validation and logical
absence. A failed marker write leaves work retryable; a crash before persistence
cannot imply completion. A complete marker retains the fast path with no repeated
VACUUM or new full snapshot/file scan.

The supported Redux writer now uses MMKV; the historical importer is guarded by
the versioned key/migration record and only removes/imports its existing source
under the repaired rules. Audited non-Redux AsyncStorage writers do not create
legacy Redux `persist:root`. Downgrades, external database replacement/restore,
malicious rollback and arbitrary in-process execution are not added support cases.

## Ownership and fail-preserving access

A single process-wide `SerialExecutor` in the patched supplier is used by every
Java AsyncStorage module, maintenance, initialization and invalidation/close.
Queued writes before invalidation finish before that close; a later context reopens
through the same owner. A cleaner-only mutex would not provide this guarantee.
Blocking SQL runs on this worker, not the UI or JS thread.

Only unstarted maintenance queue entries can expire (5 seconds). A claimed/running
native operation retains ownership until it finishes; there is no JS timeout race
that releases an active SQLite connection. Native maintenance is cached once per
process, including deferral. A later process retries pending work. Concurrent JS
startup calls share the same promise.

The pinned supplier originally deleted the database on its second failed open,
deleted on version changes, used Android's deleting corruption handler, and could
copy a scoped Expo database before opening. The patch removes those paths:

- No delete-and-recreate retry or destructive upgrade fallback.
- An explicit non-deleting corruption callback; failed opens remain failed.
- Strict metadata inventory before opening; an existing uninitialized/unsupported
  file is not passed through a creating `onCreate` repair.
- No constructor-triggered Expo copy/delete. Such files are preserved and refused.
- Ordinary explicit `clear()` remains an ordinary API; cleanup never invokes it or
  `clearAndCloseDatabase()`, and the latter's deletion-on-error fallback is removed.
- Query/statement/open errors exposed by the provider use fixed messages; the
  cleanup bridge returns only fixed enum strings, never causes, SQL, values or paths.

Unsupported initial locking/journal states are left unchanged. Once configuration
has begun, restoration and provider reopen are verified; a failed safe lifecycle
is a preservation stop, not routine deferral.

## SQL sequence and completion postconditions

The operation has no SQL mutation that deletes a live key. Under the provider queue:

1. Inventory the fixed file family and confirm the actual database path. Refuse an
   active transaction or unsupported process/backend/settings.
2. Read journal/sync/security/timeout settings. Configure bounded busy waiting,
   `journal_size_limit=0`, and at least FULL synchronization for maintenance.
3. Validate schema/integrity and logical root absence; compute the baseline live
   key/value digest **before checkpoint/mode changes**, not merely before VACUUM.
4. If WAL is active, consume/check every `wal_checkpoint(TRUNCATE)` result column:
   busy must be zero and both remaining-frame counts zero. Disable the WAL pool,
   then require `journal_mode=DELETE` and reapply/check settings on its primary
   connection. Confirm FULL-or-stronger synchronization before rebuilding.
5. Require `locking_mode=EXCLUSIVE`; use `BEGIN EXCLUSIVE; COMMIT` to retain the
   connection's lock. VACUUM itself runs outside an application-held transaction.
6. Recheck schema, integrity, root absence and the baseline digest. Verify
   `secure_delete=ON`, then execute full `VACUUM` on the original database.
7. Consume `integrity_check`, compare live contents, and require physical main-file
   length to equal checked `page_count * page_size`. Neither logical row absence,
   smaller size nor a zero freelist is treated as sufficient erasure proof.
8. Restore settings/normal locking, restore the prior journal policy, verify data,
   close the owned connection, inspect sidecars, reopen through the patched normal
   supplier, and verify integrity/data and sidecars again. WAL and rollback journal
   must be absent or zero length. SHM is inventoried/readable but never manually
   removed: it is SQLite's index/locking structure, not a payload log.
9. Only then return `CLEANED`; the JS active-state/late-source checks and marker
   verification still follow.

The comparison streams sorted UTF-8 key/value bytes in 64 KiB chunks with separate
64-bit lengths and a final row count into SHA-256. It does not concatenate ambiguous
strings, compare counts alone, normalize values, expose digests, or replay a JS dump.
The tests independently compare the full live map and exact fixture values after
reopening. Internal rowids may change, as allowed.

An important reproduced detail: with an exclusive lock, SQLite can retain a
rollback journal even when the requested mode is DELETE. Merely running VACUUM
left a 512 KiB journal in the prototype. The source's `zeroJournalHdr` path uses a
zero journal-size limit to truncate and sync the finalized journal. The production
sequence sets/checks that limit and verifies remaining files. A mutant that skips
this and its checks is rejected by the raw-file oracle. No journal is unlinked or
truncated by application file APIs, and no journaling mode is set to OFF/MEMORY by
production cleanup.

SQLite rebuilds the database from live records; the absent root's deleted versions,
freeblock/overflow fragments and indexes are not copied as live content. The checked
main length prevents accepting an old physical tail. WAL truncation and rollback
journal finalization remove retained recovery copies through the engine. SQLite's
own temporary rebuild is permitted; no app-managed plaintext export is introduced.
Temporary files are engine-owned/deleted-on-close (or memory-backed, depending on
SQLite configuration). Unlinked blocks, flash remnants and external snapshots are
outside this readable-file guarantee. Unrelated live values are retained even when
they resemble encrypted content; ciphertext searching is not a production policy.

References: [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html),
[SQLite PRAGMAs](https://www.sqlite.org/pragma.html#pragma_journal_size_limit),
[AOSP SQLite 3.39.2 source](https://android.googlesource.com/platform/external/sqlite/+/android-14.0.0_r1/dist/sqlite3.c),
and the inspected Android SQLite connection/open-helper/error-handler sources.
The source/provenance inventory records their hashes and exact package/tag inputs.

## Bounds, failure policy and measurements

There is one maintenance attempt per process, no busy retry loop or repeated-growth
strategy, and no arbitrary small database-size eligibility cap. The app's pinned
ordinary size policy is 6 MiB; existing larger databases are not silently truncated
by this cleanup. Digest work scales with live bytes/rows, integrity checks and
VACUUM with database size. Java comparison buffers are bounded chunks; total memory
also includes SQLite's page cache, largest-row processing and temporary rebuild,
so it is not claimed to be only 64 KiB. SQLite may need up to roughly twice the
original file size in additional disk space. This is not zero-space maintenance.

The 5-second queue deadline is separate from SQLite's busy waits. The maintenance
connection is configured for 1-second busy waits; initial/open/WAL-pool operations
also retain Android's bounded connection behavior. No hard wall-clock promise is
made for stalled filesystem I/O, and ownership is never released while SQL runs.

Busy, permissions, space, unsupported shape/mode, bridge availability and unresolved
sidecars can defer only with a verified usable independent vault. Missing/invalid
active state, source conflicts, mismatched data and unsafe ownership restoration
stop startup. Corrupt/ambiguous legacy files are preserved; deferral does not assert
that unrelated contents in an already corrupt database are usable.

Measured cases include a 2.4 MiB live value, whole-file sizes over 2 MiB, and 16 KiB
SQLite pages. Results retain operation duration, sampled named-file peak, sampled
volume free-space drop, and Java/native allocation peaks. Samples are every 2 ms,
include the instrumentation process, can miss short peaks, and can include volume
noise. They are measurements, not universal memory/time/space guarantees. The
multi-gigabyte reserve in the ENOSPC test is deliberate test pressure, not cleanup
allocation; it is removed afterward.

## Evidence and reproducibility

See `test/vault/rkstorage/README.md` for complete build/run commands, native driver,
Hermes entry, fault interposer, negative controls and fixture provenance. Safe
aggregate results and source hashes are retained under
`test/vault/rkstorage/results/`. Full logs and raw synthetic captures for this run
are in `/private/tmp/bip02-rkstorage-up13n4jr`.

Baseline at the exact starting commit: 141 Jest suites passed, 2,590 tests passed
and 2 skipped. TypeScript emitted 2,024 diagnostics; ESLint reported 632 errors and
697 warnings. Baseline Prettier passed. The prior native build evidence was retained;
a separate pre-edit Android build was not rerun for this follow-up.

Post-change repository Jest: 141 suites, 2,625 passed and 2 existing skips. The six
focused suites passed 287 tests. TypeScript still has 2,024 diagnostics with no
introduced normalized diagnostics. Final formatting, lint comparison, native and
Hermes run details are recorded in the machine-readable results alongside this
report; existing repository type/lint failures are not described as passing.

The native tests use real Android SQLite and production helper/provider/bridge.
They distinguish deliberately vulnerable `secure_delete=OFF` histories from each
platform's measured default (ON in the tested images). They cover multiple root
versions, Unicode, empty strings, large and non-JSON values, exact unrelated-data
preservation, supported historical journal modes, missing/orphan/corrupt inputs,
busy/queued/lifecycle cases, recovered hot journals, repeated failures and retries,
and process termination before/during/after SQL and finalization. Raw main/sidecar
scans include actual CBC decryptability, escaped representations, known fragments,
bare EDDSA and opaque EDDSA password material.

The syscall tests inject real EIO at SQLite journal writes/sync/truncation and main
writes during checkpoint, limited to the disposable RKStorage file family. Each
injection must actually fire; failures remain incomplete, exact live data survives,
and a fresh-process retry completes. The disk-full case reserves available space
immediately before VACUUM and verifies both allocation and subsequent recovery.
These are distinct from modeled JS/platform failures and deliberate phase exceptions.

Negative controls deliberately omit VACUUM, omit sidecar finalization/checks,
delete a live root, and mark completion prematurely. The initial sidecar oracle
was found insufficient because a later ordinary write could clean the journal;
that write was removed from the raw-scan window and the mutant then failed as
required. Initial real-runtime fixture adaptations were also corrected to retain
nested CBC and historical `_persist` serialization; production decode strictness
was not relaxed to accommodate invalid fixtures.

## Final validation results

| Check                                     | Actual result                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Full repository Jest                      | 141 suites; 2,625 passed, 2 skipped; exit 0                                                                                  |
| Six focused suites                        | 287 passed; exit 0                                                                                                           |
| Android native matrix                     | 44 cases on API 32 / SQLite 3.32.2 and 44 on API 34 / SQLite 3.39.2; both exit 0                                             |
| Real Hermes startup                       | Four scenarios, three launches each, on both APIs: 24 launches; both drivers exit 0                                          |
| Real SQLite syscall faults                | Four EIO cases (write, sync, truncate, checkpoint), each with exact preservation, cold recovery and successful retry; exit 0 |
| Negative controls                         | Skipped VACUUM, skipped sidecar handling, live-row deletion and premature marker all rejected by assertions                  |
| Android app/test build                    | Normal build exit 0; no interposer or wrapper in normal APK                                                                  |
| iOS production JS bundle                  | Exit 0; no new iOS native module required                                                                                    |
| TypeScript                                | Exit 2, same 2,024 diagnostics; zero introduced normalized diagnostics                                                       |
| Repository ESLint                         | Exit 1, same 632 errors / 697 warnings                                                                                       |
| Changed-source/script lint and formatting | Pass; no rules disabled                                                                                                      |
| Dependency patch                          | Clean package application exit 0; byte-for-byte match with installed native sources                                          |

The Hermes scenarios are legacy primary, old-base-complete/new-marker-absent,
AsyncStorage-only wallet, and unfinished import with matching empty primary/backup.
They verify exact restored wallet contents under the actual versioned key,
unrelated AsyncStorage data, legacy-entry retirement, raw decryptability counts,
and a subsequent completed launch with zero native cleanup calls. The old-complete
case also verifies unchanged primary ciphertext and vault-key reuse.

Representative **2,400,000-byte live-value** measurements from the final native
runs are below. Byte columns are sampled process/file measures, not pure algorithm
allocation; the harness itself retains expected values for independent comparison.

| Environment | SQLite | Operation duration | Peak named DB/sidecar bytes | Sampled free-space drop bytes | Peak native allocated bytes | Peak Java used bytes |
| ----------- | ------ | ------------------ | --------------------------- | ----------------------------- | --------------------------- | -------------------- |
| Android 32  | 3.32.2 | 203 ms             | 4847336                     | 2428928                       | 26466480                    | 100350368            |
| Android 34  | 3.39.2 | 216 ms             | 4847336                     | 2428928                       | 22996176                    | 96146656             |

The preserved main file in both representative cases was 2,420,736 bytes; the
rollback journal was zero length and WAL absent at success. Full-disk reserve
allocation is excluded from this resource table. Timed kill reports show the last
observed phase before process termination; they are not field failure-rate or
hardware-power-loss estimates.

The Android 12L rerun waited for application initialization after one earlier
instrumentation attempt reached a native loader before `Application.onCreate`
completed. Its data-preservation assertion had already passed; the test runner was
corrected instead of counting the interrupted run as a pass.

## Remaining release gates and scope of claims

- Physical phones, hardware-backed Keystore behavior, and 16 KiB **OS-page** Android
  environments have not been certified here. The tested emulators have 4 KiB OS
  pages; a 16 KiB SQLite database-page case is a separate result.
- Instrumented Hermes verifies actual native stores/startup migration and exact
  wallet restoration. It is not a manual wallet-UI/terms/background-unlock test or
  a hardware power-cut campaign. iOS takes its original path and requires no Android
  module; its unit coverage and JavaScript bundle are checked, not a new iOS native
  device certification.
- Unsupported/scoped/orphan/corrupt states stay pending or stop safely. No generic
  repair, database replacement, source merge or recovery UI was added.
- The two existing MMKV native-compaction interruption residuals remain unchanged:
  the earlier root write may have an older/absent recovery source, and scrub-phase
  recovery can depend on its current cache backup. This work does not accept those
  risks or use them to excuse SQLite data loss. Explicit owner acceptance and the
  earlier full-app/device release gates still apply.
- Successful completion addresses the scoped, readable historical RKStorage files.
  Pending installations retain the residual risk. This is not hardware secure
  erasure, protection from arbitrary app execution/memory or secure-storage
  compromise, or protection for previously extracted data/external snapshots.

## Final working-tree inventory

At validation completion, HEAD was `f307e0aec2c95d71905d8188bddf37b6cc5c5c3e`, with
nothing staged or committed. The inventory records that pre-commit state; the user
subsequently requested a local commit.
Seven existing files changed: this report's historical companion
`BIP-02-REPAIR-REPORT.md`, `android/app/build.gradle`, `MainApplication.kt`,
`src/store/index.ts`, `src/store/vault-diagnostics.ts`,
`src/store/vault-migration.ts`, and `src/store/vault-migration.spec.ts`.

The 29 added files consist of this report, the three production RKStorage Java
classes, `src/store/vault-rkstorage.ts`, the pinned dependency patch, three Android
instrumentation files, eight reproduction/test-input files under
`test/vault/rkstorage`, and twelve safe result/inventory JSON files. Exact paths,
source hashes, APK hashes, and final status are in
`test/vault/rkstorage/results/final-inventory.json`.

The final review checked completion/deferral/error paths, serialized provider
ownership, absence/corruption distinctions, live-root checks, journal cleanup,
source guards after failed awaits, unsupported initial settings, marker ordering,
and absence of generic SQL/path/deletion bridge methods. Thirteen pre-existing
untracked files were verified unchanged. No real secrets, dependency trees,
compiled binaries or generated build products were added to the working-tree
changes. The normal APK contains neither the test interposer nor `wrap.sh`.
The two disposable emulators were shut down after verification.
