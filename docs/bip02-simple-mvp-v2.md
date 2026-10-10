# BIP-02 simple MVP, revision 2

Local implementation against `ad06764ccb9ba28e66e741d5151c9d7f31aa5787`.
Codec, key and sanitized reporting reuse is from
`98f74ed940fa52767dba8889c6764988c1dd3791`. The historical fixture and its
provenance are retained in `test/vault/fixtures`. No reference coordinator,
scrubber, SQLite cleaner, provider patch or receipt machinery is included.

Decision 12's first-release hold is based on the pinned `13b6110` tree, not
current upstream `develop`. Integration into the eventual shipping branch,
including the seven pre-MVP Encryption commits, is a separate task. This change
does not validate those commits in a distributed application or authorize any
rebase, merge, compatibility rewrite, or remigration mechanism.

The preceding native-reader repair implements decisions 8–11. The approved RNFS
2.20.0
patch changes only the bounded reader's length and position arguments from
integer pointers to scalar integers. The rebuilt iOS application and Android
test carrier passed 17 real-file assertions and the warm/reload/cold lifecycle
sequence; its external execution evidence was inspected for this continuation.
Those earlier guard demonstrations directly remove synthetic files and do not
prove that the production retirement hold is respected. The exact metadata-version-3
rejection cases are covered in both the
runtime suite and native integration table. The external report preserves the
original failures, successful retries, binary identities and remaining gates.

Local iOS validation uses decision 11's checksum-only Podfile.lock accommodation
with the normal manifest check enabled. That adjustment is excluded from this
repair commit. The permanent CocoaPods baseline correction still needs a team
owner and must be resolved in the shipping checkout; this is not rollout approval.
A correction on another upstream branch does not change this pinned checkout.

## Storage and handover

Normal consumers use `bitpay.wallet.v2`; ordinary backups use the cache
directory `bitpay/redux-v2/`, retaining main, `.bak` and writer `.tmp` roles.
The separate `bitpay.wallet.transfer.v2` instance has one bounded `transfer`
record with `preparing`, `active` and `retired` phases. The correction uses format
version 3, with a fixed copy map, preparation ownership and one Boolean deletion
permission per known old location. It stores no source hashes or arbitrary paths.
All version-2 records from internal build `34971a0` are rejected in every phase,
without reset, replacement keys or migration. Operators must reset internal test
devices themselves or seed them from a released build; the app never resets them.

Before activation, ordinary root reads/writes, restore writes and backups are
gated, and preparation logs remain in memory. Standalone old `persist:logs` is
not imported. All fields inside transferred roots, including `LOG`, survive the
pure converter. Ordinary application transforms and backup filters still apply
to later application operations; those filters never run during transfer.

Source selection uses the existing `APP.migrationMMKVStorageComplete` history.
Established MMKV wins over a leftover AsyncStorage row. A pending AsyncStorage
root goes directly to modern MMKV. Conflicting history stops without deleting
inputs. Exact duplicated bytes can establish an interrupted copy. When the
MMKV root is absent, old backups use main-before-bak JSON selection; a selected
snapshot that cannot decode stops rather than searching by decryption. A rejected
primary observation gets exactly one immediate re-read; if both fail, the same
main/bak fallback applies and the old MMKV files are not deletable. With no usable
fallback, startup stops rather than opening empty. Required AsyncStorage and
control-record failures remain errors. Failed key-list inspection also preserves
the old instance even when its wallet was readable. The old import thunk only satisfies its existing UI
completion gate after activation; it neither copies rows nor restarts the app.

Each primary/main/bak replacement is checked for exact destination bytes and
complete decoded equality against its own source. Application code leaves originals
untouched until verified activation; decision 9 permits the pinned library's own
writable-open repair or discard. No checkpoint or fresh backup is created. Preparation
replans from current sources on every retry with the existing verified key.
Before saving a replacement plan, a source-role guard rejects losing the selected
wallet or moving down MMKV → main → bak; AsyncStorage is not a backup rank. The
previous record and every unfinished output stay unchanged on that stop, including
when the unfinished modern root is the only wallet copy left. Repeated attempts
can remain stopped; no recovery from unfinished output is added. After a valid
replacement plan is saved/read back, only obsolete owned main/bak outputs may be
removed, with absence verification. An unfinished root is never cleared. There is
no second source inventory; immediate and final destination verification remain.
An active record never reimports legacy
sources, even when all modern data disappears. Modern loading uses only the
verified random Keychain key and authenticated modern envelopes.

## First-release retirement hold

