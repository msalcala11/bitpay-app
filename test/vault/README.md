# BIP-02 repair verification

All keys in `fixtures/legacy-14.32.json` were generated offline for these tests.
They are public throwaway test data. Never fund or use them for a real wallet.
The runners report only booleans, counts, safe labels, and resource measurements.
Native `get` output is private IPC captured by the runner, never forwarded to logs.

## Repository regressions

Run from the application checkout, with its frozen dependencies:

```sh
yarn install --frozen-lockfile
yarn test:ci
npx jest src/store/vault-migration.spec.ts src/store/vault-scrub.spec.ts src/store/vault-diagnostics.spec.ts src/store/encryption-key.spec.ts src/store/transforms/transforms.spec.ts src/store/persistence-guard.spec.ts --runInBand --forceExit
npx tsc --noEmit
npx eslint . --ext .js,.jsx,.ts,.tsx
yarn prettier:check
npx eslint test/vault/*.cjs --env node --parser-options '{"ecmaVersion":2022,"sourceType":"script"}'
```

`forceExit` is confined to focused diagnostics because the existing suite leaks
worker handles. The required full suite runs with its unchanged command.
The CommonJS tools run on Node 22; the separate parser setting selects their
language version without disabling lint rules or altering the repository gate.

## Historical fixtures

`fixture-project/` is an isolated input manifest and archived serializer source,
not an application dependency change. Its lockfile comes from the supplied
review bundle. The `.source` file is historical data, kept outside application
compilation/lint. Its body is verbatim from `v.14.32.0`, with only the relative
`Network` import adjusted. The archived dependency patch is a fixture input,
not a patch of this repair.

Copy that small fixture project to a new scratch directory, then run there:

```sh
npm ci --ignore-scripts
patch -p1 < released-encrypt.patch
```

From the application checkout:

```sh
node test/vault/generate-legacy-fixtures.cjs /absolute/path/to/scratch-fixture-project
```

Generation uses `bitcore-wallet-client@10.10.0`, the archived field serializer,
and the patched `redux-persist-transform-encrypt@3.0.1` through real Redux Persist.
It produces fresh random test keys/salts, so regeneration changes fixture bytes;
the generated provenance file records the actual source and fixture hashes.
`passwordOperation` models the historical app-style `encrypt(password)` call.
`constructorPassword` is explicitly library-supported defensive coverage, not a
claim about a shipped app creation path. `whole` is a defensive whole-CBC layout.

## Native core adapter

Build outside the repository. `MMKV_CORE_DIR` must be the installed pinned 3.3.1
package's `MMKV/Core`. The test CMake wrapper establishes the target platform
before including the unchanged core's build file.

```sh
cmake -S test/vault -B /tmp/bip02-native-build -DMMKV_CORE_DIR="$PWD/node_modules/react-native-mmkv/MMKV/Core" -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/bip02-native-build -j2
node test/vault/run-native.cjs /tmp/bip02-native-build/bip02-native-api /tmp/bip02-native-cases
```

The runner loads the actual working-tree migration, encryption, strict file
helpers, and scrub planner. Platform boundaries are replaced: secure storage,
AsyncStorage, and the migration journal are in-memory; filesystem backups are
real scratch files; default MMKV operations use the real core in fresh processes.
The unchanged production `Network` enum is evaluated without unrelated app
configuration. Every native call reopens the actual files and closes/syncs on
exit. This is not a full mobile-app or real-Keychain/Keystore test.

`trim` performs `clearMemoryCache(); trim();`, exactly like the pinned wrapper.
The optional test-only `ftruncate` interposer rejects shrinking without editing
files. `RLIMIT_FSIZE` rejects a growth request; it does not model every disk-full
failure. There are no direct MMKV data/CRC edits in the tested migration.

Scans search complete CBC candidates within raw file/snapshot fragments and
attempt decryption with the synthetic fixture identifier. They also search the
known bare EDDSA key and opaque constructor-password EDDSA ciphertext. No matched
bytes or decrypted values are printed. The coverage argument in the report is
required in addition to scans; marker absence alone is not the security claim.

