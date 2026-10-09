# BIP-02 simple MVP, revision 2

Local implementation against `ad06764ccb9ba28e66e741d5151c9d7f31aa5787`.
Codec, key and sanitized reporting reuse is from
`98f74ed940fa52767dba8889c6764988c1dd3791`. The historical fixture and its
provenance are retained in `test/vault/fixtures`. No reference coordinator,
scrubber, SQLite cleaner, provider patch or receipt machinery is included.

## Storage and handover

Normal consumers use `bitpay.wallet.v2`; ordinary backups use the cache
directory `bitpay/redux-v2/`, retaining main, `.bak` and writer `.tmp` roles.
The separate `bitpay.wallet.transfer.v2` instance has one bounded `transfer`
record with `preparing`, `active` and `retired` phases. It carries compiled slot
identities and preparation ownership, never arbitrary filesystem paths.

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
snapshot that cannot decode stops rather than searching by decryption. Failed
required reads are errors. The old import thunk only satisfies its existing UI
completion gate after activation; it neither copies rows nor restarts the app.

Each primary/main/bak replacement is checked for exact destination bytes and
complete decoded equality against its own source. Originals stay untouched
until verified activation. No checkpoint or fresh backup is created. Preparation
can retry only its owned destinations. An active record never reimports legacy
sources, even when all modern data disappears. Modern loading uses only the
verified random Keychain key and authenticated modern envelopes.

## Retirement boundary

MMKV 3.3.1's `MmkvHostObject` destructor syncs and clears its cache; it does not
close the underlying instance. The small `react-native-mmkv+3.3.1.patch` adds a
process-wide atomic guard shared across native module/React-context recreation.
Any default-instance construction marks it opened, including a failed attempt.
The retirement claim succeeds only before any such access and permanently seals
subsequent default-instance construction for that process. It is not a close API.

Preparation opens the old instance read-only, so its file retirement normally
waits for a cold launch. Before either unlink, the runtime verifies the recorded
data/CRC identities without opening MMKV. A partial pair removal can retry from
the active control record. Unknown old keys prevent whole-instance removal.
Unrelated files and instances are left alone. Failed independent cleanup reports
pending status and cannot revoke modern access. The old credential is removed
and checked only after every covered source obligation is absent.

## Executable checks and outcome mapping

| Contract | Executable coverage |
| --- | --- |
| Historical CBC, nested fields, 14.32 EDDSA/password and GCM contexts | `vault-codec.spec.ts`; actual `encryptSpecificFields` and Redux Persist reader |
| Complete payload, unknown fields, own properties, LOG/cache preservation | `vault-codec.spec.ts`; boolean-only equality assertions |
| Source history, separate backup snapshots, owned output, activation interruptions | `vault-transfer.spec.ts` |
| Device-ID candidate after old-key rejection, modern key creation/read-back/backend failures | `vault-runtime.spec.ts` |
| No replay after activation, total modern-data loss, unresolved material and partial retirement | `vault-transfer.spec.ts`, `vault-runtime.spec.ts` |
| Preparation gates, ordinary empty result, buffered logs | `vault-storage.spec.ts`, `log/initLogs.spec.ts` |
| Ordinary backup rotation, triggers/filter semantics and JSON selection | Existing `backup/fs-backup.spec.ts` with modern paths and activated setup |
| Old importer disabled | Existing importer suite's obsolete copying tests replaced by committed-gate/no-I/O assertions |
| Modern-only transform wiring | Existing transform call-signature assertions now include the strict argument; base crypto compatibility tests retained |
| Native process guard | `test/vault/legacy-instance-guard.cpp`; actual patched header, distinct process invocations |
| Real MMKV native lifecycle | `test/vault/native-entry.js`; device probe described below, not covered by mocks |

The old reference's receipt, in-place scrub, SQLite and broad state-campaign tests
do not describe this architecture and were not imported. Its relevant historical
compatibility fixtures are exercised directly. No dependency or lockfile changes
are required. Normal postinstall applies the narrowly scoped MMKV patch.

Compile the portable native guard check from the repository root:

```sh
clang++ -std=c++17 -Wall -Wextra -Werror test/vault/legacy-instance-guard.cpp -o /tmp/bip02-guard
/tmp/bip02-guard opened
/tmp/bip02-guard cold
```

For native integration, use a dedicated synthetic test build whose Metro/bundle
entry is `test/vault/native-entry.js`, retaining the app's registered component
name. The probe uses its own `CachesDirectoryPath/bip02-native-lifecycle-proof`
directory. Follow its displayed sequence: initial open, JavaScript reload with
the process alive, native process termination/relaunch, then another termination
after the first unlink. The final stage checks cold reopen, partial deletion,
rejected old-instance recreation, and preserved modern/unrelated files. Repeat
on both platforms. This probe is intentionally outside ordinary application UI.
It does not establish packaged-upgrade, signing, low-space or performance gates.

## Limitations and release gates

Retained undecodable backups, unresolved AsyncStorage rows, old temporary files
and unknown old keys may keep retirement pending indefinitely. No Android SQLite
residual-byte cleanup or stock-provider patch is included, and deleting a
credential does not secure device-ID-decryptable residue. No flash-erasure claim
is made. Old standalone logs are dropped only with eligible instance retirement.

Ordinary JSON-readable backups can fail later in decryption without selecting a
different snapshot. With valid control/key state and no usable modern data, the
ordinary empty-app behavior remains. Missing modern keys are errors. No downgrade
to a binary unable to read the activated layout is supported.

Implementation submission, native lifecycle validation and release approval are
separate states. Native builds, actual lifecycle checks on both platforms, signed
in-place upgrades on physical iPhone and Android, interruption/low-space exercises,
normal signing/recovery and representative duration/disk/memory measurements
remain release gates. The external execution report records actual results and
unrun checks for this candidate; mocks and a generated patch are not release approval.
