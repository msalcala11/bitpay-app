# Android RKStorage follow-up verification

Use a disposable emulator. The scripts deliberately reset the test app/database,
create low-space conditions, and terminate its process. Never run them against a
wallet installation containing real keys or unrelated user data. All wallet data
comes from the public throwaway fixtures in `../fixtures`; do not fund those keys.

The production helper and patched Java AsyncStorage provider are compiled into the
real application. The instrumentation APK invokes them through the actual native
module or its package-private phase observer. No SQL mock substitutes for Android
SQLite. The Hermes entry uses the real new-architecture bridge, Keychain, MMKV,
RNFS and AsyncStorage plus the existing production migration and rehydration
transforms. It does not render the wallet UI or certify hardware secure storage.

## Dependencies and patch

App dependencies and lockfiles remain pinned. The checked-in patch is
`patches/@react-native-async-storage+async-storage+2.2.0.patch`; the existing
`postinstall`/`patch-package` mechanism applies it. Evidence includes a clean
application to the published 2.2.0 package and byte comparison with the compiled
native inputs. No new test dependency is required; tests use the SDK, pinned NDK,
existing Node packages, Python standard library, and Android instrumentation.

## Build and native cases

From the repository root, set a writable scratch directory and a disposable device
serial. Paths below are examples; replace them for the local installation.

```sh
export RK_SCRATCH=/tmp/bip02-rk-tests
export RK_SERIAL=emulator-5586
mkdir -p "$RK_SCRATCH/react-assets"
NODE_ENV=development SENTRY_DISABLE_AUTO_UPLOAD=true node node_modules/react-native/cli.js bundle --platform android --dev true --minify false --entry-file test/vault/rkstorage/react-entry.js --bundle-output "$RK_SCRATCH/react-assets/rkstorage-test.bundle" --assets-dest "$RK_SCRATCH/react-assets" --max-workers 2
cd android
JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home SENTRY_DISABLE_AUTO_UPLOAD=true NODE_ENV=development ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --max-workers=2 --console=plain --project-cache-dir "$RK_SCRATCH/gradle-cache" -PreactNativeArchitectures=arm64-v8a -PrkStorageTestAssets="$RK_SCRATCH/react-assets"
cd ..
adb -s "$RK_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$RK_SERIAL" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
node test/vault/rkstorage/run-android.cjs "$RK_SERIAL" "$RK_SCRATCH/native" all
node test/vault/rkstorage/run-react.cjs "$RK_SERIAL" "$RK_SCRATCH/react"
```

Run suites sequentially on each device. Different disposable devices can run
independently. `ADB=/absolute/path/to/adb` overrides the host script's default.
The native driver can use `default`, `delete`, `truncate`, `persist`, `wal`, or
`extra` instead of `all` for targeted diagnosis.

The native cases include default/historical journal modes, same-process WAL
maintenance, empty and large stores, Unicode/empty/non-JSON data, an already-live
NUL-containing SQLite value, denied/corrupt/orphan states, queued writes across
module invalidation, a held cursor and queue deadline, a busy checkpoint, hot
journal recovery, phase exceptions, process kills and timed VACUUM kills. It tests
4 KiB and 16 KiB **SQLite database pages** separately from the reported OS page size.

`secure_delete` is measured before deliberately disabling it to construct vulnerable
controls. These controls are not claimed to be captured released-device databases.
Android's pinned provider truncates embedded NUL on input; that one existing-value
fixture is seeded with a SQLite text expression and compared as stored bytes.
Other histories use real provider writes/updates/removals. Public padding is
appended without changing the archived serializer's escaping.

The raw scans cover main, WAL, rollback journal and SHM at the production return
boundary, before ordinary follow-up writes can hide journal residue. They decode
JSON-escaped slashes, attempt CBC decryption with the synthetic identifier, and
check known ciphertext fragments, bare EDDSA and opaque EDDSA password material.
The Hermes scan keeps the emulator identifier in memory and exports only counts.
The source-level erasure argument and native postconditions remain necessary;
marker absence alone is not proof.