The deliberately red original-implementation control is:

```sh
node test/vault/run-native.cjs /tmp/bip02-native-build/bip02-native-api /tmp/bip02-native-baseline --baseline
```

It loads the unchanged migration from starting commit `04486e844...` in memory,
without editing the checkout. Expected exit: **1**, `rejected scrub lost primary`.
A green exploratory run is not substituted for this assertion.

## Actual Android 4 KiB core

Using the installed pinned NDK 27.1.12297006, configure the same test build with:

```sh
cmake -S test/vault -B /tmp/bip02-native-android -DMMKV_CORE_DIR="$PWD/node_modules/react-native-mmkv/MMKV/Core" -DCMAKE_TOOLCHAIN_FILE=/absolute/sdk/ndk/27.1.12297006/build/cmake/android.toolchain.cmake -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/bip02-native-android -j2
adb -s emulator-5584 shell mkdir -p /data/local/tmp/bip02-final-repair
adb -s emulator-5584 push /tmp/bip02-native-android/bip02-native-api /data/local/tmp/bip02-final-repair/native-api
adb -s emulator-5584 shell chmod 700 /data/local/tmp/bip02-final-repair/native-api
BIP02_ADB=/absolute/sdk/platform-tools/adb BIP02_ADB_SERIAL=emulator-5584 node test/vault/run-native.cjs /data/local/tmp/bip02-final-repair/native-api /tmp/bip02-android-cases
```

Use only a disposable test emulator; adjust its serial explicitly. The runner
creates new case directories under `/data/local/tmp/bip02-final-repair`.
Metadata comes from actual remote `stat`, and raw scans read the remote files.
Secure storage, journal, and cache boundaries remain host-controlled models.
This run uses a synthetic identifier, not the app's actual device identifier.
Those differences are release gates, not hidden equivalences.

## Inside-native kills and distinct recovery sources

```sh
node test/vault/run-native.cjs /tmp/bip02-native-build/bip02-native-api /tmp/bip02-native-kills --kills
```

`kill-one.py` signals only its own native child after an operation-start marker.
The adapter warms the dictionary and reads the input before that marker.
The root-write case asserts that the write needs compaction. The driver then
models process death for all remaining platform calls, restarts the production
migration, and asserts the exact recovered wallet properties against the actual
surviving source. It separately covers current, older, absent, and AsyncStorage
sources, plus scrub recovery with the current backup retained or purged.

The manifest contains requested delays, observed termination, recovered source,
key counts, exact-content assertion outcomes, and resource measurements.
A completed operation followed by termination must retain the full key set.
A timed kill may expose the explicitly documented native-compaction residual.
These schedules are not production failure rates, and passing scenario assertions
does not mean that the deliberately demonstrated data loss is fixed or accepted.

`results/` contains the concise evidence retained for this working-tree review.
Do not copy dependency directories, native binaries, bundles, or raw MMKV files
into this directory. Full temporary logs for this run were under
`/private/tmp/bip02-final-repair-yl0ueiig`.

## Supplied exploratory control

`supplied/scrubfuzz.cpp` and `supplied/killfuzz.py` are unmodified copies from the
verified input archive. They were inspected before use. The superseded earlier
single-process programs were not copied. To repeat the supporting macOS control:

```sh
mkdir -p /tmp/bip02-supplied
clang++ -std=c++20 -O1 -DFORCE_POSIX -I node_modules/react-native-mmkv/MMKV/Core test/vault/supplied/scrubfuzz.cpp /tmp/bip02-native-build/core/libcore.a -lpthread -lz -o /tmp/bip02-supplied/scrubfuzz
cp test/vault/supplied/killfuzz.py /tmp/bip02-supplied/killfuzz.py
python3 /tmp/bip02-supplied/killfuzz.py 2097152 12 42 current,inplace0,persist
```

Those prototype roots contain marker strings, not valid vault ciphertext. Their
normal-write/clearing/inplace timings are supporting controls only. The prototype
also uses native page-size selection and lacks the production compacted-layout
guard, so its green outcomes do not certify the repaired JavaScript algorithm.
