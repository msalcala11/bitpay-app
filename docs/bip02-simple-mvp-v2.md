# BIP-02 vault migration: simple MVP

## Storage and ordinary access

Wallet persistence uses MMKV `bitpay.wallet.v2` and a verified random Keychain
key in `bitpay-app-vault-key-v1`. Ordinary readers accept authenticated modern
GCM envelopes and designated public reducer JSON, without device-ID or legacy
fallback. The codec's independent traversal and validation share only field names,
contexts and primitives with ordinary transforms. A missing gift-card invoice ID
retains `.undefined.` in its authenticated context.

Modern backups are `<caches>/bitpay/redux-v2/persist-root.json`, with `.bak` and
writer `.tmp` siblings. Transfer and ordinary backup code share these paths.
Legacy backups remain under `<caches>/bitpay/redux/`; legacy credentials use
`bitpay-app-encryption-key`. Only the vault runtime opens the default MMKV instance.

MMKV `bitpay.wallet.transfer.v2` holds one bounded version-3 `transfer` record:
layout, phase (`preparing`, `active`, `retired`), ownership, fixed copy map and
Boolean permissions per old location. No source hashes/arbitrary paths are stored.
Other versions stop without replacement keys; the app never resets data.

Activation gates ordinary reads/writes, restore write-back and backups; modern
wallet storage holds at most `persist:root` beforehand. Transfer preserves complete
payloads, including unknown fields and `LOG`, without ordinary application filters.
Write errors are reported and `flushPersistor()` rejects. Read/decryption/rehydration
failures pause persistence; REHYDRATE checks for missing secrets. A thrown primary
read with no restored backup rejects with that error; clean absence is unchanged.

## Preparation, source selection and restart

Source selection follows `APP.migrationMMKVStorageComplete`: established MMKV wins
over leftover AsyncStorage; pending AsyncStorage transfers directly to modern MMKV.
Conflicting history stops; exact duplicated bytes can establish an interrupted copy.

A missing MMKV root uses old main-before-bak JSON selection. A selected snapshot
that cannot decode stops rather than searching by decryption. A rejected primary
observation gets exactly one immediate re-read, then the same backup fallback;
without a usable fallback startup stops instead of opening empty. Required
AsyncStorage/control read failures remain errors; failed key-list inspection
preserves the old pair even with a readable wallet.

Preparation opens the legacy instance writable, so the native library may repair
or discard data before activation. An empty native answer requires bounded file
evidence: every applicable current, alternate-header and last-confirmed loading
bound must be below the five bytes required for a live entry in the pinned MMKV
decoder. This proves logical emptiness, not successful native loading. Missing,
short or unreadable evidence, or any larger applicable bound, takes the existing
single retry and backup fallback/stop path, granting neither old-pair permission.
This conservatively rejects some deletion-emptied journals, unused larger bounds
and larger slices that decode to no live entries; no further parsing is attempted.

Whole-snapshot legacy key candidates, including the device ID, serve only legacy
decoding. Modern keys require backend validation/read-back; destinations must be
absent before preparation ownership is claimed. Required copies receive immediate
and final exact-byte/decoded-payload verification before the saved/read-back record
becomes active. Unexpected modern data stops preparation. No checkpoint, fresh
backup, source-content comparison or second inventory is added.

A retry replans from current sources with the existing verified modern key.
Before replacing the preparing record, a source-role guard rejects loss of the
selected wallet or a move down MMKV → main → bak; AsyncStorage is not a backup
rank. Such a stop preserves the prior record, unfinished outputs and key.
After the replacement plan is saved and read back, obsolete owned main/bak outputs
with null sources may be removed using presence, unlink and verified absence;
cleanup does not require readable contents. The unfinished root is never removed
or used for recovery. Repeated retries can remain stopped.

## Wallet secrets and session logs

`WALLET_SECRETS` is a whole-encrypted reducer, without nested encryption or a
plaintext-allowlist entry. The codec accepts both upstream layouts: the first
flush has populated secrets with `WALLET.secretsMigrated=false` and inline secrets;
the second sets the flag and removes inline secrets. Successful bootstrap runs
secrets rehydration. Historical/intermediate states finish the two-flush move;
completed states restore key properties, credential secrets, TSS data and pending
joiner sessions. Backups resume after flagged writer output is observed through
its two JSON serialization layers.

Session logs, production opt-in and the one-time cleanup marker share the dedicated
MMKV instance `bitpay.session-logs.v1`. Early preference reads open neither wallet
nor default storage. Appending, reading, pruning, clearing and preference changes
use that instance; preparation entries remain buffered until activation. No old
standalone logs or preferences are imported. The exact legacy names
`sessionLogsProdEnabled` and `sessionLogsCleanupDone` are recognized; other unknown
legacy names still prevent whole-instance removal.