Cold reopen checks use the patched production supplier. Native tests compare the
full live map before/after maintenance, and independently assert fixture contents
across process termination. Timed kill reports list observed phases; timing counts
are not production failure rates or power-loss certification.

## Real syscall failures

The opt-in debug build uses a tiny, test-only `LD_PRELOAD` interposer. It injects one
EIO on a fixed RKStorage file class when instrumentation arms the operation. There
is no generic SQL/path interface. The `.so` and wrapper are absent from normal
builds and from release sources. [Android's wrapper documentation](https://developer.android.com/ndk/guides/wrap-script)
explains the required debug packaging.

```sh
mkdir -p "$RK_SCRATCH/fault-jni/arm64-v8a" "$RK_SCRATCH/fault-jni/resources/lib/arm64-v8a"
"$ANDROID_SDK_ROOT/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android30-clang" -shared -fPIC -Wall -Werror test/vault/rkstorage/faults.c -o "$RK_SCRATCH/fault-jni/arm64-v8a/librkstorage_faults.so" -ldl
cp test/vault/rkstorage/wrap.sh "$RK_SCRATCH/fault-jni/resources/lib/arm64-v8a/wrap.sh"
cd android
JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home SENTRY_DISABLE_AUTO_UPLOAD=true NODE_ENV=development ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --max-workers=2 --console=plain --project-cache-dir "$RK_SCRATCH/gradle-cache" -PreactNativeArchitectures=arm64-v8a -PrkStorageTestAssets="$RK_SCRATCH/react-assets" -PrkStorageFaultJni="$RK_SCRATCH/fault-jni"
cd ..
adb -s "$RK_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$RK_SERIAL" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
node test/vault/rkstorage/run-syscalls.cjs "$RK_SERIAL" "$RK_SCRATCH/syscalls"
```

Rebuild and reinstall **without** `rkStorageFaultJni` afterward. The final validation
also verifies that normal APKs contain neither `wrap.sh` nor the interposer.
The disk-full case reserves space only on the disposable emulator, bounded by its
available data volume (under 8 GiB). It removes the reserve in `finally`. If a test
host is interrupted, remove only `files/rkstorage-test-reserve` in that disposable
app before continuing; never touch an RKStorage journal manually.

## Negative controls

```sh
python3 test/vault/rkstorage/run-mutants.py "$RK_SERIAL" "$RK_SCRATCH/mutants"
```

This deliberately mutates only `RKStorageCleanup.java` temporarily, builds the
mutant APK, and restores the source in `finally`, refusing to overwrite concurrent
source changes. It checks omitted VACUUM, omitted journal finalization/checks, and
unsafe live-root deletion. Rebuild/reinstall the normal APK after these tests.
A native instrumentation assertion reports code `1` even when ADB transport exits
`0`; the driver checks the assertion code, not just ADB's exit status.

The same driver also runs the targeted Jest premature-marker mutation; append
`premature-marker` to run just that control without rebuilding/installing an APK. All generated APKs, raw captures, temporary package trees,
AVDs and full logs remain outside tracked source (or in ignored build directories).
Only safe aggregate results, source hashes, scripts and test inputs are retained.

## Fresh-initialization restart regression

`run-react.cjs` also runs `react-fresh-start`, two `react-fresh-retry` launches,
`react-fresh-save`, and two `react-clean` launches. Each operation gets a fresh
Hermes process. Before the first save, each process additionally retries startup
three times, asserting the same key, durable initialization provenance, no
fabricated root, no cleanup call and no cleanup-complete marker. The save uses
the real Redux Persist transforms and production `reduxStorage` adapter; it must
retire initialization provenance. The next process must clean successfully and
restore the exact synthetic wallet, and the final launch must take the fast path.

The fresh-initialization campaign comprised five scenarios and 18 launches;
the EDDSA extension below adds another four-process scenario. `src/store/vault-migration.spec.ts` adds modeled failures and process
interruptions after every fresh base-migration mutation, after the first root
write and after provenance retirement. It retains established-source-loss,
invalid-key, unavailable-bridge, strict-read and iOS controls. See
`results/fresh-initialization.json` for the repair's actual executions; earlier
native fault-injection evidence is not relabeled as rerun by this JS state fix.


## EDDSA upgrade between deferred cleanup attempts

The driver now includes `react-eddsa-seed`, `react-eddsa-upgrade`,
`react-eddsa-retry` and `react-eddsa-verify`, each in a fresh Hermes process. A
synthetic pre-upgrade key is serialized as whole-reducer CBC. The upgrade launch
injects an AsyncStorage deletion rejection, runs the real app EDDSA upgrade effect
and SDK, verifies every old key property is unchanged, then persists the enriched
state through the production adapter. The next process compares it with the still
live old source, completes cleanup, and verifies the enriched primary is unchanged.
The final process asserts the completed fast path. Safe booleans/counts are the only
exported evidence; no key or snapshot is emitted. The raw-file scan requires CBC
in the deliberately retained live source before completion and no recoverable CBC
markers after cleanup.

With the previous five scenarios, the driver performs six scenarios and 22
launches. `../results/preservation-repair.json` records this repair's actual run;
previous fault-injection and physical-device coverage is not inferred from it.


## Consolidated fresh-start ruling

The existing real-Hermes driver also seeds an empty persistence installation
with the legacy Keychain item, and with both legacy and independently generated
versioned items. Each runs repeated preparations before the first ordinary save,
asserts no native cleaning before that save, checks legacy-entry retirement and
versioned-key reuse, and reopens in later instrumented processes. This constructs
the surviving-Keychain state; it does not claim to perform a real Android reinstall
or certify hidden failed-load behavior. Source/record/partial-write acceptance
cases remain separately labeled JavaScript boundary models.

The receipt driver also includes `react-receipt-temp-*`: a real production refresh
leaves its verified temp after an injected promotion rejection; the next process
loses the primary and recovers from that exact temp with suspension persistence
rejected. Later processes read the retained older source successfully and must
keep its uncovered key, retain conversion and never replenish the receipt. The
file/key/record libraries and process boundaries are real; the promotion and
suspension errors are deliberate test-boundary injections, not inside-native
failures. Together the driver runs 11 scenarios and 54 launches.


The follow-up adds `react-receipt-read-*`: while cleanup is pending, the real
MMKV getter is wrapped to reject primary reads until a successful native restore
write. A failed suspension write must not prevent one verified receipt-free
restore; later fresh processes requalify covered source cleanup. This is a
JavaScript-injected read fault over real native libraries, not a native load-fault
simulation or hardware claim. The driver now runs 12 scenarios / 59 launches.


## Follow-up 2: E/F/G

The existing driver adds `react-followup2-once-*`, `react-followup2-sql-*`, and
`react-followup2-temp-*`, each over five fresh processes. The first keeps an exact
newer primary after a single injected getter failure. The second establishes base
completion with RKStorage pending, injects getter failure until the real restore
write, then lets native cleaning finish on a later launch. The third leaves a
real half-written optional temp through a rejected JS write wrapper, performs an
ordinary backup rotation in the same session, and checks later cleanup with the
primary and both targets unchanged. Faults are JavaScript-boundary injections;
storage, production policy, Android native cleaning and process boundaries are
real. No actual disk-full or inside-native read failure is claimed. The complete
driver now contains 15 scenarios / 74 launches. Validation results belong to
`../stage-a/stage-b-results.json.followup2Repair`.


## Follow-up 4: H/I/J/K

`react-followup4-*` adds six five-process scenarios: production verified-temp
recovery beside a damaged target; first-save history with interrupted retirement;
Android unavailable-marker retirement; and legacy-entry read/delete/verification
outcomes (deletable then absent, continued unreadability, rejected deletion).
First-save scenarios finish by losing all modern copies and requiring the existing
classified stop. Other scenarios finish on the completed fast path. All faults are
JS-boundary injections; native storage and process restarts are real. The driver
now has 21 scenarios / 104 launches. Results belong to
`../stage-a/stage-b-results.json.followup4Repair`; no physical-device or real native
Keychain-failure claim follows from these tests.