`vault-retirement-policy.ts` exports the build-fixed
`LEGACY_RETIREMENT_ENABLED = false`. Conversion and verified activation run as
before, but `retire()` returns before any legacy existence scan, native claim,
removal or pending callback. It emits no informational, failure, pending or
completed-retirement message for the hold. A successful migration leaves the
version-3 record active with its original ownership, copy map and deletion
permissions. Later active launches validate the modern key and use modern data
without opening or inventorying legacy sources or rewriting that record.
Already-retired records remain retired; disabling cleanup cannot undo deletion
performed by an earlier internal build.

The old MMKV wallet and standalone logs, old main/bak/temp files, AsyncStorage
row and old credential remain. Their weak-key copies stay exposed under the
original threat model: this first release is not BIP-02 completion. Existing
Android residual and unresolved-source limitations remain open. Holding
application-driven deletion reduces that source of irreversible loss; it does
not prevent decision 9's ordinary native repair/discard before activation.

Retained data is a stale snapshot, not an automatic fallback or synchronized
rollback. It lacks modern-only wallets or changes made after handover. Legacy
edits are never imported into an active modern layout, including after total
modern-data loss. Missing modern keys still stop; valid-key ordinary empty-app
behavior is unchanged. No nonce, counter, replay route or older-build detector
is implemented or prepared.

## Enabled retirement boundary — later release only

A later owner decision and physical-device validation are required before enabling
retirement. Tests select the enabled policy through module isolation; the shipped
constant remains false. Already-active installations use their saved permissions
without another inventory or conversion. Users who skip the first release still
perform migration and cleanup in the same enabled build, subject to the existing
native guard; no per-install waiting period is introduced.

MMKV 3.3.1's `MmkvHostObject` destructor syncs and clears its cache; it does not
close the underlying instance. The small `react-native-mmkv+3.3.1.patch` adds a
process-wide atomic guard shared across native module/React-context recreation.
Any default-instance construction marks it opened, including a failed attempt.
The retirement claim succeeds only before any such access and permanently seals
subsequent default-instance construction for that process. It is not a close API.

Preparation still opens the old instance writable. When retirement is enabled,
file removal normally waits for a cold launch. Before either unlink, the unchanged native guard must
permit removal. Pending retirement checks existence only, without rereading or
hashing contents; a changed permitted original is still disposable. A partial
pair removal can retry from
the active control record. Unknown old keys prevent whole-instance removal.
An inspected standalone-log-only instance remains disposable. An empty native
answer requires direct file evidence: every applicable current, alternate-header,
and last-confirmed loading bound must be below the five bytes required for any
live entry in the pinned decoder. This establishes logical emptiness, not native
load success. Missing/short/unreadable evidence or larger bounds use the existing
retry and fallback/stop path and grant neither old-pair deletion permission.
An existing pair proved logically empty remains disposable. Decision 11 accepts
conservative rejection of deletion-emptied journals with larger bounds, valid
empty current views with unused larger alternate/last-confirmed bounds, and
larger valid slices that decode to no live entries. These cases use the same
single retry and backup fallback, or stop without a usable backup. Their old
pair receives no deletion permission and its presence retains the old credential.
No further parsing or exceptions are added. A location
observed physically absent has no deletion permission if material later appears
there; unresolved or late-arriving present material keeps retirement pending. A
non-permitted location that is absent needs no removal. The exact old writer
`persist-root.json.tmp` is the sole unconditional discard exception after activation
when enabled,
even if it appears later; it is never a source or a fresh-install blocker. Modern
temps and unrelated files/instances are untouched. Each deletion is followed by
an absence check, and all required locations must be confirmed absent before
removing the old credential. Failed independent cleanup reports
pending status and cannot revoke modern access. The old credential is removed
and checked only after every covered source obligation is absent.

## Executable checks and outcome mapping

| Contract | Executable coverage |
| --- | --- |
| Historical CBC, nested fields, 14.32 EDDSA/password and GCM contexts | `vault-codec.spec.ts`; actual `encryptSpecificFields` and Redux Persist reader |
| Complete payload, unknown fields, own properties, LOG/cache preservation | `vault-codec.spec.ts`; boolean-only equality assertions |
| Restarted preparation, source-loss/lower-fallback preservation, separate snapshots, activation interruptions | `vault-transfer.spec.ts` |
| Device-ID candidate after old-key rejection, modern key creation/read-back/backend failures | `vault-runtime.spec.ts` |
| No replay after activation, total modern-data loss, unresolved material and partial retirement | `vault-transfer.spec.ts`, `vault-runtime.spec.ts` |
| Preparation gates, ordinary empty result, buffered logs | `vault-storage.spec.ts`, `log/initLogs.spec.ts` |
| Ordinary backup rotation, triggers/filter semantics and JSON selection | Existing `backup/fs-backup.spec.ts` with modern paths and activated setup |
| Old importer disabled | Existing importer suite's obsolete copying tests replaced by committed-gate/no-I/O assertions |
| Modern-only transform wiring | Existing transform call-signature assertions now include the strict argument; base crypto compatibility tests retained |
| Native process guard | `test/vault/legacy-instance-guard.cpp`; actual patched header, distinct process invocations |
| Real MMKV native lifecycle | `test/vault/native-entry.js`; device probe described below, not covered by mocks |
| Disabled first migration/cold launch, no cleanup warnings, saved-permission transition to an enabled build | `vault-transfer.spec.ts`, `vault-runtime.spec.ts`; real unmocked disabled policy plus isolated enabled tests |