## Retained legacy data and disabled retirement

`LEGACY_RETIREMENT_ENABLED = false` stops retirement before legacy existence scans,
native claims, removal or cleanup reporting. Old MMKV data/logs, backups/temp,
AsyncStorage and credentials remain under their old weak key. Modern wallet/key/
password changes do not update or secure these stale copies. Active records validate
the modern key and never re-import legacy data, even after total modern-data loss.
There is no automatic fallback/rollback; the hold cannot restore retired data.

Enabled retirement uses saved permissions on a later invocation starting active,
never the preparing invocation. Retry/reload can qualify, not only a cold launch.
MMKV pair removal also needs the native process guard: the patch marks every default
construction (including failure), allows a claim only before any, and seals later
opens. It is not a close API; host-object destruction does not close the instance.

Enabled cleanup checks absence after each deletion and removes/verifies the old
credential only after all covered obligations are absent. Unknown keys, unresolved
sources and non-permitted late arrivals can keep it pending. A physically absent
source grants no later deletion permission. The exact old writer temp is the sole
unconditional discard exception after activation when enabled. Modern temps and
unrelated data are untouched. Cleanup failure cannot revoke modern access.
Enabling retirement requires an owner decision and physical-device validation.

## Executable checks (store paths relative to `src/store/`)

| Contract | Tests |
| --- | --- |
| Historical CBC, fixed modern vectors, literal fields/contexts, complete conversion | `vault-codec.spec.ts`, `vault-compatibility.spec.ts`, `transforms/encrypt.spec.ts` |
| Independent primitives, exact-key transform dispatch, strict modern arguments | `transforms/persist-encryption.spec.ts`, `transforms/transforms.spec.ts` |
| Restart, source guard, copy verification, activation and retirement hold/guard | `vault-transfer.spec.ts`, `vault-runtime.spec.ts` |
| Strict MMKV reads and required caller retry behavior | `vault-runtime-read.spec.ts` |
| Both upstream secrets layouts, historical lifecycle and real writer/reader | `vault-upstream.spec.ts` |
| Activation gates, paused persistence, sanitized diagnostics and alerts | `vault-storage.spec.ts`, `index.spec.ts`, `persistor.spec.ts`, `vault-diagnostics.spec.ts`, `vault-startup-alert.spec.ts` |
| Backup rotation, measurement, suppression and cleanup/resume cache behavior | `backup/fs-backup.spec.ts` |
| Buffered/dedicated logs and disabled old importer | `log/initLogs.spec.ts`, `log/log.reducer.spec.ts`, `wallet/effects/import/import.spec.ts`, `src/utils/sessionLogs.spec.ts` |
| Native guard and real MMKV lifecycle | `test/vault/legacy-instance-guard.cpp`, `test/vault/native-entry.js` |

Run `yarn test:ci`, `yarn validate`, `yarn eslint --ext .js,.jsx,.ts,.tsx src/`, and
`yarn tsc --noEmit --skipLibCheck`. `validate` filters TypeScript codes; inspect the
unfiltered result too. Normal postinstall applies the MMKV and RNFS patches.

Compile and run the portable native guard from the repository root:

```sh
clang++ -std=c++17 -Wall -Wextra -Werror test/vault/legacy-instance-guard.cpp -o /tmp/bip02-guard
/tmp/bip02-guard opened
/tmp/bip02-guard cold
```

For native integration, use a dedicated synthetic test build with bundle/Metro
entry `test/vault/native-entry.js`, retaining the app's registered component name.
It tests the production empty-read predicate through RNFS, then displays: initial
open; JavaScript reload in the same process; process termination/relaunch; another
termination after the first unlink. The final stage checks cold reopen, partial
deletion, rejected old-instance recreation and preserved modern/unrelated files.
Repeat on both platforms. This direct-unlink probe does not test the production
retirement hold or packaged upgrade continuity.

## Limitations and release gates

Native builds/lifecycle checks, signed in-place upgrades on physical iPhone and
Android, interruption/low-space exercises, signing/recovery behavior and
representative duration/disk/memory measurements remain rollout gates. Mocked
storage/native probes do not establish these guarantees. Internal old → new → old →
new continuity requires identified compatible older binaries, matching installation/
signing/access groups and their actual distribution route, with intact legacy data
and synthetic unfunded wallets. Clearing data or uninstalling is not continuity.
Modern-only changes must survive; legacy-only changes must never be re-imported.
Public downgrade remains unsupported.

JSON-readable backups can fail decryption without trying another snapshot. Valid
control/key state without modern data retains empty-app behavior; missing keys stop.
There is no unfinished-output recovery, rollback sync, Android SQLite residual-byte
cleanup or stock provider patch. Credential removal cannot secure device-ID-readable
residue; no flash-erasure guarantee is made.