Decision-12 native validation uses a temporary external test entry that calls the
actual production runtime with synthetic native storage and observes primitive
operations. First migration and cold launch are separate checks; the existing
direct-unlink guard probe is not repurposed as a production control. The external
report separates these runs from Jest models and earlier decision-11 evidence.
On fresh dedicated iOS/Android virtual installations, first migration retained
every seeded legacy source and credential after independent destination
verification; a cold process preserved the control/key and performed no legacy
operations or cleanup reporting. The driver independently checked retained files;
its fixture reads are not production-runtime reads. These are not older-build
installation or physical-device continuity results.

The old reference's receipt, in-place scrub, SQLite and broad state-campaign tests
do not describe this architecture and were not imported. Its relevant historical
compatibility fixtures are exercised directly. No dependency versions or committed
lockfiles change. Normal postinstall applies the MMKV guard and approved RNFS
bounded-read patches.

Compile the portable native guard check from the repository root:

```sh
clang++ -std=c++17 -Wall -Wextra -Werror test/vault/legacy-instance-guard.cpp -o /tmp/bip02-guard
/tmp/bip02-guard opened
/tmp/bip02-guard cold
```

For native integration, use a dedicated synthetic test build whose Metro/bundle
entry is `test/vault/native-entry.js`, retaining the app's registered component
name. The probe uses its own `CachesDirectoryPath/bip02-native-read-proof-decision11`
directory and tests the production predicate through RNFS before the lifecycle
sequence. Follow its displayed sequence: initial open, JavaScript reload with
the process alive, native process termination/relaunch, then another termination
after the first unlink. The final stage checks cold reopen, partial deletion,
rejected old-instance recreation, and preserved modern/unrelated files. Repeat
on both platforms. This probe is intentionally outside ordinary application UI.
It does not establish packaged-upgrade, signing, low-space or performance gates.

## Limitations and release gates

Internal old → new → same old → new continuity is limited to an identified,
compatible upstream build from before both the seven unmerged Encryption commits
and this migration, using its actual approved in-place distribution route and
synthetic unfunded data. A numerically older version, source tag, `ad06764`, or
intermediate BIP-02 build is not that evidence. Installation identity, signing
and access groups must remain compatible; uninstalling or clearing data is not a
continuity test. Start with an intact old layout, since the hold cannot recreate
what an earlier internal build removed.

The physical continuity sequence was not run: the owner reported the required
approved artifacts/device setup unavailable. TestFlight previous-build availability
and Android downgrade eligibility have not been established. No distributed
baseline is inferred from a tag. A lab reconstruction, if separately authorized,
would not be an unmodified released-artifact downgrade. Modern-only changes must
survive a real sequence, while legacy-only changes must never be reimported;
ordinary modern startup/log/backup writes must be distinguished from interference
by the old build. Later enabled deletion still applies only at already-permitted
locations plus the exact old temp exception; non-permitted late material remains.

When enabled, retained undecodable backups, unresolved AsyncStorage rows, late arrivals at
non-permitted locations and unknown old keys may keep retirement pending while
they exist. The exact old writer temp is disposable after activation only when
retirement is enabled. No Android SQLite
residual-byte cleanup or stock-provider patch is included, and deleting a
credential does not secure device-ID-decryptable residue. No flash-erasure claim
is made. Old standalone logs are dropped only with eligible instance retirement.

Ordinary JSON-readable backups can fail later in decryption without selecting a
different snapshot. With valid control/key state and no usable modern data, the
ordinary empty-app behavior remains. Missing modern keys are errors. Public
downgrade remains unsupported; the bounded internal continuity test above is
not a general rollback or synchronization guarantee.

Implementation submission, native lifecycle validation and release approval are
separate states. Native builds, actual lifecycle checks on both platforms, signed
in-place upgrades on physical iPhone and Android, interruption/low-space exercises,
normal signing/recovery and representative duration/disk/memory measurements
remain release gates. The external execution report records actual results and
unrun checks for this candidate; mocks and a generated patch are not release approval.
